/**
 * 自主生活 UI · 纯投影/文案层（无 React、无网络，单测直接覆盖）。
 *
 * 为什么单独一层：界面上的每个数字与每句话都必须是「服务端说过的」——
 *   - 状态/原因/预算全部来自 CharacterLifeState，不在这里推算「应该还剩几次」；
 *   - 时间显示统一按角色时区（服务端给 IANA 时区，界面只做展示换算）；
 *   - 未知原因码原样显示，不翻译成「TA 改变心意」这类编出来的动机（契约 §1.7）。
 */

import {
  ACTION_STATUSES,
  ACTIVITY_KINDS,
  DEFAULT_ACCOUNT_LIMITS,
  PLATFORM_FORBIDDEN_CATEGORIES,
  type ActionSource,
  type ActionStatus,
  type ActivityKind,
  type ActivityRecord,
  type AutonomyLifeErrorCode,
  type BudgetUsage,
  type Capability,
  type CharacterLifeState,
  type LifeAvailability,
  type LifeEvent,
  type LifePhase,
  type LifeReasonCode,
} from '../../contracts/autonomyLife';

// ── 文案表 ──────────────────────────────────────────────────────────────────

export const KIND_LABELS: Record<ActivityKind, string> = {
  'journal.write': '写日记',
  'room.plan': '整理计划',
  'room.note': '记笔记',
  'phone.record': '翻手机记录',
  'takeout.order': '点外卖',
  'shopping.order': '买东西',
  'interaction.message': '发消息',
  'travel.wish': '想出门',
  'external.read': '看外部内容',
};

/** 深链目标：kind → 原 App（点击进真实记录；App 没消费 context 时就只打开首页）。 */
export const KIND_APP: Record<ActivityKind, { appId: string; label: string }> = {
  'journal.write': { appId: 'journal', label: '日记' },
  'room.plan': { appId: 'room', label: '房间' },
  'room.note': { appId: 'room', label: '房间' },
  'phone.record': { appId: 'check_phone', label: '查手机' },
  'takeout.order': { appId: 'takeout', label: '外卖' },
  'shopping.order': { appId: 'shopping', label: '购物' },
  'interaction.message': { appId: 'chat', label: '聊天' },
  'travel.wish': { appId: 'travel', label: '出行' },
  'external.read': { appId: 'xhs_free_roam', label: '小红书' },
};

export const PHASE_LABELS: Record<LifePhase, string> = {
  resting: '在休息',
  idle: '闲着',
  engaged: '正在做点什么',
  waiting: '在等机会',
};

export const AVAILABILITY_LABELS: Record<LifeAvailability, string> = {
  ready: '正常运行',
  disabled: '未启用',
  pausing: '正在停止',
  paused: '已暂停',
  limited: '受限运行',
  error: '暂时不可用',
};

export const AVAILABILITY_TONES: Record<LifeAvailability, 'ok' | 'idle' | 'warn' | 'bad'> = {
  ready: 'ok',
  disabled: 'idle',
  pausing: 'warn',
  paused: 'idle',
  limited: 'warn',
  error: 'bad',
};

export const REASON_LABELS: Record<LifeReasonCode, string> = {
  GLOBAL_PAUSED: '总暂停已开启',
  CHAR_DISABLED: '这个角色未参与自主生活',
  PAUSING: '正在停止，等当前动作收尾',
  BUDGET_EXHAUSTED: '今天的次数额度用完了',
  TOKEN_BUDGET_EXHAUSTED: '今天的 token 额度用完了',
  QUIET_HOURS: '正处在免打扰时段',
  SLEEPING: '按作息在休息',
  WAITING_DEVICE: '执行设备不在线',
  MISSING_CREDENTIALS: '模型凭据还没配置',
  CAPABILITY_UNAVAILABLE: '所需能力当前不可用',
  CIRCUIT_OPEN: '连续失败后进入保护性暂停',
  MODEL_FAILED: '模型调用失败',
  POLICY_DENIED: '被安全策略挡下',
  GRANT_REQUIRED: '需要先授权外部访问',
  NO_CANDIDATE: '暂时没有想做的事',
  RESTING: '在休息',
};

export const SOURCE_LABELS: Record<ActionSource, string> = {
  autonomy_round: '自主回合',
  chat_reply: '聊天里提出',
  rhythm: '人设节奏',
  user_request: '你让它做',
  legacy: '旧记录',
};

export const SCOPE_LABELS = {
  os_simulation: 'OS 内模拟',
  external_read: '外部只读',
} as const;

export const STATUS_LABELS: Record<ActionStatus, string> = {
  proposed: '提出来了',
  scheduled: '排上了',
  waiting_device: '等设备上线',
  awaiting_confirmation: '等你确认',
  running: '在做',
  succeeded: '做完了',
  failed: '没做成',
  unknown: '结果待核对',
  blocked: '被限制',
  expired: '过期了',
  cancelled: '取消了',
};

export const NOTIFICATION_LABELS: Record<ActivityRecord['notificationState'], string> = {
  none: '不需要通知',
  queued: '通知已排队',
  delivered: '通知已送达',
  not_delivered: '通知未送达',
};

/** 首期未接入自主调度的 App（保留手动入口，界面必须说清楚）。 */
export const NOT_AUTONOMOUS_APPS = [
  { appId: 'vrworld', label: '彼方' },
  { appId: 'world_home', label: '家园' },
  { appId: 'moments', label: '朋友圈' },
  { appId: 'study', label: '自习室' },
  { appId: 'pomodoro', label: '番茄钟' },
  { appId: 'music', label: '音乐' },
  { appId: 'special_moments', label: '特别时光' },
] as const;

/** 旧能力入口的快捷跳转（统一边界页里的「就地入口」，不再各自设周期）。 */
export const BOUNDARY_QUICK_LINKS = [
  { appId: 'journal', label: '日记' },
  { appId: 'room', label: '房间' },
  { appId: 'check_phone', label: '查手机' },
  { appId: 'takeout', label: '外卖' },
  { appId: 'shopping', label: '购物' },
] as const;

// ── 金额 / 时间 ────────────────────────────────────────────────────────────

/** 最小货币单位 → 展示金额（后端只给整数分；不做四舍五入美化）。 */
export function formatMinor(minor: number | null | undefined, currency: string = 'CNY'): string {
  if (minor === null || minor === undefined || !Number.isFinite(minor)) return '—';
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(Math.round(minor));
  const major = Math.floor(abs / 100);
  const cents = abs % 100;
  const symbol = currency === 'CNY' ? '¥' : `${currency} `;
  return `${sign}${symbol}${major}${cents === 0 ? '' : `.${String(cents).padStart(2, '0')}`}`;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 按时区取年月日时分；时区无效时回落本地时间（不让展示整块失败）。 */
export function zonedParts(ts: number, timezone?: string): {
  year: number; month: number; day: number; hour: number; minute: number; weekday: number;
} {
  const date = new Date(ts);
  if (!Number.isFinite(date.getTime())) {
    return { year: 0, month: 0, day: 0, hour: 0, minute: 0, weekday: 0 };
  }
  if (timezone) {
    try {
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
      });
      const parts = fmt.formatToParts(date);
      const read = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
      const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      const hour = Number(read('hour')) % 24;
      return {
        year: Number(read('year')),
        month: Number(read('month')),
        day: Number(read('day')),
        hour,
        minute: Number(read('minute')),
        weekday: weekdayMap[read('weekday')] ?? 0,
      };
    } catch {
      /* 时区字符串坏了就退回本地时间 */
    }
  }
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    weekday: date.getDay(),
  };
}

/** 时间戳 → 「今天 14:20」/「昨天 09:05」/「10/22 20:11」。 */
export function formatWhen(ts: number, timezone: string | undefined, now: number): string {
  if (!Number.isFinite(ts)) return '—';
  const then = zonedParts(ts, timezone);
  const today = zonedParts(now, timezone);
  const clock = `${pad2(then.hour)}:${pad2(then.minute)}`;
  const sameDay = (a: typeof then, b: typeof today) =>
    a.year === b.year && a.month === b.month && a.day === b.day;
  if (sameDay(then, today)) return `今天 ${clock}`;
  const yesterday = zonedParts(now - 86_400_000, timezone);
  if (sameDay(then, yesterday)) return `昨天 ${clock}`;
  return `${then.month}/${then.day} ${clock}`;
}

export function dayKey(ts: number, timezone?: string): string {
  const p = zonedParts(ts, timezone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

export function formatDayLabel(ts: number, timezone: string | undefined, now: number): string {
  const then = zonedParts(ts, timezone);
  const today = zonedParts(now, timezone);
  const sameDay = (a: typeof then, b: typeof today) =>
    a.year === b.year && a.month === b.month && a.day === b.day;
  if (sameDay(then, today)) return '今天';
  const yesterday = zonedParts(now - 86_400_000, timezone);
  if (sameDay(then, yesterday)) return '昨天';
  return `${then.month} 月 ${then.day} 日`;
}

/** 时段名（用于「预计午后再看看」，不是承诺倒计时）。 */
export function phaseOfDay(ts: number, timezone?: string): string {
  const hour = zonedParts(ts, timezone).hour;
  if (hour < 5) return '深夜';
  if (hour < 9) return '清晨';
  if (hour < 12) return '上午';
  if (hour < 14) return '午后';
  if (hour < 18) return '下午';
  if (hour < 22) return '傍晚';
  return '夜里';
}

/**
 * 下次自然机会的展示文案。契约要求「预计午后再看看」这种软说法，
 * 不给用户一个会跳秒的倒计时（节奏由人设+情境决定，不是定时任务）。
 */
export function nextOpportunityHint(
  nextAt: number | null | undefined,
  timezone: string | undefined,
  now: number,
): string {
  if (nextAt === null || nextAt === undefined || !Number.isFinite(nextAt)) {
    return '暂时没有排下一次机会';
  }
  if (nextAt <= now) return '下一个机会已经到了，可能在挑要做什么';
  if (nextAt - now > 20 * 60 * 60 * 1000) return '短期内大概率不会再有新动作';
  return `预计${phaseOfDay(nextAt, timezone)}再看看`;
}

// ── 状态摘要 ────────────────────────────────────────────────────────────────

export interface AvailabilitySummary {
  label: string;
  tone: 'ok' | 'idle' | 'warn' | 'bad';
  /** 一句话原因：优先系统原因，其次作息/免打扰。 */
  detail: string;
  reasonLabels: string[];
}

export function reasonLabel(code: string): string {
  return (REASON_LABELS as Record<string, string>)[code] ?? code;
}

export function summarizeAvailability(state: CharacterLifeState): AvailabilitySummary {
  const tone = AVAILABILITY_TONES[state.availability];
  const reasonLabels = state.reasonCodes.map(reasonLabel);
  const detail =
    reasonLabels.length > 0
      ? reasonLabels.join('；')
      : state.lifePhase === 'resting'
        ? '按自己的作息在休息，不需要你安排'
        : '一切正常，什么时候做什么由 TA 的人设和当下情境决定';
  return { label: AVAILABILITY_LABELS[state.availability], tone, detail, reasonLabels };
}

export interface BudgetRow {
  dim: BudgetUsage['dimension'];
  label: string;
  used: number;
  reserved: number;
  limit: number;
  unit: 'calls' | 'tokens' | 'count' | 'minor';
  exhausted: boolean;
  text: string;
}

const BUDGET_LABELS: Record<BudgetUsage['dimension'], string> = {
  model_calls: '模型调用',
  model_calls_account: '账号模型调用',
  tokens: 'token',
  notifications: '通知',
  virtual_spend: '模拟消费',
};

const BUDGET_UNITS: Record<BudgetUsage['dimension'], BudgetRow['unit']> = {
  model_calls: 'calls',
  model_calls_account: 'calls',
  tokens: 'tokens',
  notifications: 'count',
  virtual_spend: 'minor',
};

/** 预算行：只展示服务端给的 used/reserved/limit，不在这里推算剩余。 */
export function budgetRows(state: CharacterLifeState, currency = 'CNY'): BudgetRow[] {
  return state.budget.map((item) => {
    const unit = BUDGET_UNITS[item.dimension];
    const used = Math.max(0, item.used);
    const reserved = Math.max(0, item.reserved);
    const limit = Math.max(0, item.limit);
    const remaining = Math.max(0, limit - used - reserved);
    const text =
      unit === 'minor'
        ? `${formatMinor(used, currency)} / ${formatMinor(limit, currency)}（剩 ${formatMinor(remaining, currency)}）`
        : `${used} / ${limit}${unit === 'tokens' ? ' token' : ' 次'}`;
    return {
      dim: item.dimension,
      label: BUDGET_LABELS[item.dimension] ?? item.dimension,
      used,
      reserved,
      limit,
      unit,
      exhausted: limit <= used + reserved,
      text,
    };
  });
}

/** 最近一件事：按 occurredAt+id 稳定降序取第一条真正有副作用的终态记录。 */
export function latestActivity(items: ActivityRecord[]): ActivityRecord | null {
  const candidates = items.filter((item) => item.status === 'succeeded' && item.effectVerified);
  if (candidates.length === 0) return null;
  return [...candidates].sort(compareActivities)[0] ?? null;
}

export function compareActivities(a: ActivityRecord, b: ActivityRecord): number {
  if (a.occurredAt !== b.occurredAt) return b.occurredAt - a.occurredAt;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export function sortActivities(items: ActivityRecord[]): ActivityRecord[] {
  return [...items].sort(compareActivities);
}

export interface ActivityGroup {
  dayKey: string;
  label: string;
  items: ActivityRecord[];
}

export function groupActivities(
  items: ActivityRecord[],
  timezone: string | undefined,
  now: number,
): ActivityGroup[] {
  const groups = new Map<string, ActivityGroup>();
  for (const item of sortActivities(items)) {
    const key = dayKey(item.occurredAt, timezone);
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
    } else {
      groups.set(key, {
        dayKey: key,
        label: formatDayLabel(item.occurredAt, timezone, now),
        items: [item],
      });
    }
  }
  return [...groups.values()];
}

/** 能力排序：首期核心在前，外部窗口在后；不可用的沉到组内末尾由 UI 决定。 */
export function sortCapabilities(capabilities: Capability[]): Capability[] {
  const order = new Map(ACTIVITY_KINDS.map((kind, index) => [kind, index]));
  return [...capabilities].sort(
    (a, b) => (order.get(a.kind) ?? 99) - (order.get(b.kind) ?? 99),
  );
}

export function capabilityStatusText(cap: Capability): string {
  if (!cap.available) return cap.unavailableReason || '当前不可用';
  if (!cap.enabled) return '已关闭';
  if (cap.requiresGrant) return '需先授权外部访问';
  if (cap.requiresForeground) return '需要设备在线时才会做';
  return '可用';
}

// ── 事件合并 ────────────────────────────────────────────────────────────────

export interface EventMergeState {
  events: LifeEvent[];
  lastSequence: number;
}

export interface EventMergeResult extends EventMergeState {
  /** 服务端说游标过期，调用方必须做一次全量刷新。 */
  needsResync: boolean;
  changed: boolean;
}

/**
 * 事件游标合并：按 eventId 去重、sequence 只向前；`hasMore` 时继续拉，
 * `resyncRequired` 时由调用方丢弃本地增量做全量刷新（契约 §7）。
 */
export function mergeEvents(
  prev: EventMergeState,
  incoming: { items: LifeEvent[]; nextSequence: number; resyncRequired: boolean },
): EventMergeResult {
  if (incoming.resyncRequired) {
    return { events: [], lastSequence: 0, needsResync: true, changed: true };
  }
  const seen = new Set(prev.events.map((e) => e.eventId));
  const fresh: LifeEvent[] = [];
  for (const event of incoming.items) {
    if (seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    fresh.push(event);
  }
  fresh.sort((a, b) => a.sequence - b.sequence);
  const lastSequence = Math.max(
    prev.lastSequence,
    incoming.nextSequence,
    ...fresh.map((e) => e.sequence),
  );
  const changed = fresh.length > 0 || incoming.nextSequence !== prev.lastSequence;
  return {
    events: [...prev.events, ...fresh],
    lastSequence,
    needsResync: false,
    changed,
  };
}

// ── 待确认的外部数据请求 ────────────────────────────────────────────────────

export interface PendingConfirmation {
  id: string;
  payloadHash: string;
  nonce: string;
  purpose: string;
  host: string;
  fields: string[];
  expiresAt: number;
  expectedRevision: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 从 `action.changed` 事件的最小补丁里读待确认请求。
 * 形状不全就不显示确认按钮——宁可不提供入口，也不造一个点下去没用的确认。
 */
export function readPendingConfirmation(event: LifeEvent): PendingConfirmation | null {
  if (event.type !== 'action.changed') return null;
  const data = event.data;
  if (data.status !== 'awaiting_confirmation') return null;
  const raw = isRecord(data.confirmation) ? data.confirmation : null;
  if (!raw) return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  const payloadHash = typeof raw.payloadHash === 'string' ? raw.payloadHash : '';
  const nonce = typeof raw.nonce === 'string' ? raw.nonce : '';
  if (!id || !payloadHash || !nonce) return null;
  return {
    id,
    payloadHash,
    nonce,
    purpose: typeof raw.purpose === 'string' ? raw.purpose : '外部只读查询',
    host: typeof raw.host === 'string' ? raw.host : '',
    fields: Array.isArray(raw.fields) ? raw.fields.filter((f): f is string => typeof f === 'string') : [],
    expiresAt: typeof raw.expiresAt === 'number' ? raw.expiresAt : 0,
    expectedRevision: typeof raw.expectedRevision === 'number' ? raw.expectedRevision : event.revision,
  };
}

export function pendingConfirmationsFromEvents(events: LifeEvent[]): PendingConfirmation[] {
  const byId = new Map<string, PendingConfirmation>();
  for (const event of events) {
    const pending = readPendingConfirmation(event);
    if (pending) byId.set(pending.id, pending);
  }
  return [...byId.values()];
}

// ── 错误文案 ────────────────────────────────────────────────────────────────

export interface ErrorCopy {
  title: string;
  hint: string;
  retryable: boolean;
}

export function describeError(code: AutonomyLifeErrorCode | 'NOT_CONFIGURED' | 'NETWORK' | 'MALFORMED_RESPONSE' | 'DEPRECATED_FIELD_SENT'): ErrorCopy {
  switch (code) {
    case 'NOT_CONFIGURED':
      return { title: '还没连上后台', hint: '先在设置里配置网络代理 / 主动消息后台，再回来查看。', retryable: false };
    case 'NETWORK':
      return { title: '状态暂无法确认', hint: '网络断了或后台不可达，显示的是上次同步的结果。', retryable: true };
    case 'MALFORMED_RESPONSE':
      return { title: '后台回包看不懂', hint: '这可能是不兼容的旧版后台，已停止展示以免显示错数据。', retryable: true };
    case 'DEPRECATED_FIELD_SENT':
      return { title: '界面配置有误', hint: '检测到已退役的频率字段，已拒绝提交。', retryable: false };
    case 'UNAUTHENTICATED':
      return { title: '登录状态失效', hint: '重新登录后再试。', retryable: false };
    case 'FORBIDDEN':
      return { title: '没有权限', hint: '这个角色不属于当前账号，或服务端拒绝了这次请求。', retryable: false };
    case 'REVISION_CONFLICT':
      return { title: '别处已经改过', hint: '已重新读取最新设置，请确认后再保存一次。', retryable: true };
    case 'STATE_CONFLICT':
      return { title: '动作状态已变', hint: '刷新后按最新状态处理。', retryable: true };
    case 'GLOBAL_PAUSED':
      return { title: '总暂停已开启', hint: '在「边界」里关闭总暂停后再试。', retryable: false };
    case 'CHAR_DISABLED':
      return { title: '这个角色没开自主生活', hint: '在「边界」里允许该角色参与。', retryable: false };
    case 'BUDGET_EXHAUSTED':
      return { title: '额度用完了', hint: '今天的上限已用完；明天自动重置，不用你手动补。', retryable: false };
    case 'POLICY_DENIED':
      return { title: '被安全策略挡下', hint: '这类内容不允许自主执行。', retryable: false };
    case 'MISSING_CREDENTIALS':
      return { title: '模型凭据没配置', hint: '配置云端模型凭据后 TA 才能生成内容。', retryable: false };
    case 'WAITING_DEVICE':
      return { title: '等执行设备上线', hint: '本机不在线时动作不会假装完成。', retryable: true };
    case 'CAPABILITY_UNAVAILABLE':
      return { title: '这个能力当前不可用', hint: '可能缺少授权、配置或服务不可达。', retryable: false };
    case 'MODEL_FAILED':
      return { title: '模型调用失败', hint: '会自动退避重试，不需要你反复点。', retryable: true };
    case 'CIRCUIT_OPEN':
      return { title: '失败后进入保护性暂停', hint: '连续失败后暂停一段时间，恢复后只探测一次。', retryable: false };
    case 'GRANT_REQUIRED':
    case 'GRANT_EXPIRED':
      return { title: '需要（重新）授权外部访问', hint: '在「边界」里补授权，未授权前只发你同意过的字段。', retryable: false };
    case 'UNKNOWN_EFFECT':
      return { title: '结果待核对', hint: '这次动作是否生效还不确定，先不要重复操作。', retryable: false };
    case 'CANNOT_CANCEL':
      return { title: '取消不了这一步了', hint: '已经开始执行的动作不承诺能撤销。', retryable: false };
    default:
      return { title: '操作没成功', hint: '稍后再试一次。', retryable: true };
  }
}

// ── 校验辅助（测试/调试用）──────────────────────────────────────────────────

/** 界面只认识契约里的状态；出现新值时保持原样展示而不是崩掉。 */
export function statusLabel(status: string): string {
  return (STATUS_LABELS as Record<string, string>)[status] ?? status;
}

export function statusOrder(status: ActionStatus): number {
  const index = (ACTION_STATUSES as readonly string[]).indexOf(status);
  return index < 0 ? ACTION_STATUSES.length : index;
}

export const UI_LIMIT_KEYS = Object.keys(DEFAULT_ACCOUNT_LIMITS) as Array<keyof typeof DEFAULT_ACCOUNT_LIMITS>;

export const UI_PLATFORM_FORBIDDEN = PLATFORM_FORBIDDEN_CATEGORIES;

export const FORBIDDEN_CATEGORY_LABELS: Record<string, string> = {
  gambling: '赌博',
  betting_promotion: '博彩引流',
  real_finance: '真实金融交易',
  illegal_trade: '违法交易',
  credential_theft: '凭据窃取',
};
