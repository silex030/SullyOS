/**
 * 本机 MOSS-TTS-Nano 客户端（CPU 常驻，中文；见 docs/superpowers/specs/2026-09-28-nano-tts-adapter-design.md）。
 *
 * 走主代理中转 `${agentUrl}/agent/v1/tts` → main-agent → 本机 runtime（127.0.0.1:19890）。
 * 这一层只做四件事：
 *   1. 剥掉所有 TTS 专属标记（Nano 不支持 inline cue）
 *   2. 组请求体：只有 {text}，试听时额外显式 demo:true（音色 id 只由服务端 env 决定）
 *   3. 把错误码翻成人话（缺参考音频必须报「待配置」，绝不放假音频）
 *   4. audio/wav → Blob + Blob URL
 *
 * 与另外三家的差异：没有 API Key、没有 per-char 音色，所以 ttsRouter 里
 * characterHasVoice / canSynthesizeSpeech 对本地语音无条件返回 true；
 * 「到底能不能出声」由 probeMossVoiceStatus 读真实健康判断。
 */
import type { APIConfig, CharacterProfile } from '../types';
import { cleanTextForTts, cleanVoiceMarkupForDisplay, type TtsResult } from './minimaxTts';
import type { SynthOptions } from './ttsRouter';
import { readAgentRoutingConfig } from './agentRouting';
import { normalizeMossVoiceHealth, type MossVoiceStatus } from './mossTtsStatus';

/**
 * 错误码 → 人话。
 * 本机 runtime 的细码（no_ref_voice / reference_invalid / model_loading / busy …）和
 * 主代理折叠后的粗码（synth_failed / nano_unavailable）两套都映射，将来换接线不用再改前端。
 * no_ref_voice 必须说清「待配置」——绝不能拿假音频或公开演示糊过去。
 */
const ERROR_TEXT: Record<string, string> = {
  bad_request: '请求格式不正确',
  empty: '没有可朗读的文字',
  synth_failed: '语音合成失败；若用本地语音，请先为该角色配置参考音频',
  nano_unavailable: '本机语音服务暂时不可用',
  no_ref_voice: '该角色还没有配置本地声音（需要 3-15 秒干净中文 WAV 参考音频）',
  reference_invalid: '参考音频不符合要求（需要 3-15 秒、单声道 WAV）',
  payload_too_large: '参考音频超过 10MB 上限',
  unsupported_media: '只接受 WAV 格式的参考音频',
  text_too_long: '这段话太长，本机语音单次约 400 字上限；拆成几段再发即可',
  model_loading: '本地语音模型正在加载，请稍后再试',
  model_unavailable: '本地语音模型未就绪',
  resource_low: '服务器内存紧张，暂时无法本地合成',
  busy: '本地语音正在忙，请稍后再试',
  timeout: '语音合成超时（本地排队过久）',
};

/**
 * 阶段 A 是 opt-in：只有显式写 true 才启用。
 * 用户要的「默认开启」由设置开关落地（用户点了「本地语音」才写 true），
 * 不能在这里把 undefined 当 true——模型在本机准备好不等于该替用户全局切换。
 */
export function isGenieVoiceEnabled(apiConfig: APIConfig): boolean {
  return apiConfig.genieVoiceEnabled === true;
}

const GENIE_EMOTIONS = ['calm', 'happy', 'sad', 'angry', 'surprised', 'fearful', 'fluent'] as const;

/** auto 跟随 <语音 emotion>，fixed 用配置值；非白名单一律回落 calm。 */
export function resolveGenieEmotion(
  options: SynthOptions | undefined,
  apiConfig: APIConfig,
): string {
  const raw = apiConfig.genieEmotionMode === 'fixed'
    ? apiConfig.genieEmotion
    : options?.emotion;
  return raw && (GENIE_EMOTIONS as readonly string[]).includes(raw) ? raw : 'calm';
}

/** Nano 不理解任何 inline cue：只保留 <语音> 块内的正文，其余全剥。 */
export function cleanTextForTtsGenie(raw: string): string {
  return cleanVoiceMarkupForDisplay(cleanTextForTts(raw))
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function postGenie(text: string, demo: boolean, voice: string, timeoutMs: number): Promise<TtsResult> {
  const spoken = cleanTextForTtsGenie(text);
  if (!spoken) throw new Error('没有可朗读的文字');

  const { agentToken } = readAgentRoutingConfig();
  // 基址统一走候选解析：剥掉误粘的 `/agent` 前缀，没填时回落到同源反代。
  // 合成是 POST，只挑一个基址，绝不为了兜底把同一段话合成两次。
  const base = mossAgentBaseForWrite();

  const controller = new AbortController();
  // 本地 CPU 合成比云慢，但仍要快速失败：超过 75 秒基本是卡死或排队积压。
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (agentToken) headers['X-Client-Token'] = agentToken;
    const res = await fetch(`${base}/agent/v1/tts`, {
      method: 'POST',
      headers,
      // 只发 text/voice；试听公开演示靠 demo:true（具体 demo id 在主代理 env，浏览器不能自选）。
      // voice 只是「选哪个已授权的本机音色」，主代理会按服务端白名单校验，给未知 ID 一律 409。
      body: JSON.stringify(
        demo ? { text: spoken, demo: true }
          : voice ? { text: spoken, voice }
            : { text: spoken },
      ),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(await readErrorText(res));
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 44) throw new Error('语音服务返回了空音频');
    const blob = new Blob([buf], { type: 'audio/wav' });
    return { url: URL.createObjectURL(blob), blob };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error('语音合成超时');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function synthesizeSpeechGenieDetailed(
  text: string,
  char: CharacterProfile,
  apiConfig: APIConfig,
  options?: SynthOptions,
): Promise<TtsResult> {
  // 角色单独指定的本机音色优先；没有就用设置页的全局本机音色；
  // 都没选就交给服务端默认。前端不猜、也不拿别的角色音色顶替。
  const voice = resolveMossVoiceId(char, apiConfig);
  return postGenie(text, options?.demo === true, voice, 75_000);
}

/**
 * 角色实际使用的本机音色 ID：角色 > 全局 > 空串（服务端默认）。
 * 纯函数，单独导出便于回归「两个角色各选各的不串音」。
 */
export function resolveMossVoiceId(
  char: Pick<CharacterProfile, 'voiceProfile'> | null | undefined,
  apiConfig: Pick<APIConfig, 'mossVoiceId'> | null | undefined,
): string {
  return (char?.voiceProfile?.mossVoiceId || '').trim() || (apiConfig?.mossVoiceId || '').trim();
}

/** 与主代理/relay 一致的音色 ID 形状。前端先挡一次，避免把路径发给后端。 */
const MOSS_VOICE_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
/** 2 秒 48k 立体声 16bit ≈ 384KB；留足余量，超限一律拒播。 */
export const MAX_MOSS_PREVIEW_BYTES = 2 * 1024 * 1024;

/**
 * 取「某个已授权音色」的约 2 秒试听副本（鉴权主代理转发，asset 不进静态站）。
 * 与合成完全分开：不跑模型、不写任何配置、不带 demo:true。
 */
export async function fetchMossVoicePreview(voiceId: string, timeoutMs = 15_000): Promise<TtsResult> {
  const id = typeof voiceId === 'string' ? voiceId.trim() : '';
  if (!MOSS_VOICE_ID_RE.test(id)) throw new Error('音色 ID 不合法，无法试听');

  const { agentToken } = readAgentRoutingConfig();
  // 试听是 GET，按候选逐个试不会产生副作用（失败只换下一个基址）。
  const bases = mossAgentBaseCandidates();
  if (bases.length === 0) throw new Error('未配置主代理地址，无法试听本机音色');
  let lastError: Error | null = null;
  for (const base of bases) {
    try {
      return await fetchPreviewFrom(base, id, agentToken, timeoutMs);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError ?? new Error('试听暂时不可用，请稍后再试');
}

async function fetchPreviewFrom(base: string, id: string, agentToken: string, timeoutMs: number): Promise<TtsResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {};
    if (agentToken) headers['X-Client-Token'] = agentToken;
    const res = await fetch(`${base}/agent/v1/tts/preview?voice=${encodeURIComponent(id)}`, {
      headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      if (res.status === 403 || res.status === 401) throw new Error('没有访问本机语音的权限（主代理鉴权失败，请检查令牌）');
      if (res.status === 404) throw new Error('该音色没有可试听的片段');
      if (res.status === 409 || res.status === 400) throw new Error('这个音色不在已授权范围内（或还没有注册参考音频）');
      throw new Error('试听暂时不可用，请稍后再试');
    }
    const ctype = String(res.headers.get('content-type') || '').toLowerCase();
    if (!ctype.includes('audio/')) throw new Error('试听返回的不是音频（已拒绝播放）');
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 44 || buf.byteLength > MAX_MOSS_PREVIEW_BYTES) {
      throw new Error('试听返回的音频为空或过大（已拒绝播放）');
    }
    const blob = new Blob([buf], { type: ctype.includes('wav') ? 'audio/wav' : 'audio/mpeg' });
    return { url: URL.createObjectURL(blob), blob };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw new Error('试听加载超时，请稍后再试');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export interface MossVoiceProbe {
  /** 主代理是否给出健康响应（false = 网络/令牌/服务问题，不代表「没有音色」）。 */
  reachable: boolean;
  status: MossVoiceStatus;
  error?: string;
  /** 实际探通的那个基址（'' / '同源' = 同源兜底）；仅用于诊断展示，不含令牌。 */
  base?: string;
}

/**
 * 主代理基址候选：配置优先，同源兜底。
 *
 * 2026-10-24 线上反馈（本地语音已选 → 一直「已选·未连接」+ 音色列表空）复核：
 * `/agent/*` 由托管前端的同一台机器反代，所以**页面同源本身就是一条可用通道**；
 * 而 `agentUrl` 要用户手填，一旦留空 / 填成网站根 / 把文档里的 `/agent` 前缀一起
 * 粘进来，拼出来就是 `.../agent/agent/v1/tts/health` —— 主代理在路由前先鉴权，
 * 所以这种情况和「令牌错」一样只回 403，UI 无从区分，用户只能反复重填令牌。
 *
 * 这不是该让用户修的配置，所以探活/试听/合成按顺序试候选，并在失败时给出
 * 「是网页不是接口 / 令牌被拒 / 连不上」三种不同的说法。只影响本机语音这条路，
 * 不改任何其他请求的中转路由，也不改用户选的服务商。
 */
export function mossAgentBaseCandidates(): string[] {
  const { agentUrl } = readAgentRoutingConfig();
  // 用户可能把 `/agent` 或 `/agent/v1` 一起粘进来（文档里的接口路径就带这个前缀）。
  const base = String(agentUrl || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/agent(\/v1)?$/, '')
    .replace(/\/+$/, '');
  const out: string[] = [];
  if (base) out.push(base);
  // '' = 相对当前站点。只在 http(s) 页面里加，jsdom/本地文件不参与。
  if (typeof window !== 'undefined' && /^https?:$/.test(String(window.location?.protocol || ''))) {
    out.push('');
  }
  return [...new Set(out)];
}

/** 写入类请求（POST 合成）只挑一个基址：不能为了兜底把同一段话合成两次。 */
export function mossAgentBaseForWrite(): string {
  const bases = mossAgentBaseCandidates();
  if (bases.length === 0) throw new Error('未配置主代理地址，无法使用本机语音');
  return bases[0];
}

/**
 * 最近一次健康状态（模块级缓存）。
 * 为什么要缓存：聊天的「要不要自动合成」是同步判断，而探活是异步的。
 * 缓存只用于**自动**合成的门；用户手点的合成永远照发（由服务端给真实错误码）。
 */
let cachedMossStatus: MossVoiceStatus | null = null;
let cachedMossAt = 0;

function cacheMossStatus(status: MossVoiceStatus): MossVoiceStatus {
  cachedMossStatus = status;
  cachedMossAt = Date.now();
  return status;
}

/**
 * 同步判断「本机语音现在真能出声」：必须 ready **且** 有参考音频。
 * 没探过 / 探不通 / 缺参考一律 false —— 宁可不自动合成，也不要每条消息弹一次失败。
 */
export function isMossVoiceUsableSync(): boolean {
  return cachedMossStatus?.ready === true && cachedMossStatus.referenceConfigured === true;
}

/** 探活并写缓存（默认 30 秒内复用，避免每条消息都打一次 health）。 */
export async function refreshMossVoiceStatus(maxAgeMs = 30_000): Promise<MossVoiceStatus> {
  if (cachedMossStatus && Date.now() - cachedMossAt < maxAgeMs) return cachedMossStatus;
  return cacheMossStatus((await probeMossVoiceStatus()).status);
}

/**
 * 读真实健康状态（免费、不触发生成、不花钱）。
 * 不抛异常：UI 需要的是「连不上」这个事实本身，而不是一个要 catch 的错误。
 */
export async function probeMossVoiceStatus(_apiConfig?: APIConfig): Promise<MossVoiceProbe> {
  const offline: MossVoiceProbe = { reachable: false, status: normalizeMossVoiceHealth(null) };
  // 与合成同一套路由读取（localStorage 里的 agentUrl/agentToken），设置改了立即生效。
  const { agentToken } = readAgentRoutingConfig();
  const bases = mossAgentBaseCandidates();
  if (bases.length === 0) {
    return { ...offline, error: '还没填主代理地址', status: cacheMossStatus({ ...offline.status, state: 'offline' }) };
  }

  let lastError = '';
  // 逐个候选试：配置的那条失败时同源可能仍然可用（前端就托管在反代这台机器上）。
  for (const base of bases) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const headers: Record<string, string> = {};
      if (agentToken) headers['X-Client-Token'] = agentToken;
      const res = await fetch(`${base}/agent/v1/tts/health`, { headers, signal: controller.signal });
      if (!res.ok) {
        lastError = await classifyProbeFailure(res);
        continue;
      }
      // 静态站对未知路径会回 index.html（200 + text/html）。那不是健康数据，
      // 之前会被当成 reachable=true + 空音色目录，UI 于是说「服务端没注册音色」，
      // 把用户引到完全错误的排查方向。这里必须先确认拿到的是 JSON。
      const ctype = String(res.headers.get('content-type') || '').toLowerCase();
      let raw: unknown = null;
      try {
        raw = await res.json();
      } catch {
        raw = null;
      }
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        lastError = ctype.includes('html')
          ? '这个地址返回的是网页，不是主代理接口：检查是否填成了网站地址，或少了 /agent 前缀'
          : '这个地址返回的不是主代理健康数据';
        continue;
      }
      return {
        reachable: true,
        base: base || '同源',
        status: cacheMossStatus(normalizeMossVoiceHealth(raw)),
      };
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === 'AbortError';
      lastError = aborted ? '主代理 5 秒内没有响应' : '连不上主代理（网络错误或跨域被拦）';
    } finally {
      clearTimeout(timer);
    }
  }

  return { ...offline, error: lastError || '连不上主代理', status: cacheMossStatus({ ...offline.status, state: 'offline' }) };
}

/**
 * 探活失败的原因分类。只给结论，不回显地址或令牌本身。
 *
 * 403 有两种完全不同的原因，而主代理在路由前就鉴权，所以**路径写错也报 403**：
 * 只能说「令牌不对，或地址里多带了 /agent」，不能断言是令牌。
 */
async function classifyProbeFailure(res: Response): Promise<string> {
  if (res.status === 401 || res.status === 403) {
    return '主代理拒绝了访问：令牌不对，或地址里多带了 /agent';
  }
  if (res.status === 404) return '主代理没有这个接口（地址可能少了 /agent）';
  if (res.status >= 500) return `主代理出错了（${res.status}）`;
  return `主代理返回 ${res.status}`;
}

async function readErrorText(res: Response): Promise<string> {
  let code = '';
  try {
    const parsed = JSON.parse(await res.text());
    code = typeof parsed?.error === 'string' ? parsed.error : '';
  } catch {
    code = '';
  }
  return ERROR_TEXT[code] ?? `语音服务返回 ${res.status}`;
}
