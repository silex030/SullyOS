/**
 * 本机 MOSS-TTS-Nano 的状态归一（纯函数，无网络、无副作用）。
 *
 * 为什么单独一片：Settings 的选项徽标、聊天里的「语音待配置」提示都要同一套判断。
 * 唯一的真相是主代理 `/agent/v1/tts/health` 转来的 runtime `/health`
 * （`{ready, model, referenceConfigured}`）——**不允许**由前端常量硬编码「可用」。
 *
 * 语义边界：
 *   - ready + referenceConfigured → 角色音色能用（用户自己的参考音频）
 *   - ready + 没有参考音频        → 只能试听「公开演示音色」，不是角色音色
 *   - ready=false                → 模型没加载好，不当成可用
 *   - 探不通                     → 未连接，不猜成功
 */

export type MossVoiceState = 'ready' | 'needs_reference' | 'starting' | 'offline' | 'unknown';

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

/** runtime `/health` → 状态。任何非布尔/非对象输入都收敛成 unknown，绝不乐观兜底。 */
export function normalizeMossVoiceHealth(raw: unknown): MossVoiceStatus {
  const base: MossVoiceStatus = {
    state: 'unknown',
    ready: false,
    referenceConfigured: false,
    demoAvailable: false,
    voices: [],
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const rec = raw as Record<string, unknown>;
  const ready = rec.ready === true;
  const referenceConfigured = rec.referenceConfigured === true;
  const model = typeof rec.model === 'string' && rec.model.trim() ? rec.model.trim() : undefined;
  const voices = normalizeVoiceIds(rec.voices);
  const state: MossVoiceState = !ready
    ? (rec.ready === false ? 'starting' : 'unknown')
    : (referenceConfigured ? 'ready' : 'needs_reference');
  return { state, ready, referenceConfigured, demoAvailable: ready, voices, ...(model ? { model } : {}) };
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
          + '在配置完成前，只能试听公开演示音色，不能当角色声音。',
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
