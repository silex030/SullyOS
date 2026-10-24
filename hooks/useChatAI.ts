import { useState, useRef, useEffect, MutableRefObject } from 'react';
import { CharacterProfile, UserProfile, Message, Emoji, EmojiCategory, GroupProfile, RealtimeConfig, CharacterBuff, Amsg2ExpiredNoticeRecord } from '../types';
import { DB } from '../utils/db';
import { ChatPrompts } from '../utils/chatPrompts';
import { safeFetchJson, safeResponseJson } from '../utils/safeApi';
import { observeFinalChatRequest } from '../utils/requestPrefixObserver';
import { KeepAlive } from '../utils/keepAlive';
import { ContextBuilder } from '../utils/context';
import { ChatParser } from '../utils/chatParser';
// 思考链 / HTML / MCD / memoryPalace 注入已下沉到 chatRequestPayload；这里不再直接调用
import { useMusic, loadMusicHooks } from '../context/MusicContext';
import { processNewMessagesWithAutoArchive } from '../utils/memoryPalace/autoArchive';
import { incrementDigestRound, runCognitiveDigestion, detectPersonalityStyle } from '../utils/memoryPalace';
// evolveFlowNarrative 保留为低频深刷新备用，日常意识流由副 API 的情绪评估同轮产出（innerState 字段）
// import { evolveFlowNarrative } from '../utils/scheduleGenerator';
import { isScheduleFeatureOn } from '../utils/scheduleGenerator';
import type { DigestResult } from '../utils/memoryPalace';
// 麦当劳: useChatAI 现在只读 McdMiniApp 当前快照注入 system prompt + 给 LLM 一个
// UI 钩子工具 propose_cart_items。MCP 实际调用都在 McdMiniApp 组件内做, useChatAI
// 不再 import callMcdTool / normalizeMcdToolName / isMcdConfigured / 旧 prompt。
import { MCD_PROPOSE_TOOL, autoFixProposalCodesByName } from '../utils/mcdToolBridge';
// 瑞幸: 与麦当劳同构, 只读 LuckinMiniApp 快照注入 + propose_cart_items UI 钩子工具
import { LUCKIN_PROPOSE_TOOL, autoFixProposalCodesByName as autoFixLuckinProposalCodesByName, fetchOpenAIToolsForLuckin, inferCardKind as inferLuckinCardKind } from '../utils/luckinToolBridge';
import { callLuckinTool } from '../utils/luckinMcpClient';
import { callMcpTool, getMcpUseNativeTools, hasWorkerUnreachableMcpServer, loadMcpSettings } from '../utils/mcpClient';
import { normalizeMcpToolArguments, validateMcpToolArguments } from '../utils/mcpFireCore';
import { bumpMcpTurn, recordMcpResult } from '../utils/mcpResultMemory';
import { buildMcpOpenAITools, buildMcpRejectedToolsFallbackBody, buildMcpTextFallbackBody, extractTextFakedMcpCalls, formatMcpToolResult, MCP_CHAT_MAX_STALLED_ROUNDS, MCP_CHAT_MAX_TOOL_LOOPS, sanitizeMcpLeadInText, shouldRetryMcpWithoutTools, stripTextFakedMcpCalls, type FakedMcpCall } from '../utils/mcpToolBridge';import { buildToolResultMessage, normalizeToolCallsForCompat } from '../utils/toolCallCompat';
import { toolCallFingerprint } from '../utils/agenticToolFeedback';
// 链接分享按需读片段（执行卡 t_75dd49a5）：分享卡在场 + 总开关开着时把 read_share_excerpts
// 注入本轮工具清单；执行/预算/落历史的逻辑都在 socialShareTool（独立模块，别往本文件加逻辑）。
import { isSocialShareEnabled, readSocialShareConfig, resolveShareEndpoint } from '../utils/socialShare';
import {
    attachShareExcerptPairs,
    buildShareExcerptsTool,
    createShareExcerptTurn,
    executeShareExcerptToolCall,
    hasReadableShareExcerptTarget,
    pickShareExcerptAnchor,
    SHARE_EXCERPTS_TOOL_NAME,
    type ShareExcerptTurn,
} from '../utils/socialShareTool';
import { buildChatRequestPayload } from '../utils/chatRequestPayload';
import {
    isInstantConfigReady,
    sendInstantPushAndAwaitReply,
    formatDiagnostics,
    type InstantPushPayload,
} from '../utils/instantPushClient';
import { applyAssistantPostProcessing, type XhsCaches } from '../utils/applyAssistantPostProcessing';
import {
    computeStreamPreviewBubbles,
    extractStreamingEmbeddedThinking,
    findNewStreamPreviewHandoverIds,
} from '../utils/streamPreview';
import { ActiveMsgStore } from '../utils/activeMsgStore';
import { markAmsgStateDirty, startAmsgChatPresence, stopAmsgChatPresence } from '../utils/amsgStateSync';
import { getLastRealUserMessageAt } from '../utils/amsg2ExpireGuard';
import { getPendingTasks, hasActiveAiTask, isAmsg2EnabledForChar } from '../utils/amsg2Tasks';
import { buildAmsg2NoticesText, buildAmsg2TaskContextText, collectAmsg2TaskContext, insertAmsg2TaskContextBlock } from '../utils/amsg2TaskContext';
import { resolveCharTimeZone } from '../utils/timezone';
import { announceInstantChatRoute, getInstantChatPending, resolveInstantChatReadiness, sendInstantChatTurn, stageInstantChatExpiredNotices } from '../utils/amsgInstantChat';
// worker 模块的常量叶子（零运行时依赖，前端引它不带进 worker 环境）：
// 云端 fire 的总时长上限，安全网超时从它推导，worker 调预算时前端自动跟上。
import { INSTANT_TOTAL_TIMEOUT_MS } from '../worker/amsg/src/instantChat';
import { appendInstantTraceEntry } from '../utils/instantTraceLog';
import { AMSG2_TOOLS, AMSG2_TOOL_NAMES, createAmsg2ToolSession, executeAmsg2Tool, isAmsg2GlobalReady } from '../utils/amsg2ToolBridge';
import { mergeAutonomySettings } from '../utils/airp/autonomySettings';
import { chatLifeWorkflowAvailability } from '../utils/airp/chatLifeWorkflow';
import {
    CHAT_LIFE_WORKFLOW_TOOLS,
    CHAT_LIFE_WORKFLOW_TOOL_NAMES,
    executeChatLifeWorkflowTool,
} from '../utils/airp/chatLifeWorkflowClient';
import { bleEngine } from '../utils/bleEngine';
import { BT_TOOL_NAMES, BT_TOOLS, executeBleSendCommand } from '../utils/bleToolBridge';
import { shouldSendThinkingParams } from '../utils/thinkingGate';
import { dispatchAgenticTool } from '../utils/agenticTools';
import { buildAirpRuntimeSnapshot } from '../utils/airp/snapshot';
import { runAirpDirector } from '../utils/airp/directorClient';
import { renderDirectorInstruction } from '../utils/airp/directorPrompt';
import { createChatToolExecutor } from '../utils/airp/toolExecutor';
import type { AirpDirectorOutput } from '../utils/airp/types';
import { buildClaudeProxyCompatibilityBody, shouldRetryClaudeProxyCompatibility } from '../utils/claudeProxyCompat';
import { routeMiniAppToolCall } from '../utils/miniAppToolRoute';
import { applyEmotionEvalRaw, extractAssistantText } from '../utils/emotionApply';
import { announceChatGen, CHAT_GEN_EVENTS } from '../utils/chatGenEvents';
import { shouldRequestAmbient, buildAmbientEvalSection } from '../utils/roomAmbient';
import { isEmotionEvalSkipped, isAirpDirectorTraceEnabled } from '../utils/devDebug';
import {
    computeContextRangeSnapshot,
    getMemoryPalaceHighWaterMarkForContext,
    loadCharacterContextRange,
} from '../utils/chatContextRange';

// ─── 云端情绪评估的安全网定时器（模块级，按角色）───
// 为什么不放 hook 里：结论（emotionDone）是全局事件，用户切了角色、离开聊天页之后
// 照样会到，而 hook 里的监听是跟着当前挂载角色走的——单个 ref 存定时器的话，切走再回来
// 结论到了也没人清，安全网到点就弹「worker 可能是旧版，请重新部署」的假告警；给 B 布防
// 还会静默吞掉 A 的真告警。按 charId 记、模块级监听清，两个都治。
const cloudEmotionTimers = new Map<string, ReturnType<typeof setTimeout>>();
const clearCloudEmotionTimer = (charId: unknown): void => {
    if (typeof charId !== 'string') return;
    const timer = cloudEmotionTimers.get(charId);
    if (timer != null) {
        clearTimeout(timer);
        cloudEmotionTimers.delete(charId);
    }
};
if (typeof window !== 'undefined') {
    // emotionDone 是「这一轮评估有结论了」（成败都发）：flush 落结果、收尾判失败两条路
    // 都会广播。不论哪个角色、Chat 挂没挂载，结论一到就撤掉对应的安全网。
    window.addEventListener(CHAT_GEN_EVENTS.emotionDone, (e) => {
        clearCloudEmotionTimer((e as CustomEvent).detail?.charId);
    });
}

// ─── 情绪评估（副API，fire & forget）───

import { getBuiltinContent, fillIdentity } from '../utils/promptPresetCatalog';
import { resolveTechnicalPrompt } from '../utils/promptPresetRuntime';

// 情绪评估主模板内置默认（与提示词目录同源；测试经快照对拍防漂移）。
const AMSG_EMOTION_EVAL_BUILTIN = getBuiltinContent('amsg.emotionEval');
// 意识系 / 生活系规则段内置默认（目录行停用/缺行时的技术模板回退）。
const AMSG_EMOTION_EVAL_MINDFUL_BUILTIN = getBuiltinContent('amsg.emotionEvalMindful');
const AMSG_EMOTION_EVAL_LIVING_BUILTIN = getBuiltinContent('amsg.emotionEvalLiving');

async function buildEmotionEvalPrompt(
    char: CharacterProfile,
    userProfile: UserProfile,
    mainSystemPrompt: string,
    apiMessages: Array<{ role: string; content: any }>,
    includeContext: boolean = true,
    // 小屋生活动态的可选输出段（utils/roomAmbient.ts，双闸通过时才非空）。
    // instant 模式的 prompt 也是这里构建后传给 worker 的，所以这一处覆盖两条路径。
    ambientSection: string = ''
): Promise<string> {
    // 直接复用主 API 的完整 system prompt 和消息历史，确保 100% 信息对齐
    // （包含：角色设定、印象档案、世界书、记忆宫殿、实时信息、日程内心旁白、群聊、日记标题等）
    const currentBuffs = char.activeBuffs || [];

    // 将主 API 的消息数组展平成文本（保留时间戳、引用、特殊消息类型等格式）
    // 不截断：与主 API 完全对齐（contextLimit 条），让情绪 eval 能看到完整的情绪演变轨迹
    const recentLines = apiMessages.map(m => {
        const role = m.role === 'user' ? '用户' : (m.role === 'assistant' ? char.name : '系统');
        let text = '';
        if (typeof m.content === 'string') {
            text = m.content;
        } else if (Array.isArray(m.content)) {
            text = m.content.map((part: any) => {
                if (part?.type === 'text') return part.text || '';
                if (part?.type === 'image_url') return '[图片]';
                return '';
            }).filter(Boolean).join(' ');
        }
        return `[${role}]: ${text}`;
    }).join('\n');

    const buffStr = currentBuffs.length > 0
        ? JSON.stringify(currentBuffs, null, 2)
        : '（当前无buff，情绪平稳）';

    // instant 模式 (includeContext=false): 章节结构与本地**完全一致**, 只把两段大文本 (system prompt、
    // 对话历史) 留成占位符 token, 由 worker 用本次请求已有的 messages 填回**原位** —— 输出与本地逐字
    // 对齐 (顺序/章节/格式都一样), 又不必把上下文重复塞进请求体 (省一份, keepalive 不被降级).
    // worker 端 (worker/instant-push runEmotionEval) 负责把 messages[0]=system、messages[1..]=对话历史
    // 还原成与本地 mainSystemPrompt / recentLines 相同的文本替换进去.
    const contextSection = includeContext
        ? `

## 角色此刻看到的完整上下文（与主 API 发送的 system prompt 完全一致）
${mainSystemPrompt}

## 完整对话历史（与主 API 看到的消息历史完全一致）
${recentLines}`
        : `

## 角色此刻看到的完整上下文（与主 API 发送的 system prompt 完全一致）
__EMOTION_EVAL_SYSTEM_PROMPT__

## 完整对话历史（与主 API 看到的消息历史完全一致）
__EMOTION_EVAL_HISTORY__`;

    // 情绪评估主模板走提示词目录（amsg.emotionEval，技术模板：停用回退默认）。
    // 规则段三选一读目录行（技术模板语义：停用回退内置）：mindful→Mindful 行，
    // 生活系（lifestyle，历史值 living 兼容）→Living 行；未设风格回退主模板 key，
    // 规则槽取生活系内置（与旧硬编码 else 一致；schedule 门要求 style 已设，实际不可达）。
    // instant 模式的 __EMOTION_EVAL_*__ 槽位在 contextSection 里原样携带，由 worker 回填。
    const style = char.scheduleStyle as string | undefined;
    const scheduleSourceKey =
        style === 'mindful'
            ? 'amsg.emotionEvalMindful'
            : style === 'lifestyle' || style === 'living'
                ? 'amsg.emotionEvalLiving'
                : 'amsg.emotionEval';
    const scheduleRule = fillIdentity(
        scheduleSourceKey === 'amsg.emotionEval'
            ? await resolveTechnicalPrompt('amsg.emotionEvalLiving', AMSG_EMOTION_EVAL_LIVING_BUILTIN)
            : await resolveTechnicalPrompt(scheduleSourceKey, getBuiltinContent(scheduleSourceKey)),
        char.name,
        userProfile.name,
    );
    const evalTpl = await resolveTechnicalPrompt('amsg.emotionEval', AMSG_EMOTION_EVAL_BUILTIN);
    return fillIdentity(evalTpl, char.name, userProfile.name)
        .replace(/__CONTEXT_SECTION__/g, () => contextSection)
        .replace(/__BUFFS__/g, () => buffStr)
        .replace(/__SCHEDULE_RULE__/g, () => scheduleRule)
        .replace(/__AMBIENT_SECTION__/g, () => ambientSection);;
}

export async function evaluateEmotionBackground(
    charData: CharacterProfile,
    userProfile: UserProfile,
    mainSystemPrompt: string,
    apiMessages: Array<{ role: string; content: any }>,
    api: { baseUrl: string; apiKey: string; model: string; stream?: boolean }
): Promise<string | null> {
    // 全局横幅「xx 正在感受…」（ChatBroadcast）。这里是所有本地评估路径的汇聚点
    // （主链路 fire & forget / post-push 补跑 / OSContext 主动消息），在函数级
    // start/finally 派发一次即可全覆盖；instant 模式的 worker 评估另行点灯。
    announceChatGen(CHAT_GEN_EVENTS.emotionStart, { charId: charData.id, charName: charData.name });
    try {
        const ambientSection = shouldRequestAmbient(charData.id) ? buildAmbientEvalSection(charData) : '';
        const prompt = await buildEmotionEvalPrompt(charData, userProfile, mainSystemPrompt, apiMessages, true, ambientSection);

        const baseUrl = api.baseUrl.replace(/\/+$/, '');
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${api.apiKey || 'sk-none'}`
        };

        const evalBody = {
            model: api.model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.85,
            // 显式给足输出额度: 部分代理不传 max_tokens 时默认很小 (1k~2k), eval 的
            // injection+innerState 很长, 会被截断成半截 JSON → buff 静默丢失.
            max_tokens: 8000,
        };
        const evalMeta = { appName: '消息', charId: charData.id, charName: charData.name, purpose: '情绪评估' };
        try {
            const { captureCall } = await import('../utils/promptCallCapture');
            captureCall('emotion-eval', [{ role: 'user', content: prompt }], { charId: charData?.id ?? '', label: '情绪评估' });
        } catch { /* 抓取永不挡主链路 */ }
        let data: any;
        try {
            data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    ...evalBody,
                    // 跟随全局流式开关（响应由 safeFetchJson 透明拼装，下游 JSON 解析不变）。
                    // 好处: ①评估动辄生成 4~5k token、跑 30~46s，非流式最容易撞网关超时；
                    // ②中转若按流式/非流式分渠道池，评估与主聊天落同一池，行为可对比。
                    stream: !!api.stream,
                    ...(api.stream ? { stream_options: { include_usage: true } } : {}),
                })
            }, 2, 0, evalMeta);
        } catch (e: any) {
            if (!api.stream) throw e;
            // 流式自愈: 个别中转/模型对 stream / stream_options 直接 4xx。主聊天的透明流式
            // 升级层有「用升级前原 body 重发」的回退 (OSContext), 但评估请求自带 stream:true
            // 不经过升级层, 没有这层兜底 —— 这里补上同等待遇: 非流式重发一次, 行为退回
            // 「评估跟随流式开关」(32c7be7) 之前。评估失败过去被静默吞掉, 用户只看到
            // 情绪徽章闪一下就灭、情绪永不更新 (真实反馈), 这类形状问题必须能自愈。
            console.warn('🎭 [Emotion] streamed eval failed, retrying non-stream:', e?.message);
            data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ ...evalBody, stream: false })
            }, 1, 0, evalMeta);
        }

        // 排查贩子降级路由用：把评估实际落到的后端和 token 计数打出来，
        // 和主聊天的 🔢 [Token Usage] 一对比就能看出哪个请求被挤进了备用渠道。
        console.log(`🎭 [Emotion] backend=${data?.model || '?'} | prompt=${data?.usage?.prompt_tokens ?? '?'} completion=${data?.usage?.completion_tokens ?? '?'}`);

        // content 可能是分块数组 / 空 content + reasoning_content (个别 Claude 兼容代理), 统一走兜底提取
        const raw = extractAssistantText(data.choices?.[0]?.message);
        if (!raw) {
            console.warn('🎭 [Emotion] Empty eval response:', JSON.stringify({
                finish_reason: data.choices?.[0]?.finish_reason,
                has_message: !!data.choices?.[0]?.message,
            }));
            announceChatGen(CHAT_GEN_EVENTS.emotionFailed, {
                charId: charData.id, charName: charData.name,
                reason: `评估模型没有输出内容 (finish_reason: ${data.choices?.[0]?.finish_reason ?? '?'})`,
            });
            return null;
        }
        return await applyEmotionEvalRaw(raw, charData);
    } catch (e: any) {
        console.warn('🎭 [Emotion] Evaluation failed:', e.message);
        announceChatGen(CHAT_GEN_EVENTS.emotionFailed, {
            charId: charData.id, charName: charData.name,
            reason: e?.message || '请求失败',
        });
        return null;
    } finally {
        announceChatGen(CHAT_GEN_EVENTS.emotionEnd, { charId: charData.id, charName: charData.name });
    }
}

interface UseChatAIProps {
    char: CharacterProfile | undefined;
    userProfile: UserProfile;
    apiConfig: any;
    groups: GroupProfile[];
    emojis: Emoji[];
    categories: EmojiCategory[];
    addToast: (msg: string, type: 'info'|'success'|'error') => void;
    /** 长报错走弹窗 (toast 一行装不下), 手机用户能看清并复制反馈 */
    showError?: (title: string, details: string) => void;
    setMessages: (msgs: Message[]) => void; // Callback to update UI messages
    /** 正式消息接替流式预览前同步登记 id，避免真实气泡重新播放入场动画。 */
    onStreamPreviewHandover?: (charId: string, messageIds: number[]) => void;
    realtimeConfig: RealtimeConfig; // 实时配置（amsg2 工具排程要用，两个调用点都必传）
    translationConfig?: { enabled: boolean; sourceLang: string; targetLang: string };
    memoryPalaceConfig?: { embedding: { baseUrl: string; apiKey: string; model: string; dimensions: number }; lightLLM: { baseUrl: string; apiKey: string; model: string } };
    /** 从 OSContext 传入，用于 palace 自动归档写 char.memories + hideBeforeMessageId */
    updateCharacter: (id: string, partial: Partial<CharacterProfile>) => void;
    /** 麦当劳小程序当前快照 (cart/menu/nutrition); open=true 时把这段实时状态追加到 system prompt 末尾, 让 char 协同选餐 */
    mcdMiniAppRef?: MutableRefObject<import('../utils/mcdToolBridge').McdMiniAppSnapshot | undefined>;
    /** 瑞幸小程序当前快照 (cart/menu); 与麦当劳同构 */
    luckinMiniAppRef?: MutableRefObject<import('../utils/luckinToolBridge').LuckinMiniAppSnapshot | undefined>;
    /** 瑞幸聊天点单模式 (点"瑞一杯"激活): 角色直接调真实 8 工具 + 注入定位/提示词 */
    luckinChatRef?: MutableRefObject<import('../utils/luckinToolBridge').LuckinChatState | undefined>;
}

export const useChatAI = ({
    char,
    userProfile,
    apiConfig,
    groups,
    emojis,
    categories,
    addToast,
    showError,
    setMessages,
    onStreamPreviewHandover,
    realtimeConfig,  // 新增
    translationConfig,
    memoryPalaceConfig,
    updateCharacter,
    mcdMiniAppRef,
    luckinMiniAppRef,
    luckinChatRef,
}: UseChatAIProps) => {
    
    // 音乐上下文 — 用于聊天时注入"user 正在听什么 + 当前歌词窗口"
    const music = useMusic();

    const [isTyping, setIsTyping] = useState(false);
    // 流式预览气泡：stream 开启时，已完成行与安全尾句随增量以临时气泡上屏。
    // 流结束后由 applyAssistantPostProcessing 正常落库渲染，预览随即清空 —— 只影响体感，不改持久化。
    const [streamingBubbles, setStreamingBubbles] = useState<string[]>([]);
    const [streamingThinking, setStreamingThinking] = useState('');
    const [recallStatus, setRecallStatus] = useState<string>('');
    const [searchStatus, setSearchStatus] = useState<string>('');
    const [diaryStatus, setDiaryStatus] = useState<string>('');
    const [xhsStatus, setXhsStatus] = useState<string>('');
    const [emotionStatus, setEmotionStatus] = useState<string>('');
    const [memoryPalaceStatus, setMemoryPalaceStatus] = useState<string>('');
    const [memoryPalaceResult, setMemoryPalaceResult] = useState<import('../utils/memoryPalace/pipeline').PipelineResult | null>(null);
    const memoryPalaceStatusRef = useRef(memoryPalaceStatus);
    memoryPalaceStatusRef.current = memoryPalaceStatus;

    // triggerAI 的 finally 在 AI 流式回复完后才跑记忆宫殿后台任务。
    // 闭包里捕获的 char 是 hook 调用时那一份，如果用户在流式中途把宫殿关了，
    // 这里读 char.memoryPalaceEnabled 仍然是 true，导致关掉后还会再触发一次
    // LLM 提取（+ 50 轮认知消化）。用 ref 在 finally 里读最新状态。
    const charRef = useRef(char);
    charRef.current = char;

    // beforeunload 保护：记忆宫殿后台处理中时，阻止用户意外关闭页面
    useEffect(() => {
        const handler = (e: BeforeUnloadEvent) => {
            if (memoryPalaceStatusRef.current) {
                e.preventDefault();
            }
        };
        window.addEventListener('beforeunload', handler);
        return () => window.removeEventListener('beforeunload', handler);
    }, []);

    const [lastDigestResult, setLastDigestResult] = useState<DigestResult | null>(null);
    const [lastTokenUsage, setLastTokenUsage] = useState<number | null>(null);
    const [tokenBreakdown, setTokenBreakdown] = useState<{ prompt: number; completion: number; total: number; msgCount: number; pass: string } | null>(null);
    const [lastSystemPrompt, setLastSystemPrompt] = useState<string>('');

    // 意识流：由副 API 的情绪评估同轮产出（innerState 字段）
    // 下一轮 system prompt 会把它作为角色的内心状态注入
    const [evolvedNarrative, setEvolvedNarrative] = useState<string>('');

    // 云端情绪评估安全网到点时判断「用户现在看的还是不是布防那个角色」用（防止过期
    // 定时器把当前角色的徽章错熄）。定时器本体在模块级 cloudEmotionTimers（按角色记）。
    const currentCharIdRef = useRef<string | null>(null);
    currentCharIdRef.current = char?.id ?? null;

    // 切换角色时重置
    useEffect(() => {
        setEvolvedNarrative('');
    }, [char?.id]);

    // ─── Post-push emotion eval (Option B: online/offline split) ───────────────
    //
    // push 落库 (activeMsgRuntime) 后, 我们希望情绪 eval 跟 line 613 同样的 full ctx 跑 —
    // 不再走 push-tail 的 degraded ctx. 两路触发:
    //   1. 在线: activeMsgRuntime dispatch 'post-push-emotion-eval' 事件, 这里监听即时跑
    //   2. 离线 / 切到别的 char: activeMsgRuntime 写 KV pending → useChatAI mount 切到这个
    //      char 时 useEffect 兜底 drain
    //
    // 行为对齐 line 613: gate = isScheduleFeatureOn(char) && emotionConfig.enabled.
    // ctx 重建用 buildChatRequestPayload 同一个 helper — push 那条 assistant msg 已经在
    // DB 里 (activeMsgRuntime.flushInboxToChat 已 await saveMessage), DB.getRecentMessagesByCharId
    // 拿到的 history 含它.
    //
    // 用 ref 包高频变化的依赖 (music / userProfile / 等), 不在 dep 数组里 → effect 只在 char.id 变时
    // 重建 listener (切角色), 避免 music 每秒 tick 一次都 remove+addEventListener.
    const emotionEvalDepsRef = useRef({
        userProfile, groups, emojis, categories, realtimeConfig, apiConfig,
        translationConfig, music, mcdMiniAppRef, luckinMiniAppRef, luckinChatRef, evolvedNarrative,
    });
    emotionEvalDepsRef.current = {
        userProfile, groups, emojis, categories, realtimeConfig, apiConfig,
        translationConfig, music, mcdMiniAppRef, luckinMiniAppRef, luckinChatRef, evolvedNarrative,
    };

    useEffect(() => {
        if (!char?.id) return;
        const charIdAtMount = char.id;

        const runEvalForPushedChar = async (): Promise<void> => {
            // The listener is keyed by character ID, but settings may change without remounting it.
            const evalChar = charRef.current?.id === charIdAtMount ? charRef.current : char;
            // 双 gate: 跟 line 613 一致 (schedule feature on + emotionConfig enabled).
            // 关掉的话还是要 clear pending, 否则下次 mount 反复尝试.
            if (!isScheduleFeatureOn(evalChar) || !evalChar.emotionConfig?.enabled) {
                try { await ActiveMsgStore.clearPendingEmotionEval(charIdAtMount); } catch { /* ignore */ }
                return;
            }

            const deps = emotionEvalDepsRef.current;
            if (isEmotionEvalSkipped()) {
                try { await ActiveMsgStore.clearPendingEmotionEval(charIdAtMount); } catch { /* ignore */ }
                return;
            }
            // 评估跟随全局流式开关（与 triggerAI 路径同口径；专用情绪 API 自带 stream 时以它为准）
            const emotionApi = (evalChar.emotionConfig.api?.baseUrl)
                ? { ...evalChar.emotionConfig.api, stream: (evalChar.emotionConfig.api as any).stream ?? !!(deps.apiConfig.stream ?? false) }
                : { baseUrl: deps.apiConfig.baseUrl, apiKey: deps.apiConfig.apiKey, model: deps.apiConfig.model, stream: !!(deps.apiConfig.stream ?? false) };

            try {
                // 重新从 DB 拉与主聊天一致的「自适应/拉杆最大范围 + 用户断点」。
                const pushedRange = await loadCharacterContextRange(evalChar);
                const contextMsgs = pushedRange.messages;
                if (pushedRange.userBreakpointExpired && updateCharacter) {
                    updateCharacter(charIdAtMount, { contextUserStartMessageId: undefined });
                }

                // 跟 sendMessage line 553 同一个 helper, 同一份 ctx → emotion eval 看到的 systemPrompt
                // + cleanedApiMessages 跟 主 API 调用看到的几乎完全一致 (差别仅在 music live snapshot 时序).
                const mcdMiniSnap = deps.mcdMiniAppRef?.current;
                const mcdMiniOpen = !!mcdMiniSnap?.open;
                const luckinMiniSnap = deps.luckinMiniAppRef?.current;
                const luckinMiniOpen = !!luckinMiniSnap?.open;
                const payload = await buildChatRequestPayload({
                    char: evalChar,
                    userProfile: deps.userProfile,
                    groups: deps.groups,
                    emojis: deps.emojis,
                    categories: deps.categories,
                    historyMsgs: contextMsgs,
                    contextLimit: Math.max(1, contextMsgs.length),
                    recallEntryPoint: 'emotion_eval',
                    realtimeConfig: deps.realtimeConfig,
                    innerState: deps.evolvedNarrative || undefined,
                    musicSnapshot: {
                        current: deps.music.current,
                        playing: deps.music.playing,
                        lyric: deps.music.lyric,
                        activeLyricIdx: deps.music.activeLyricIdx,
                        listeningTogetherWith: deps.music.listeningTogetherWith,
                        cfg: deps.music.cfg,
                        recentTrackChange: deps.music.recentTrackChange,
                    },
                    translationConfig: deps.translationConfig,
                    htmlMode: { enabled: !!(evalChar as any).htmlModeEnabled, customPrompt: (evalChar as any).htmlModeCustomPrompt },
                    thinkingChain: { enabled: !!(evalChar as any).showThinkingChain, customPrompt: (evalChar as any).thinkingChainCustomPrompt },
                    visionApiConfig: deps.apiConfig.visionApi,
                    mcdMiniSnap: mcdMiniOpen ? mcdMiniSnap : undefined,
                    luckinMiniSnap: luckinMiniOpen ? luckinMiniSnap : undefined,
                });

                if (payload.flags.promptBuildSkipped) {
                    try { await ActiveMsgStore.clearPendingEmotionEval(charIdAtMount); } catch { /* ignore */ }
                    return;
                }

                setEmotionStatus('evaluating');
                const innerState = await evaluateEmotionBackground(
                    evalChar, deps.userProfile, payload.systemPrompt, payload.cleanedApiMessages, emotionApi,
                );
                if (innerState) setEvolvedNarrative(innerState);
                // 成功后清 pending. 失败不清 → 下次 mount drain 重试.
                try { await ActiveMsgStore.clearPendingEmotionEval(charIdAtMount); } catch { /* ignore */ }
            } catch (e) {
                console.warn('[post-push-emotion-eval] failed', e);
                // 保留 pending 给下次 mount 重试
            } finally {
                setEmotionStatus('');
            }
        };

        // 1. 在线路径: 监听 push 落库后 activeMsgRuntime 发的事件
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.charId !== charIdAtMount) return;
            void runEvalForPushedChar();
        };
        window.addEventListener('post-push-emotion-eval', handler);

        // 1b. instant 模式: 情绪评估在 worker 跑 (副 API), 结果走 emotion_update push → activeMsgRuntime
        //     flush 时 applyEmotionEvalRaw 落 buff 并广播 innerState. 这里只把 innerState 喂回 evolvedNarrative
        //     (下一轮 system prompt 用), buff 已在 activeMsgRuntime 落库.
        const innerStateHandler = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.charId !== charIdAtMount) return;
            if (typeof detail?.innerState === 'string' && detail.innerState.trim()) {
                setEvolvedNarrative(detail.innerState.trim());
            }
        };
        window.addEventListener('emotion-innerstate-updated', innerStateHandler);

        // 上云的评估有结论了（worker 推回后由 activeMsgRuntime / 收尾判定派发）→ 熄灭 "情绪更新中".
        const emotionDoneHandler = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.charId !== charIdAtMount) return;
            // 安全网定时器由模块级监听按 charId 清（切走了也清得到），这里只管当前页的徽章。
            setEmotionStatus('');
        };
        window.addEventListener(CHAT_GEN_EVENTS.emotionDone, emotionDoneHandler);

        // 2. 离线路径兜底: mount 时检查这个 char 有没有 pending (老版本 / 非 worker-eval 路径残留的 push)
        void ActiveMsgStore.getPendingEmotionEval(charIdAtMount).then((pending) => {
            if (pending) void runEvalForPushedChar();
        }).catch(() => { /* ignore */ });

        return () => {
            window.removeEventListener('post-push-emotion-eval', handler);
            window.removeEventListener('emotion-innerstate-updated', innerStateHandler);
            window.removeEventListener(CHAT_GEN_EVENTS.emotionDone, emotionDoneHandler);
        };
    }, [char?.id]);

    // ── 本轮生成 guard：切角色/卸载/新一轮开始时，旧轮的网络中断、落库与 UI 提交作废。
    // isTyping 仍挡并发双发（行为不变）；这里解决的是"旧轮跑完污染新会话"。
    const genRef = useRef(0);
    const turnAbortRef = useRef<AbortController | null>(null);
    useEffect(() => {
        // 切角色：掐掉旧轮网络、作废旧轮提交、熄 typing 灯（新轮开始会重亮）。
        turnAbortRef.current?.abort();
        turnAbortRef.current = null;
        genRef.current++;
        setIsTyping(false);
    }, [char?.id]);
    useEffect(() => {
        return () => {
            turnAbortRef.current?.abort();
            turnAbortRef.current = null;
            genRef.current++;
        };
    }, []);

    // 跨消息持久化的 noteId→xsecToken 缓存，避免 lastXhsNotes 局部变量每次 triggerAI 都重置
    const xsecTokenCacheRef = useRef<Map<string, string>>(new Map());
    // noteId→title 缓存，用于 detail 失败时重新搜索拿新 token
    const noteTitleCacheRef = useRef<Map<string, string>>(new Map());
    // commentId→userId 缓存，reply_comment 需要 user_id 帮助 MCP 服务端定位评论
    const commentUserIdCacheRef = useRef<Map<string, string>>(new Map());
    // commentId→authorName 缓存，reply 降级为顶级评论时用 @authorName 让回复有上下文
    const commentAuthorNameCacheRef = useRef<Map<string, string>>(new Map());
    // commentId→parentCommentId 缓存，供 reply_comment 传递 parent_comment_id（xiaohongshu-mcp PR#440+）
    const commentParentIdCacheRef = useRef<Map<string, string>>(new Map());
    // AIRP 导演本轮产出的完整 output。阶段一只存不读（后续阶段消费它做事件/状态提交）；
    // 放 hook 顶层是硬要求——useRef 只能在渲染期调用，塞进 triggerAI 会变成非法 hook 调用。
    // 每轮 triggerAI 开头清空，AIRP 未开启时永远保持 undefined。
    const airpDirectorOutputRef = useRef<AirpDirectorOutput | undefined>(undefined);

    const updateTokenUsage = (data: any, msgCount: number, pass: string) => {
        if (data.usage?.total_tokens) {
            setLastTokenUsage(data.usage.total_tokens);
            const breakdown = {
                prompt: data.usage.prompt_tokens || 0,
                completion: data.usage.completion_tokens || 0,
                total: data.usage.total_tokens,
                msgCount,
                pass
            };
            setTokenBreakdown(breakdown);
            console.log(`🔢 [Token Usage] pass=${pass} | prompt=${breakdown.prompt} completion=${breakdown.completion} total=${breakdown.total} | msgs_in_context=${msgCount}`);
        }
    };

    const triggerAI = async (
        currentMsgs: Message[],
        overrideApiConfig?: { baseUrl: string; apiKey: string; model: string },
        onInstantPosted?: () => void,
        opts?: { skipEmotionInjection?: boolean },
    ) => {
        // 早退路径也要熄「发送准备中」灯: caller (Chat.tsx) 是先 setInstantSendingActive(true)
        // 再调 triggerAI 的, 这里 return 掉而不通知的话指示灯会永远亮着。
        if (isTyping || !char) { onInstantPosted?.(); return; }
        const effectiveApi = overrideApiConfig || apiConfig;
        if (!effectiveApi.baseUrl) { alert("请先在设置中配置 API URL"); onInstantPosted?.(); return; }

        // 重 roll（回溯重生）时不带入上一轮的情绪余波：清掉 buff 注入（buffInjection/activeBuffs）和
        // 意识流（innerState/evolvedNarrative），让主回复与情绪评估两边都从干净状态独立重新生成——
        // 否则上一次生成留下的情绪 buff 与内心独白会被原样再注入，两次 roll 受同一情绪底色裹挟，失去独立性。
        // charForGen 只是本地浅拷贝（清空 buff 字段），不落 DB，不影响角色持久化的情绪状态——
        // 紧接着重跑的情绪评估会基于新回复覆写出新的 buff/innerState。
        const skipEmotionInjection = !!opts?.skipEmotionInjection;
        const charForGen: CharacterProfile = skipEmotionInjection
            ? { ...char, buffInjection: '', activeBuffs: [] }
            : char;

        setIsTyping(true);
        setStreamingBubbles([]);
        setStreamingThinking('');
        setRecallStatus('');
        // 本轮的取消器 + 代次：旧轮残留先掐断（正常情况上轮已结束，这里是 no-op）。
        // 同一 hook 实例下切角色由上面的 char?.id effect 处理，这里只管"新一轮顶掉旧一轮"。
        turnAbortRef.current?.abort();
        const turnController = new AbortController();
        turnAbortRef.current = turnController;
        const turnSignal = turnController.signal;
        const genId = ++genRef.current;
        const turnAlive = () => genId === genRef.current;
        // 单轮全局 LLM 调用预算：各工具循环（MCD/Luckin/MCP 原生/正文）共享计数，
        // 防止多循环叠加烧穿（正常全流程远到不了上限，超限只可能是模型卡死循环）。
        let turnLlmCalls = 0;
        const TURN_LLM_BUDGET = 16;
        const spendLlmCall = () => {
            turnLlmCalls++;
            if (turnLlmCalls > TURN_LLM_BUDGET) throw new Error('[turn-budget] 本轮 LLM 调用超限已自动停止');
        };
        // 本轮是否产出过可见消息（B2 空回复判定用）：经统一提交漏斗落库的 assistant 消息才算。
        let turnProducedVisible = false;
        // 全局横幅「xx 正在回应…」（ChatBroadcast）。isTyping 等 UI 状态随 Chat 卸载
        // 一起销毁，但这个异步闭包会继续跑完并落库——横幅靠 window 事件与组件生命周期
        // 解耦，用户切走 Chat 也能看到生成还活着。finally 里派发 end（两条路径都经过）。
        announceChatGen(CHAT_GEN_EVENTS.replyStart, { charId: char.id, charName: char.name });

        // Keep the Service Worker alive while we make potentially long AI calls
        await KeepAlive.start();
        // MCP 结果记忆：本轮轮次 +1。一次完整回复（含全部工具循环）= 1 轮，
        // 结果按这个号留档（最近 N 轮窗口 + 手册类长期保存，见 mcpResultMemory）。
        const mcpTurnId = bumpMcpTurn(char.id);

        // 本轮的 amsg2 工具会话：角色一轮里可能连着排/取消多个任务，任务清单要在这一轮内
        // 累加，所以由 session 兜住最新 config，别从 char 快照上读写（char 是生成开始的
        // 那份，updateCharacter 不回写它）。finally 里打脏也要读它，所以声明在 try 外面。
        const amsg2Session = createAmsg2ToolSession({
            char, userProfile, groups, realtimeConfig, apiConfig, updateCharacter,
        });
        // 本轮里角色自己新排出来的任务。排程现状块每轮现算时靠它把这些点名标出来——不标
        // 的话角色分不清清单上哪条是自己刚排的，回头又排一条一模一样的。
        const amsg2CreatedThisTurn = new Set<string>();
        // 这一轮走的是即时对话、并且云端已经受理：收尾时不要再打脏重传一次 fire_pack。
        // POST 上去的那份就是权威的（还多带了 chat 段），再传一遍是同样内容白走一趟网络。
        let instantChatAccepted = false;
        // amsg2 工具在三个工具循环（麦当劳 / 瑞幸 / 通用）里都可能出现，执行方式完全一样，
        // 只有各自的 loopMessages 不同。
        const runAmsg2ToolCall = async (tc: any, fname: string, args: any, loopMessages: any[]) => {
            setSearchStatus(`正在执行：${fname}...`);
            const taskUuidsBefore = new Set(
                (amsg2Session.getConfig()?.tasks ?? []).map((t) => t.taskUuid),
            );
            const result = await executeAmsg2Tool(fname, args, amsg2Session);
            // 新增了哪几条不看工具回话（那是给模型读的散文），直接比对清单前后差异——
            // schedule 与 renew 都走这里，补发/替换出来的新任务一并算进去。
            for (const task of amsg2Session.getConfig()?.tasks ?? []) {
                if (!taskUuidsBefore.has(task.taskUuid)) amsg2CreatedThisTurn.add(task.taskUuid);
            }
            // 带上 name：Gemini 兼容层要求工具结果的 name 非空，缺了会被判 INVALID_ARGUMENT。
            loopMessages.push(buildToolResultMessage(tc, result) as any);
            setSearchStatus('');
        };

        try {
            const baseUrl = effectiveApi.baseUrl.replace(/\/+$/, '');
            const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${effectiveApi.apiKey || 'sk-none'}` };

            // ── 分段计时（从用户发送到 API 发出）──
            const perfSendT0 = performance.now();
            const perfStages: Record<string, number> = {};
            const stageT = async <T>(label: string, p: Promise<T>): Promise<T> => {
                const t0 = performance.now();
                try { return await p; }
                finally { perfStages[label] = Math.round(performance.now() - t0); }
            };

            // 0.9 历史消息加载：最大范围与记忆宫殿水位线彻底解耦。
            // adaptive 从 HWM 之后开始；manual 忽略 HWM 读取最近 N 条完整原文；
            // 用户断点只可在最大范围内继续收窄，越界后自动失效。
            const contextRange = char.id
                ? await stageT('dbHistory', loadCharacterContextRange(char).catch(e => {
                    console.error('Failed to load context range from DB, using React state:', e);
                    // 即便 DB 读取失败，降级路径也必须继续遵守水位线/拉杆硬上限，不能把 React
                    // 缓存里的更早消息意外送回模型。
                    return computeContextRangeSnapshot(
                        currentMsgs,
                        char,
                        getMemoryPalaceHighWaterMarkForContext(char.id),
                    );
                }))
                : null;
            if (contextRange?.userBreakpointExpired && updateCharacter) {
                updateCharacter(char.id, { contextUserStartMessageId: undefined });
            }
            const fullHistory = contextRange?.messages || null;
            const contextMsgs = fullHistory || currentMsgs;
            const limit = Math.max(1, fullHistory ? fullHistory.length : (char.contextLimit || 500));
            if (fullHistory) {
                console.log(`📊 [Context] Loaded ${fullHistory.length} msgs from DB (React state had ${currentMsgs.length}, mode=${contextRange?.mode}, maxStart=${contextRange?.maxRangeStartMessageId ?? 'none'}, effectiveStart=${contextRange?.effectiveStartMessageId ?? 'none'})`);
            }

            // 1. 构造完整 chat 请求载荷（memoryPalace 召回 + system prompt + 双语 / HTML / 思考链 / MCD + 历史）
            //    — 主动消息和 emotion eval 走的是同一个 helper，保证三家拿到的"材料"完全一致。
            const mcdMiniSnap = mcdMiniAppRef?.current;
            const mcdMiniOpen = !!mcdMiniSnap?.open;
            const mcdInheritMeta = mcdMiniOpen ? { fromMcdMiniApp: true } : undefined;
            const luckinMiniSnap = luckinMiniAppRef?.current;
            const luckinMiniOpen = !!luckinMiniSnap?.open;

            // ─── 即时对话的路由在构建 payload 之前就定下来 ───
            // 走云端的那份 prompt 不烤前端时效段（时钟/节日/天气/热搜/MCP 说明由 worker
            // fire 时独家供给），本地那份照旧全量。判定材料和下面的 payload.flags 同源：
            // luckinChatActive / mcdActive / luckinActive 就是由这三个值算出来的
            // （skipPromptBuild 那个 dev 开关下 flags 会整片置 false，那时只有这边的 ref 是准的）。
            // IP 还开着（脏配置）时让 IP 先走、按全量构建——别把剥过时效段的 prompt 交给 IP。
            //
            // Instant Push 配没配着，一回合只读这一次，下面所有用到的地方都吃这个值。
            // 从这里到真正分流之间隔着好几个 await（构建 payload、取 amsg2 任务现状…），
            // 期间用户在设置页存一次盘就能把它翻面；各读各的话会出现「按上云剥掉了时效段
            // 的 prompt，最后却交给了 IP 或落回本地」——两个钟的问题原样回来。
            const instantPushConfigured = isInstantConfigReady();
            const luckinChatOn = !!luckinChatRef?.current?.active;
            // 本机 / 内网的 MCP 服务器（docs/mcp-client.md 教用户填的 http://localhost:18061
            // 就是这一类）：上云那一轮前端不注入 MCP 说明块，而 worker 从 CF 那头连不上这类
            // 地址、上云清单里压根没有它——两边都不说，角色这一轮彻底不知道自己有工具。
            // 判据就一句话：这一轮上云会让角色掉能力，那就别上云。留在本地跑，工具照常用。
            // （地址够得着的服务器不受影响，照常上云，worker 自己跑后台 MCP。）
            const mcpWorkerUnreachable = hasWorkerUnreachableMcpServer(char.id);
            const instantChatVeto: string | null = luckinChatOn ? 'luckin-chat'
                : mcdMiniOpen ? 'mcd'
                    : luckinMiniOpen ? 'luckin'
                        : mcpWorkerUnreachable ? 'mcp-worker-unreachable' : null;
            // 带上 char：角色单独关了即时对话（reason char-disabled）时 ready 直接为
            // false，和「全局没开」同一待遇——下面那条 veto trace 的条件够不到它，
            // 静默走本地。那是用户的主动选择，每条消息刷一遍 warn 就成骚扰了。
            const instantChatReadiness = await resolveInstantChatReadiness(char);
            const instantChatOn = instantChatReadiness.ready;
            const instantChatRoute = instantChatOn && !instantChatVeto && !instantPushConfigured;
            // 「即时对话开着、这一轮却没上云」的所有情形都在这一处留痕，三种原因去向不同：
            //   · 点单流程否决：瑞幸/麦当劳是客户端交互式循环（选城市、确认单），云端接不了
            //     手，这一轮留在本地跑是对的；
            //   · MCP 地址 worker 够不着：同上，留在本地才有工具（见上面那段）；
            //   · IP 配置也还在（脏配置）：这一轮交给下面的 Instant Push 分支，它也不接的话
            //     （比如配了 MCP，在它的排除名单里）就一路落回本地。
            // 几个原因同时成立时报最前面那个——越靠前越具体，也更可能是用户真正想问的。
            // 不留痕的话，用户看到的是「开关亮着、消息照常出来」，查无可查——静默分流那个坑
            // 就是这么来的。这里只报不拦：拦不拦已经由 instantChatRoute 说了算。
            if (instantChatOn && !instantChatRoute) {
                const skipReason = instantChatVeto ?? 'instant-push-configured';
                console.warn(
                    skipReason === 'mcp-worker-unreachable'
                        ? '[AmsgInstantChat] 这一轮没上云（有 MCP 服务器填的是本机/内网地址，worker 够不着），本地生成，工具照常可用'
                        : instantChatVeto
                            ? `[AmsgInstantChat] 这一轮没上云（${instantChatVeto} 点单流程需要客户端交互），本地生成`
                            : '[AmsgInstantChat] 这一轮没走即时对话（Instant Push 配置仍在，脏配置）：交给 Instant Push，它也不接就落回本地',
                );
                appendInstantTraceEntry({
                    ts: new Date().toISOString(),
                    event: 'instant-chat-veto',
                    charId: char.id,
                    reason: skipReason,
                });
            } else if (instantChatReadiness.reason === 'worker-outdated' || instantChatReadiness.reason === 'worker-unreachable') {
                // 用户把开关开着，是我们判定这一轮上不了云才让位给本地生成的
                // （见 resolveInstantChatReadiness 的同名门）。上面那条 trace 的条件
                // （instantChatOn）在这里天然为假，所以单独留一条：这一档比别的更需要
                // 查得到——用户的主观意愿是「上云」，实际走的却是本地，不留痕就又是一次
                // 静默分流。拦不拦不用这里管，readiness 已经说了 not ready，
                // 下面照常走本地生成那条路。
                //
                // 两档分开记：worker-outdated 是「问到了、那台 Worker 确实跑不动」（该去更新），
                // worker-unreachable 是「这一刻够不着云端」（多半是网络，会自己好）。
                appendInstantTraceEntry({
                    ts: new Date().toISOString(),
                    event: instantChatReadiness.reason === 'worker-outdated'
                        ? 'instant-chat-worker-outdated'
                        : 'instant-chat-worker-unreachable',
                    charId: char.id,
                });
            } else if (instantChatReadiness.reason === 'config-unreadable') {
                // 配置根本没读出来（IndexedDB 被别的标签页 versionchange 卡住 / iOS 存储压力）。
                // 这不是「用户没开」：开关很可能开着，只是这一刻问不到。上面那条 trace 的条件
                // （instantChatOn）在这里天然为假，所以单独留一条，别让这种情形在观察窗里查无此事。
                // 点单流程否决 / Instant Push 配置还在（脏配置）时例外：配置就算读出来了这一轮
                // 也轮不到即时对话（去向由 veto / IP 分支决定），照原路走本就是对的，只留痕不拦。
                const configUnreadableFailsTurn = !instantChatVeto && !instantPushConfigured;
                appendInstantTraceEntry({
                    ts: new Date().toISOString(),
                    event: 'instant-chat-config-unreadable',
                    charId: char.id,
                    outcome: configUnreadableFailsTurn ? 'turn-failed' : 'other-route',
                });
                if (configUnreadableFailsTurn) {
                    // 悄悄退回本地直连生成的话：用户按「发完就自由」的心智随手锁屏，本地 fetch
                    // 被系统掐掉，回来时既没有回复也没有报错，设置页还写着「已开启」。所以和下面
                    // sendInstantChatTurn 没发出去同一口径：明确落系统消息 + 弹错，这一轮不发起
                    // 本地生成，用户稍后重发即可。**绝不静默退回本地生成**。收尾交给 finally
                    // （熄 isTyping / 熄「发送准备中」灯 / 停 KeepAlive），和那条失败路径同一段。
                    const reason = '即时对话暂时出了点问题：本地配置这一刻读不出来（可能是存储正忙）。这条没有发出去，稍等几秒重新发一次就好。';
                    console.warn('[AmsgInstantChat] 全局配置读不出来，开没开都不知道：这一轮明确报错等重发，不悄悄退回本地生成');
                    await DB.saveMessage({ charId: char.id, role: 'system', type: 'text', content: `[${reason}]` });
                    setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                    if (showError) showError('即时对话发送失败', reason);
                    else addToast(reason, 'error');
                    return;
                }
                console.warn('[AmsgInstantChat] 全局配置读不出来（开没开都不知道），但这一轮本就不走即时对话，照原路继续');
            }

            // 这一轮到底走了哪条路，播给输入框上方那条小提示。**每轮都发**，包括走成了云端
            // 那一轮（reason=null，提示自己收起来）——只在出问题时发的话，用户会一直盯着一条
            // 早就过期的提示，猜不出来「现在到底恢复了没有」。
            announceInstantChatRoute({
                charId: char.id,
                reason: instantChatRoute ? null : (instantChatReadiness.reason ?? null),
            });

            // ─── AIRP 导演（阶段一）────────────────────────────────────────────
            // 仅对开启 AIRP 的角色多跑一次导演 LLM：产出《演出指令》插进本轮 prompt。
            // 关闭（char.airp?.enabled 假）= 整段跳过，零额外调用，payload 与历史逐字一致。
            // 任何失败都只降级、绝不打断主聊天；工具执行只在 runAirpDirector 内部发生。
            let airpInstruction: string | undefined;
            airpDirectorOutputRef.current = undefined;
            if (char.airp?.enabled) {
                const extractMsgText = (content: any): string => {
                    if (typeof content === 'string') return content;
                    if (Array.isArray(content)) {
                        return content.map((part: any) => {
                            if (part?.type === 'text') return part.text || '';
                            if (part?.type === 'image_url') return '[图片]';
                            return '';
                        }).filter(Boolean).join(' ');
                    }
                    try { return JSON.stringify(content) ?? ''; } catch { return ''; }
                };
                try {
                    const airpTail = contextMsgs.slice(-8).map((m) => extractMsgText(m.content).slice(0, 500));
                    const latestUser = [...contextMsgs].reverse().find((m) => m.role === 'user');
                    const latestUserMessage = latestUser ? extractMsgText(latestUser.content) : '';
                    const snapshot = await buildAirpRuntimeSnapshot(char, { recentDialogueTail: airpTail });
                    const run = await runAirpDirector(
                        char,
                        { baseUrl, apiKey: effectiveApi.apiKey || 'sk-none', model: char.airp?.directorModel || effectiveApi.model },
                        snapshot,
                        latestUserMessage,
                        airpTail,
                        {
                            // 阶段一 ctx 刻意最小：接线的 recall/web_search/read_note 都不读 XHS 系列字段，
                            // 也就不把 XHS 缓存跟后处理共享（等 XHS 家族能力接线时再议）。
                            executor: createChatToolExecutor(dispatchAgenticTool, { char: charForGen, userProfile, realtimeConfig }, {
                                // 复用本轮的 amsg2 会话（不新建）：seenCalls 共享，导演与正文重复的排程调用会被同一道闸拦掉。
                                amsg2Execute: (toolName, args) => executeAmsg2Tool(toolName, args, amsg2Session),
                            }),
                        },
                    );
                    if (run.ok && run.output) {
                        const block = renderDirectorInstruction(run.output);
                        if (block) airpInstruction = block;
                        airpDirectorOutputRef.current = run.output;
                        if (isAirpDirectorTraceEnabled()) {
                            console.log('[airp] director ok', {
                                facts: snapshot.facts.length,
                                sceneGoal: run.output.sceneGoal,
                                replyIntent: run.output.replyIntent,
                                beats: run.output.beats.length,
                                toolIntents: run.output.toolIntents.length,
                                hasInstruction: !!block,
                            });
                        }
                    } else if (isAirpDirectorTraceEnabled()) {
                        console.warn('[airp] director degraded:', run.error);
                    }
                } catch (e) {
                    console.warn('[airp] snapshot/director degraded', e);
                }
            }

            const payload = await stageT('payload', buildChatRequestPayload({
                char: charForGen, userProfile, groups, emojis, categories,
                historyMsgs: contextMsgs,
                recentMsgsHint: currentMsgs,
                contextLimit: limit,
                realtimeConfig,
                airpInstruction,
                innerState: skipEmotionInjection ? undefined : (evolvedNarrative || undefined),
                userListeningContext: (() => {
                    if (music.current && music.playing && music.lyric.length > 0) {
                        const idx = music.activeLyricIdx;
                        if (idx >= 0) {
                            const from = Math.max(0, idx - 2);
                            const to = Math.min(music.lyric.length, idx + 2 + 1);
                            const window = music.lyric.slice(from, to).map(l => l.text);
                            return {
                                songName: music.current.name,
                                artists: music.current.artists,
                                lyricWindow: window,
                                activeIdx: idx - from,
                            };
                        }
                    }
                    if (music.current && music.playing) {
                        return {
                            songName: music.current.name,
                            artists: music.current.artists,
                            lyricWindow: [],
                            activeIdx: -1,
                        };
                    }
                    return null;
                })(),
                isListeningTogether: !!(music.current && music.playing && music.listeningTogetherWith.includes(char.id)),
                musicCfg: music.cfg,
                recentTrackChange: music.recentTrackChange,
                translationConfig,
                htmlMode: { enabled: !!(char as any).htmlModeEnabled, customPrompt: (char as any).htmlModeCustomPrompt },
                thinkingChain: { enabled: !!(char as any).showThinkingChain, customPrompt: (char as any).thinkingChainCustomPrompt },
                visionApiConfig: apiConfig.visionApi,
                mcdMiniSnap: mcdMiniOpen ? mcdMiniSnap : undefined,
                luckinMiniSnap: luckinMiniOpen ? luckinMiniSnap : undefined,
                luckinChat: luckinChatOn ? luckinChatRef?.current : undefined,
                timelyByWorker: instantChatRoute,
                recallEntryPoint: 'chat_app',
            }));
            const systemPrompt = payload.systemPrompt;
            const cleanedApiMessages = payload.cleanedApiMessages;
            const fullMessages = payload.fullMessages;
            try {
                const { captureCall } = await import('../utils/promptCallCapture');
                captureCall('chat-main', fullMessages, { charId: char?.id ?? '', label: '主聊天请求' });
            } catch { /* 抓取永不挡主链路 */ }
            const promptBuildSkipped = payload.flags.promptBuildSkipped;
            if (payload.flags.mcdActive) {
                console.log(`🍔 [MCD-MiniApp] 注入协同点餐上下文 step=${mcdMiniSnap?.step} cartItems=${mcdMiniSnap?.cart?.length || 0} menuItems=${mcdMiniSnap?.menuMeals ? Object.keys(mcdMiniSnap.menuMeals).length : 0} nutrition=${mcdMiniSnap?.nutritionData ? mcdMiniSnap.nutritionData.length : 0}字`);
            }
            if (payload.flags.luckinActive) {
                console.log(`☕ [Luckin-MiniApp] 注入协同点单上下文 step=${luckinMiniSnap?.step} cartItems=${luckinMiniSnap?.cart?.length || 0} menuItems=${luckinMiniSnap?.menuItems ? Object.keys(luckinMiniSnap.menuItems).length : 0}`);
            }
            const bilingualActive = payload.flags.bilingualActive;

            // Debug: Log context composition
            const systemPromptLength = systemPrompt.length;
            const historyMsgCount = cleanedApiMessages.length;
            const historyTotalChars = cleanedApiMessages.reduce((sum: number, m: any) => sum + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0);
            console.log(`📊 [Context Debug] system_prompt_chars=${systemPromptLength} | history_msgs=${historyMsgCount} | history_chars=${historyTotalChars} | total_msgs_in_array=${fullMessages.length} | contextLimit=${limit}`);

            // Save for dev debug viewer
            setLastSystemPrompt(systemPrompt);

            // 3. 情绪评估 (副 API). 直接复用已 build 好的 systemPrompt 和 cleanedApiMessages，确保情绪
            //    评估和主 API 看到的上下文完全一致；同时产出 innerState（意识流），注入下一轮 system prompt。
            //    未单独配置情绪 API 时回退到主 apiConfig。
            //    ── 路径分叉 ──
            //    - 本地 fetch 模式: 客户端 fire-and-forget 跑 eval (前端活着).
            //    - 上云模式 (Instant Push / 即时对话): 不在客户端跑, 改把 eval prompt + 副 API 凭据
            //      一起交给 worker, worker 跑完把结果推回来, 客户端 flush 时落 buff —— 这样前端被杀
            //      也算数, 且不会跟客户端 eval 双跑双扣费. 见下方两个上云分支 + activeMsgRuntime.
            const emotionEvalEnabled = !!(!promptBuildSkipped && !isEmotionEvalSkipped() && isScheduleFeatureOn(char) && char.emotionConfig?.enabled);
            // 这一轮的生成在云端跑（两条路互斥，见 instantChatRoute 的算法）。
            // instantPushConfigured 是路由判定处冻结的同一回合终值——这里绝不自己再读
            // 一次，否则可能「按上云模式把评估打包走了，实际却走本地」，情绪底色悄悄停更。
            const cloudGenRoute = instantPushConfigured || instantChatRoute;
            // 评估跟随全局流式开关（专用情绪 API 自带 stream 字段时以它为准）
            const evalStream: boolean = !!((effectiveApi as any).stream ?? apiConfig.stream ?? false);
            const emotionApi = emotionEvalEnabled
                ? ((char.emotionConfig!.api?.baseUrl)
                    ? { ...char.emotionConfig!.api!, stream: (char.emotionConfig!.api as any).stream ?? evalStream }
                    : { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model, stream: evalStream })
                : null;
            // 本地路径的情绪评估：主 fetch 发出后立即发射（见下方调用点）。
            // 历史备注：曾为串行中转做过 1.5s 错峰（评估抢跑会把主回复压后一个评估时长），
            // 用户侧已排查确认当前渠道无该并发问题，2026-07 应用户要求取消延迟。
            // 上云模式不受影响：worker 那边自己安排评估的时机。
            const fireLocalEmotionEval = (emotionEvalEnabled && !cloudGenRoute && emotionApi) ? () => {
                setEmotionStatus('evaluating');
                evaluateEmotionBackground(charForGen, userProfile, systemPrompt, cleanedApiMessages, emotionApi)
                    .then((innerState) => {
                        if (innerState) setEvolvedNarrative(innerState);
                    })
                    .finally(() => {
                        setEmotionStatus('');
                    });
            } : null;
            // 交给云端跑的那份评估配置。两条上云路径共用同一个形状（提示词模板 + 副 API 凭据），
            // 只是搭在各自请求体的不同位置上：Instant Push 放顶层 emotionEval 字段，
            // 即时对话放任务 metadata.amsgEmotionEval（那份走加密信封）。
            const cloudEmotionEval = (emotionEvalEnabled && cloudGenRoute && emotionApi)
                ? {
                    // includeContext=false: 不嵌 system prompt + 对话历史 (worker 复用本次请求的 messages 作前文),
                    // 把 emotionEval 块压到最小, 让请求体留在 keepalive 64KB 上限内 (关前端也能跑完).
                    prompt: await buildEmotionEvalPrompt(
                        charForGen, userProfile, systemPrompt, cleanedApiMessages, false,
                        shouldRequestAmbient(charForGen.id) ? buildAmbientEvalSection(charForGen) : ''
                    ),
                    api: { baseUrl: emotionApi.baseUrl, apiKey: emotionApi.apiKey, model: emotionApi.model },
                }
                : undefined;

            // 上云的情绪评估在 worker 跑 (副 API), 客户端看不到 LLM 调用时机, 但仍要给用户一个
            // "情绪更新中" 的可见信号 (header 徽章, 跟本地模式一致), 否则 "发送中" 消失后一片空白像死了.
            //
            // 正常的熄灭信号只有一个: worker 把结论推回来之后派发的 CHAT_GEN_EVENTS.emotionDone
            // (Chat 页的徽章和全局横幅各自监听, 都不依赖本 hook 存活 —— 用户切走 Chat 也能正常熄灭).
            // 剩下两种情况自己收场: 这一轮压根没发出去 —— 下面两个失败分支当场调
            // extinguishCloudEmotionBadge; 结论永远没回来 (worker 被杀 / 推送丢了 / 用户部署的是旧版)
            // —— 徽章的 setTimeout 和横幅的 TTL 同时到点, 两边用的是同一个数.
            //
            // 这个数按各自 worker 最长能跑多久给:
            //   · Instant Push: 一个请求里跑完就回, 90s 足够;
            //   · 即时对话: worker 那条 fire 的总时长上限是 INSTANT_TOTAL_TIMEOUT_MS（工具循环
            //     也算在内），评估结果又是跟着主回复的最后一条推送回来的——直接从 worker 模块
            //     import 那个数 + 一分钟推送在途余量，worker 侧调预算时这里自动跟上
            //     （ChatBroadcast 的横幅 TTL 同样从它推导，见那边注释）。
            const cloudEvalTimeoutMs = instantChatRoute ? INSTANT_TOTAL_TIMEOUT_MS + 60_000 : 90_000;
            /**
             * 熄灭「情绪更新中」的三件套：撤掉安全网、灭页内徽章、灭全局横幅。
             *
             * 这一轮没发出去时两个失败分支都要调它 —— 云端根本不会跑评估，那个正常的熄灭信号
             * 永远不会来。少调一处的表现是：徽章亮着直到安全网到点，然后弹一句
             * 「worker 可能是旧版」的提示，而真实原因是这条消息压根没发出去。
             */
            const extinguishCloudEmotionBadge = () => {
                clearCloudEmotionTimer(char.id);
                setEmotionStatus('');
                announceChatGen(CHAT_GEN_EVENTS.emotionEnd, { charId: char.id, charName: char.name });
            };
            if (cloudEmotionEval) {
                setEmotionStatus('evaluating');
                // 横幅这一条的存活上限跟徽章同一个数：不带的话横幅按自己那档默认值（本地评估的
                // 量级）扫，即时对话会出现「横幅先没了、徽章还亮着」，看着像出了两次故障。
                announceChatGen(CHAT_GEN_EVENTS.emotionStart, {
                    charId: char.id, charName: char.name, ttlMs: cloudEvalTimeoutMs,
                });
                // 布防按 charId 记进模块级 map。到点先看这一轮死没死透：即时对话的待收
                // 记录还在 = 云端还没给结论（worker 的 2/4/6 分钟重试梯子完全可能把合法
                // 回复拖过这个点）——这不是「无回音」，安静续期一小段再看，别抢在状态机
                // 前面宣判、把一个好端端的 worker 说成旧版让用户白重部署。待收记录没了
                // 而结论（emotionDone）一直没来，才是真的「跑完了但没人回音」。
                const charIdAtArm = char.id;
                const charNameAtArm = char.name;
                const armCloudEmotionSafetyNet = (delayMs: number) => {
                    clearCloudEmotionTimer(charIdAtArm);
                    cloudEmotionTimers.set(charIdAtArm, setTimeout(() => {
                        cloudEmotionTimers.delete(charIdAtArm);
                        if (instantChatRoute && getInstantChatPending(charIdAtArm)) {
                            armCloudEmotionSafetyNet(60_000);
                            return;
                        }
                        // 徽章只熄「布防那个角色」的：用户已切到别的角色时，这个 setter
                        // 管的是人家的徽章，不能碰。
                        if (currentCharIdRef.current === charIdAtArm) setEmotionStatus('');
                        // 超时无回音最常见的原因是用户部署的 worker 版本过旧（不支持情绪评估、
                        // 压根不会推结果回来），其次是 worker 被杀/推送丢失。过去这里
                        // 静默熄灯, 用户只看到「情绪永远不更新」—— 给一条可操作的提示。
                        announceChatGen(CHAT_GEN_EVENTS.emotionFailed, {
                            charId: charIdAtArm, charName: charNameAtArm,
                            reason: instantChatRoute
                                ? '云端情绪评估超时无回音——worker 可能是旧版（不支持情绪评估），请到 设置→主动消息 2.0 重新部署 worker 后重试'
                                : '云端情绪评估超时无回音——worker 可能是旧版（不支持情绪评估），请到 设置→Instant 消息设置 更新 worker 后重试',
                        });
                    }, delayMs));
                };
                armCloudEmotionSafetyNet(cloudEvalTimeoutMs);
            }

            // 发送前汇总计时
            const perfPreApi = Math.round(performance.now() - perfSendT0);
            const stageStr = Object.entries(perfStages)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => `${k}=${v}ms`)
                .join(' ');
            console.log(`⏱ [send→API] pre-API=${perfPreApi}ms | ${stageStr}`);

            // 3. API Call (safe parsing: prevents "Unexpected token <" on HTML error pages)
            // 温度 / 流式：优先读 effectiveApi（用户在设置里保存的值或预设值），
            // 缺省时回退到主 apiConfig，再回退默认值（temp=0.85, stream=false）。
            // safeResponseJson 已能透明拼接 SSE 响应，所以打开 stream 后无需改下游。
            const apiT0 = performance.now();
            const userTemp = (effectiveApi as any).temperature ?? apiConfig.temperature ?? 0.85;
            const userStream = (effectiveApi as any).stream ?? apiConfig.stream ?? false;
            const baseReqBody: any = {
                model: effectiveApi.model,
                messages: fullMessages,
                temperature: userTemp,
                max_tokens: 8000,
                stream: userStream,
            };
            // 预设套组采样参数（第 3 期）：active 套组配了 generation 就逐项覆盖，
            // 缺项回退上面的 API 设置。读取失败=无配置，零行为变化。
            // 思考链分支在下面仍会删采样参数（纪律不变）。
            try {
                const { getActivePackGeneration } = await import('../utils/presetKits');
                const { applyGenerationOverride } = await import('../utils/presetGeneration');
                const kitGen = await getActivePackGeneration();
                if (kitGen) {
                    const genBase: Record<string, number> = {};
                    for (const k of ['temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty', 'max_tokens']) {
                        if (typeof baseReqBody[k] === 'number') genBase[k] = baseReqBody[k];
                    }
                    Object.assign(baseReqBody, applyGenerationOverride(genBase, kitGen));
                }
            } catch (e) {
                console.warn('[PresetKit] generation override skipped:', e);
            }
            // 思考过程展示开启时显式向后端请求 extended thinking。
            // 不同代理认不同入口，全都试一遍，代理不识别的会自动忽略：
            //  - 模型名 -thinking 后缀：packycode / anyrouter 等第三方 Claude 中转的主流约定
            //  - thinking.type='enabled' / budget_tokens：Anthropic 原生与多数官方代理
            //  - reasoning_effort：OpenAI 系（o1/o3、GLM-4.5、deepseek-reasoner 等）
            //  - extra_body.thinking：LiteLLM 系桥
            // 关掉则一个都不传，避免无谓的 thinking token 计费。
            // ⚠️ 工具模式(瑞幸点单/麦当劳)下绝不带 thinking/reasoning 参数: "thinking + tools" 同发
            //    Gemini 等会直接 400 INVALID_ARGUMENT —— 表现就是"开了思考链的角色一点单就报错,
            //    换个没开思考链的角色就好"。工具循环优先, 思考链这一轮让步。
            const toolModeActive = payload.flags.luckinChatActive || payload.flags.mcdActive || payload.flags.luckinActive || payload.flags.mcpChatActive;
            // 主动消息 2.0 的工具本轮会不会注入：thinking 门要先知道这件事（工具在下面才真正
            // 拼进 tools，但参数取舍必须现在就定）。角色级开关关掉的不注入——否则被用户显式
            // 关掉的功能会被角色一次工具调用重新打开。
            const amsg2ToolsInjected = isAmsg2EnabledForChar(char) && await isAmsg2GlobalReady();
            const btToolsInjected = bleEngine.hasConnectedDevice() && realtimeConfig?.bluetoothEnabled !== false;
            if (shouldSendThinkingParams({
                thinkingActive: !!payload.flags.thinkingActive,
                legacyToolModeActive: !!toolModeActive,
                amsg2ToolsInjected,
                btToolsInjected,
                model: baseReqBody.model || '',
            })) {
                const m: string = baseReqBody.model || '';
                if (/^claude-/i.test(m) && !/-thinking$/i.test(m)) {
                    baseReqBody.model = `${m}-thinking`;
                }
                baseReqBody.thinking = { type: 'enabled', budget_tokens: 4000 };
                baseReqBody.reasoning_effort = 'medium';
                baseReqBody.extra_body = { ...(baseReqBody.extra_body || {}), thinking: { type: 'enabled', budget_tokens: 4000 } };
                // 开思考时不要带采样参数: Claude 系（含各种中转 claude-*）在 thinking 启用时
                // 只接受 temperature=1，传 0.85 会被 400 ("temperature may only be set to 1 when
                // thinking is enabled")。删掉让服务端用默认即可——对其它模型(非 Claude)也安全:
                // 它们开思考时同样不需要我们指定温度，回退默认不影响行为。
                delete baseReqBody.temperature;
                delete baseReqBody.top_p;
            }
            // 流式时显式要求 usage 统计随末尾 chunk 一起返回，否则 token 徽标拿不到数据
            if (userStream) {
                baseReqBody.stream_options = { include_usage: true };
            }
            // 小程序模式: 给 LLM 一个 UI 钩子工具 propose_cart_items, 推荐时可调用,
            // 工具不真改购物车也不调 MCP, 只是把推荐渲染成 + 加按钮卡片让用户决定
            if (payload.flags.mcdActive) {
                baseReqBody.tools = [MCD_PROPOSE_TOOL];
                baseReqBody.tool_choice = 'auto';
            } else if (payload.flags.luckinActive) {
                baseReqBody.tools = [LUCKIN_PROPOSE_TOOL];
                baseReqBody.tool_choice = 'auto';
            } else if (payload.flags.luckinChatActive) {
                // 瑞幸聊天点单: 给角色真实 8 个 MCP 工具, 自己去查门店/搜商品/定规格/算价
                const luckinTools = await fetchOpenAIToolsForLuckin();
                if (luckinTools && luckinTools.length) {
                    baseReqBody.tools = luckinTools;
                    baseReqBody.tool_choice = 'auto';
                }
            }
            // MCP 调用策略设置（生成开始时读一次本轮不变）：次数上限 / 结果保留轮次 / 懒加载。
            const mcpSettings = loadMcpSettings();
            // 通用 MCP: 用户自配服务器的已发现工具, 追加而不覆盖(可与瑞幸/麦当劳共存)。
            // 工具清单读的是设置里持久化的发现结果, 不发网络请求。
            // 懒加载设置在生成开始时读一次（mcpSettings），展开重填用的 resolve 原样复用。
            let mcpToolResolve: ReturnType<typeof buildMcpOpenAITools>['resolve'] | null = null;
            if (payload.flags.mcpChatActive) {
                const { tools: mcpTools, resolve } = buildMcpOpenAITools(char.id, {
                    lazy: mcpSettings.lazyLoad,
                });
                if (mcpTools.length) {
                    mcpToolResolve = resolve;
                    const mcpOnly = !payload.flags.luckinChatActive && !payload.flags.mcdActive && !payload.flags.luckinActive;
                    if (!getMcpUseNativeTools() && mcpOnly) {
                        // 用户已明确判断当前模型/中转不支持 tools：首轮直接走正文兼容模式。
                        // 兼容模式不带 tools 参数，懒加载 stub 无意义，签名清单用完整 schema。
                        const compatibilityBody = buildMcpRejectedToolsFallbackBody({
                            ...baseReqBody,
                            tools: buildMcpOpenAITools(char.id).tools,
                            tool_choice: 'auto',
                        });
                        baseReqBody.messages = compatibilityBody.messages;
                    } else {
                        baseReqBody.tools = [...(baseReqBody.tools || []), ...mcpTools];
                        if (!baseReqBody.tool_choice) baseReqBody.tool_choice = 'auto';
                    }
                }
            }
            // 链接分享「按需读片段」（执行卡 t_75dd49a5）：只有「本轮上下文里真有分享卡」+「前端总开关
            // 开着」才注入 read_share_excerpts。模型能看到的卡片集合就是这里从 contextMsgs 推出来的那份，
            // 执行时也只认这份集合（不接受模型指定的任意 URL/contentId）。
            // 关掉时（默认）什么都不做：工具清单与集成前一致。
            const shareCfg = readSocialShareConfig();
            const shareEndpoint = isSocialShareEnabled(shareCfg) ? resolveShareEndpoint(shareCfg) : null;
            // 预算对象跟着这一轮走：工具循环里多次模型迭代、同批多个调用共享同一份，不重置。
            let shareExcerptTurn: ShareExcerptTurn | null = shareEndpoint
                ? createShareExcerptTurn(contextMsgs, { endpoint: shareEndpoint })
                : null;
            // 一张能读的卡都没有（全是解析中/失败）时不注入：只给一个注定报错的工具没有意义。
            if (shareExcerptTurn && !hasReadableShareExcerptTarget(shareExcerptTurn)) shareExcerptTurn = null;
            if (shareExcerptTurn) {
                baseReqBody.tools = [...(baseReqBody.tools || []), buildShareExcerptsTool()];
                if (!baseReqBody.tool_choice) baseReqBody.tool_choice = 'auto';
            }
            // 主动消息 2.0 本地工具：worker 已配置 + 角色没关掉时注入 schedule/cancel/renew/list，
            // 并注入「排程现状」背景块（常驻能力简介 + 进行中任务 + 作废待处理，角色自行判断怎么接）。
            // 是否注入在上面 thinking 门那里就算好了（amsg2ToolsInjected）。
            // amsg2 和 Instant Push 在设置页已经是双向互斥，正常情况下不可能两个都开，
            // 这里不需要额外判断（下面的 Instant Push 分支只为历史配置兜底保留）。
            let amsg2ExpiredIds: string[] = [];
            let amsg2Notices: Amsg2ExpiredNoticeRecord[] = [];
            // P5 生活工作流：角色可以在正常聊天里顺带提一条「之后想为自己做的小事」。
            //
            // 注入条件是**设置终值**（自主开着 + 写入总闸开着 + 至少一类白名单动作被放行），
            // 与后台调度/到点执行读的是同一份权限代理；模型说的话不参与这个判定。
            // 工具本身不带正文、不带网址/工具名/权限字段——正文由后台那次独立请求生成。
            // sourceRef 锚在**这一轮真实用户消息 id** 上（不是时间戳）：服务端据此去重/溯源，
            // 「这条计划是哪句话引出的」才追得回来。拿不到 id 才退回时间戳（旧消息/导入数据）。
            const latestUserMsgRef = [...contextMsgs].reverse()
                .find((m) => m.role === 'user' && typeof (m as { id?: unknown }).id === 'number') as { id?: number } | undefined;
            const lifeWorkflowSourceRef = latestUserMsgRef?.id != null
                ? `chat:${char.id}:m${latestUserMsgRef.id}`
                : `chat:${char.id}:t${Date.now().toString(36)}`;
            const chatLifeWorkflowToolsInjected = chatLifeWorkflowAvailability(mergeAutonomySettings(char)).allowed;
            if (chatLifeWorkflowToolsInjected) {
                baseReqBody.tools = [...(baseReqBody.tools || []), ...CHAT_LIFE_WORKFLOW_TOOLS];
                if (!baseReqBody.tool_choice) baseReqBody.tool_choice = 'auto';
            }
            if (amsg2ToolsInjected) {
                baseReqBody.tools = [...(baseReqBody.tools || []), ...AMSG2_TOOLS];
                if (!baseReqBody.tool_choice) baseReqBody.tool_choice = 'auto';
                try {
                    // 回执这半边是「检出 + 落台账」的结果，带副作用，一轮只算一次；
                    // 进行中任务那半边每次发请求现取（见下面的 withAmsg2TaskContext）。
                    const taskContext = await collectAmsg2TaskContext(char, userProfile.name);
                    amsg2ExpiredIds = taskContext.expiredIds;
                    amsg2Notices = taskContext.notices;
                } catch (e) {
                    // 挂掉的只是作废回执这半边（它要读历史消息和台账）。进行中清单在内存里，
                    // 照常渲染——角色至少知道自己名下有哪些任务，不至于一问三不知再排一条。
                    console.warn('[amsg2] 作废回执检出失败，本轮只带进行中清单', e);
                }
            }
            // 蓝牙工具：真有已连接的 BLE 设备时才注入，零成本保持沉默。
            if (btToolsInjected) {
                baseReqBody.tools = [...(baseReqBody.tools || []), ...BT_TOOLS];
                if (!baseReqBody.tool_choice) baseReqBody.tool_choice = 'auto';
            }

            /**
             * 把排程现状块贴到 messages 末尾，每次发请求都按「此刻」的任务清单现算。
             *
             * 不写死进 baseReqBody.messages、也不进 loopMessages，是因为工具循环里角色会
             * 边聊边排：写死的话第二轮起看到的是**排程前**那份空清单，跟工具刚回的「已创建」
             * 打架，角色于是把同一条再排一遍；攒进历史的话则是好几份互相矛盾的旧清单叠着。
             * 现算 + 只留一份，角色每轮读到的都是自己名下真实的任务，本轮刚排的还会被点名。
             */
            const withAmsg2TaskContext = (messages: any[]): any[] => {
                if (!amsg2ToolsInjected) return messages;
                const now = Date.now();
                const text = buildAmsg2TaskContextText(
                    getPendingTasks(amsg2Session.getConfig(), now),
                    amsg2Notices,
                    now,
                    resolveCharTimeZone(char),
                    amsg2CreatedThisTurn,
                    userProfile.name,
                );
                // 常驻简介让这一块总是非空：没任务时角色也得知道自己随时能排。
                const block = { role: 'system', content: text };
                // 插在易变尾段**之前**，不贴数组尾巴：「回到你自己」钢印焊在 volatileTail 末尾，
                // 靠 recency 抢模型开口前的最后一眼；一份带 promptHint 原文的清单摆在它后面，
                // 排在今晚的事会被当成本轮就该催的事（「书看到哪了」每轮问一遍的由来）。
                // 插入点在本轮用户消息之后，前缀缓存的断点更靠前，命中率一个 token 都不受影响。
                // 工具循环的 loopMessages 是 baseReqBody.messages 追加尾巴，前缀没动，下标照用。
                return insertAmsg2TaskContextBlock(messages, block, payload.volatileTailIndex);
            };

            // ─── Instant Push 分支 ───
            // 与本地 fetch 对称：sendInstantPushAndAwaitReply 内部完成 sub 获取 / push 监听 /
            // 300s 超时兜底，返回时 push 已落库（或失败）。外层 finally 统一清 isTyping /
            // KeepAlive / 跑 memory palace 后处理，与本地路径完全对齐。
            // worker 端跑完 LLM → push → SW → activeMsgRuntime.flushInboxToChat 写 DB 并刷 UI。
            // 瑞幸聊天点单 / 麦当劳 / 瑞幸小程序 这些"客户端工具循环"模式必须走本地 fetch:
            // instant push 会把请求交给 worker 并在这里提前 return, 工具循环(callLuckinTool 等)根本跑不到,
            // 表现就是"选了城市也没用 / 角色不下单"。这些模式下跳过 instant push, 用本地 fetch 跑工具循环。
            // 双向互斥后理论上到不了：走到这条 trace 说明两边开关同时亮着（脏配置），当断言告警看。
            const AMSG2_SUPPRESSED_TRACE = 'amsg2-suppressed-by-instant';
            if (instantPushConfigured && !payload.flags.luckinChatActive && !payload.flags.mcdActive && !payload.flags.luckinActive && !payload.flags.mcpChatActive) {
                // 走这条路 = 上面那段 amsg2 的工具、排程现状块都白拼了（instant 发的是原始
                // fullMessages、请求体不带 tools），下面的活跃会话租约也不会开。三样都是静默
                // 失效，留一条 trace 让观察窗看得见，别让人对着「功能不响」凭空排查。
                if (amsg2ToolsInjected) {
                    appendInstantTraceEntry({ ts: new Date().toISOString(), event: AMSG2_SUPPRESSED_TRACE });
                }
                const instantResult = await sendInstantPushAndAwaitReply({
                    contactName: char.name,
                    messages: fullMessages as InstantPushPayload['messages'],
                    apiUrl: effectiveApi.baseUrl,
                    apiKey: effectiveApi.apiKey,
                    primaryModel: effectiveApi.model,
                    maxTokens: 8000,
                    temperature: userTemp,
                    // amsg-instant 0.6+ 端 validateAvatarUrl 拒 data: / >2KB,
                    // 这里按 contract 只传 https URL, data URL 本地头像直接不传
                    // (SW 显示通知时回退到默认 app icon, 不影响推送成功率).
                    avatarUrl: /^https?:\/\//i.test(char.avatar || '') ? char.avatar : undefined,
                    metadata: { source: 'sullyos-chat', charId: char.id },
                    // 副 API 情绪评估: worker 跑完主回复后用这套跑 eval, 推 emotion_update 回来 (见 worker 包装层).
                    // 放顶层字段, 不进 metadata —— 框架不会回显它, 副 API apiKey 不会泄进 push.
                    ...(cloudEmotionEval ? { emotionEval: cloudEmotionEval } : {}),
                }, char.id, undefined, onInstantPosted);
                if (!instantResult.ok && instantResult.outcome !== 'cancelled') {
                    // 长报错 (worker 400 校验信息 + CF 错误页可能很长) 走弹窗, 手机用户能
                    // 看清并复制反馈; 没注入 showError 时降级到 toast.
                    // 完整诊断由 instantPushClient 的 formatDiagnostics 输出 —— 涵盖
                    // http (status/bodyBytes/keepalive/cf-ray/response 截断) / fetchError /
                    // config / subscription / timeout / context / env 各段, 已主动 mask
                    // worker / api host, 不含 apiKey / apiUrl / workerUrl / push endpoint.
                    //
                    // 'cancelled' = pagehide / signal abort, caller 自己取消的, 不弹错。
                    const errMsg = instantResult.error || '未知错误';
                    if (showError && instantResult.diagnostics) {
                        showError(
                            'Instant Push 发送失败',
                            formatDiagnostics(instantResult.diagnostics, {
                                outcome: instantResult.outcome,
                                reason: errMsg,
                            }),
                        );
                    } else if (showError) {
                        showError('Instant Push 发送失败', `outcome: ${instantResult.outcome}\nreason: ${errMsg}`);
                    } else {
                        addToast(`Instant Push: ${errMsg}`, 'error');
                    }
                }
                // 发送失败/取消 → worker 不会跑情绪评估，那个正常的熄灭信号永不到达，当场自己熄。
                if (!instantResult.ok && cloudEmotionEval) extinguishCloudEmotionBadge();
                return;
            }

            // ─── 即时对话（主动消息 2.0 云端生成）分支 ───
            // 和上面的 Instant Push 对称：这一轮的上下文 + 任务一个 POST 上云，云端跑完
            // 走推送回来（收件箱同一条管线入库），客户端发完那一刻就自由了。
            // 设置页那道门已经把两条路做成双向互斥，正常情况下不可能两个都开；
            // 上面的 Instant Push 分支只为历史配置兜底保留。
            //
            // 走不走这条路，构建 payload 之前的 instantChatRoute 已经算完了，这里只认它
            // 一个值：「这份 prompt 剥没剥时效段」和「这一轮走不走云端」必须是同一个判断，
            // 各算各的话两边总有一天会不同意，剥过的那份 prompt 就落到别的路上去了。
            // 没上云的那些情形（点单否决 / IP 配置也还在）在那一段里已经报过 trace，
            // 这边不重复报，也不重复拦。
            //
            // MCP 刻意不在排除名单里：worker fire 时自己解析 tool_config、自己跑后台
            // MCP（这次 POST 顺手把配置传上去了），云端答得了。排掉它的话，只要全局配着
            // 一台 enabled 的 MCP 服务器，即时对话就永远静默走回本地——设置页亮着
            // 「已开启」、界面毫无异样，正是 instant push 静默分流那个坑的复刻。
            if (instantChatRoute) {
                // 作废回执跟着 chat 段上云：检出（collectAmsg2TaskContext，带落台账的副作用）
                // 在上面已经跑过了，本地路径靠 withAmsg2TaskContext 注入的排程清单和能力
                // 简介到点由 worker 的 instant timely block 现算现渲，唯独回执云端没有——
                // 只把这一样单独成块贴上，不带清单不带简介，别和到点渲染的那份撞车。
                const amsg2NoticesBlock = amsg2ToolsInjected && amsg2Notices.length
                    ? buildAmsg2NoticesText(amsg2Notices, resolveCharTimeZone(char), userProfile.name)
                    : null;
                const instantChatResult = await sendInstantChatTurn({
                    char,
                    // 云端要发给模型的就是本地这一份，一个字不改（见 fire_pack 的 chat 段）。
                    chatMessages: (amsg2NoticesBlock
                        ? [...fullMessages, { role: 'system', content: amsg2NoticesBlock }]
                        : fullMessages) as Array<{ role: string; content: unknown }>,
                    // 凭据用本地这一轮的那份：换成别的等于同一句话由不同模型来答，而用户看不出来。
                    // model / temperature 取 baseReqBody 的终值而不是 effectiveApi 的原始值：
                    // 上面那段已经按本地规则把 thinking 后缀（claude 系 -thinking）拼好、
                    // 开思考时把温度删掉了——云端要的就是「本地这一轮会发出去的那份」。
                    api: { baseUrl: effectiveApi.baseUrl, apiKey: effectiveApi.apiKey, model: baseReqBody.model },
                    ...(typeof baseReqBody.temperature === 'number' ? { temperature: baseReqBody.temperature } : {}),
                    maxTokens: baseReqBody.max_tokens,
                    // 思考链三件套同理取终值：shouldSendThinkingParams 通过时本地会带
                    // thinking / reasoning_effort / extra_body 三个入口（不同代理认不同的），
                    // 云端不带的话，凡是靠请求体参数激活思考的渠道（Anthropic 原生、
                    // OpenAI 系、LiteLLM 桥——即除了 -thinking 模型名后缀之外的全部）
                    // 一开即时对话思考就静默消失，心象卡片跟着没了。
                    ...(baseReqBody.thinking || baseReqBody.reasoning_effort || baseReqBody.extra_body
                        ? {
                            extraBody: {
                                ...(baseReqBody.thinking ? { thinking: baseReqBody.thinking } : {}),
                                ...(baseReqBody.reasoning_effort ? { reasoning_effort: baseReqBody.reasoning_effort } : {}),
                                ...(baseReqBody.extra_body ? { extra_body: baseReqBody.extra_body } : {}),
                            },
                        }
                        : {}),
                    userProfile, groups, realtimeConfig,
                    // 情绪评估也交给云端：worker 到点和主回复并行跑，结果随最后一条推送回来
                    // （见 worker/amsg/src/emotionEval.ts）。放在这里而不是本地 fire 一枪，
                    // 是因为用户发完就能关页面——留在本地的话，页面一关情绪底色就停更了。
                    ...(cloudEmotionEval ? { emotionEval: cloudEmotionEval } : {}),
                });
                if (instantChatResult.ok) {
                    // 这次 POST 已经把权威的那份 fire_pack 传上去了，收尾不必再打脏重传一遍。
                    instantChatAccepted = true;
                    // 202 只说明云端收下了，不说明角色真的读到过这些回执：那一轮可能空输出被
                    // 判 skip-push，也可能 fire 重试打光标 failed。所以这里只记账不销账，等回复
                    // 真的落库那一刻（activeMsgRuntime 认末段到齐）再调
                    // settleInstantChatExpiredNotices 写 notifiedAt；这一轮没成的话
                    // failInstantChatPending 会把它们退回未告知，下一轮重新注入。
                    // 本地路径同一口径：回复 applyAssistantPostProcessing 落库之后才标记。
                    if (amsg2ExpiredIds.length && instantChatResult.uuid) {
                        stageInstantChatExpiredNotices(char.id, instantChatResult.uuid, amsg2ExpiredIds);
                    }
                } else {
                    // 没发出去就是没发出去：明确落一条系统消息 + 弹错，用户可以直接重发。
                    // **绝不静默退回本地生成** —— 静默分流那种查无可查的坑踩过一次就够了。
                    const reason = instantChatResult.error || '未知错误';
                    await DB.saveMessage({ charId: char.id, role: 'system', type: 'text', content: `[${reason}]` });
                    setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                    if (showError) showError('即时对话发送失败', reason);
                    else addToast(reason, 'error');
                    // 没发出去 → 云端不会跑评估，那个正常的熄灭信号永不到达。当场自己熄，
                    // 否则「情绪更新中」要一直亮到 11 分钟后安全网到点。
                    if (cloudEmotionEval) extinguishCloudEmotionBadge();
                }
                return;
            }

            // 流式预览：仅在用户开了 stream、且非工具/双语模式时启用。
            // 工具模式的首轮响应可能是 tool_calls（无正文可预览）；双语模式正文包在
            // 跨行 <翻译> 标签里。这两类连正文/思考钩子都不挂，完整走原有整包路径。
            // 语音、日记、HTML 等由内容标签动态识别，computeStreamPreviewBubbles 会扣住控制块，
            // 只允许标签外确实属于普通文字的部分预览。
            // 每次 onDelta 基于累计全文全量重算（safeFetchJson 重试会重开流，天然重置）；
            // 正文尾句和思考内容只在累计文本确实变化时触发重渲染。
            const streamUiEligible = !!userStream && !toolModeActive && !bilingualActive;
            const streamPreviewEligible = streamUiEligible;
            const streamThinkingEligible = streamUiEligible && payload.flags.thinkingActive;
            // 预览真的上过屏才置 true → 后处理落库时跳过拟人打字延迟（instantRender），
            // 否则用户会看到"预览气泡收回去、再一条条慢慢重弹"的二次播放。
            let streamPreviewShown = false;
            let streamThinkingShown = false;
            let latestStreamPreviewBubbles: string[] = [];
            let latestNativeReasoning = '';
            let latestEmbeddedThinking = '';
            const publishStreamingThinking = () => {
                const combined = [latestNativeReasoning, latestEmbeddedThinking]
                    .map(text => text.trim())
                    .filter(Boolean)
                    .join('\n\n');
                if (combined) streamThinkingShown = true;
                setStreamingThinking(prev => prev === combined ? prev : combined);
            };
            const streamHooks = (streamPreviewEligible || streamThinkingEligible) ? {
                onDelta: (_delta: string, fullText: string) => {
                    if (streamPreviewEligible) {
                        const bubbles = computeStreamPreviewBubbles(fullText);
                        latestStreamPreviewBubbles = bubbles;
                        if (bubbles.length > 0) streamPreviewShown = true;
                        setStreamingBubbles(prev =>
                            (prev.length === bubbles.length && prev.every((b, i) => b === bubbles[i])) ? prev : bubbles
                        );
                    }
                    if (streamThinkingEligible) {
                        latestEmbeddedThinking = extractStreamingEmbeddedThinking(fullText);
                        publishStreamingThinking();
                    }
                },
                onReasoningDelta: (_delta: string, fullReasoning: string) => {
                    if (!streamThinkingEligible) return;
                    latestNativeReasoning = fullReasoning;
                    publishStreamingThinking();
                },
            } : undefined;

            // 主请求即将发出 → 立即并行发射情绪评估（错峰延迟已按用户要求取消，见定义处注释）。
            fireLocalEmotionEval?.();

            // 同角色活跃会话租约：本地 fetch 路径本轮真实消息已落库、模型请求即将发出，
            // 启动心跳告诉 worker「正在和这个角色聊」——到点的 expire AI 任务据此 skip，
            // 别在用户正聊时又弹主动消息。instant push 路径在上方已 return，天然不重复开 lease。
            // 只对已排程 AI 任务的角色开租约：其余角色没有 worker 消费，开了纯浪费还刷 warn。
            const amsg2Cfg = char.activeMsg2Config;
            if (amsg2Cfg?.enabled && hasActiveAiTask(amsg2Cfg)) {
                startAmsgChatPresence(char.id, getLastRealUserMessageAt(contextMsgs));
            }

            let data: any;
            const turnStartedAt = Date.now();
            try {
                spendLlmCall();
                data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                    method: 'POST', headers, signal: turnSignal,
                    body: JSON.stringify(observeFinalChatRequest(char.id, baseUrl, { ...baseReqBody, messages: withAmsg2TaskContext(baseReqBody.messages) }))
                }, 2, 0, { appName: '消息', charId: char.id, charName: char.name, purpose: '聊天回复' }, streamHooks);
            } catch (e) {
                let requestError: unknown = e;
                const attemptedBody = {
                    ...baseReqBody,
                    messages: withAmsg2TaskContext(baseReqBody.messages),
                };
                // 部分第三方 OpenAI→Claude 中转会把请求形状不兼容包装成 502
                // bad_response_status_code：thinking 三种方言、tools、尾部 system 单独都能收，
                // 组合在一起却在上游适配层失败。只对这一条高度特征化的 502 降级一次：
                // tools 和正文完整保留，system 合到开头，thinking 参数让步。普通网络 502、
                // 非 Claude、没工具的请求一律不重发，避免无依据地重复计费。
                if (shouldRetryClaudeProxyCompatibility(requestError, attemptedBody)) {
                    console.warn('🧩 [Claude compat] 中转拒绝 thinking + tools 组合，使用兼容请求体重试一次');
                    try {
                        spendLlmCall();
                        data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                            method: 'POST', headers, signal: turnSignal,
                            body: JSON.stringify(observeFinalChatRequest(char.id, `${baseUrl}:claude-compat`, buildClaudeProxyCompatibilityBody(attemptedBody))),
                        }, 0, 0, { appName: '消息', charId: char.id, charName: char.name, purpose: 'Claude 中转兼容重试' }, streamHooks);
                        requestError = null;
                    } catch (compatError) {
                        requestError = compatError;
                    }
                }

                if (!requestError) {
                    // Claude 兼容重试已成功，继续走下方统一后处理。
                } else {
                // 仅通用 MCP、且没有和其他工具模式混用时降级。部分 OpenAI 兼容中转
                // 会对携带 tools 的请求直接回 4xx，而不是忽略参数；去掉 tools 后让
                // 现有正文假调用容错接手。真实鉴权失败会在这次重试中再次抛出原样错误。
                // 「只有 MCP」还要求真的注入了 MCP 工具（mcpToolResolve）：只开了开关但没配服务器时
                // 这一轮实际只有别的工具在场，不能按 MCP 兼容模式处理。
                const mcpOnly = payload.flags.mcpChatActive && !!mcpToolResolve
                    && !payload.flags.luckinChatActive && !payload.flags.mcdActive && !payload.flags.luckinActive;
                // 只注入了分享片段工具的轮次同理：中转不认 tools 时这一轮退回无工具继续聊，
                // 别让整轮回复因为多了一个工具直接 400。
                const shareToolOnly = !mcpOnly && !!shareExcerptTurn
                    && !payload.flags.luckinChatActive && !payload.flags.mcdActive && !payload.flags.luckinActive;
                const toolsRejected = !!baseReqBody.tools?.length && shouldRetryMcpWithoutTools(requestError);
                if ((!mcpOnly && !shareToolOnly) || !toolsRejected) throw requestError;
                console.warn(mcpOnly
                    ? '🔌 [MCP] 当前中转拒绝 tools 请求，降级为正文工具调用兼容模式'
                    : '🔗 [分享] 当前中转拒绝 tools 请求，这一轮不注入 read_share_excerpts');
                // 这条路把 tools 全删了，角色排不了新任务；排程现状照样要带——它得知道
                // 自己名下已经有哪些承诺，否则又会在正文里许一遍。
                const fallbackBody = mcpOnly
                    ? buildMcpRejectedToolsFallbackBody({
                        ...baseReqBody,
                        messages: withAmsg2TaskContext(baseReqBody.messages),
                    })
                    : buildMcpTextFallbackBody(
                        { ...baseReqBody, messages: withAmsg2TaskContext(baseReqBody.messages) },
                        withAmsg2TaskContext(baseReqBody.messages),
                    );
                // 这一轮没有分享片段工具了：明确告诉模型不要假装读过片段，只基于卡片简介回答。
                if (shareToolOnly) {
                    shareExcerptTurn = null;
                    fallbackBody.messages = [
                        ...(fallbackBody.messages || []),
                        { role: 'system', content: '这一轮外部工具不可用：不要声称读过分享片段，基于卡片里已有的简介回答。' },
                    ];
                }
                // 同一轮还注入了主动消息 2.0 排程工具时，它们也随 tools 一起被删了；按本文件既有的
                // 「宁可它不提，也不能它用正文假装登记成功」原则补一句，别让角色在这一轮许下提醒/取消。
                if (shareToolOnly && amsg2ToolsInjected) {
                    fallbackBody.messages = [
                        ...(fallbackBody.messages || []),
                        { role: 'system', content: '这一轮排程工具不可用：不要声称已经记下、修改或撤销任何提醒/安排。' },
                    ];
                }
                // 这条路把 tools 全删了，生活工作流工具也不在：明确告诉模型这一轮没有可用工具，
                // 不要声称「已经记下/撤销」。宁可它不提，也不能让它用正文假装登记成功。
                if (chatLifeWorkflowToolsInjected) {
                    fallbackBody.messages = [
                        ...(fallbackBody.messages || []),
                        { role: 'system', content: '这一轮没有可用工具：不要声称已经记下或撤销任何安排。' },
                    ];
                }
                spendLlmCall();
                data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                    method: 'POST', headers, signal: turnSignal,
                    body: JSON.stringify(fallbackBody)
                }, 0, 0, { appName: '消息', charId: char.id, charName: char.name, purpose: 'MCP tools 兼容重试' });
                // 后续正文工具循环必须继续带着兼容协议；只把它放在这次重试请求里，下一跳
                // 又退回原 messages，会让模型忘掉工具签名和「每步只输出一行」的约定。
                baseReqBody.messages = fallbackBody.messages;
                }
            }
            console.log(`⏱ [API call] ${Math.round(performance.now() - apiT0)}ms`);
            updateTokenUsage(data, historyMsgCount, 'initial');

            // MCP 多阶段展示：工具前的角色文字先落库，最终工具结果回复仍走统一后处理。
            const displayedMcpLeadIns = new Set<string>();
            const persistMcpLeadIn = async (raw: string, fakedCalls: FakedMcpCall[] = []): Promise<void> => {
                if (!turnAlive()) return;
                if (!mcpToolResolve || !raw.trim()) return;
                const withoutCalls = fakedCalls.length ? stripTextFakedMcpCalls(raw, fakedCalls) : raw.trim();
                const display = ChatParser.sanitize(sanitizeMcpLeadInText(withoutCalls), { keepCitations: true }).trim();
                if (!display || !ChatParser.hasDisplayContent(display) || displayedMcpLeadIns.has(display)) return;
                displayedMcpLeadIns.add(display);
                const chunks = ChatParser.chunkText(display).filter(chunk => ChatParser.hasDisplayContent(chunk));
                for (const chunk of chunks) {
                    const cleanChunk = ChatParser.sanitize(chunk, { keepCitations: true }).trim();
                    if (!cleanChunk) continue;
                    await DB.saveMessage({
                        charId: char.id,
                        role: 'assistant',
                        type: 'text',
                        content: cleanChunk,
                        metadata: { mcpLeadIn: true },
                    } as any);
                    setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                }
            };

            // 3.4 麦当劳小程序 propose_cart_items UI 钩子工具循环
            //     不调 MCP, 只把模型的 args 作为 mcd_card kind=proposal 落库, 让小程序聊天面板渲染
            //     成"+加进购物车"卡片。返回 ack 给模型继续走它的文字 reply。
            if (payload.flags.mcdActive && data.choices?.[0]?.message?.tool_calls?.length) {
                const MAX_PROPOSE_LOOPS = 3;
                let loopMessages = [...baseReqBody.messages];
                for (let it = 0; it < MAX_PROPOSE_LOOPS; it++) {
                    const toolCalls = data.choices?.[0]?.message?.tool_calls;
                    if (!toolCalls || !toolCalls.length) break;
                    loopMessages.push({
                        role: 'assistant',
                        // 空 content + tool_calls 在 Gemini 兼容层会被判 INVALID_ARGUMENT, 给个占位
                        content: data.choices[0].message.content || '(调用工具中)',
                        tool_calls: toolCalls,
                    } as any);
                    for (const tc of toolCalls) {
                        const fname: string = tc.function?.name || '';
                        let args: any = {};
                        try {
                            const raw = tc.function?.arguments ?? tc.arguments;
                            args = typeof raw === 'string' ? (raw ? JSON.parse(raw) : {}) : (raw || {});
                        } catch (e) {
                            console.warn('🍔 [MCD-MiniApp] propose 参数解析失败:', e);
                        }
                        // 主动消息 2.0 的排程工具与点单工具会在同一批 tool_calls 里出现:
                        // 先分流执行, 否则会落进下面的「畸形调用」分支被吃掉, 而续写请求
                        // 又不带 tools, 角色「点单时顺手排个提醒」就永远不会生效。
                        const route = routeMiniAppToolCall(fname, args);
                        if (route === 'amsg2') {
                            await runAmsg2ToolCall(tc, fname, args, loopMessages);
                            continue;
                        }
                        if (route === 'propose') {
                            // 第一步: 菜单还没加载就直接拒, 不能让模型瞎编 code
                            // 这是导致 calculate-price 返回空列表的根因之一: propose 在 pick 步骤被调用,
                            // 此时 menuMeals 是空的, 旧版 menuKeys.length===0 会直接跳过校验, 烂 code 一路到 cart。
                            const menu = mcdMiniSnap?.menuMeals || {};
                            const menuKeys = Object.keys(menu);
                            if (menuKeys.length === 0) {
                                loopMessages.push({
                                    role: 'tool',
                                    tool_call_id: tc.id,
                                    content: `菜单还没加载 (用户当前在选模式 / 选地址门店阶段, 还没进入菜单页)。请先用文字陪用户聊, 等用户在小程序里选完地址/门店、菜单加载出来后再调 propose_cart_items。所有 code 必须从加载后的"当前门店在售"清单里挑, 不能凭印象编。`,
                                } as any);
                                continue;
                            }
                            // 第二步: 全局名字匹配自动修 code (char 经常把"板烧鸡腿堡"当 code 传)
                            const { fixed, fixes } = autoFixProposalCodesByName(args.items, menu);
                            if (fixes.length) {
                                console.log(`🍔 [MCD-MiniApp] propose 自动修 ${fixes.length} 个 code:`,
                                    fixes.map(f => `'${f.from}' → '${f.to}' (${f.name})`).join(', '));
                            }
                            args.items = fixed;
                            // 第三步: 修完后还有非法的就退回 char 重提 (严格模式: 任何不在 menu 字典里的 code 都拒)
                            const invalidItems = args.items.filter((it: any) => !it?.code || !(menu as any)[it.code]);
                            if (invalidItems.length > 0) {
                                const sample = menuKeys.slice(0, 20).map(k => `${k}=${(menu as any)[k]?.name || ''}`).join(', ');
                                const bad = invalidItems.map((i: any) => `'${i.code}'(${i.name || '?'})`).join(', ');
                                loopMessages.push({
                                    role: 'tool',
                                    tool_call_id: tc.id,
                                    content: `propose_cart_items 里这些 code/name 在菜单里都找不到匹配 (已尝试名字模糊匹配但失败): ${bad}。这些商品本店不卖, 别推。当前菜单可用 code 示例: ${sample}。请只从菜单里挑实际有的, 重新调一次 propose。`,
                                } as any);
                                continue;
                            }
                            try {
                                await DB.saveMessage({
                                    charId: char.id,
                                    role: 'assistant',
                                    type: 'mcd_card',
                                    content: `${args.items.length} 件推荐`,
                                    metadata: {
                                        mcdCardKind: 'proposal',
                                        mcdProposal: args,
                                        fromMcdMiniApp: true,
                                    },
                                } as any);
                                setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                            } catch (e) {
                                console.warn('🍔 [MCD-MiniApp] 保存 proposal 失败:', e);
                            }
                            const ackExtra = fixes.length
                                ? ` (我帮你把 ${fixes.length} 个 code 按名字校准到了菜单里真实的 code, 下次 propose 时直接用菜单字典 key 别传名字, 省一步)`
                                : '';
                            loopMessages.push({
                                role: 'tool',
                                tool_call_id: tc.id,
                                content: `OK 已把推荐展示给用户, 用户可以点 + 加进购物车${ackExtra}`,
                            } as any);
                        } else {
                            // 未知工具 / 空 items, 给个温和的报错让模型自纠
                            loopMessages.push({
                                role: 'tool',
                                tool_call_id: tc.id,
                                content: `工具 ${fname} 调用形态不对, 期望 {items: [{code, name, qty, reason?}]}; 你这次给的是 ${JSON.stringify(args).slice(0, 200)}`,
                            } as any);
                        }
                    }
                    // 让 char 继续生成文字补充 (不再带 tools, 避免无限调)
                    const followBody = { ...baseReqBody, messages: loopMessages };
                    delete followBody.tools;
                    delete followBody.tool_choice;
                    spendLlmCall();
                    data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                        method: 'POST', headers, signal: turnSignal,
                        body: JSON.stringify(followBody)
                    });
                    updateTokenUsage(data, historyMsgCount, `mcd-propose-${it + 1}`);
                    // 第二轮跳过 (我们已经禁用了 tools)
                    if (!data.choices?.[0]?.message?.tool_calls?.length) break;
                }
            }

            // 3.5 瑞幸小程序 propose_cart_items UI 钩子工具循环 (与麦当劳同构)
            if (payload.flags.luckinActive && data.choices?.[0]?.message?.tool_calls?.length) {
                const MAX_PROPOSE_LOOPS = 3;
                let loopMessages = [...baseReqBody.messages];
                for (let it = 0; it < MAX_PROPOSE_LOOPS; it++) {
                    const toolCalls = data.choices?.[0]?.message?.tool_calls;
                    if (!toolCalls || !toolCalls.length) break;
                    loopMessages.push({
                        role: 'assistant',
                        // 空 content + tool_calls 在 Gemini 兼容层会被判 INVALID_ARGUMENT, 给个占位
                        content: data.choices[0].message.content || '(调用工具中)',
                        tool_calls: toolCalls,
                    } as any);
                    for (const tc of toolCalls) {
                        const fname: string = tc.function?.name || '';
                        let args: any = {};
                        try {
                            const raw = tc.function?.arguments ?? tc.arguments;
                            args = typeof raw === 'string' ? (raw ? JSON.parse(raw) : {}) : (raw || {});
                        } catch (e) {
                            console.warn('☕ [Luckin-MiniApp] propose 参数解析失败:', e);
                        }
                        // 主动消息 2.0 的排程工具与点单工具会在同一批 tool_calls 里出现:
                        // 先分流执行, 否则会落进下面的「畸形调用」分支被吃掉, 而续写请求
                        // 又不带 tools, 角色「点单时顺手排个提醒」就永远不会生效。
                        const route = routeMiniAppToolCall(fname, args);
                        if (route === 'amsg2') {
                            await runAmsg2ToolCall(tc, fname, args, loopMessages);
                            continue;
                        }
                        if (route === 'propose') {
                            const menu = luckinMiniSnap?.menuItems || {};
                            const menuKeys = Object.keys(menu);
                            if (menuKeys.length === 0) {
                                loopMessages.push({
                                    role: 'tool',
                                    tool_call_id: tc.id,
                                    content: `菜单还没加载 (用户当前在选模式 / 选门店阶段)。请先用文字陪用户聊, 等菜单加载出来、出现"当前门店在售"清单后再调 propose_cart_items, code 必须从清单里挑。`,
                                } as any);
                                continue;
                            }
                            const { fixed, fixes } = autoFixLuckinProposalCodesByName(args.items, menu);
                            if (fixes.length) {
                                console.log(`☕ [Luckin-MiniApp] propose 自动修 ${fixes.length} 个 code:`,
                                    fixes.map(f => `'${f.from}' → '${f.to}' (${f.name})`).join(', '));
                            }
                            args.items = fixed;
                            const invalidItems = args.items.filter((it: any) => !it?.code || !(menu as any)[it.code]);
                            if (invalidItems.length > 0) {
                                const sample = menuKeys.slice(0, 20).map(k => `${k}=${(menu as any)[k]?.name || ''}`).join(', ');
                                const bad = invalidItems.map((i: any) => `'${i.code}'(${i.name || '?'})`).join(', ');
                                loopMessages.push({
                                    role: 'tool',
                                    tool_call_id: tc.id,
                                    content: `propose_cart_items 里这些 code/name 在菜单里找不到匹配: ${bad}。这些商品本店不卖, 别推。当前菜单可用 code 示例: ${sample}。请只从菜单里挑实际有的, 重新调一次 propose。`,
                                } as any);
                                continue;
                            }
                            try {
                                await DB.saveMessage({
                                    charId: char.id,
                                    role: 'assistant',
                                    type: 'luckin_card',
                                    content: `${args.items.length} 件推荐`,
                                    metadata: {
                                        luckinCardKind: 'proposal',
                                        luckinProposal: args,
                                        fromLuckinMiniApp: true,
                                    },
                                } as any);
                                setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                            } catch (e) {
                                console.warn('☕ [Luckin-MiniApp] 保存 proposal 失败:', e);
                            }
                            const ackExtra = fixes.length
                                ? ` (我帮你把 ${fixes.length} 个 code 按名字校准到了菜单里真实的 code)`
                                : '';
                            loopMessages.push({
                                role: 'tool',
                                tool_call_id: tc.id,
                                content: `OK 已把推荐展示给用户, 用户可以点 + 加进购物车${ackExtra}`,
                            } as any);
                        } else {
                            loopMessages.push({
                                role: 'tool',
                                tool_call_id: tc.id,
                                content: `工具 ${fname} 调用形态不对, 期望 {items: [{code, name, qty, reason?}]}; 你这次给的是 ${JSON.stringify(args).slice(0, 200)}`,
                            } as any);
                        }
                    }
                    const followBody = { ...baseReqBody, messages: loopMessages };
                    delete followBody.tools;
                    delete followBody.tool_choice;
                    spendLlmCall();
                    data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                        method: 'POST', headers, signal: turnSignal,
                        body: JSON.stringify(followBody)
                    });
                    updateTokenUsage(data, historyMsgCount, `luckin-propose-${it + 1}`);
                    if (!data.choices?.[0]?.message?.tool_calls?.length) break;
                }
            }

            // 3.6 客户端工具循环 —— 两类共用一个循环骨架:
            //     · 瑞幸聊天点单: 真实 8 工具 (queryShopList → searchProductForMcp →
            //       switchProduct → previewOrder)。结果落 luckin_card; previewOrder 落"结账卡"(可改量+扫码付);
            //       createOrder 被拦截 —— 下单付款必须用户在结账卡上点。
            //     · 通用 MCP: 工具名命中 mcpToolResolve 映射就分发给对应服务器 (utils/mcpClient),
            //       结果只回填循环不落卡片。两类工具可同时在场, 按名字各走各的。
            if ((payload.flags.luckinChatActive || mcpToolResolve || amsg2ToolsInjected || btToolsInjected || chatLifeWorkflowToolsInjected || shareExcerptTurn) && data.choices?.[0]?.message?.tool_calls?.length) {
                // 每轮工具轮数上限：优先用户设置；接通用 MCP 时取两者较大值，保证 master 侧 12 轮预算。
                // 只有分享片段工具时不需要那么多轮（预算最多撑两次满额读），给 4 轮就够纠错。
                const MAX_LOOPS = mcpToolResolve
                    ? Math.max(mcpSettings.maxToolLoops, MCP_CHAT_MAX_TOOL_LOOPS)
                    : shareExcerptTurn ? 4 : mcpSettings.maxToolLoops;
                // 懒加载展开重填（二次请求）的预算：与主循环共享 maxToolLoops 上限，防死循环
                let mcpRefillsUsed = 0;                let loopMessages = [...baseReqBody.messages];
                const loc = luckinChatRef?.current;
                const seenMcpOutcomes = new Set<string>();
                let stalledMcpRounds = 0;
                let lastMcpCallSignature: string | null = null;
                for (let it = 0; it < MAX_LOOPS; it++) {
                    const toolCalls = normalizeToolCallsForCompat(
                        data.choices?.[0]?.message?.tool_calls,
                        `private_${it}`,
                    );
                    if (!toolCalls || !toolCalls.length) break;
                    if (mcpToolResolve && toolCalls.some((tc: any) => mcpToolResolve?.has(tc.function?.name || ''))) {
                        await persistMcpLeadIn(data.choices?.[0]?.message?.content || '');
                    }
                    loopMessages.push({
                        role: 'assistant',
                        // 空 content + tool_calls 在 Gemini 兼容层会被判 INVALID_ARGUMENT, 给个占位
                        content: data.choices[0].message.content || '(调用工具中)',
                        tool_calls: toolCalls,
                    } as any);
                    let mcpCallsThisRound = 0;
                    let mcpProgressThisRound = false;
                    for (const tc of toolCalls) {
                        const fname: string = tc.function?.name || '';
                        let args: any = {};
                        try {
                            const raw = tc.function?.arguments ?? tc.arguments;
                            args = typeof raw === 'string' ? (raw ? JSON.parse(raw) : {}) : (raw || {});
                        } catch (e) {
                            console.warn('☕ [Luckin-Chat] 工具参数解析失败:', e);
                        }
                        // 通用 MCP 工具: 命中映射直接分发, 不走下面的瑞幸逻辑。
                        // 懒加载智能混合：模型在 stub（宽松参数）下第一次给出的参数可能不完整，
                        // 执行前按完整 schema 轻量校验；不通过且还有重填预算时，带完整 schema
                        // 二次请求让模型重填；重填仍失败则把校验错误回填给模型自我纠正。
                        const mcpHit = mcpToolResolve?.get(fname);
                        if (mcpHit) {
                            mcpCallsThisRound += 1;
                            const callSignature = toolCallFingerprint(fname, args);
                            // 连续同名同参通常是模型卡住。先拦再执行，避免发帖 / 下单之类的
                            // 副作用真的重复发生；中间做过其他动作后同参查状态仍会正常放行。
                            if (callSignature === lastMcpCallSignature) {
                                loopMessages.push(buildToolResultMessage(
                                    tc,
                                    `工具 ${fname} 的同一组参数刚刚已经执行过，请不要原地重复；根据已有结果选择能推进目标的下一步，或直接回复。`,
                                ) as any);
                                continue;
                            }
                            lastMcpCallSignature = callSignature;
                            setSearchStatus(`正在调用 MCP 工具：${fname}...`);
                            // 懒加载 stub 约定参数形如 {args:{...}}；兼容直接给完整参数两种写法
                            let execArgs: any = args;
                            if (execArgs && typeof execArgs === 'object' && !Array.isArray(execArgs)
                                && Object.keys(execArgs).length === 1 && 'args' in execArgs
                                && execArgs.args && typeof execArgs.args === 'object') {
                                execArgs = execArgs.args;
                            }
                            execArgs = normalizeMcpToolArguments(execArgs, mcpHit.tool.inputSchema);
                            let validation = validateMcpToolArguments(execArgs, mcpHit.tool.inputSchema);
                            if (!validation.ok && mcpRefillsUsed < MAX_LOOPS) {
                                // —— 展开重填：该工具带完整 schema，其余仍 stub，一轮最多占用共享预算 ——
                                mcpRefillsUsed += 1;
                                console.warn(`🔌 [MCP] 懒加载参数校验未通过, 展开重填 (${mcpRefillsUsed}/${MAX_LOOPS}):`, validation.errors);
                                try {
                                    const expanded = buildMcpOpenAITools(char.id, {
                                        lazy: mcpSettings.lazyLoad,
                                        expandTools: [fname],
                                    });
                                    const schemaText = JSON.stringify(mcpHit.tool.inputSchema || { type: 'object', properties: {} });
                                    const refillBody = {
                                        ...baseReqBody,
                                        tools: expanded.tools,
                                        messages: [
                                            ...loopMessages,
                                            {
                                                role: 'user',
                                                content: `[系统消息: 你刚才调用 ${fname} 的参数未通过校验: ${validation.errors.join('; ')}。下面是该工具的完整参数定义(JSON Schema): ${schemaText} 。请立即重新调用 ${fname}，按完整定义把参数补齐，不要输出任何文字]`,
                                            },
                                        ],
                                    };
                                    spendLlmCall();
                                    const refillData = await safeFetchJson(`${baseUrl}/chat/completions`, {
                                        method: 'POST', headers, signal: turnSignal,
                                        body: JSON.stringify(refillBody),
                                    });
                                    updateTokenUsage(refillData, historyMsgCount, `mcp-refill-${it + 1}`);
                                    const refillCalls = normalizeToolCallsForCompat(
                                        refillData?.choices?.[0]?.message?.tool_calls, `mcp_refill_${it}`,
                                    ) || [];
                                    const refillCall = refillCalls.find((r: any) => r.function?.name === fname) || refillCalls[0];
                                    if (refillCall) {
                                        try {
                                            const raw2 = refillCall.function?.arguments ?? refillCall.arguments;
                                            let refillArgs: any = typeof raw2 === 'string' ? (raw2 ? JSON.parse(raw2) : {}) : (raw2 || {});
                                            if (refillArgs && typeof refillArgs === 'object' && !Array.isArray(refillArgs)
                                                && Object.keys(refillArgs).length === 1 && 'args' in refillArgs
                                                && refillArgs.args && typeof refillArgs.args === 'object') {
                                                refillArgs = refillArgs.args;
                                            }
                                            refillArgs = normalizeMcpToolArguments(refillArgs, mcpHit.tool.inputSchema);
                                            const revalidation = validateMcpToolArguments(refillArgs, mcpHit.tool.inputSchema);
                                            if (revalidation.ok) {
                                                execArgs = refillArgs;
                                                validation = revalidation;
                                                // 历史消息里显示最终参数（toolCalls 已被引用进 loopMessages，原地改即可）
                                                try { tc.function.arguments = JSON.stringify(execArgs); } catch { /* ignore */ }
                                            } else {
                                                validation = revalidation;
                                            }
                                        } catch { /* 解析失败按原校验错误处理 */ }
                                    }
                                } catch (e: any) {
                                    console.warn('🔌 [MCP] 展开重填请求失败:', e?.message || e);
                                }
                            }
                            let mcpResult: any;
                            if (!validation.ok) {
                                // 重填预算用尽/仍失败：不执行，把错误回填让模型纠正或文字解释
                                mcpResult = { success: false, error: `参数校验未通过: ${validation.errors.join('; ')}` };
                            } else {
                                try { mcpResult = await callMcpTool(mcpHit.server, mcpHit.toolName, execArgs); }
                                catch (e: any) { mcpResult = { success: false, error: e?.message || String(e) }; }
                            }
                            // 跨轮结果记忆（最近 N 轮窗口 + 手册类长期保存，见 mcpResultMemory）
                            try {
                                recordMcpResult({
                                    charId: char.id,
                                    server: { id: mcpHit.server.id, name: mcpHit.server.name, persistMode: mcpHit.server.persistMode },
                                    toolName: mcpHit.toolName,
                                    args: execArgs,
                                    result: mcpResult,
                                    turnId: mcpTurnId,
                                    keepTurns: mcpSettings.resultKeepTurns,
                                });
                            } catch { /* 记忆失败不影响主链路 */ }
                            const mcpMsg = mcpResult.success
                                ? `工具 ${fname} 成功。结果: ${formatMcpToolResult(mcpResult.data)}`
                                : `工具 ${fname} 失败: ${mcpResult.error}`;
                            // 同名同参在动作前后可能得到不同状态，结果不同就算仍在推进；只有
                            // 调用和结果都原样重复才算原地打转。
                            let outcomeKey = `${fname}|${JSON.stringify(args)}|${mcpMsg}`;
                            if (outcomeKey.length > 4000) outcomeKey = outcomeKey.slice(0, 4000);
                            if (!seenMcpOutcomes.has(outcomeKey)) {
                                seenMcpOutcomes.add(outcomeKey);
                                mcpProgressThisRound = true;
                            }
                            loopMessages.push(buildToolResultMessage(tc, mcpMsg) as any);
                            continue;
                        }
                        // 链接分享按需读片段（执行卡 t_75dd49a5）：只读 HTTP，预算挂在 turn 上（整个
                        // 工具循环共享）；成功/超限/失败都回结构化文本，交给模型自己决定如实怎么说。
                        // 参数不在这里二次解析：executor 内部统一清洗（拒绝 URL/token/scope，限制字段与额度）。
                        if (shareExcerptTurn && fname === SHARE_EXCERPTS_TOOL_NAME) {
                            setSearchStatus('正在读取分享片段...');
                            const excerptOutcome = await executeShareExcerptToolCall({ toolCall: tc, turn: shareExcerptTurn });
                            loopMessages.push(buildToolResultMessage(tc, excerptOutcome.text) as any);
                            continue;
                        }
                        // 主动消息 2.0 工具
                        if (AMSG2_TOOL_NAMES.has(fname)) {
                            await runAmsg2ToolCall(tc, fname, args, loopMessages);
                            continue;
                        }
                        // 生活工作流提议（P5）：一次鉴权登记请求，回话只说「后台已排队」。
                        // 失败/被拒都在工具回话里收口，不抛、不重试、不影响这一轮回复。
                        if (CHAT_LIFE_WORKFLOW_TOOL_NAMES.has(fname)) {
                            try {
                                const lifeText = await executeChatLifeWorkflowTool(args, {
                                    charId: char.id,
                                    sourceRef: lifeWorkflowSourceRef,
                                });
                                loopMessages.push(buildToolResultMessage(tc, lifeText) as any);
                            } catch (e) {
                                console.warn('[life-workflow] 工具执行异常（不影响本轮回复）', e);
                                loopMessages.push(buildToolResultMessage(
                                    tc,
                                    '这一次没有登记成功。不要向对方提起这件事，也不要重试，继续正常聊天。',
                                ) as any);
                            }
                            continue;
                        }
                        // 蓝牙外设工具
                        if (BT_TOOL_NAMES.has(fname)) {
                            const btText = await executeBleSendCommand(args as { device?: string; command?: string });
                            loopMessages.push(buildToolResultMessage(tc, btText) as any);
                            continue;
                        }
                        // 只开了 MCP 没开瑞幸时, 幻觉出的未知工具名直接回错误让模型自我纠正
                        if (!payload.flags.luckinChatActive) {
                            loopMessages.push(buildToolResultMessage(tc, `未知工具 ${fname}, 只能使用系统提供的工具。`) as any);
                            continue;
                        }
                        // 经纬度兜底: 角色漏传就用激活时抓到的定位补上
                        if (/queryShopList|createOrder/i.test(fname) && loc) {
                            if (args.longitude == null && loc.longitude != null) args.longitude = loc.longitude;
                            if (args.latitude == null && loc.latitude != null) args.latitude = loc.latitude;
                        }
                        // 拦截 createOrder: 不真下单, 引导走结账卡
                        if (/create[-_]?order/i.test(fname)) {
                            loopMessages.push(buildToolResultMessage(
                                tc,
                                '下单与支付由用户在结账卡上完成, 你不要调 createOrder。若还没出结账卡, 请先调 previewOrder 把订单算价展示出来, 然后用角色语气让用户去卡片上确认支付。',
                            ) as any);
                            continue;
                        }
                        let result: any;
                        try { result = await callLuckinTool(fname, args); }
                        catch (e: any) { result = { success: false, error: e?.message || String(e) }; }

                        const isPreview = /preview[-_]?order/i.test(fname);
                        try {
                            await DB.saveMessage({
                                charId: char.id,
                                role: 'assistant',
                                type: 'luckin_card',
                                content: fname,
                                metadata: {
                                    luckinToolName: fname,
                                    luckinToolArgs: args,
                                    luckinToolResult: result.success ? result.data : undefined,
                                    luckinToolError: result.success ? undefined : result.error,
                                    luckinToolRawText: result.rawText,
                                    luckinCardKind: isPreview ? 'checkout' : inferLuckinCardKind(fname),
                                    luckinLoc: (loc && loc.longitude != null) ? { longitude: loc.longitude, latitude: loc.latitude } : undefined,
                                },
                            } as any);
                            setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                        } catch (e) { console.warn('☕ [Luckin-Chat] 存卡片失败:', e); }

                        const toolMsg = result.success
                            ? `工具 ${fname} 成功。结果(截断): ${(() => { try { return JSON.stringify(result.data).slice(0, 1500); } catch { return String(result.data).slice(0, 800); } })()}`
                            : `工具 ${fname} 失败: ${result.error}`;
                        loopMessages.push(buildToolResultMessage(tc, toolMsg) as any);
                    }
                    if (mcpCallsThisRound > 0) {
                        stalledMcpRounds = mcpProgressThisRound ? 0 : stalledMcpRounds + 1;
                    }
                    const reachedHardLimit = !!mcpToolResolve && it + 1 >= MAX_LOOPS;
                    const stalled = !!mcpToolResolve && stalledMcpRounds >= MCP_CHAT_MAX_STALLED_ROUNDS;
                    const forceWrapUp = reachedHardLimit || stalled;
                    // 继续让角色多步推进 (保留 tools, 允许 query→search→preview 连续走)
                    if (mcpToolResolve) setSearchStatus('正在整理 MCP 工具结果...');
                    // 排程现状现算一次贴上：本轮刚排的任务这时才进得了清单，角色下一轮
                    // 看到的是自己名下真实的排程，不会对着排程前的空清单再排一条。
                    const followMessages = withAmsg2TaskContext(loopMessages);
                    if (forceWrapUp) {
                        followMessages.push({
                            role: 'user',
                            content: `[系统消息：工具阶段${stalled ? '连续两轮没有产生新结果' : '已到本轮安全上限'}。请停止调用工具，基于已经拿到的结果直接用角色语气回复；如目标仍未完成，请如实说明卡在哪一步。不要输出工具名、参数或这条系统消息。]`,
                        });
                    }
                    const followBody = { ...baseReqBody, messages: followMessages };
                    if (forceWrapUp) {
                        delete followBody.tools;
                        delete followBody.tool_choice;
                    }
                    spendLlmCall();
                    data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                        method: 'POST', headers, signal: turnSignal,
                        body: JSON.stringify(followBody)
                    });
                    updateTokenUsage(data, historyMsgCount, `${payload.flags.luckinChatActive ? 'luckin-chat' : 'mcp-chat'}-${it + 1}`);
                    if (forceWrapUp) break;
                }
                if (mcpToolResolve) setSearchStatus('');
            }

            // 3.6b MCP 掉格式容错（第二层, 对标见面观测协议的两层容错）:
            //     不支持 function calling 的模型会把工具调用写成正文文字, 如
            //     ask_question("SullyOS") / ask_question: SullyOS。这里检测出来
            //     系统代为执行, 把结果喂回去让角色重新组织语言, 用户就看不到乱码了。
            //     连续调用指纹防止模型复读同一调用导致副作用工具重复执行；中间若有别的
            //     动作，则允许用同参重新查询已经变化的状态。
            if (mcpToolResolve) {
                const MAX_TEXT_LOOPS = MCP_CHAT_MAX_TOOL_LOOPS;
                let lastExecutedSig: string | null = null;
                let textLoopMessages: any[] | null = null;
                for (let it = 0; it < MAX_TEXT_LOOPS; it++) {
                    const contentNow: string = data.choices?.[0]?.message?.content || '';
                    // 兼容协议约定每轮只发一行。一次只执行一个，既让 12 轮真正按步骤自适应，
                    // 也避免一段失控正文批量触发多个副作用。
                    const allFaked = extractTextFakedMcpCalls(contentNow, mcpToolResolve).slice(0, 1);
                    const faked = allFaked
                        .filter(c => toolCallFingerprint(c.exposedName, c.args) !== lastExecutedSig);
                    // 兼容模式没有原生 tool_call id，模型重复写同名同参时绝不能再次执行
                    // 副作用工具；给一次强制收尾请求，把已经拿到的结果组织成人话。
                    if (allFaked.length > 0 && faked.length === 0) {
                        if (!textLoopMessages) textLoopMessages = [...baseReqBody.messages];
                        textLoopMessages.push({ role: 'assistant', content: contentNow });
                        textLoopMessages.push({
                            role: 'user',
                            content: '[系统消息：你重复请求了已经执行过的同一工具。不要再次调用工具，请直接根据已有结果回复；如目标未完成就如实说明。不要输出工具调用格式或提及本消息。]',
                        });
                        const wrapBody = buildMcpTextFallbackBody(baseReqBody, textLoopMessages);
                        spendLlmCall();
                        data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                            method: 'POST', headers, signal: turnSignal,
                            body: JSON.stringify(wrapBody)
                        });
                        updateTokenUsage(data, historyMsgCount, `mcp-text-wrap-${it + 1}`);
                        break;
                    }
                    if (!faked.length) break;
                    console.warn(`🔌 [MCP] 检测到 ${faked.length} 个正文假工具调用, 代为执行:`, faked.map(c => c.exposedName).join(', '));
                    await persistMcpLeadIn(contentNow, faked);
                    setSearchStatus(`正在调用 MCP 工具：${faked.map(c => c.exposedName).join('、')}...`);
                    const results: string[] = [];
                    for (const call of faked) {
                        lastExecutedSig = toolCallFingerprint(call.exposedName, call.args);
                        let r: any;
                        try { r = await callMcpTool(call.server, call.toolName, call.args); }
                        catch (e: any) { r = { success: false, error: e?.message || String(e) }; }
                        // 跨轮结果记忆（与 3.6 真实工具循环同一份档案，正文假调用同样防重复）
                        try {
                            recordMcpResult({
                                charId: char.id,
                                server: { id: call.server.id, name: call.server.name, persistMode: (call.server as any).persistMode },
                                toolName: call.toolName,
                                args: call.args,
                                result: r,
                                turnId: mcpTurnId,
                                keepTurns: mcpSettings.resultKeepTurns,
                            });
                        } catch { /* 记忆失败不影响主链路 */ }
                        results.push(r.success
                            ? `工具 ${call.exposedName} 执行成功, 结果: ${formatMcpToolResult(r.data)}`
                            : `工具 ${call.exposedName} 执行失败: ${r.error}`);
                    }
                    if (!textLoopMessages) textLoopMessages = [...baseReqBody.messages];
                    textLoopMessages.push({ role: 'assistant', content: contentNow });
                    textLoopMessages.push({
                        role: 'user',
                        content: `[系统消息：你把工具调用写成了聊天文字，系统已代为执行：\n${results.join('\n')}\n如果目标已经完成，请直接用角色语气回复；如果仍需下一步工具，只输出一行真正能推进目标的工具调用，不要重复读取同一说明或状态。不要提及这条系统消息。]`,
                    });
                    const reachedHardLimit = it + 1 >= MAX_TEXT_LOOPS;
                    if (reachedHardLimit) {
                        textLoopMessages.push({
                            role: 'user',
                            content: '[系统消息：工具阶段已到本轮安全上限。停止调用工具，基于已有结果直接回复；如目标未完成就如实说明。不要输出工具调用格式或提及本消息。]',
                        });
                    }
                    setSearchStatus('正在整理 MCP 工具结果...');
                    const followBody = buildMcpTextFallbackBody(baseReqBody, textLoopMessages);
                    spendLlmCall();
                    data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                        method: 'POST', headers, signal: turnSignal,
                        body: JSON.stringify(followBody)
                    });
                    updateTokenUsage(data, historyMsgCount, `mcp-text-${it + 1}`);
                    if (reachedHardLimit) break;
                }
                setSearchStatus('');
            }

            // DEBUG: Log full API response details for troubleshooting truncation issues
            console.log('🔍 [API Response Debug]', JSON.stringify({
                finish_reason: data.choices?.[0]?.finish_reason,
                usage: data.usage,
                content_length: data.choices?.[0]?.message?.content?.length,
                raw_content: data.choices?.[0]?.message?.content,
                reasoning_content: data.choices?.[0]?.message?.reasoning_content,
                reasoning_content_length: data.choices?.[0]?.message?.reasoning_content?.length,
                model: data.model,
                id: data.id,
            }, null, 2));

            // ─── 后处理管线 (13 步) ───
            // 详见 utils/applyAssistantPostProcessing.ts。Phase 0 行为字节级不变;
            // Phase 1 会让 instant push 路径也调它 (skipSecondPassLLM=true);
            // Phase 2 会让 worker 端把识别的副作用打包成 directives 传过来重放。
            // 预览气泡的无缝交棒：不提前清（提前清 = 气泡集体消失→再劈里啪啦重放，用户实报），
            // 而是包装 setMessages——后处理第一条真实消息落库上屏的**同一帧**清预览。
            // 交接前预览一直挂着，交接后 instantRender 秒速回填，视觉上是"预览定格成正式消息"。
            let previewHandedOver = false;
            const previewHandoverIds = new Set<number>();
            const previewBaselineMaxId = contextMsgs.reduce(
                (maxId, message) => Math.max(maxId, message.id),
                Number.NEGATIVE_INFINITY,
            );
            const setMessagesWithPreviewHandover = (msgs: Message[]) => {
                // 旧轮提交作废：切角色/卸载后不再碰 UI（DB 侧由 abort 掐断 + 下方 announce/mark 守卫）。
                if (!turnAlive()) return;
                if (msgs.some((m) => m.role === 'assistant' && (m.id ?? 0) > previewBaselineMaxId)) {
                    turnProducedVisible = true;
                }
                const newlyHandedOverIds = findNewStreamPreviewHandoverIds(
                    msgs,
                    latestStreamPreviewBubbles,
                    previewBaselineMaxId,
                    previewHandoverIds,
                );
                const handoverIds = new Set(newlyHandedOverIds);
                if (streamThinkingShown) {
                    const thinkingHost = msgs.find(message =>
                        message.id > previewBaselineMaxId && message.role === 'assistant'
                    );
                    if (thinkingHost && !previewHandoverIds.has(thinkingHost.id)) handoverIds.add(thinkingHost.id);
                }
                if (handoverIds.size > 0) {
                    handoverIds.forEach(id => previewHandoverIds.add(id));
                    // ref 在 setMessages 触发渲染前同步更新，首帧就能关掉正式气泡的 fade-in。
                    onStreamPreviewHandover?.(char.id, [...handoverIds]);
                }
                setMessages(msgs);
                if (!previewHandedOver) {
                    previewHandedOver = true;
                    setStreamingBubbles([]);
                    setStreamingThinking('');
                }
            };
            const rawAiContent = data.choices?.[0]?.message?.content || '';
            const xhsCaches: XhsCaches = {
                xsecTokenCache: xsecTokenCacheRef.current,
                noteTitleCache: noteTitleCacheRef.current,
                commentUserIdCache: commentUserIdCacheRef.current,
                commentAuthorNameCache: commentAuthorNameCacheRef.current,
                commentParentIdCache: commentParentIdCacheRef.current,
            };
            await applyAssistantPostProcessing(rawAiContent, {
                char,
                userProfile,
                emojis,
                categories,
                realtimeConfig,
                groups,
                contextMsgs,
                fullMessages,
                initialData: data,
                historyMsgCount,
                mcdInheritMeta,
                xhsCaches,
                api: {
                    baseUrl,
                    headers,
                    effectiveApi,
                },
                hooks: {
                    setMessages: setMessagesWithPreviewHandover,
                    addToast,
                    setRecallStatus,
                    setSearchStatus,
                    setDiaryStatus,
                    setXhsStatus,
                    updateTokenUsage,
                    // 整组 musicHooks 由 MusicProvider 注册到模块级 slot, 本地 fetch 路径和
                    // instant push 路径 (activeMsgRuntime) 共享同一份, 见 MusicContext.loadMusicHooks.
                    musicHooks: loadMusicHooks() ?? undefined,
                },
                // 流式预览已把气泡展示过 → 落库免打字延迟，秒回填（未预览时行为不变）
                instantRender: streamPreviewShown,
                // AI 生图运行时：内联 [[GEN_IMAGE:]] 标签的执行上下文（1:1 聊天只有本角色）。
                imageGen: {
                    apiConfig,
                    characters: [char],
                    saveCharProfile: (id, profile) => updateCharacter?.(id, { imageGenProfile: profile } as any),
                },
                // Phase 0: 本地 fetch 路径保持原逻辑, 不跳 2nd-pass LLM, 也没有结构化 directives。
                skipSecondPassLLM: false,
                directives: [],
                airpDirectorOutput: airpDirectorOutputRef.current,
                // 自主生活转述记账输入（C2）：本轮转述块里出现过的账本条目 id。
                autonomyToldIds: payload.autonomyToldIds,
            });

            // 链接分享按需读片段：把本轮真实的 call/result 成对挂到刚落库的那条助手消息上。
            // 这样下一轮投影（messageFormat）能成对回放「问什么→读到什么」，片段确实会占未来
            // 上下文（不承诺它们不占），但成对有界，不会只剩孤立片段让模型误以为读过更多。
            // 只挂时间上属于本轮的那条 assistant；找不到就不挂（不往别的消息上硬塞）。
            if (shareExcerptTurn && shareExcerptTurn.calls.length > 0) {
                try {
                    const recentAfterTurn = await DB.getRecentMessagesByCharId(char.id, 30);
                    const anchorId = pickShareExcerptAnchor(recentAfterTurn as any[], turnStartedAt);
                    if (anchorId != null) {
                        const records = [...shareExcerptTurn.calls];
                        await DB.updateMessageMetadata(anchorId, (prev: any) => attachShareExcerptPairs(prev, records));
                    }
                } catch (e) {
                    // 记历史失败不影响这轮回复（片段已经是真实结果，只是下一轮回放会缺这对记录）。
                    console.warn('[share-excerpt] 工具记录落历史失败:', e);
                }
            }

            // B2 空回复可见化：正文空 + 无工具调用 + 漏斗没产出过可见消息时，
            // 落一条可重发的系统提示，而不是静默结束（用户看到"停了但没消息"）。
            // 工具/卡片/生图等非文本产物会走上面的提交漏斗置 turnProducedVisible，不会误报。
            if (!turnProducedVisible
                && !String(rawAiContent || '').trim()
                && !data.choices?.[0]?.message?.tool_calls?.length) {
                await DB.saveMessage({
                    charId: char.id, role: 'system', type: 'text',
                    content: '[空回复] TA 这一轮没有说话，可能是模型开了小差，重新发送一次试试。',
                } as any);
                if (turnAlive()) setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
            }

            // 本地路径回复已全部落库。OSContext 监听这个事件 bump lastMsgTimestamp——
            // 当前挂载的 Chat（可能是切走又切回后新 mount 的实例，本闭包的 setMessages
            // 对它已失效）会重新 reloadMessages；用户不在该会话时补未读 + toast。
            // instant 路径不发：它的落库回落走 'active-msg-received'（activeMsgRuntime）。
            // 旧轮不广播：切角色后旧轮的落库若残留，不应再触发新会话的刷新/未读。
            if (turnAlive()) {
                announceChatGen(CHAT_GEN_EVENTS.replyArrived, { charId: char.id, charName: char.name });
            }

            // 防穿帮闸：仅当这轮请求真的成功、回执确实进了模型上下文并产出已落库的
            // 回复，才标记已告知；失败/中断路径不标，下轮重新注入（回执不丢）。
            // 放在 try 成功尾部（回复已 applyAssistantPostProcessing 落库），与 catch/finally 互斥；
            // amsg2 与 Instant Push 设置页双向互斥，instant 路径在上方已 return（那条分支
            // 只为历史配置兜底保留），这里只覆盖本地 fetch 路径。
            // 旧轮不标：切角色后旧轮残留的成功也不应认领新会话的回执。
            if (turnAlive() && amsg2ExpiredIds.length) {
                void ActiveMsgStore.markExpiredNoticesNotified(char.id, amsg2ExpiredIds);
            }

        } catch (e: any) {
            // 旧轮/卸载：abort 触发的 AbortError 安静退场，不写错误消息、不碰 UI。
            if (turnSignal.aborted || e?.name === 'AbortError') return;
            // 注意: 这个 catch 兜的是「拿到 API 响应之后」的整条后处理管线 (applyAssistantPostProcessing,
            // 13 步)。这里抛错多半不是网络问题, 而是解析/正则/落库异常。别再叫"连接中断"误导排查。
            const errMsg = e?.message || String(e);
            // 单轮调用预算耗尽：这是主动熔断不是故障，文案说清楚"已保留的保留、换个问法"。
            if (String(errMsg).startsWith('[turn-budget]')) {
                await DB.saveMessage({
                    charId: char.id, role: 'system', type: 'text',
                    content: '[调用超限] 本轮工具调用太多已自动停止，已经产生的内容保留着，换个问法或稍后再试。',
                } as any);
            // 瑞一杯模式下报错: 大概率是聊天模型/中转不支持 function calling(tools) → 带 tools 一发就 400。
            // 在 APK 里看不到控制台, 这里把完整原因 + 解法存成可读消息, 方便排查。
            } else if (luckinChatRef?.current?.active && /\b400\b|tool|function[_\s-]?call/i.test(errMsg)) {
                await DB.saveMessage({
                    charId: char.id, role: 'system', type: 'text',
                    content: `[瑞一杯失败] ${errMsg}\n\n大概率是你当前聊天用的「模型/中转」不支持函数调用(function calling / tools)——瑞一杯靠角色自己调工具点单, 模型不支持就会直接报 400。\n解决: 换一个支持 tools 的模型/中转 (如官方 OpenAI / Claude / 多数主流中转)。\n另外确认: APK 是全新存储, 你的聊天 API 配置(密钥/地址/模型)在 APK 里填好了吗?`,
                });
            } else {
                await DB.saveMessage({ charId: char.id, role: 'system', type: 'text', content: `[回复处理失败: ${errMsg}]` });
            }
            // 旧轮的错误不刷到新会话 UI（消息本身归属 char.id 存对了地方，只是不主动刷新）。
            if (turnAlive()) setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
        } finally {
            KeepAlive.stop();
            // 旧轮不碰 UI 状态：新轮活着时 typing 灯和预览属于它；切角色时灯已由 char?.id effect 熄过。
            // （卸载时组件已死，setter 皆为 no-op。）
            const settledCurrent = turnAlive();
            if (settledCurrent) {
                setIsTyping(false);
                setStreamingBubbles([]);  // 错误/中断路径兜底清预览
                setStreamingThinking('');
                setRecallStatus('');
                setSearchStatus('');
                setDiaryStatus('');
                setXhsStatus('');
            }
            // 本轮生成结束（成功/失败/中断都经过）→ 停止本地续租；远端靠 45s TTL 自然失效。
            // 未开过租约（instant push / 非 amsg2 角色）时是幂等 no-op。
            stopAmsgChatPresence(char.id);
            // 全局横幅熄灭（成功/失败/instant 均经过这里；OSContext 同时借它兜底刷新，
            // 覆盖 catch 里落库的错误系统消息）。
            announceChatGen(CHAT_GEN_EVENTS.replyEnd, { charId: char.id, charName: char.name });
            // 兜底熄「发送准备中」灯 (幂等, 正常路径 deliver() 前已熄过)。不加的话
            // config-missing / subscription-failed / 拼 context 阶段 throw 这些没走到
            // POST 的路径都不会调 onInstantPosted, 头部「发送中…」徽章会卡死到刷新
            // —— 2026-07 安卓用户实测: 订阅失败弹了错, 但三个小点到角色回复了都不消失。
            onInstantPosted?.();

            // 满血主动消息：一轮聊完把该角色标脏，fire_pack 随即批量同步到 worker 的
            // client_state（未配 amsg2 任务的角色在 markDirty 内直接忽略，零成本）。
            // 本轮角色自己排过任务时 char 快照上的清单已经过期，得用工具会话里的最新那份
            // 打脏——否则本轮新建的首个任务过不了 markDirty 的 hasActiveAiTask 门，
            // fire_pack 会停在排程那一刻、少掉角色排完之后说的这段。
            // 即时对话受理成功那一轮跳过：那次 POST 已经把这一轮的 fire_pack（还多带了
            // chat 段）传上去了，这里再打脏就是同样的内容再走一趟网络。
            // 旧轮不标脏：快照是旧的，推上去会覆盖新轮的同步内容；新轮收尾时会标。
            if (!instantChatAccepted) {
                if (settledCurrent) {
                    markAmsgStateDirty({
                        char: { ...char, activeMsg2Config: amsg2Session.getConfig() },
                        userProfile, groups, realtimeConfig,
                    });
                }
            }

            // Memory Palace — 后台缓冲区处理（不阻塞 UI，内部有并发锁）
            // 使用全局配置（memoryPalaceConfig）。lightLLM 未配置时回退主 apiConfig；
            // embedding 因端点类型特殊（/embeddings），不做回退，必须显式配置。
            const mpEmb = memoryPalaceConfig?.embedding;
            const mpLLMConfigured = memoryPalaceConfig?.lightLLM;
            const mpLLM = (mpLLMConfigured?.baseUrl)
                ? mpLLMConfigured
                : { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model };
            // 读 ref 拿到最新的 char 状态；同 id 才信任，否则保守跳过（用户已经切角色了）
            const liveChar = charRef.current?.id === char.id ? charRef.current : null;
            if (liveChar?.memoryPalaceEnabled && mpEmb?.baseUrl && mpEmb?.apiKey && mpLLM.baseUrl) {
                const charName = char.name;
                // 不再预置"正在回味"状态：pipeline 会在水位线未到时立刻 skip，
                // 预置状态会让"沉思"指示器一闪让用户误以为在干活。
                // onProgress 在 pipeline 真正进入处理路径后（过完 hot_zone/threshold 检查）
                // 才首次触发 setMemoryPalaceStatus，这样 skip 路径下指示器不会亮。

                // 缓冲区处理（LLM提取 + Embedding向量化）
                const recentMsgs = await DB.getRecentMessagesByCharId(char.id, 50);
                processNewMessagesWithAutoArchive(recentMsgs, char.id, charName, mpEmb, mpLLM, userProfile?.name || '', false, (stage) => {
                        setMemoryPalaceStatus(stage);
                    })
                    .then(async (pipelineResult) => {
                        // pipeline 跑的过程中用户可能又关掉了宫殿，跑完后所有"额外动作"
                        // （autoArchive 写 char.memories / 50 轮认知消化的 LLM 调用）都要再 check 一次。
                        const liveAfter = charRef.current?.id === char.id ? charRef.current : null;
                        if (!liveAfter?.memoryPalaceEnabled) return;

                        // 显示结果让用户看到
                        if (pipelineResult && pipelineResult.stored > 0) {
                            setMemoryPalaceResult(pipelineResult);
                        }

                        // 全自动记忆双写已由统一封装完成，React 外的入口也不会再漏接返回值。
                        // 轮数计数 + 自动认知消化（每50轮触发一次）
                        const shouldAutoDigest = incrementDigestRound(char.id);
                        if (shouldAutoDigest) {
                            console.log(`🧠 [AutoDigest] 已达 50 轮，自动触发认知消化...`);
                            setMemoryPalaceStatus(`${charName}闭上眼睛，开始整理内心…`);
                            const persona = [char.systemPrompt || '', char.worldview || ''].filter(Boolean).join('\n');
                            const result = await runCognitiveDigestion(
                                char.id, charName, persona, mpLLM, false, userProfile?.name, mpEmb,
                                // 消化链路可能含多次 LLM 调用（审视→历史回填续传→门牌整理），
                                // 实时刷状态条让用户知道后台在干活、别急着关页面
                                (stage) => setMemoryPalaceStatus(`${charName}${stage}`),
                            );
                            if (result) {
                                // 自我领悟不再追加到 char.selfInsights（只进不出的旧常驻层）——
                                // 归宿已改为 self_room 门牌（digestion 内部提交），这里只负责弹窗昭告
                                const total = result.resolved.length + result.deepened.length + result.faded.length +
                                    result.fulfilled.length + result.disappointed.length + result.internalized.length +
                                    result.synthesizedUser.length + result.selfInsights.length + result.selfConfused.length +
                                    (result.worries?.length || 0) + (result.aspirations?.length || 0) + (result.distilled?.length || 0);
                                if (total > 0) {
                                    setLastDigestResult(result);
                                }
                            }
                        }
                    })
                    .catch(e => { console.error('❌ [MemoryPalace] 后台处理异常:', e.message); addToast('记忆整理失败', 'error'); })
                    .finally(() => {
                        // 如果状态文本包含"完成"，先让用户看到再清除
                        const current = memoryPalaceStatusRef.current;
                        if (current && current.includes('完成')) {
                            addToast(current, 'success');
                        }
                        setMemoryPalaceStatus('');
                    });
            }

            // 意识流进化现在由副 API 的情绪评估同轮产出（innerState 字段），
            // 不再需要独立的后台 API 调用，也不再分散主 API 注意力。
        }
    };



return {
        isTyping,
        streamingBubbles,
        streamingThinking,
        recallStatus,
        searchStatus,
        diaryStatus,
        xhsStatus,
        emotionStatus,
        memoryPalaceStatus,
        memoryPalaceResult,
        setMemoryPalaceResult,
        lastDigestResult,
        setLastDigestResult,
        lastTokenUsage,
        tokenBreakdown,
        setLastTokenUsage, // Allow manual reset if needed
        triggerAI,
        lastSystemPrompt,
        evolvedNarrative,
    };
};