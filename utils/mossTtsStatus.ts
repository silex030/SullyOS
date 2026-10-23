/**
 * 本机 MOSS-TTS-Nano 的状态归一（纯函数，无网络、无副作用）。
 *
 * 为什么单独一片：Settings 的选项徽标、聊天里的「语音待配置」提示都要同一套判断。
 * 唯一的真相是主代理 `/agent/v1/tts/health` 转来的 runtime `/health`
 * （`{ready, model, referenceConfigured}`）——**不允许**由前端常量硬编码「可用」。
 *
 * 语义边界：
 *   - ready + referenceConfigured → 角色音色能用（用户自己的参考音频）
 *   - ready + 没有参考音频        → 只能听各音色的 2 秒参考副本（音色示例），不是角色音色
 *   - ready=false                → 模型没加载好，不当成可用
 *   - 探不通                     → 未连接，不猜成功
 */

export type MossVoiceState = 'ready' | 'needs_reference' | 'starting' | 'offline' | 'unknown';

export interface MossVoiceOption {
  /** 服务端白名单内的短 ID（唯一可用于选择和上行的值）。 */
  id: string;
  /** 展示名；缺省回退为 ID。 */
  label: string;
  /** 来源说明（例如「用户本人提供」「AISHELL-3（Apache-2.0）」），可为空。 */
  origin: string;
  /** 该音色是否有约 2 秒试听片段（后端按私有预览文件是否真实存在给出）。 */
  preview: boolean;
  /** relay 是否真的注册了参考音频（缺参考时选择仍可保存，合成会报 no_ref_voice）。 */
  registered: boolean;
}

export interface MossVoiceStatus {
  state: MossVoiceState;
  ready: boolean;
  referenceConfigured: boolean;
  /** 公开演示音色可试听（契约里没有单独字段，只在 ready 时放行试听）。 */
  demoAvailable: boolean;
  model?: string;
  /**
   * 主代理白名单里可选的本机音色 ID（服务端 env 决定，前端只做选择，不能自造）。
   * 是「可选清单」而不是「已注册清单」：真缺参考音频时合成会明确报 no_ref_voice。
   */
  voices: string[];
  /** 与 voices 同源的结构化目录（展示名 / 来源 / 试听可用），由鉴权后端权威返回。 */
  voiceOptions: MossVoiceOption[];
}

/** 与 relay/main-agent 一致的音色 ID 形状：短的安全标识符，不含路径/空格。 */
const VOICE_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** 只保留服务端给的合法 ID（去重保序）。非法值一律丢弃，不塞进下拉框。 */
function normalizeVoiceIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (VOICE_ID_RE.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** 展示文本只做最少净化：去控制字符、压空白、限长；不含路径或 HTML（React 会转义）。 */
function displayText(raw: unknown, fallback: string, maxLen: number): string {
  if (typeof raw !== 'string') return fallback;
  const text = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return text ? text.slice(0, maxLen) : fallback;
}

/**
 * 结构化音色目录。只认后端 voiceOptions；缺失时按旧版 voices[] 构造最小选项
 * （label=id、无来源、无试听），绝不补任何前端已知音色。顺序跟随服务端。
 */
function normalizeVoiceOptions(raw: unknown, fallbackIds: string[]): MossVoiceOption[] {
  const out: MossVoiceOption[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      const id = typeof rec.id === 'string' ? rec.id.trim() : '';
      if (!VOICE_ID_RE.test(id) || seen.has(id)) continue;
      seen.add(id);
      const label = displayText(rec.label, id, 40);
      const origin = displayText(rec.origin, '', 60);
      out.push({
        id,
        label,
        origin,
        preview: rec.preview === true,
        registered: rec.registered === true,
      });
    }
  }
  if (out.length > 0) return out;
  return fallbackIds.map((id) => ({ id, label: id, origin: '', preview: false, registered: false }));
}

/** runtime `/health` → 状态。任何非布尔/非对象输入都收敛成 unknown，绝不乐观兜底。 */
export function normalizeMossVoiceHealth(raw: unknown): MossVoiceStatus {
  const base: MossVoiceStatus = {
    state: 'unknown',
    ready: false,
    referenceConfigured: false,
    demoAvailable: false,
    voices: [],
    voiceOptions: [],
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const rec = raw as Record<string, unknown>;
  const ready = rec.ready === true;
  const referenceConfigured = rec.referenceConfigured === true;
  const model = typeof rec.model === 'string' && rec.model.trim() ? rec.model.trim() : undefined;
  const declaredIds = normalizeVoiceIds(rec.voices);
  const voiceOptions = normalizeVoiceOptions(rec.voiceOptions, declaredIds);
  // voices 是 voiceOptions 的 ID 投影：两边永远同源，避免 UI 列表与上行值不一致。
  const voices = voiceOptions.map((v) => v.id);
  const state: MossVoiceState = !ready
    ? (rec.ready === false ? 'starting' : 'unknown')
    : (referenceConfigured ? 'ready' : 'needs_reference');
  return { state, ready, referenceConfigured, demoAvailable: ready, voices, voiceOptions, ...(model ? { model } : {}) };
}

/** 按 ID 取选项（给「继承全局」显示当前音色名用）。 */
export function voiceOptionById(status: MossVoiceStatus | null | undefined, id: string): MossVoiceOption | undefined {
  if (!status || !id) return undefined;
  return status.voiceOptions.find((v) => v.id === id);
}

export interface MossVoiceStatusText {
  /** 选项右侧徽标（例如「使用中」「已选 · 待配置」）。 */
  badge: string;
  /** 一行说明，含下一步该怎么办。 */
  detail: string;
}

/**
 * 状态 → 界面文案。
 * 硬约束：只有 ready 才允许出现「使用中」；任何状态都不出现「已成功」，
 * 也不把公开演示音色说成角色音色。
 */
export function describeMossVoiceStatus(status: MossVoiceStatus): MossVoiceStatusText {
  switch (status.state) {
    case 'ready':
      return {
        badge: '使用中',
        detail: '本机 MOSS-TTS-Nano 就绪，用的是本机已配置的参考音频（仅中文）。',
      };
    case 'needs_reference':
      return {
        badge: '已选 · 待配置参考音频',
        detail: '本机模型已就绪，但还没有角色参考音频：需要 3-15 秒干净中文 WAV（单声道、16kHz 左右，≤10MB）。'
          + '在配置完成前，只能听各音色的 2 秒示例（参考音频副本），不能当角色声音。',
      };
    case 'starting':
      return {
        badge: '已选 · 未就绪',
        detail: '本机语音模型还没加载完（首次启动较慢）；就绪前合成会失败，可稍后重试。',
      };
    case 'offline':
      return {
        badge: '已选 · 未连接',
        detail: '连不上主代理（或本机语音 runtime 没起来）：先确认主代理地址/令牌，再看本机 19890 服务状态。',
      };
    default:
      return {
        badge: '已选 · 状态未知',
        detail: '还没拿到主代理返回的健康信息：确认主代理地址可访问，稍后重试。',
      };
  }
}
