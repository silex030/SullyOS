/**
 * P4 / L2：把**前台已有的快照**归一成一小段动态尾段（不新增任何请求）。
 *
 * 三条硬规矩，代码里逐条钉着：
 *
 * 1. **不取数**：这里只吃调用方已经拿到的值（天气缓存读数、日程槽位、用户日程）。
 *    函数是纯的——零 fetch、零轮询、零 Date.now（nowMs 必须传进来），所以可以在
 *    离线测试里钉住「有没有多打一次网络」。
 * 2. **不重复注入**：调用方把「这段提示词里已经渲染过的来源」传进来（alreadyRendered），
 *    这些来源一律不再出现在快照里。同一件事说两遍比不说更糟：模型会当成两条独立观测。
 * 3. **缺席就省略**：没数据、没权限（开关关掉）、过期、与角色无关，都不占位——
 *    空字符串就是「这一段不该存在」，不要留个空标题。
 *
 * 认知边界（总计划 L1/L4）：快照只陈述观测到的读数；日程「这会儿没安排」不等于
 * 「对方有空」，天气好也不等于心情好。措辞里明写「只看到标题，没读正文」这类限定。
 */

import {
  activityPerception,
  calendarPerception,
  filterPerceptionEvents,
  newsPerception,
  renderPerceptionSnapshot,
  weatherPerception,
  type AirpPerceptionEvent,
  type AirpPerceptionSource,
} from './perception';

export interface ChatPerceptionWeatherSnapshot {
  city: string;
  description: string;
  temp?: number;
  observedAt: number;
}

export interface ChatPerceptionNewsSnapshot {
  platform: string;
  title: string;
  observedAt: number;
}

export interface ChatPerceptionCalendarSnapshot {
  id: string;
  title: string;
  startsAt: number;
  endsAt: number;
  subject: 'user' | string;
}

export interface ChatPerceptionActivitySnapshot {
  label: string;
  startLabel?: string;
  endLabel?: string;
  observedAt: number;
}

export interface ChatPerceptionInput {
  nowMs: number;
  /** 角色时区（日历/活动按它折算）。 */
  tzId: string;
  charId: string;
  /** 这次提示词里已经渲染过的来源：绝不重复注入。 */
  alreadyRendered?: AirpPerceptionSource[];
  /** 各来源开关（关掉的来源连快照都不给）。 */
  enabled?: Partial<Record<AirpPerceptionSource, boolean>>;
  weather?: ChatPerceptionWeatherSnapshot | null;
  news?: ChatPerceptionNewsSnapshot[];
  calendar?: ChatPerceptionCalendarSnapshot[];
  activity?: ChatPerceptionActivitySnapshot | null;
  maxItems?: number;
}

const DEFAULT_MAX_ITEMS = 4;

/**
 * 归一 → 本地过滤 → 渲染。返回空字符串表示「这一段不出现」。
 *
 * `filterPerceptionEvents` 会丢掉过期/重复/无权限/无关的事件，所以这里不需要自己
 * 判一遍新鲜度；`kept` 的顺序按 observedAt 由近到远，快照只取前 maxItems 条。
 */
export function buildChatPerceptionSnapshot(input: ChatPerceptionInput): string {
  const maxItems = typeof input.maxItems === 'number' && input.maxItems > 0
    ? Math.trunc(input.maxItems)
    : DEFAULT_MAX_ITEMS;
  const rendered = new Set<AirpPerceptionSource>(input.alreadyRendered ?? []);
  const enabled = (source: AirpPerceptionSource): boolean =>
    input.enabled?.[source] !== false && !rendered.has(source);

  const events: AirpPerceptionEvent[] = [];

  if (input.weather && enabled('weather')) {
    const temp = typeof input.weather.temp === 'number' && Number.isFinite(input.weather.temp)
      ? `，${Math.round(input.weather.temp)}°C`
      : '';
    events.push(weatherPerception({
      city: input.weather.city,
      summary: `${input.weather.description || '天气未知'}${temp}`,
      observedAt: input.weather.observedAt,
      subject: input.charId,
    }));
  }

  if (enabled('news')) {
    for (const item of input.news ?? []) {
      if (!item || typeof item.title !== 'string' || !item.title.trim()) continue;
      events.push(newsPerception({
        platform: item.platform || '热榜',
        title: item.title,
        observedAt: item.observedAt,
        subject: input.charId,
      }));
    }
  }

  if (enabled('calendar')) {
    for (const item of input.calendar ?? []) {
      if (!item || !item.id || !item.title) continue;
      // 已经结束的日程不是「此刻的观测」：calendarPerception 的过期时间取 max(endsAt, now+1min)，
      // 靠它兜不住过去的事，所以这里先按结束时刻筛掉。
      if (Number.isFinite(item.endsAt) && item.endsAt <= input.nowMs) continue;
      events.push(calendarPerception({
        id: item.id,
        title: item.title,
        startsAt: item.startsAt,
        endsAt: item.endsAt,
        observedAt: input.nowMs,
        subject: item.subject,
        tzId: input.tzId,
      }));
    }
  }

  if (input.activity && enabled('activity')) {
    events.push(activityPerception({
      label: input.activity.label,
      ...(input.activity.startLabel ? { startLabel: input.activity.startLabel } : {}),
      ...(input.activity.endLabel ? { endLabel: input.activity.endLabel } : {}),
      observedAt: input.activity.observedAt,
      subject: input.charId,
    }));
  }

  if (events.length === 0) return '';

  const { kept } = filterPerceptionEvents({
    events,
    nowMs: input.nowMs,
    subjectAllow: [input.charId, 'user'],
    maxItems,
  });
  if (kept.length === 0) return '';
  return renderPerceptionSnapshot(kept, { nowMs: input.nowMs, maxItems });
}
