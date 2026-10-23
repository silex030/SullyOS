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

  const { agentUrl, agentToken } = readAgentRoutingConfig();
  if (!agentUrl) throw new Error('未配置主代理地址，无法使用本机语音');
  // agentRouting 只 trim 不剥尾斜杠，这里自己处理。
  const base = agentUrl.replace(/\/+$/, '');

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
  const voice = (char?.voiceProfile?.mossVoiceId || apiConfig?.mossVoiceId || '').trim();
  return postGenie(text, options?.demo === true, voice, 75_000);
}

/**
 * 试听公开演示音色。**不是角色音色**，只用来让用户在没配参考音频时听到本机效果。
 * 服务端只接受 demo:true → 固定 env 里的公开 demo，不能借这个接口读别人的音色。
 */
export async function synthesizeMossDemoPreview(
  text: string,
  apiConfig?: APIConfig,
): Promise<TtsResult> {
  return synthesizeSpeechGenieDetailed(text, {} as CharacterProfile, apiConfig ?? ({} as APIConfig), { demo: true });
}

export interface MossVoiceProbe {
  /** 主代理是否给出健康响应（false = 网络/令牌/服务问题，不代表「没有音色」）。 */
  reachable: boolean;
  status: MossVoiceStatus;
  error?: string;
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
  const { agentUrl, agentToken } = readAgentRoutingConfig();
  if (!agentUrl) return { ...offline, status: cacheMossStatus({ ...offline.status, state: 'offline' }) };
  const base = agentUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const headers: Record<string, string> = {};
    if (agentToken) headers['X-Client-Token'] = agentToken;
    const res = await fetch(`${base}/agent/v1/tts/health`, { headers, signal: controller.signal });
    if (!res.ok) return { reachable: false, status: cacheMossStatus({ ...offline.status, state: 'offline' }) };
    let raw: unknown = null;
    try {
      raw = await res.json();
    } catch {
      raw = null;
    }
    return { reachable: true, status: cacheMossStatus(normalizeMossVoiceHealth(raw)) };
  } catch {
    return { reachable: false, status: cacheMossStatus({ ...offline.status, state: 'offline' }) };
  } finally {
    clearTimeout(timer);
  }
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
