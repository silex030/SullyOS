/**
 * 出行 · 真实的角色选点出口（decisionPort 的生产实现）
 *
 * 这里回答一个主审问题：「`decisionPort` 是不是永远注入 stub？」——不是。
 * 这份实现真的会发一次 chat/completions：
 *
 * - 凭据**复用既有模型配置**（由调用方注入 baseUrl/apiKey/model；index.ts 从 worker 现有的
 *   `LLM_*` 环境读，和别的后台能力同一来源），不新建第二套密钥体系；
 * - 人格与记忆只取既有 `fire_pack` 渲染文本（角色设定/世界/生活），**不含任何坐标**；
 * - 候选只给地名/类别/距离与真实 ID，坐标在 `toDecisionCandidates` 就被结构性丢掉；
 * - 输出必须是一次严格 JSON，`kind` 只认四种；解析失败/超时/非 2xx 一律抛错，
 *   由 `decideWishAction` 落到 `wait`（愿望保留，不伪造「角色改变主意」）；
 * - 情绪/亲密度系统当前不存在 → 提示词里就没有这两个维度，不生成分值、不随机心情。
 *
 * 诚实边界：这份实现用的是 **worker 级的模型凭据**。每用户的 `llm_credentials` 表行
 * 走的是端到端加密信封（只有上游 hook 的 `resolveLlmCredential` 能解），本批没有把它
 * 接进来 —— 缺凭据时决策端口直接缺席（`null`），tick 会停在 `wait`，不会假装有人格判断。
 */

import { assertPromptSafe, scanTextForLeak } from '../../../../utils/travel/privacy';
import type { TravelDecisionPort, TravelSegmentContext } from './decision';

export interface TravelModelCredentials {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface TravelModelCallInput {
  system: string;
  user: string;
  timeoutMs?: number;
}

/**
 * 一次真实模型调用：返回正文文本（也可以连真实 usage 一起回）。
 * 非 2xx / 空正文 / 超时 → 抛错。
 */
export type TravelModelCallResult = string | { text: string; totalTokens?: number };
export type TravelModelCall = (input: TravelModelCallInput) => Promise<TravelModelCallResult>;

export const TRAVEL_DECISION_TIMEOUT_MS = 20_000;

/** 凭据是否够用（缺一个就当没有，不做空 Key 请求）。 */
export function isUsableModelCredentials(
  creds: Partial<TravelModelCredentials> | null | undefined,
): creds is TravelModelCredentials {
  return !!creds
    && typeof creds.baseUrl === 'string' && creds.baseUrl.trim().length > 0
    && typeof creds.apiKey === 'string' && creds.apiKey.trim().length > 0
    && typeof creds.model === 'string' && creds.model.trim().length > 0;
}

/**
 * OpenAI 兼容的 chat/completions 调用器。地址口径与既有 `normalizeChatApiUrl` 一致：
 * 传进来的是 baseUrl，这里补 `/chat/completions`（已经是完整地址就直接用）。
 */
export function createTravelModelCaller(input: {
  credentials: TravelModelCredentials;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}): TravelModelCall {
  const base = input.credentials.baseUrl.trim().replace(/\/+$/, '');
  const url = /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
  const timeoutMs = Math.max(1_000, Math.trunc(input.timeoutMs ?? TRAVEL_DECISION_TIMEOUT_MS));
  return async ({ system, user, timeoutMs: perCall }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1_000, Math.trunc(perCall ?? timeoutMs)));
    try {
      const response = await (input.fetch ?? globalThis.fetch)(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${input.credentials.apiKey.trim()}`,
        },
        body: JSON.stringify({
          model: input.credentials.model.trim(),
          temperature: 0.7,
          stream: false,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`travel-decision-http-${response.status}`);
      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: { total_tokens?: unknown };
      };
      const content = body?.choices?.[0]?.message?.content;
      const text = typeof content === 'string' ? content : '';
      if (!text.trim()) throw new Error('travel-decision-empty');
      // 供应商回了真实 usage 就带出去（结算用它，而不是预估值）；没回就不编。
      const rawTotal = Number(body?.usage?.total_tokens);
      return Number.isFinite(rawTotal) && rawTotal > 0
        ? { text, totalTokens: Math.trunc(rawTotal) }
        : text;
    } finally {
      clearTimeout(timer);
    }
  };
}

const SYSTEM_PROMPT = [
  '你在扮演一个有自己的生活的角色。现在你要决定：这一次想不想出门、去哪里。',
  '规则：',
  '1. 只能从给定的候选里挑一个（用它的 id），或者说「换一批」「算了」「再等等」。',
  '2. 不要编造候选里没有的地点，也不要提到坐标、门牌号或任何定位细节。',
  '3. 出门不是义务：累了、没兴趣、想待着，都可以选择「再等等」或「算了」。',
  '4. 只用 JSON 回答，形如 {"kind":"choose","candidateId":"...","reason":"一句话"}；',
  '   其他可用的 kind 是 "reroll" / "drop" / "wait"。',
].join('\n');

const SEGMENT_SYSTEM_PROMPT = [
  '你在扮演一个有自己的生活的角色。你现在正走到一处、也待了一阵子。',
  '接下来做什么由你自己决定，没有人要求你继续走，也没有人要求你回家。',
  '可选的回答只有四种：',
  '  {"kind":"next","candidateId":"...","reason":"一句话"}  从给定的地方里挑下一个想去的',
  '  {"kind":"stay","minutes":30,"reason":"一句话"}          就在这儿再待一会儿',
  '  {"kind":"return","reason":"一句话"}                     想回家了',
  '  {"kind":"stop","reason":"一句话"}                       今天就到这儿，不想再走了',
  '规则：只能挑给定 id 的地方，不要编地点；不要提到坐标、门牌或定位细节；',
  '不累也可以继续逛，累了想回去也正常；没有情绪分或好感度这类数字。',
  '只用 JSON 回答。',
].join('\n');

const INTENT_SYSTEM_PROMPT = [
  '你在扮演一个有自己的生活的角色。没有人在跟你说话，也没有人要求你出门。',
  '你自己想一想：现在想不想出去走走？',
  '三种回答：',
  '  {"want":"none"}                                    不想出门（待着也很好，这是正常答案）',
  '  {"want":"wander"}                                  想随便走走，没有具体目的地',
  '  {"want":"go","wish":"一句话","category":"类别"}   想去某类地方（说类别，不写地址/门牌/坐标）',
  '不要为了「有产出」而说要出门；不要提到坐标、门牌或任何定位细节。只用 JSON 回答。',
].join('\n');

export interface TravelDecisionContext {
  /** 角色设定 + 世界设定 + 最近生活（来自既有 fire_pack 渲染，调用方保证不含坐标）。 */
  persona?: string | null;
  /** 角色最近自己的记录/日记摘要（可选）。 */
  memory?: string | null;
}

export interface CreateTravelDecisionPortInput extends TravelDecisionContext {
  callModel: TravelModelCall;
  maxReasonChars?: number;
}

/**
 * 人格/记忆文本的脱敏：**按行**丢掉含坐标或住户级细节的行，而不是整段拒绝。
 * 聊天模板里用户可能自己提过地址，整段拒绝会让决策永远停在 wait；逐行丢弃既能
 * 保住人格语义，又不会把门牌/坐标送进模型。
 */
export function sanitizePersonaText(raw: string, maxChars = 1_200): string {
  const lines = String(raw ?? '').split(/\r?\n/);
  const kept: string[] = [];
  let total = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let leaks: string[] = [];
    try {
      leaks = scanTextForLeak(trimmed);
    } catch {
      leaks = [];
    }
    if (leaks.length > 0) continue;
    if (total + trimmed.length > maxChars) break;
    kept.push(trimmed);
    total += trimmed.length;
  }
  return kept.join('\n');
}

const clip = (text: string, max: number): string => {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
};

/**
 * 生产 decisionPort。返回的对象直接交给 `runTravelTick` 的 `wiring.decisionPort`。
 * `choose()` 抛错是**预期行为**之一：tick 会把它当成「这一轮没结论」，不写任何状态。
 */
/** 把 callModel 的返回值统一成「正文 + 可选真实 usage」。 */
const readModelText = (result: TravelModelCallResult): { text: string; totalTokens?: number } =>
  typeof result === 'string' ? { text: result } : { text: result?.text ?? '', totalTokens: result?.totalTokens };

export function createTravelDecisionPort(input: CreateTravelDecisionPortInput): TravelDecisionPort {
  // 先逐行脱敏再截断：人格里可以有城市，但不能有坐标/门牌。
  const persona = sanitizePersonaText(String(input.persona ?? ''), 1_200);
  const memory = sanitizePersonaText(String(input.memory ?? ''), 600);
  /** 最近一次调用拿到的真实 token 数（供应商没回就是 undefined）。 */
  let lastUsage: number | undefined;
  const call = async (system: string, user: string): Promise<string> => {
    const result = readModelText(await input.callModel({ system, user }));
    if (typeof result.totalTokens === 'number' && result.totalTokens > 0) {
      lastUsage = Math.trunc(result.totalTokens);
    }
    return result.text;
  };
  const contextLines = (): string[] => {
    const parts: string[] = [];
    if (persona) parts.push(`【你是谁】${persona}`);
    if (memory) parts.push(`【你最近记得的事】${memory}`);
    return parts;
  };
  return {
    lastUsageTokens: () => lastUsage,
    async proposeIntent({ homeLabel, minutesSinceLastOuting }) {
      const parts = contextLines();
      if (homeLabel) {
        const safeHome = sanitizePersonaText(homeLabel, 40);
        if (safeHome) parts.push(`【你现在在家里】${safeHome}`);
      }
      if (typeof minutesSinceLastOuting === 'number' && Number.isFinite(minutesSinceLastOuting)) {
        parts.push(`【上一趟出门】大约 ${Math.max(0, Math.round(minutesSinceLastOuting))} 分钟前结束`);
      }
      const user = parts.join('\n\n') || '（没有额外背景）';
      const safe = assertPromptSafe(user);
      if (!safe.ok) throw new Error('travel-intent-context-unsafe');
      const raw = await call(INTENT_SYSTEM_PROMPT, safe.text);
      const json = extractJsonObject(raw);
      if (!json) throw new Error('travel-intent-non-json');
      return json;
    },
    async nextSegment(context: TravelSegmentContext) {
      const parts = contextLines();
      parts.push(`【这次出门的想法】${clip(context.wishText, 120) || '随便走走'}`);
      const where: string[] = [];
      if (context.homeLabel) where.push(`住处：${clip(context.homeLabel, 40)}`);
      if (context.hereLabel) where.push(`现在在这里：${clip(context.hereLabel, 40)}`);
      where.push(`已经走了 ${Math.max(0, Math.trunc(context.segmentsSoFar))} 段，出门约 ${Math.max(0, Math.trunc(context.minutesOut))} 分钟`);
      where.push(context.minutesHome === null
        ? '走回家要多久：还不知道'
        : `走回家大约 ${Math.max(0, Math.trunc(context.minutesHome))} 分钟`);
      parts.push(`【现在的位置】\n${where.join('\n')}`);
      if (context.candidates.length > 0) {
        parts.push(
          '【附近还能去的地方】\n'
            + context.candidates
              .map((c, i) => `${i + 1}. id=${c.id} ｜ ${clip(c.label, 40)}${
                c.category ? ` ｜ ${clip(c.category, 20)}` : ''
              }${typeof c.distanceM === 'number' ? ` ｜ 约 ${Math.round(c.distanceM)} 米` : ''}`)
              .join('\n'),
        );
      } else {
        parts.push('【附近还能去的地方】这一轮没查到（只能 stay / return / stop）');
      }
      const user = parts.join('\n\n');
      const safe = assertPromptSafe(user);
      if (!safe.ok) throw new Error('travel-segment-context-unsafe');
      const raw = await call(SEGMENT_SYSTEM_PROMPT, safe.text);
      const json = extractJsonObject(raw);
      if (!json) throw new Error('travel-segment-non-json');
      return json;
    },
    async choose({ wishText, candidates, rerollsUsed }) {
      const parts: string[] = [];
      if (persona) parts.push(`【你是谁】${persona}`);
      if (memory) parts.push(`【你最近记得的事】${memory}`);
      if (wishText) parts.push(`【这次的想法】${clip(wishText, 120)}`);
      parts.push(
        '【可去的地方】\n'
          + candidates
            .map((c, i) => `${i + 1}. id=${c.id} ｜ ${clip(c.label, 40)}${
              c.category ? ` ｜ ${clip(c.category, 20)}` : ''
            }${typeof c.distanceM === 'number' ? ` ｜ 约 ${Math.round(c.distanceM)} 米` : ''}`)
            .join('\n'),
      );
      if (rerollsUsed > 0) parts.push(`（你已经要求换过 ${rerollsUsed} 次了，别再无脑换。）`);

      const user = parts.join('\n\n');
      // 兜底：候选 id 是 `tc:` 前缀的随机串，不含坐标；但设定文本仍是外部内容，
      // 命中坐标/门牌就整段不发（宁可这一轮不决定，也不把定位细节送出去）。
      const safe = assertPromptSafe(user);
      if (!safe.ok) throw new Error('travel-decision-context-unsafe');

      const raw = await call(SYSTEM_PROMPT, safe.text);
      const json = extractJsonObject(raw);
      if (!json) throw new Error('travel-decision-non-json');
      return json;
    },
  };
}

/** 从模型回复里取第一段平衡的 JSON 对象（允许带 ```json 围栏或前后废话）。 */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1));
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
