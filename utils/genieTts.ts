/**
 * Genie-TTS（VPS 自建，中文克隆）客户端。
 *
 * 走主代理中转 `${agentUrl}/agent/v1/tts` → main-agent → VPS 适配层 → Genie。
 * 适配层已把情绪表、队列、分块与 WAV 包裹做完，这里负责：
 *   1. 剥掉所有 TTS 专属标记（Genie 不支持任何 inline cue）
 *   2. 组请求体（text；Nano 无情绪参数）
 *   3. 把错误码翻成人话
 *   4. audio/wav → Blob + Blob URL
 *
 * 与另外三家的差异：没有 API Key、没有 per-char 音色，所以 ttsRouter 里
 * characterHasVoice / canSynthesizeSpeech 对 genie 无条件返回 true。
 */
import type { APIConfig, CharacterProfile } from '../types';
import { cleanTextForTts, cleanVoiceMarkupForDisplay, type TtsResult } from './minimaxTts';
import type { SynthOptions } from './ttsRouter';
import { readAgentRoutingConfig } from './agentRouting';

/**
 * 错误码 → 人话。
 * 本地 GPT-SoVITS relay 会返回比 Nano 更细的码（no_ref_voice / model_loading / busy …）；
 * 主代理目前把它们统一折成 synth_failed / nano_unavailable，所以这里两套都映射，
 * 将来接线改成直连时不用再改前端。
 * no_ref_voice 必须说清「待配置」——绝不能拿假音频糊过去。
 */
const ERROR_TEXT: Record<string, string> = {
  bad_request: '请求格式不正确',
  empty: '没有可朗读的文字',
  synth_failed: '语音合成失败；若用本地语音，请先为该角色配置参考音频',
  nano_unavailable: '语音服务暂时不可用',
  no_ref_voice: '该角色还没有配置本地声音（需要 3-10 秒干净中文录音 + 逐字稿）',
  model_loading: '本地语音模型正在加载，请稍后再试',
  model_unavailable: '本地语音模型未就绪',
  resource_low: '服务器内存紧张，暂时无法本地合成',
  busy: '本地语音正在忙，请稍后再试',
  timeout: '语音合成超时（本地排队过久）',
};

/**
 * 阶段 A 是 opt-in：只有显式写 true 才启用。
 * 用户要的「默认开启」由阶段 B 的设置开关落地（UI 默认勾选 + 保存时写入 true），
 * 不能在这里把 undefined 当 true——阶段 A 没有 UI，老用户会被切走且无法关闭。
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

/** Genie 不理解任何 inline cue：只保留 <语音> 块内的正文，其余全剥。 */
export function cleanTextForTtsGenie(raw: string): string {
  return cleanVoiceMarkupForDisplay(cleanTextForTts(raw))
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export async function synthesizeSpeechGenieDetailed(
  text: string,
  char: CharacterProfile,
  apiConfig: APIConfig,
  options?: SynthOptions,
): Promise<TtsResult> {
  void char;
  const spoken = cleanTextForTtsGenie(text);
  if (!spoken) throw new Error('没有可朗读的文字');

  const { agentUrl, agentToken } = readAgentRoutingConfig();
  if (!agentUrl) throw new Error('未配置主代理地址，无法使用 Genie-TTS');
  // agentRouting 只 trim 不剥尾斜杠，这里自己处理。
  const base = agentUrl.replace(/\/+$/, '');

  const controller = new AbortController();
  // 本地 relay 自己的排队上限是 60 秒（超时后返回 504 timeout），这里留 15 秒余量。
  // 从 135s 收到 75s：本地合成失败时要快速反馈，不能让用户干等两分多钟。
  const timer = setTimeout(() => controller.abort(), 75_000);
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (agentToken) headers['X-Client-Token'] = agentToken;
    const res = await fetch(`${base}/agent/v1/tts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: spoken }),
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
