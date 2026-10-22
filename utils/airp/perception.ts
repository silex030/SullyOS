/**
 * P4 L1/L2：感知事件归一 + 本地规则过滤 + 小快照渲染（纯叶子）。
 *
 * 这一层**只转换调用方已经拿到的数据**：天气缓存、角色时区、热榜标题、用户日程、
 * 当前日程槽位。它自己不发请求、不建轮询、不读 IndexedDB——「不新增持续监控」是硬约束。
 *
 * 三个作用：
 *   1. 所有感知统一成同一种事件（source / subject / observedAt / expiresAt / permissions /
 *      version / dedupeKey），后续事实库、快照、日志都只认这一种形状；
 *   2. 在**进提示词之前**用本地规则砍掉过期、没变化、重复、无权限、无关联的候选；
 *   3. 只把相关的一小段渲染进动态尾段，并写死认知边界：观测是观测，推测是推测，
 *      虚拟经历是虚拟经历，谁也不许拿天气/日程去断言对方的情绪或空闲。
 */

/** 感知来源白名单。新增来源要同时想清楚「谁在什么时候产生它」，别变成新的监控源。 */
export const PERCEPTION_SOURCES = ['weather', 'clock', 'news', 'calendar', 'activity'] as const;
export type AirpPerceptionSource = (typeof PERCEPTION_SOURCES)[number];

/**
 * 认知档：现实观测 / 角色推测 / 角色虚拟经历。
 * 这三档在提示词里必须分开写，不能把推测说成观测、也不能把虚拟经历说成现实。
 */
export const PERCEPTION_EPISTEMICS = ['observation', 'inference', 'virtual'] as const;
export type AirpPerceptionEpistemic = (typeof PERCEPTION_EPISTEMICS)[number];

export interface AirpPerceptionPermissions {
  /** 这条感知是关于谁的：角色自己 / 用户 / 公开信息。 */
  audience: 'self' | 'user' | 'public';
  /** 是否允许进提示词（无权限的候选连过滤都不用做，直接丢）。 */
  promptAllowed: boolean;
}

export interface AirpPerceptionEvent {
  v: 1;
  /** 去重键：同一来源同一对象稳定不变（天气按城市、热搜按条目、日程按事件 id）。 */
  dedupeKey: string;
  source: AirpPerceptionSource;
  /** 主体：charId / 'user' / 城市等。 */
  subject: string;
  /** 一行以内的短事实，不塞长正文（热榜只放标题）。 */
  summary: string;
  observedAt: number;
  expiresAt: number;
  permissions: AirpPerceptionPermissions;
  epistemic: AirpPerceptionEpistemic;
  /** 0..1；渲染时只用于「推测」档的措辞强度。 */
  confidence: number;
  /** 值指纹：同一 dedupeKey 下值没变就不必再喂一次。 */
  valueHash: string;
  version: 1;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** 稳定、无依赖的小哈希（只用于「值有没有变」，不做安全用途）。 */
export function perceptionHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const eventBase = (args: {
  dedupeKey: string;
  source: AirpPerceptionSource;
  subject: string;
  summary: string;
  observedAt: number;
  expiresAt: number;
  epistemic: AirpPerceptionEpistemic;
  confidence?: number;
  permissions?: Partial<AirpPerceptionPermissions>;
}): AirpPerceptionEvent => ({
  v: 1,
  dedupeKey: args.dedupeKey,
  source: args.source,
  subject: args.subject,
  summary: args.summary.trim(),
  observedAt: args.observedAt,
  expiresAt: args.expiresAt,
  permissions: {
    audience: args.permissions?.audience ?? 'self',
    promptAllowed: args.permissions?.promptAllowed ?? true,
  },
  epistemic: args.epistemic,
  confidence: clamp01(args.confidence ?? 1),
  valueHash: perceptionHash(`${args.dedupeKey}\u0000${args.summary.trim()}`),
  version: 1,
});

/** 天气：同城 30 分钟内复用（与前台缓存同一档）；只搬已取到的读数。 */
export function weatherPerception(args: {
  city: string;
  summary: string;
  observedAt: number;
  subject: string;
  ttlMs?: number;
  /** 用户那边的天气：主体是 user，权限仍是可进提示词。 */
  forUser?: boolean;
}): AirpPerceptionEvent {
  const ttl = args.ttlMs && args.ttlMs > 0 ? args.ttlMs : 30 * MINUTE_MS;
  return eventBase({
    dedupeKey: `weather:${args.city}`,
    source: 'weather',
    subject: args.forUser ? 'user' : args.subject,
    summary: args.forUser ? `对方那边（${args.city}）${args.summary}` : `${args.city}${args.summary}`,
    observedAt: args.observedAt,
    expiresAt: args.observedAt + ttl,
    epistemic: 'observation',
  });
}

/** 角色时区下的日期/小时键。非法时区回退 UTC 而不是抛。 */
function zonedParts(nowMs: number, tzId: string): { dateKey: string; hour: number; minute: number; second: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tzId,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date(nowMs));
    const map: Record<string, string> = {};
    for (const part of parts) map[part.type] = part.value;
    let hour = Number(map.hour);
    if (hour === 24) hour = 0;
    return {
      dateKey: `${map.year}-${map.month}-${map.day}`,
      hour,
      minute: Number(map.minute),
      second: Number(map.second),
    };
  } catch {
    const d = new Date(nowMs);
    return {
      dateKey: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`,
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds(),
    };
  }
}

/**
 * 时钟：只报「角色那边现在几点」，按小时去重，整点过期。
 * 分钟级变化不值得每轮都占一段提示词——日程槽位本身会带出更具体的时间。
 */
export function clockPerception(args: {
  nowMs: number;
  tzId: string;
  subject: string;
}): AirpPerceptionEvent {
  const p = zonedParts(args.nowMs, args.tzId);
  const hh = String(p.hour).padStart(2, '0');
  const mm = String(p.minute).padStart(2, '0');
  const msIntoHour = p.minute * MINUTE_MS + p.second * 1000 + (args.nowMs % 1000);
  return eventBase({
    dedupeKey: `clock:${args.tzId}:${p.dateKey}:${hh}`,
    source: 'clock',
    subject: args.subject,
    summary: `你那边现在是 ${hh}:${mm}`,
    observedAt: args.nowMs,
    expiresAt: args.nowMs + (HOUR_MS - msIntoHour),
    epistemic: 'observation',
  });
}

/** 热搜：只给标题，并在摘要里明说「没读正文」——不许假装看过内容。 */
export function newsPerception(args: {
  platform: string;
  title: string;
  observedAt: number;
  subject: string;
  ttlMs?: number;
}): AirpPerceptionEvent {
  const ttl = args.ttlMs && args.ttlMs > 0 ? args.ttlMs : 24 * HOUR_MS;
  return eventBase({
    dedupeKey: `news:${args.platform}:${perceptionHash(args.title.trim())}`,
    source: 'news',
    subject: args.subject,
    summary: `${args.platform}热榜「${args.title.trim()}」（只看到标题，没读正文）`,
    observedAt: args.observedAt,
    expiresAt: args.observedAt + ttl,
    epistemic: 'observation',
  });
}

const hhmm = (ms: number, tzId: string): string => {
  const p = zonedParts(ms, tzId);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};

/**
 * 用户/角色日程。用户日程主体是 user、权威高；不能因为它「这会儿没有条」就推断对方有空。
 * 过期时间取结束时刻：结束之后这条日程不再是「此刻的观测」。
 */
export function calendarPerception(args: {
  id: string;
  title: string;
  startsAt: number;
  endsAt: number;
  observedAt: number;
  subject: 'user' | string;
  tzId?: string;
}): AirpPerceptionEvent {
  const tz = args.tzId ?? 'UTC';
  const range = `${hhmm(args.startsAt, tz)}–${hhmm(args.endsAt, tz)}`;
  return eventBase({
    dedupeKey: `calendar:${args.id}`,
    source: 'calendar',
    subject: args.subject,
    summary: `日程「${args.title}」${range}`,
    observedAt: args.observedAt,
    expiresAt: Math.max(args.endsAt, args.observedAt + MINUTE_MS),
    epistemic: 'observation',
    permissions: { audience: args.subject === 'user' ? 'user' : 'self' },
  });
}

/** 角色当前日程槽位（来自 fire_pack.scene，不是新抓的）。 */
export function activityPerception(args: {
  label: string;
  startLabel?: string;
  endLabel?: string;
  observedAt: number;
  subject: string;
  /** 日程推出来的活动是「按表应当在做」，不是亲眼看到——默认算观测（表是确定性的）。 */
  epistemic?: AirpPerceptionEpistemic;
}): AirpPerceptionEvent {
  const range = args.startLabel && args.endLabel
    ? `（${args.startLabel}–${args.endLabel}）`
    : args.startLabel ? `（${args.startLabel} 起）` : '';
  return eventBase({
    dedupeKey: `activity:${args.subject}:${args.startLabel ?? ''}:${args.label}`,
    source: 'activity',
    subject: args.subject,
    summary: `按你的作息，这会儿在${args.label}${range}`,
    observedAt: args.observedAt,
    expiresAt: args.observedAt + 2 * HOUR_MS,
    epistemic: args.epistemic ?? 'observation',
  });
}

// ─── 过滤 ────────────────────────────────────────────────────────────────

export type PerceptionDropReason =
  | 'invalid' | 'expired' | 'unchanged' | 'duplicate'
  | 'no-permission' | 'irrelevant' | 'cap';

export interface PerceptionSeenEntry {
  dedupeKey: string;
  valueHash: string;
  observedAt: number;
  expiresAt?: number;
}

export interface PerceptionFilterInput {
  events: readonly AirpPerceptionEvent[];
  nowMs: number;
  /** 上一次已经喂过的指纹（D1 或内存快照都行）。 */
  seen?: readonly PerceptionSeenEntry[];
  /** 允许的主体；不传 = 不过滤主体。 */
  subjectAllow?: readonly string[];
  /** 允许的受众；不传 = 只允许 self/user（public 的原始事件默认不进私聊上下文）。 */
  audienceAllow?: readonly AirpPerceptionPermissions['audience'][];
  maxItems?: number;
}

export interface PerceptionFilterResult {
  kept: AirpPerceptionEvent[];
  dropped: Array<{ dedupeKey: string; reason: PerceptionDropReason }>;
}

const isValidEvent = (event: AirpPerceptionEvent): boolean => {
  if (!event || typeof event !== 'object') return false;
  if (typeof event.dedupeKey !== 'string' || event.dedupeKey.length === 0) return false;
  if (typeof event.summary !== 'string' || event.summary.trim().length === 0) return false;
  if (!Number.isFinite(event.observedAt) || !Number.isFinite(event.expiresAt)) return false;
  if (!PERCEPTION_SOURCES.includes(event.source)) return false;
  if (!PERCEPTION_EPISTEMICS.includes(event.epistemic)) return false;
  return true;
};

/**
 * 本地规则过滤（顺序固定，测试按这个顺序断言）：
 *   非法 → 无权限 → 过期 → 无关联 → 批内去重（同 key 留最新）→ 无变化 → 上限。
 * 全程确定性，不调模型、不读网络。
 */
export function filterPerceptionEvents(input: PerceptionFilterInput): PerceptionFilterResult {
  const dropped: PerceptionFilterResult['dropped'] = [];
  const subjectAllow = input.subjectAllow ? new Set(input.subjectAllow) : null;
  const audienceAllow = new Set(input.audienceAllow ?? (['self', 'user', 'public'] as const));
  const maxItems = Math.max(1, Math.trunc(input.maxItems ?? 6));

  const seen = new Map<string, PerceptionSeenEntry>();
  for (const row of input.seen ?? []) {
    if (row && typeof row.dedupeKey === 'string') seen.set(row.dedupeKey, row);
  }

  const valid: AirpPerceptionEvent[] = [];
  for (const event of input.events) {
    if (!isValidEvent(event)) {
      dropped.push({ dedupeKey: String((event as { dedupeKey?: unknown })?.dedupeKey ?? '?'), reason: 'invalid' });
      continue;
    }
    if (event.permissions?.promptAllowed !== true) {
      dropped.push({ dedupeKey: event.dedupeKey, reason: 'no-permission' });
      continue;
    }
    if (!audienceAllow.has(event.permissions.audience)) {
      dropped.push({ dedupeKey: event.dedupeKey, reason: 'no-permission' });
      continue;
    }
    if (event.expiresAt <= input.nowMs) {
      dropped.push({ dedupeKey: event.dedupeKey, reason: 'expired' });
      continue;
    }
    if (subjectAllow && !subjectAllow.has(event.subject)) {
      dropped.push({ dedupeKey: event.dedupeKey, reason: 'irrelevant' });
      continue;
    }
    valid.push(event);
  }

  // 批内同 key：只留最新一条（observedAt 大者胜；同时间留先出现的）。
  const newestByKey = new Map<string, AirpPerceptionEvent>();
  for (const event of valid) {
    const current = newestByKey.get(event.dedupeKey);
    if (!current) {
      newestByKey.set(event.dedupeKey, event);
      continue;
    }
    const winner = event.observedAt > current.observedAt ? event : current;
    const loser = winner === event ? current : event;
    newestByKey.set(event.dedupeKey, winner);
    dropped.push({ dedupeKey: loser.dedupeKey, reason: 'duplicate' });
  }

  const fresh: AirpPerceptionEvent[] = [];
  for (const event of newestByKey.values()) {
    const before = seen.get(event.dedupeKey);
    if (before && before.valueHash === event.valueHash) {
      dropped.push({ dedupeKey: event.dedupeKey, reason: 'unchanged' });
      continue;
    }
    fresh.push(event);
  }

  fresh.sort((a, b) => (b.observedAt - a.observedAt) || a.dedupeKey.localeCompare(b.dedupeKey));
  const kept = fresh.slice(0, maxItems);
  for (const event of fresh.slice(maxItems)) {
    dropped.push({ dedupeKey: event.dedupeKey, reason: 'cap' });
  }
  return { kept, dropped };
}

/** 过滤后要落库的指纹行（下一跳拿来判「没变化」）。 */
export function perceptionDedupeRows(
  events: readonly AirpPerceptionEvent[],
): Array<PerceptionSeenEntry & { expiresAt: number }> {
  return events.map((event) => ({
    dedupeKey: event.dedupeKey,
    valueHash: event.valueHash,
    observedAt: event.observedAt,
    expiresAt: event.expiresAt,
  }));
}

// ─── 渲染 ────────────────────────────────────────────────────────────────

const EPISTEMIC_LABEL: Record<AirpPerceptionEpistemic, string> = {
  observation: '观测',
  inference: '推测',
  virtual: '虚拟经历',
};

const SOURCE_LABEL: Record<AirpPerceptionSource, string> = {
  weather: '天气',
  clock: '时间',
  news: '热搜',
  calendar: '日程',
  activity: '活动',
};

const relativeTime = (fromMs: number, nowMs: number): string => {
  const diff = Math.max(0, nowMs - fromMs);
  if (diff < MINUTE_MS) return '刚刚';
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)} 分钟前`;
  if (diff < 24 * HOUR_MS) return `${Math.floor(diff / HOUR_MS)} 小时前`;
  return `${Math.floor(diff / (24 * HOUR_MS))} 天前`;
};

/**
 * 一小段「此刻的感知」，进动态尾段用。空数组返回空串：没有感知就不硬凑。
 * 末尾的边界句是契约的一部分——它挡住了「拿天气猜心情」「拿日程空白猜对方有空」。
 */
export function renderPerceptionSnapshot(
  events: readonly AirpPerceptionEvent[],
  opts: { nowMs: number; maxItems?: number } = { nowMs: Date.now() },
): string {
  const maxItems = Math.max(1, Math.trunc(opts.maxItems ?? 6));
  const kept = events.slice(0, maxItems);
  if (kept.length === 0) return '';
  const lines = kept.map((event) => {
    const label = EPISTEMIC_LABEL[event.epistemic] ?? '推测';
    const source = SOURCE_LABEL[event.source] ?? event.source;
    return `- ${label}·${source}｜${event.summary}｜${relativeTime(event.observedAt, opts.nowMs)}`;
  });
  return [
    '【此刻的感知】',
    ...lines,
    '【边界】以上只是此刻感知到的：观测是观测、推测是推测、虚拟经历是虚拟经历，别混着说；'
      + '没列在这里的不要当成事实，也不能用天气、日程或对方的空闲去推断对方的情绪。',
  ].join('\n');
}
