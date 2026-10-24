/**
 * imageGenFlow — 聊天生图的编排层（内联标签 / 手动按钮共用）。
 *
 * runImageGenReply(req, deps)：fire-and-forget，由调用方 `void` 调用——文字消息
 * 先落库，这里的长耗时（LLM 提取档案 + 排队生图 + 轮询）绝不阻塞聊天。
 * 函数自己吞掉所有异常转 toast，永不 throw。
 *
 * 链路：
 *   1. 外貌档案 ensure（说话角色 + prompt 里 @ 到的已知角色，首次自动从人设提取）
 *   2. resolveAppearanceRefs 替换 @名字
 *   3. queueLatentGeneration 串行生图
 *   4. putImageBlob → blobref 令牌
 *   5. DB.saveMessage(type:'image') + saveGalleryImage（照用户发图入库模板）
 *   6. announceChatGen(replyArrived) → 开着该会话的 Chat 自动 reload，不在则补未读
 */

import type { APIConfig, CharacterProfile, Message, UserProfile } from '../types';
import { DB } from './db';
import { putImageBlob } from './blobRef';
import {
    resolveAppearanceRefs,
    composeImagePrompt,
    mentionsCharacterRef,
    normalizeImageGenResolution,
    DEFAULT_IMAGE_GEN_RESOLUTION,
    type AppearanceProfile,
    type GenImageRequest,
    type ImageGenResolution,
} from './imageGenTags';
import {
    queueLatentGeneration,
    type LatentFetch,
} from './latentImageGen';
import { announceChatGen, CHAT_GEN_EVENTS } from './chatGenEvents';
import { getLocalDateKey } from './localDate';
import { describeImageWithVisionApi } from './visionApi';
import { markImageGenStarted, markImageGenSettled } from './imageGenPending';

export interface ImageGenMeta {
    prompt: string;
    resolution: string;
    seed: number;
    artworkId: string;
}

export interface ImageGenFlowDeps {
    apiConfig: APIConfig;
    char: CharacterProfile;
    userProfile: UserProfile;
    /** 外貌档案来源（含说话角色；@ 到的别角色也从这里匹配）。 */
    characters: CharacterProfile[];
    /** 近历史（相册 chatContext 用，可为空）。 */
    contextMsgs: Message[];
    hooks: {
        addToast: (msg: string, type: 'info' | 'success' | 'error') => void;
    };
    /** 档案自动提取后回写（调用方接 updateCharacter）。 */
    saveCharProfile: (charId: string, profile: string) => void;
    /** 单测注入；缺省全局 fetch。 */
    fetchImpl?: LatentFetch;
}

/**
 * 生图内核的依赖子集：只关心「按谁的外貌画 / 怎么调 latent / 档案改完写哪」。
 * 不落聊天消息的场景（例如朋友圈封面）传这一份就够。
 */
export interface ImageGenCoreDeps {
    apiConfig: APIConfig;
    char: CharacterProfile;
    characters: CharacterProfile[];
    saveCharProfile: (charId: string, profile: string) => void;
    fetchImpl?: LatentFetch;
}

export interface ImageGenCoreResult {
    /** 已落 blob store 的 blobref 令牌，直接塞进消息 content / 帖子 images。 */
    token: string;
    /** @名字 替换后的最终 prompt。 */
    prompt: string;
    meta: ImageGenMeta;
}

// SD 系默认负面词：latent.moe 不套站点默认，不给就等于没有。
const DEFAULT_NEGATIVE_PROMPT = 'lowres, blurry, watermark, text, deformed, worst quality';

/**
 * 默认质量提示词：**所有**生图（聊天自动 / 主动消息 / 动态封面 / 相册）统一前置，
 * 见 generateImageBlobOnly —— 那是全项目唯一的生图入口，别在别的路径上再拼一次。
 */
export const DEFAULT_QUALITY_PROMPT = 'masterpiece, best quality, amazing quality, very aesthetic, absurdres';

/** 外貌档案提取 LLM 的 system prompt（小调用，temperature 低）。 */
const PROFILE_EXTRACT_SYS = `你是角色外貌档案员。从【人设】里提取这个角色固定的外貌特征，输出一行英文 danbooru 风格 tag，逗号分隔，8-20 个 tag。
只写长相：发色、瞳色、发型、耳朵/尾巴等兽耳特征、体型、常穿的标志性服装。不要写性格、年龄数字、背景故事。
直接输出 tag 串本身，不要解释、不要引号、不要 Markdown。
例：cat girl, silver long hair, green eyes, cat ears, slender, black choker, school uniform`;

function cleanTagLine(raw: string): string {
    return (raw || '')
        .replace(/^[\s`"'']+|[\s`"'']+$/g, '')
        .replace(/^(tags?|输出)\s*[:：]\s*/i, '')
        .replace(/\n[\s\S]*$/, '')
        .trim()
        .slice(0, 500);
}

// 会话内 guard：提取中 / 提取失败过的本轮不再重试（省调用）。
const extractingProfiles = new Set<string>();
const extractFailedProfiles = new Set<string>();

async function extractAppearanceViaLLM(
    char: CharacterProfile,
    apiConfig: APIConfig,
    fetchImpl?: LatentFetch,
): Promise<string> {
    const baseUrl = (apiConfig.baseUrl || '').replace(/\/+$/, '');
    const { apiKey, model } = apiConfig;
    if (!baseUrl || !apiKey || !model) return '';
    const fetchFn: LatentFetch = fetchImpl ?? (fetch as unknown as LatentFetch);
    const persona = [char.systemPrompt, (char as any).writerPersona, (char as any).worldview]
        .filter(s => typeof s === 'string' && s.trim())
        .join('\n\n');
    const res = await fetchFn(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: PROFILE_EXTRACT_SYS },
                { role: 'user', content: `【角色名】${char.name}\n\n【人设】\n${persona || '(人设为空，按名字直觉给一套通用的)'}` },
            ],
            temperature: 0.2,
            max_tokens: 300,
        }),
    });
    if (!res.ok) return '';
    let data: any = null;
    try {
        data = await res.json();
    } catch {
        return '';
    }
    return cleanTagLine(data?.choices?.[0]?.message?.content || '');
}

async function ensureAppearanceProfile(
    char: CharacterProfile,
    deps: ImageGenCoreDeps,
): Promise<string> {
    const cur = ((char as any).imageGenProfile || '').trim();
    if (cur) return cur;
    if (extractingProfiles.has(char.id) || extractFailedProfiles.has(char.id)) return '';
    extractingProfiles.add(char.id);
    try {
        const tags = await extractAppearanceViaLLM(char, deps.apiConfig, deps.fetchImpl);
        if (tags) {
            (char as any).imageGenProfile = tags;
            try {
                deps.saveCharProfile(char.id, tags);
            } catch { /* 存档失败不阻断本次生图 */ }
            return tags;
        }
        extractFailedProfiles.add(char.id);
        return '';
    } catch {
        extractFailedProfiles.add(char.id);
        return '';
    } finally {
        extractingProfiles.delete(char.id);
    }
}

/** 参考图解析用的 system prompt：只要固定外貌特征，不要动作 / 场景 / 画风。 */
const PROFILE_FROM_IMAGE_SYS = `你是角色外貌标签师。看这张参考图，提取画面人物固定可复用的外貌特征，输出一行英文 danbooru 风格 tag，逗号分隔，8-20 个 tag。
只写长相：发色、瞳色、发型、耳朵/尾巴等兽耳特征、体型、常穿的标志性服装。不要写动作、场景、光线、情绪、画风词。
直接输出 tag 串本身，不要解释、不要引号、不要 Markdown。`;

/**
 * 从角色设定提取外貌 tag（神经链接角色页「从角色设定提取」按钮）。
 *
 * 与首次生图的自动提取共用同一份实现，但**不吃**模块级的失败缓存——手动点按钮
 * 要能重试，自动路径里「失败过就本轮不再试」的省调用逻辑在这里是反作用。
 * 失败抛 Error，message 可直接 toast。
 */
export async function extractAppearanceFromPersona(
    char: CharacterProfile,
    apiConfig: APIConfig,
    fetchImpl?: LatentFetch,
): Promise<string> {
    const tags = await extractAppearanceViaLLM(char, apiConfig, fetchImpl);
    if (!tags) throw new Error('没能从人设里提取出外貌 tag：检查 API 配置，或先把人设写具体一点');
    return tags;
}

/**
 * 从用户上传的参考图解析外貌 tag（神经链接角色页「上传图片解析」按钮）。
 *
 * 路由与聊天识图一致：visionApi 开着就用它（配置不全时抛它自己的提示），否则回落
 * 主 API——主模型不支持看图时以人话错误收场，UI 会提示去设置里配识图中转。
 * 返回清洗过的一行英文 tag；失败抛 Error。
 */
export async function extractAppearanceFromReferenceImage(
    imageDataUrl: string,
    apiConfig: APIConfig,
): Promise<string> {
    const vision = apiConfig.visionApi?.enabled
        ? apiConfig.visionApi
        : {
            enabled: true,
            baseUrl: apiConfig.baseUrl || '',
            apiKey: apiConfig.apiKey || '',
            model: apiConfig.model || '',
        };
    const text = await describeImageWithVisionApi(imageDataUrl, vision, {
        prompt: PROFILE_FROM_IMAGE_SYS,
        maxTokens: 300,
        temperature: 0.2,
    });
    const tags = cleanTagLine(text);
    if (!tags) throw new Error('模型没解析出外貌 tag，换一张人物更清楚的图再试');
    return tags;
}

function findCharByName(name: string, characters: CharacterProfile[]): CharacterProfile | null {
    const key = name.trim().toLowerCase();
    if (!key) return null;
    return characters.find(c => (c.name || '').trim().toLowerCase() === key) ?? null;
}

/**
 * prompt 里 @ 到的已知角色（+ 说话角色自己），ensure 档案后组装替换表。
 * ensure 上限 3 个，防病态 prompt 刷调用。
 */
async function collectAppearanceProfiles(
    rawPrompt: string,
    deps: ImageGenCoreDeps,
): Promise<AppearanceProfile[]> {
    const wanted = new Map<string, CharacterProfile>();
    wanted.set(deps.char.id, deps.char);
    const atRe = /@([^@\s,，、。！？!?.|\]]+)/g;
    let m: RegExpExecArray | null;
    while ((m = atRe.exec(rawPrompt)) !== null) {
        const hit = findCharByName(m[1], deps.characters);
        if (hit && !wanted.has(hit.id) && wanted.size < 4) wanted.set(hit.id, hit);
    }
    const out: AppearanceProfile[] = [];
    let ensured = 0;
    for (const c of wanted.values()) {
        let tags = ((c as any).imageGenProfile || '').trim();
        if (!tags && ensured < 3) {
            ensured++;
            tags = await ensureAppearanceProfile(c, deps);
        }
        if (tags) out.push({ names: [c.name], tags });
    }
    return out;
}

function buildGalleryChatContext(char: CharacterProfile, userName: string, contextMsgs: Message[]): string[] | undefined {
    if (!contextMsgs || contextMsgs.length === 0) return undefined;
    return contextMsgs.slice(-10).map(m => {
        const sender = m.role === 'user' ? userName : char.name;
        const isMedia = m.type === 'image' || m.type === 'emoji';
        const preview = isMedia ? '[图片]' : String(m.content || '').substring(0, 100);
        return `${sender}: ${preview}`;
    });
}

/**
 * 只生成一张图并落 Blob（返回 blobref 令牌），不写聊天记录、不进相册——
 * 动态封面这类场景复用。与 runImageGenReply 共用同一套外貌档案替换 /
 * 串行排队 / 默认负面词；缺 Key 直接抛错（提示语与聊天路径一致，可直接 toast）。
 */
export async function generateImageBlobOnly(
    req: GenImageRequest,
    deps: ImageGenCoreDeps,
): Promise<ImageGenCoreResult> {
    const apiKey = (deps.apiConfig.latentImageKey || '').trim();
    if (!apiKey) throw new Error('生图缺 Key：去「设置 → AI 生图」填 Latent API Key');

    const profiles = await collectAppearanceProfiles(req.prompt, deps);
    // 画风 / 质量词通用注入；性别只在画面里真的出现该角色时注入（@引用判定，替换前）。
    const gender = deps.char.imageGenGender && mentionsCharacterRef(req.prompt, deps.char.name)
        ? deps.char.imageGenGender
        : undefined;
    const resolved = resolveAppearanceRefs(req.prompt, profiles);
    const prompt = composeImagePrompt(resolved, {
        qualityTags: DEFAULT_QUALITY_PROMPT,
        styleTags: (deps.char.imageGenStyleTags || '').trim(),
        gender,
    });

    const res = await queueLatentGeneration({
        apiKey,
        prompt,
        negativePrompt: DEFAULT_NEGATIVE_PROMPT,
        resolution: req.resolution,
        fetchImpl: deps.fetchImpl,
    });

    const token = await putImageBlob(res.blob);
    return {
        token,
        prompt,
        meta: {
            prompt,
            resolution: req.resolution,
            seed: res.seed,
            artworkId: res.artworkId,
        },
    };
}

/**
 * 执行一次生图并落库（聊天消息 + 相册）。调用方 fire-and-forget；永不 throw，失败走 toast。
 */
export async function runImageGenReply(req: GenImageRequest, deps: ImageGenFlowDeps): Promise<void> {
    const { char, apiConfig, hooks } = deps;
    try {
        const apiKey = (apiConfig.latentImageKey || '').trim();
        if (!apiKey) {
            hooks.addToast('生图缺 Key：去「设置 → AI 生图」填 Latent API Key', 'error');
            return;
        }

        // 「正在加载图片…」提示从这一刻亮起，收尾（成功 / 失败 / Abort）在 finally 熄灭。
        // 缺 Key 的路径不打标记——本来就不会生成，不该亮灯。
        markImageGenStarted(char.id);
        try {
            const result = await generateImageBlobOnly(req, deps);
            const savedId = await DB.saveMessage({
                charId: char.id,
                role: 'assistant',
                type: 'image',
                content: result.token,
                metadata: { imageGen: result.meta },
            } as any);

            // 相册附带记录：跟用户发图同一模板（Chat.tsx），失败不阻断消息。
            try {
                await DB.saveGalleryImage({
                    id: `img-${Date.now()}-${Math.random()}`,
                    charId: char.id,
                    url: result.token,
                    timestamp: Date.now(),
                    sourceMessageId: savedId,
                    savedDate: getLocalDateKey(),
                    chatContext: buildGalleryChatContext(char, deps.userProfile?.name || '我', deps.contextMsgs),
                });
            } catch (err) {
                console.warn('[imageGen] 图片存相册失败，消息照常保留', err);
                hooks.addToast('图片没能存进相册，消息照常保留', 'error');
            }

            // 开着该会话的 Chat 自动 reload；不在则由 Chat 自己的监听补未读/toast。
            announceChatGen(CHAT_GEN_EVENTS.replyArrived, { charId: char.id, charName: char.name });
        } finally {
            markImageGenSettled(char.id);
        }
    } catch (e: any) {
        if (e?.name === 'AbortError') return;
        console.warn('[imageGen] 生图失败', e);
        hooks.addToast(`生图失败：${e?.message || '未知错误'}`, 'error');
    }
}

/** 设置页「测试生图」的固定测试主体（英文 danbooru tag；质量词由内核统一前置）。 */
export const IMAGE_GEN_TEST_PROMPT = '1girl, solo, long silver hair, green eyes, gentle smile, cherry blossoms, soft light';

export interface ImageGenTestResult {
    blob: Blob;
    mimeType: string;
    /** 实际发出去的完整 prompt（含质量词，界面上展示用于验证注入链路）。 */
    prompt: string;
    seed: number;
    artworkId: string;
}

/**
 * 设置页「测试生图」：用固定测试词跑一次真实生图，**只回图**——
 * 不写聊天、不进相册、不落 blob store。走的是与正式生图完全相同的参数
 * （12 步 / er_sde / linear_quadratic / 默认负面词）+ 默认质量词，专门用来
 * 肉眼验证 Latent Key、代理通道和出图效果。
 *
 * 缺 Key 抛中文错误；生成失败沿用 latentImageGen 的中文映射（可直接展示）。
 * 用方图（1024×1024）方便预览；走串行队列，避免跟正在跑的生成撞并发。
 */
export async function runImageGenTest(
    apiConfig: APIConfig,
    opts?: { fetchImpl?: LatentFetch; onStatus?: (stage: string, progress?: number) => void },
): Promise<ImageGenTestResult> {
    const apiKey = (apiConfig.latentImageKey || '').trim();
    if (!apiKey) throw new Error('请先在「设置 → AI 生图」里填 Latent API Key (lat_sk_...)');
    const prompt = composeImagePrompt(IMAGE_GEN_TEST_PROMPT, { qualityTags: DEFAULT_QUALITY_PROMPT });
    const res = await queueLatentGeneration({
        apiKey,
        prompt,
        negativePrompt: DEFAULT_NEGATIVE_PROMPT,
        resolution: 'square',
        fetchImpl: opts?.fetchImpl,
        onStatus: opts?.onStatus,
    });
    return {
        blob: res.blob,
        mimeType: res.mimeType,
        prompt,
        seed: res.seed,
        artworkId: res.artworkId,
    };
}

const TAG_SUGGEST_SYS = `你是分镜师。把用户的画面描述转成英文 danbooru 风格生图 tag，并判断画幅。
规则：
- 画面里需要出现角色时，用 @名字 指代（如 @小苏）——系统会替换成固定外貌并注入性别；纯景色不要出现任何人物、不要用 @。
- 不要写发色 / 瞳色 / 服装 / 性别标记（1girl / 1boy 等），也不要写画风 / 画师 tag（这些由系统固定注入，你写了会跟它们打架）。
- 画幅按构图选：人物特写 / 竖构图 portrait，横向场景 landscape，方构图 square。
只输出下面这个 JSON，不要 Markdown 代码块、不要解释：
{"tags": "英文 tag，逗号分隔，8-20 个", "resolution": "portrait | landscape | square"}`;

function checkLlmReady(apiConfig: APIConfig): string {
    const baseUrl = (apiConfig?.baseUrl || '').replace(/\/+$/, '');
    if (!baseUrl || !apiConfig?.apiKey || !apiConfig?.model) {
        throw new Error('请先在「设置」里配置 LLM API（baseUrl + key + model）');
    }
    return baseUrl;
}

export interface ImageTagSuggestion {
    tags: string;
    /** 模型按构图自选的画幅；解析不出来时回退竖图。 */
    resolution: ImageGenResolution;
}

/**
 * 解析分镜师的输出，两级容错：
 *   1. 优先 JSON（剥代码块后取首个 `{…}`，容忍前后废话）；
 *   2. 失败退化成「一行 tag，可带 `| portrait` 后缀」（兼容旧写法）。
 * 空结果返回 null，由调用方决定报错。
 */
export function parseTagSuggestion(raw: string): ImageTagSuggestion | null {
    const text = String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try {
            const obj = JSON.parse(text.slice(start, end + 1));
            const tags = cleanTagLine(String(obj?.tags || obj?.prompt || ''));
            if (tags) {
                return {
                    tags,
                    resolution: normalizeImageGenResolution(obj?.resolution) ?? DEFAULT_IMAGE_GEN_RESOLUTION,
                };
            }
        } catch { /* 落到下一级 */ }
    }
    const line = cleanTagLine(text).split('\n')[0];
    if (!line) return null;
    const m = line.match(/^(.*?)\s*\|\s*([A-Za-z\u4e00-\u9fa5]+)\s*$/);
    if (m) {
        const tags = cleanTagLine(m[1]);
        if (tags) {
            return {
                tags,
                resolution: normalizeImageGenResolution(m[2]) ?? DEFAULT_IMAGE_GEN_RESOLUTION,
            };
        }
    }
    return { tags: line, resolution: DEFAULT_IMAGE_GEN_RESOLUTION };
}

/**
 * 把一段自然语言画面描述交给 LLM 分析成生图 tag + 画幅（聊天相册「生成图片」用）。
 * 「画面里有没有角色」「画幅多大」都由模型按描述判断；外貌 / 性别 / 画风由生图内核注入。
 * 抛出的 Error message 可直接 toast。
 */
export async function suggestImageTags(
    scene: string,
    char: CharacterProfile,
    apiConfig: APIConfig,
    fetchImpl?: LatentFetch,
): Promise<ImageTagSuggestion> {
    const baseUrl = checkLlmReady(apiConfig);
    const fetchFn: LatentFetch = fetchImpl ?? (fetch as unknown as LatentFetch);
    const res = await fetchFn(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
        body: JSON.stringify({
            model: apiConfig.model,
            messages: [
                { role: 'system', content: TAG_SUGGEST_SYS },
                { role: 'user', content: `【角色】${char.name}\n\n【画面描述】\n${scene.slice(0, 2000)}` },
            ],
            temperature: 0.7,
            max_tokens: 500,
        }),
    });
    if (!res.ok) throw new Error(`写 tag 失败 (HTTP ${res.status})`);
    let data: any = null;
    try {
        data = await res.json();
    } catch {
        throw new Error('写 tag 返回非 JSON');
    }
    const suggestion = parseTagSuggestion(data?.choices?.[0]?.message?.content || '');
    if (!suggestion) throw new Error('LLM 没写出 tag，换个说法重试');
    return suggestion;
}
