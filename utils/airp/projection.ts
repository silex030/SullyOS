/**
 * AIRP 投影共享词汇表（stage 5 基础模块）。
 *
 * 各 App 把 AIRP 事件投影成自己能显示的东西时，统一从这里取分类、筛选与场景块渲染，
 * 避免每个 App 各写一套可见性判断。本模块是纯叶子：只做类型导入（见文件末），
 * 浏览器与 worker 打包都能安全引入。
 *
 * 投影锚点约定（anchor convention — 由各 App 任务自行实现，本模块不含任何持久化代码）：
 * 1. 每条投影出来的实体都必须带 `airpEventIds: [<event.id>, ...]`（数组，一条记录可锚多个事件）。
 *    时间戳语义按载体走：「历史记录」类（PhoneEvidence 等）取 `event.at`（记录何时发生，
 *    不用写入时刻重新计时，否则事件与投影无法对账）；「新发表的东西」（SocialPost、
 *    DiaryEntry）用发表/写入时刻——帖子按发布时间排序，回填 event.at 会打乱信息流因果。
 * 2. 再次投影前，先逐条扫描该 App 中现有的 `airpEventIds`，收集成集合即可，无需额外索引。
 * 3. 若已有同 id 的实体就跳过写入：同一事件重复投影必须幂等，第二次跑不产生副本。
 * 4. 去重与写入由消费本模块的各个 App 任务落实，本模块只保证词汇统一。
 */
import type { AirpCommittedEvent } from './commit';

export type AirpEventVisibility = 'public' | 'private' | 'trace';

/** 影响为 trace/minor 时才可能公开的活动组类型。 */
const PUBLIC_ACTIVITY_TYPES: ReadonlySet<string> = new Set([
  'activity',
  'movement',
  'schedule',
  'discovery',
]);

/** 本质上属于私密交互的类型，无论影响大小都不外泄。 */
const PRIVATE_TYPES: ReadonlySet<string> = new Set(['conversation', 'relationship']);

function isPresentText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPresentNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 分类采用「宁少勿多」：模糊一律按私密处理。
 * 判定顺序锁定为：先 major/关系/对话 → private；再 social_trace → trace；
 * 再活动组且 trace/minor → public；其余默认 private。
 */
export function classifyEventVisibility(
  event: Pick<AirpCommittedEvent, 'type' | 'impact'>,
): AirpEventVisibility {
  if (event.impact === 'major' || PRIVATE_TYPES.has(event.type)) return 'private';
  if (event.type === 'social_trace') return 'trace';
  if (
    PUBLIC_ACTIVITY_TYPES.has(event.type) &&
    (event.impact === 'trace' || event.impact === 'minor')
  ) {
    return 'public';
  }
  return 'private';
}

/**
 * 按 at 倒序防御性重排：即使调用方给的是乱序（或本身已排序）也保证结果有序；
 * at 相等或非有限值时保持输入相对顺序（稳定）。返回新数组，不修改入参。
 */
function sortByAtDesc<T extends { at: number }>(events: readonly T[]): T[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => (b.event.at - a.event.at) || (a.index - b.index))
    .map((entry) => entry.event);
}

/** limit 未给 → 不限；limit <= 0 → 空；否则取前 limit 条。 */
function takeLimit<T>(events: T[], limit?: number): T[] {
  if (limit === undefined) return events;
  if (limit <= 0) return [];
  return events.slice(0, limit);
}

export function selectEventsByVisibility<
  T extends Pick<AirpCommittedEvent, 'type' | 'impact' | 'at'>,
>(events: readonly T[], visibility: AirpEventVisibility, limit?: number): T[] {
  const matched = events.filter((event) => classifyEventVisibility(event) === visibility);
  return takeLimit(sortByAtDesc(matched), limit);
}

export function selectEventsByType<
  T extends Pick<AirpCommittedEvent, 'type' | 'at'>,
>(events: readonly T[], type: AirpCommittedEvent['type'], limit?: number): T[] {
  const matched = events.filter((event) => event.type === type);
  return takeLimit(sortByAtDesc(matched), limit);
}

/**
 * 返回还没被投影过的事件：id 不在 `projectedIds` 里的原样保留，顺序与入参完全一致
 * （本函数不排序，调用方需要「最新在前」就先自己排好）。
 *
 * `projectedIds` 兼容 Set 与数组两种形态（数组内部转 Set，重复 id 自动去重）。
 * 纯函数、不碰数据库，浏览器与 worker 都能用；不 clone 事件对象本身。
 */
export function selectUnprojectedEvents<T extends { id: string }>(
  events: readonly T[],
  projectedIds: ReadonlySet<string> | readonly string[],
): T[] {
  if (!Array.isArray(events)) return [];
  const projected = new Set<string>(
    Array.isArray(projectedIds)
      ? projectedIds
      : ((projectedIds as Iterable<string> | undefined) ?? []),
  );
  return events.filter((event) => !projected.has(event.id));
}

/** 查手机素材上限：一次刷新最多喂 5 条事件（记录是短线索，多了反而把明细摊薄）。 */
export const CHECK_PHONE_MATERIAL_LIMIT = 5;

/**
 * 查手机记录类型 → AIRP 事件类型的锁定映射（Task 28 裁决，不得随手扩）：
 * - chat → relationship：「和谁来往过」的对话痕迹。
 * - order / delivery → activity：下单、点外卖都属于活动。
 * - social → social_trace：动态/浏览痕迹。
 * - call → 不映射：没有诚实的 movement→通话 对应，通话记录维持原样。
 * - contacts → 不映射：通讯录是「建立联系人」，不是痕迹证据。
 * - 自定义 App（任意 app.id，走 customPrompt）→ 不映射：提示词由用户定，类型不可预测。
 * 未映射返回 undefined → 素材为空 → prompt 与记录逐字节保持旧行为。
 */
const CHECK_PHONE_EVENT_TYPE: Readonly<Record<string, AirpCommittedEvent['type']>> = {
  chat: 'relationship',
  order: 'activity',
  delivery: 'activity',
  social: 'social_trace',
};

/** 查手机素材的诚实约束：事件摘要里没写的具体信息一律不得虚构（否则模型会补出假收据）。 */
const CHECK_PHONE_HONESTY_RULE =
  '以上是真实发生过的事，只能依据这些写，不得编造与之冲突的新事实；' +
  '事件里没提到的具体信息（金额、商家、链接等）一律不得虚构，宁缺勿造。';

/**
 * 购买记录（order/delivery）专用的兼容版约束：这条链路本身就有「金额/商家/商品」模拟生成规则
 * （`buildPurchaseGenPrompt`），严格版的「金额一律不得虚构」会与模拟规则打架。改用这版后，
 * 素材只锁「买的东西和时间」不与事实冲突，明细仍按原有模拟规则生成。仅购买 seam 传入。
 */
export const CHECK_PHONE_PURCHASE_DISCIPLINE =
  '以上是真实发生过的事，买的东西和时间以此为准；' +
  '金额、商家等明细按原有模拟规则生成，但不得与这些事实冲突。';

/**
 * 挑出这类查手机记录该用的 AIRP 事件素材：按锁定映射取对应类型、剔除已投影 id、
 * 按 at 倒序取最多 limit 条（默认 5）。类型未映射时返回 []（调用方保持旧行为）。
 * 纯函数、不碰数据库；不 clone 事件对象。
 */
export function selectCheckPhoneMaterial(
  events: readonly AirpCommittedEvent[],
  projectedIds: ReadonlySet<string> | readonly string[],
  type: string,
  limit: number = CHECK_PHONE_MATERIAL_LIMIT,
): AirpCommittedEvent[] {
  if (!Array.isArray(events)) return [];
  const eventType = CHECK_PHONE_EVENT_TYPE[type];
  if (!eventType) return [];
  return takeLimit(
    selectUnprojectedEvents(selectEventsByType(events, eventType), projectedIds),
    limit,
  );
}

export interface CheckPhoneMaterialRenderOptions {
  /** 诚实约束文案；不传用默认的严格版 `CHECK_PHONE_HONESTY_RULE`。 */
  discipline?: string;
}

/**
 * 渲染查手机素材块：每条一行 `- {summary}` + 诚实约束。空素材返回 ''，
 * 调用方插入 prompt 时逐字节等同旧 prompt。
 *
 * `options.discipline` 供购买记录这类**有自己模拟明细规则**的 seam 传入兼容版约束
 * （见 `CHECK_PHONE_PURCHASE_DISCIPLINE`）；不传即严格版，渲染结果与旧版逐字节一致。
 */
export function renderCheckPhoneMaterialSection(
  events: readonly AirpCommittedEvent[],
  options?: CheckPhoneMaterialRenderOptions,
): string {
  if (!Array.isArray(events) || events.length === 0) return '';
  const lines = events.map((event) => `- ${event.summary}`);
  const discipline = options?.discipline ?? CHECK_PHONE_HONESTY_RULE;
  return `\n\n### 最近真实发生过的事 (Recent Events)\n${lines.join('\n')}\n${discipline}`;
}

export interface AirpSceneInput {
  now: number;
  tzId: string;
  locationLabel?: string;
  activity?: string;
  energy?: number;
  mood?: string;
  weatherText?: string;
  movements: Pick<AirpCommittedEvent, 'summary' | 'locationLabel' | 'at'>[];
}

const MAX_MOVEMENTS = 3;

/**
 * 与 utils/airp/directorPrompt.ts:62 的 wallClockText 逐字一致（同一墙钟格式，
 * 全仓不允许出现第二套）。无效 tzId 返回 null，由调用方走 ISO/UTC 兜底。
 */
function wallClockText(tzId: string, now: number): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tzId, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23',
    }).formatToParts(new Date(now));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
  } catch { return null; }
}

/**
 * 渲染角色的当前场景块。缺什么略什么；`now` 不是有限数（时间不可表示）时整块可为空串。
 * 精力/情绪只在活动行存在时以括号附注；近期行踪最多 3 条、按 at 倒序（最近的在前）。
 */
export function renderSceneBlock(input: AirpSceneInput): string {
  const lines: string[] = [];

  if (isPresentNumber(input.now)) {
    // 未设自定义时区的角色（绝大多数）跟随设备：取设备时区渲染墙钟，与 VN/通话的
    // 本地时间线保持一致。设备时区解析失败时受保护地回落，仍走下面的 ISO/UTC 分支；
    // 非法自定义 tzId 同理（wallClockText 抛错 → null → ISO/UTC）。
    // 纯空白 tzId 等同缺省（trim 后再判断），走设备时区默认；否则 Intl 会把空白当非法 zone
    // 直接回落 ISO/UTC，和 VN/通话的本地墙钟对不上。
    let tzId = typeof input.tzId === 'string' ? input.tzId.trim() : '';
    if (!isPresentText(tzId)) {
      try {
        tzId = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      } catch {
        tzId = '';
      }
    }
    const wall = isPresentText(tzId) ? wallClockText(tzId, input.now) : null;
    lines.push(
      wall
        ? `时间：${wall}（${tzId}）`
        : `时间：${new Date(input.now).toISOString()}（UTC）`,
    );
  }

  if (isPresentText(input.locationLabel)) lines.push(`地点：${input.locationLabel}`);

  if (isPresentText(input.activity)) {
    const extras: string[] = [];
    if (isPresentNumber(input.energy)) extras.push(`精力 ${input.energy}`);
    if (isPresentText(input.mood)) extras.push(`情绪 ${input.mood}`);
    lines.push(
      extras.length > 0 ? `活动：${input.activity}（${extras.join('，')}）` : `活动：${input.activity}`,
    );
  }

  if (isPresentText(input.weatherText)) lines.push(`天气：${input.weatherText}`);

  const movements = (Array.isArray(input.movements) ? input.movements : []).filter((movement) =>
    isPresentText(movement?.summary),
  );
  const recent = sortByAtDesc(movements)
    .slice(0, MAX_MOVEMENTS)
    .map((movement) => movement.summary);
  if (recent.length > 0) {
    lines.push('近期行踪：');
    for (const summary of recent) lines.push(`- ${summary}`);
  }

  return lines.join('\n');
}
