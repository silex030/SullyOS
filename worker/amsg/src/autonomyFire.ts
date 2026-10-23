/**
 * 自主背景生活（`autonomous_round`）到点这一轮 —— wrapper 层 handler。
 *
 * 调度器（autonomyScheduler）把任务建出来，这里到点干活：读 fire_pack 的完整人格模板 +
 * 自主设置终值，拼成一轮「你自己的时间」的提示词交给上游那次 fire，模型回一份 JSON，
 * 这里落 D1（autonomy_experiences）→ 过反刍闸 → 判要不要推 → emitResult 把结果送回
 * 客户端 → reportAutonomyOutcome 回账。
 *
 * 四个不显然的设计点：
 *
 * 1. **D1 走模块级 holder**（`configureAutonomyFireDb`）。kind 分派点是模块级的
 *    `amsgHooks`，上游调 hook 只传一个参数（chunk 里 `hooks.onBeforeFire(fireCtx)`），
 *    闭包够不到 `env`；`KindFireCtx` / `KindSessionCtx` 也刻意不含 db。所以照
 *    `configureInstantErrorPush` 的先例：`buildWorkerConfig` 里注入一次，handler 只读
 *    这个 holder。**holder 没配上时整轮安全跳过（skip-plan），绝不抛**——单测自己喂
 *    hand-rolled 的假库并在 afterEach 里清回 null，vitest 按文件隔离，不会串味。
 *
 * 2. **这一轮没有工具面**。kind 路径的 wrapper 不转发 tools / toolChoice
 *    （index.ts:1661-1664），就算模型幻觉出 tool_calls 也没有执行器。所以提示词里
 *    **绝不出现工具块**，只明说「本轮没有可用工具」，让模型从上下文（人格、对话尾巴、
 *    兴趣、此刻的读数）里取材。真工具面留到有 live-fire 验证的那一期再接。
 *
 * 3. **采样参数不在这里**。temperature / maxTokens 由 Task-17 的
 *    `buildAutonomyScheduleRequest` 写进任务 payload（fire 侧从 payload 取），handler
 *    一个采样参数都不设；top_p 全篇不出现。
 *
 * 4. **纯逻辑全导出**：反刍闸的输入、后处理三件、两层容错解析、提示词组装都是纯函数
 *    （D1 读写只在 handler 里），单测直接钉它们，不用起 ctx。
 *
 * 结果信封 `AUTONOMY_RESULT_KIND`（= 'autonomy_result'）的字段是 Task 18→19 的锁定
 * 契约：experiences（每条带 D1 行 id，客户端按它对账 outbox）/ proposedEvents /
 * usage / toolsUsed / did / rested。
 */

import { AUTONOMY_RESULT_KIND } from '../../../utils/airp/autonomySettings';
import {
  computeScheduledAt,
  parseWorkflowExecutionOutput,
  validateAutonomyWorkflowProposals,
  type AutonomyPlanRecord,
  type AutonomyWorkflowKind,
} from '../../../utils/airp/lifeWorkflow';
import { canRunPrivateLifeAction } from '../../../utils/airp/lifeWorkflowPermissions';
import {
  activityPerception,
  clockPerception,
  filterPerceptionEvents,
  perceptionDedupeRows,
  renderPerceptionSnapshot,
  type AirpPerceptionEvent,
} from '../../../utils/airp/perception';
import {
  AMSG_FIRE_PACK_KEY,
  amsgStateNamespace,
  parseFirePack,
  renderFirePack,
  unpackStateValue,
  wallClockPartsInZone,
  type AmsgFirePack,
} from '../../../utils/amsgFirePack';
import {
  RUMIN_PAGES,
  RUMIN_WINDOW_H,
  buildRuminationBanLine,
  resolveRumination,
  ruminationVerdict,
  type RuminationPage,
} from './autonomyRumination';
import {
  autonomyDateKey,
  readAutonomyGuardrailsForUserDetailed,
  reportAutonomyOutcome,
  type AutonomyPlanMeta,
} from './autonomyScheduler';
import {
  addAutonomyExperience,
  ensureAutonomySchema,
  getAutonomyPlan,
  getAutonomyState,
  insertAutonomyPlan,
  loadPerceptionSeen,
  markAutonomyPlanRunning,
  savePerceptionSeen,
  settleAutonomyPlan,
  updateAutonomyPlanRun,
  type AutonomyDb,
} from './autonomyStore';
import type {
  FireKindHandler,
  KindDecision,
  KindFireCtx,
  KindFirePlan,
  KindSessionCtx,
} from './fireKinds';
import { buildWantToSharePush } from './instantChat';
import { parseTravelIntent, recordTravelIntent } from './travel/intent';
import { ensureTravelSchema } from './travel/store';
import type { ResolvedAirpAutonomy } from '../../../utils/airp/autonomySettings';
import { resolveScheduleSlots } from '../../../utils/scheduleInjection';

/** 只为单测导出：让测试能不经 index.ts 直接喂一份 ctx。 */
export type { KindFireCtx, KindSessionCtx };

// ─── D1 holder（见文件头第 1 点） ────────────────────────────────────────

let fireDb: AutonomyDb | null = null;
/** 共享护栏行是加密的：到点复核必须用同一把 master key。缺省 = 复核必失败 = 整轮暂停。 */
let fireMasterKey = '';

/**
 * `buildWorkerConfig` 的写入口；export 只为单测注入假库。
 * 传 null / undefined 一律收成 null：没配 D1 的部署整轮跳过，不抛。
 */
export function configureAutonomyFireDb(db: AutonomyDb | null | undefined): void {
  fireDb = db ?? null;
}

/** `buildWorkerConfig` 的写入口（与 configureAutonomyFireDb 同模式）；传空 = 无法复核护栏。 */
export function configureAutonomyFireMasterKey(masterKey: string | null | undefined): void {
  fireMasterKey = (masterKey ?? '').trim();
}

// ─── 跳过原因（日志与单测共用的字面量） ──────────────────────────────────

export const AUTONOMY_FIRE_SKIP = {
  dbUnavailable: 'autonomy-db-unavailable',
  stateMissing: 'autonomy-state-missing',
  packMissing: 'autonomy-pack-missing',
  packUnreadable: 'autonomy-pack-unreadable',
  disabled: 'autonomy-disabled',
  tzInvalid: 'autonomy-tz-invalid',
  /** 用户级护栏读不出来（缺钥/密文坏/D1 错）：fail-closed，不执行。 */
  guardrailsUnreadable: 'autonomy-guardrails-unreadable',
  /**
   * 认不出这个角色的 owner（client_state 没有带 user_id 的角色行 / 查询出错）：
   * 没有 userId 就读不到用户级总暂停，**不能**当成「一个还没暂停的新用户」放行。
   */
  ownerUnresolved: 'autonomy-owner-unresolved',
  /** 用户在我们建任务之后、到点之前按了总暂停。 */
  pausedByUser: 'autonomy-paused-by-user',
} as const;

export const AUTONOMY_BAD_OUTPUT_REASON = 'autonomy-bad-output';

// ─── 常量 ────────────────────────────────────────────────────────────────

/**
 * 一条 note 的理想长度（B2 的 800 字）。超了就整句收笔裁进这个帽——
 * 调用侧的 maxTokens 1600 正好是这个数 ×2，留给 JSON 信封与收笔的余量。
 */
export const AUTONOMY_NOTE_MAX_CHARS = 800;

const HOUR_MS = 60 * 60 * 1000;

/** 数「当日推了几条」时的回溯窗：26h 覆盖任何时区偏移，按角色时区日期过滤。 */
const PUSH_COUNT_LOOKBACK_MS = 26 * HOUR_MS;

/** 禁清嗓子的开头（B2 的指名清单，原样抄）。 */
export const THROAT_CLEARING_OPENERS = ['翻到了', '查到了', '记一下', '去查了一眼'] as const;

/** 心跳与 did 认得的几种「做了什么」（对齐 rulings 里 Task-19 的心跳契约）。 */
export const AUTONOMY_DID_KINDS = ['surf', 'game', 'forum', 'rest'] as const;

/** proposedEvents 认得的 type（对齐 utils/airp/types.ts 的 AirpProposedEvent）。 */
export const AUTONOMY_EVENT_TYPES = [
  'conversation', 'activity', 'movement', 'schedule', 'relationship', 'discovery', 'social_trace',
] as const;

const EVENT_TYPE_SET = new Set<string>(AUTONOMY_EVENT_TYPES);
const DID_KIND_SET = new Set<string>(AUTONOMY_DID_KINDS);

// ─── 后处理三件（纯） ────────────────────────────────────────────────────

/**
 * 禁清嗓子：把开头的口水话削掉，让首句从数字 / 画面 / 推翻预期处落笔。
 * 连削多道（「记一下：翻到了……」这种叠着来的）。削完可能是空串——调用方丢掉这条。
 */
export function stripThroatClearing(text: string, openers: readonly string[] = THROAT_CLEARING_OPENERS): string {
  let out = text.trimStart();
  let changed = true;
  while (changed) {
    changed = false;
    for (const opener of openers) {
      if (out.startsWith(opener)) {
        out = out.slice(opener.length).replace(/^[，,、：:。.!！?？\s]+/u, '');
        changed = true;
      }
    }
  }
  return out;
}

/**
 * 洗链接：`[词](url)` 只留词，裸网址整段抹掉。
 * 先处理带词的，再抹裸的——`[https://x](https://x)` 这种两步都能收干净。
 */
export function washMarkdownLinks(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\((?:[^()\s]|\([^()]*\))*\)/g, '$1')
    // 裸网址只吃 URL 合法字符：中文正文里网址后面常常直接接汉字，用 \S+ 会把后半句一起吞掉。
    .replace(/https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/g, '');
}

/**
 * 整句收笔：超帽裁进帽，先退到帽前最后一个整句（。！？…），
 * 一句都没有（长句没标点）就抹掉吊尾的逗号/顿号/空白，绝不留半句话。
 */
export function fullStopNote(text: string, cap: number = AUTONOMY_NOTE_MAX_CHARS): string {
  if (text.length <= cap) return text;
  const head = text.slice(0, cap);
  let lastEnd = -1;
  for (const mark of ['。', '！', '？', '…', '!', '?', '.']) {
    lastEnd = Math.max(lastEnd, head.lastIndexOf(mark));
  }
  if (lastEnd >= 0) return head.slice(0, lastEnd + 1);
  return head.replace(/[，,、；;\s]+$/u, '');
}

/** 三件按序过一遍：清嗓子 → 洗链接 → 整句收笔。空串 = 这条 note 没救了。 */
export function postProcessNote(note: string, cap: number = AUTONOMY_NOTE_MAX_CHARS): string {
  return fullStopNote(washMarkdownLinks(stripThroatClearing(note)), cap).trim();
}

// ─── 两层容错解析（纯） ──────────────────────────────────────────────────

export interface AutonomyParsedExperience {
  q: string;
  note: string;
  kind: string;
  importance: number;
}

export interface AutonomyProposedEvent {
  type: string;
  summary: string;
  participants?: string[];
  locationLabel?: string;
  impact?: string;
}

export interface AutonomyRoundReply {
  /** 这一轮什么都不记（rest:true，或压根没产出可用经历）。 */
  rested: boolean;
  experiences: AutonomyParsedExperience[];
  proposedEvents: AutonomyProposedEvent[];
  /**
   * P5：模型顺带提的低风险生活工作流（原始值，形状未校验）。
   * 真正落计划前必须过 lifeWorkflow 的白名单校验器；这里只负责「掏出来」。
   */
  workflowCandidates: unknown[];
  /**
   * B7：可选的一次「想不想出门」。原样透传，由 `travel/intent.ts` 做严格解析
   * （缺省 = 这一轮没提，等于不出门；写坏了只丢这一段，不判整轮失败）。
   */
  travelIntent: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const PARSE_FAILED = Symbol('parse-failed');

const tryParseJson = (text: string): unknown | typeof PARSE_FAILED => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return PARSE_FAILED;
  }
};

/**
 * 第一层：从模型输出里把那个 JSON 对象掏出来。容忍 ```json 围栏、前后闲话
 * （按最外层的 `{`…`}` 再切一刀）。掏不出来回 null。
 */
export function extractAutonomyJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidates = fenced ? [fenced[1], trimmed] : [trimmed];
  for (const candidate of candidates) {
    const direct = tryParseJson(candidate.trim());
    if (direct !== PARSE_FAILED) return direct;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const sliced = tryParseJson(candidate.slice(start, end + 1));
      if (sliced !== PARSE_FAILED) return sliced;
    }
  }
  return null;
}

const toExperience = (raw: Record<string, unknown>): AutonomyParsedExperience | null => {
  const note = typeof raw.note === 'string' ? raw.note.trim() : '';
  if (!note) return null;
  const kind = typeof raw.kind === 'string' && raw.kind.trim() ? raw.kind.trim() : 'rest';
  const importance = typeof raw.importance === 'number' && Number.isFinite(raw.importance)
    ? Math.trunc(raw.importance)
    : 0;
  return { q: typeof raw.q === 'string' ? raw.q.trim() : '', note, kind, importance };
};

/** 认不出来的 type 直接丢（不致命）——影响档位一律透传，客户端自己去降级。 */
const toProposedEvent = (raw: Record<string, unknown>): AutonomyProposedEvent | null => {
  const type = typeof raw.type === 'string' ? raw.type.trim() : '';
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
  if (!type || !summary || !EVENT_TYPE_SET.has(type)) return null;
  const participants = Array.isArray(raw.participants)
    ? raw.participants.filter((item): item is string => typeof item === 'string')
    : undefined;
  return {
    type,
    summary,
    ...(participants && participants.length > 0 ? { participants } : {}),
    ...(typeof raw.locationLabel === 'string' && raw.locationLabel.trim()
      ? { locationLabel: raw.locationLabel.trim() } : {}),
    ...(typeof raw.impact === 'string' && raw.impact.trim() ? { impact: raw.impact.trim() } : {}),
  };
};

/**
 * 第二层：形状校验 + 逐项抢救。
 *
 * 硬失败（回 null，调用方走失败路径）：找不到 JSON、不是对象、`v` 不是 1、
 * `rest` 不是布尔、experiences / proposedEvents 不是数组、整个对象一个认得的字段都没有。
 * 软容错：单条 experience 没有 note 就丢、未知 event type 就丢、别的字段缺了就补默认。
 *
 * `rest: true` 优先于同轮的 experiences（模型自己说歇了，就别硬记）。
 */
export function parseAutonomyRoundReply(text: string): AutonomyRoundReply | null {
  const raw = extractAutonomyJson(text);
  if (!isRecord(raw)) return null;
  if (raw.v !== undefined && raw.v !== 1) return null;
  if (raw.rest !== undefined && typeof raw.rest !== 'boolean') return null;
  if (raw.experiences !== undefined && !Array.isArray(raw.experiences)) return null;
  if (raw.proposedEvents !== undefined && !Array.isArray(raw.proposedEvents)) return null;
  // workflows 是 P5 追加的可选段：形状不对就整轮判坏（跟 experiences 同一条纪律），
  // 缺省 = 这一轮没提任何生活工作流。
  if (raw.workflows !== undefined && !Array.isArray(raw.workflows)) return null;

  const rest = raw.rest === true;
  const experiences = rest
    ? []
    : (raw.experiences ?? [])
      .filter(isRecord)
      .map(toExperience)
      .filter((item): item is AutonomyParsedExperience => item !== null);
  const proposedEvents = (raw.proposedEvents ?? [])
    .filter(isRecord)
    .map(toProposedEvent)
    .filter((item): item is AutonomyProposedEvent => item !== null);
  const workflowCandidates: unknown[] = raw.workflows ?? [];
  // 出行是**可选**产出：形状在这里不校验（各段由 travel/intent.ts 的严格解析器负责），
  // 坏值也绝不能让整轮自主回合失败——那等于用一次手滑吞掉角色这一轮的全部生活。
  const travelIntent = raw.travel;

  const hasKnownField = raw.rest !== undefined || raw.experiences !== undefined
    || raw.proposedEvents !== undefined || raw.workflows !== undefined
    || raw.travel !== undefined;
  if (!hasKnownField) return null;
  return {
    rested: rest || (experiences.length === 0 && proposedEvents.length === 0),
    experiences,
    proposedEvents,
    workflowCandidates,
    travelIntent,
  };
}

// ─── 反刍闸的输入与提示词（纯） ──────────────────────────────────────────

/**
 * 已经写腻了的方向（喂给「这次别再碰」的禁区行）：近窗口里自己就撞满
 * `RUMIN_HIT_PAGES` 页的搜索词，最新在前、去重。
 */
export function collectBurntLines(pages: readonly RuminationPage[], nowMs: number): string[] {
  const burnt: string[] = [];
  for (const page of pages) {
    const line = typeof page?.q === 'string' ? page.q.trim() : '';
    if (!line || burnt.includes(line)) continue;
    if (ruminationVerdict(line, pages, nowMs).blocked) burnt.push(line);
  }
  return burnt;
}

const HINT_LINE_MAX = 80;
const HINT_LINE_COUNT = 8;

const DIALOGUE_HEADING = '【最近对话上下文】';
const DIALOGUE_HEADING_END = '【当前时刻补充】';
const EMPTY_TRANSCRIPT = '（暂时没有最近聊天记录）';

/**
 * 对话尾巴：从渲染好的人格模板里把【最近对话上下文】那一段的最后 8 行取出来
 * （每行截 80 字）。fire_pack 里对话只有这一个常驻落点——`pack.chat` 只在那条
 * 即时对话上传路径上才有，不能赌。
 */
export function extractDialogueTail(personalityText: string): string[] {
  const start = personalityText.indexOf(DIALOGUE_HEADING);
  if (start < 0) return [];
  const after = personalityText.slice(start + DIALOGUE_HEADING.length);
  const end = after.indexOf(DIALOGUE_HEADING_END);
  const section = end >= 0 ? after.slice(0, end) : after;
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== EMPTY_TRANSCRIPT)
    .slice(-HINT_LINE_COUNT)
    .map((line) => (line.length > HINT_LINE_MAX ? line.slice(0, HINT_LINE_MAX) : line));
}

const renderTopicBlock = (args: {
  personality: string;
  autonomy: ResolvedAirpAutonomy;
}): string => {
  const { autonomy } = args;
  const tail = extractDialogueTail(args.personality);
  const lines: string[] = [];
  if (tail.length > 0) {
    lines.push('最近聊到过这些：');
    lines.push(...tail.map((line) => `- ${line}`));
  } else if (autonomy.interests.length > 0) {
    lines.push(`你平时惦记这些：${autonomy.interests.join('、')}`);
  }
  if (autonomy.avoidTopics.length > 0) {
    lines.push(`这些方向你自己说过这次不碰：${autonomy.avoidTopics.join('、')}`);
  }
  if (lines.length === 0) return '';
  return [
    '【可以顺着去的由头】',
    ...lines,
    '里头要有当时心里一动、这会儿想接着琢磨的，就顺着去；没有就当没看见，不用汇报、不用接着聊。',
  ].join('\n');
};

/**
 * 覆盖句：渲染出来的完整聊天模板末尾还挂着【开口之前】那套「已经发生过就什么都不要输出」，
 * 那是实时聊天（推送到用户）的规矩，跟这一轮的 JSON 契约正好顶牛。句子紧跟在模板后面，
 * 先把「这一轮以 JSON 契约为准」立死，再进框定语。
 */
export const AUTONOMY_ROUND_OVERRIDE =
  '注意：上面是你在正常聊天时的完整规矩，但【开口之前】那段只管实时聊天、不管这一轮——'
  + '这一轮必须按下面的 JSON 契约输出（想歇就输出 rest），绝不能输出空内容。';

/**
 * P6 预设覆盖的键（fire_pack.autonomyPromptOverrides 与 buildAutonomyRoundPrompt
 * 第二参数共用同一套 key；取值为空串 / 缺省时回退下面的硬编码常量，旧行为不变）。
 * key → 预设目录 sourceKey：overrideBlock→autonomy.override、situBlock→autonomy.situ、
 * freedomBlock→autonomy.freedom、noToolsBlock→autonomy.noTools、outputBlock→autonomy.output。
 */
export const AUTONOMY_PROMPT_OVERRIDE_KEYS = [
  'overrideBlock', 'situBlock', 'freedomBlock', 'noToolsBlock', 'outputBlock',
] as const;

/** 以下四块是 buildAutonomyRoundPrompt 的硬编码缺省（与预设目录 autonomy.* 五条逐字同源）。 */
export const AUTONOMY_ROUND_SITU = [
  '【这一轮的处境】',
  '- 对方没有在等你回话，你现在做的事不需要为了谁，也不用向谁交代。',
  '- 这是属于你自己的一小会儿：可以发呆，可以随便看看，也可以什么都不做。',
  '- 不用哄谁，不用汇报，也不用有产出。',
].join('\n');

export const AUTONOMY_ROUND_FREEDOM = [
  '【怎么过这一小会儿】',
  '- 允许无聊，允许只记下碎片，不追求有用。',
  '- 允许这次什么都不记。',
].join('\n');

export const AUTONOMY_ROUND_NO_TOOLS = [
  '【这一轮没有可用工具】',
  '本轮你没有任何工具可调，也别在正文里写工具调用——内容只能从上面给你的上下文'
    + '（人设、对话、兴趣、此刻的读数）里来。',
].join('\n');

export const AUTONOMY_ROUND_OUTPUT = [
  '【这一轮的产出】',
  '上面那份聊天模板是你在正常聊天时的规矩；这一轮不一样：不发给任何人，也不聊天，'
    + '只把结果写成一个 JSON 对象。',
  '{"v":1,"experiences":[{"q":"为什么会有这条（一句话）","note":"第一人称随手记，口语、具体、有画面",'
    + '"kind":"surf|game|forum|rest","importance":0}],"proposedEvents":[],"workflows":[],"rest":false}',
  'kind 只能从 surf（上网闲逛）、game（玩游戏）、forum（逛社区）、rest（发呆歇着）里挑一个；'
    + 'importance 是 0 到 3 的数字。',
  'proposedEvents 只在「这件事会影响你之后的生活」时才写，每项 '
    + '{"type":"conversation|activity|movement|schedule|relationship|discovery|social_trace",'
    + '"summary":"...","impact":"trace|minor|major"}；平时就写空数组。',
  'workflows 只写「你之后想为自己做的一件低风险小事」，不要为了填而填，平时就写空数组；'
    + '最多一条，每项形如 {"kind":"diary|plan|interest_note","purpose":"为什么想做（一句话）",'
    + '"trigger":{"kind":"idle","afterMinutes":120} 或 {"kind":"at_time","atLocalTime":"21:30"},'
    + '"action":{"kind":"与外面一致","title":"标题","maxChars":400},"expiresInHours":24}。'
    + '它只是提议，不是命令，也不能带网址、工具、代码或权限；不写就什么都不做。',
  '出门是可选的一段，不是任务：想出去就写 "travel":{"want":"go","wish":"一句话（说想去哪类地方，不写地址/门牌/坐标）"}；'
    + '只想随便走走就写 "travel":{"want":"wander"}；'
    + '不想出门就不写这个字段（或写 "want":"none"）。没有人在要求你出门，也没有次数指标。',
  '想说的那条放 experiences 最前面。这一轮什么都不想记就写 {"v":1,"rest":true}。',
  '除了这个 JSON 什么都别输出（不要解释、不要代码块之外的话）。',
].join('\n');

/** 这一轮的提示词。顺序锁死：人格全文 → 覆盖句 → 框定语 → 自由度 → 由头 → 语气 → 无工具 → 产出。 */
export function buildAutonomyRoundPrompt(args: {
  pack: AmsgFirePack;
  nowMs: number;
  pages: readonly RuminationPage[];
  autonomy: ResolvedAirpAutonomy;
  /** P4：本地过滤后的感知小快照（没有就省略，不硬凑一段）。 */
  perceptionBlock?: string;
}, overrides?: Record<string, string>): string {
  // 人格全文：fire_pack 的完整模板（含人设 + 对话尾巴 + 此刻的读数），槽位在 fire
  // 时刻填掉。「本次任务」留空——这一轮的任务书在下面，不借用聊天那条路的指令槽。
  const personality = renderFirePack(args.pack, args.nowMs, '');
  const topicBlock = renderTopicBlock({ personality, autonomy: args.autonomy });
  const banLine = buildRuminationBanLine(collectBurntLines(args.pages, args.nowMs));
  const noteHint = args.autonomy.noteStyleHint
    ? [`【记录的语气】`, args.autonomy.noteStyleHint].join('\n')
    : '';

  // P6 预设覆盖：显式参数优先，其次 fire_pack 经同步链带下来的 autonomyPromptOverrides，
  // 空串 / 非串一律回退硬编码（旧调用不传参行为不变）。
  const fromPack = args.pack.autonomyPromptOverrides;
  const pick = (key: string, fallback: string): string => {
    const direct = overrides?.[key];
    if (typeof direct === 'string' && direct.length > 0) return direct;
    const packed = fromPack?.[key];
    if (typeof packed === 'string' && packed.length > 0) return packed;
    return fallback;
  };
  const overrideBlock = pick('overrideBlock', AUTONOMY_ROUND_OVERRIDE);
  const situBlock = pick('situBlock', AUTONOMY_ROUND_SITU);
  const freedomBlock = pick('freedomBlock', AUTONOMY_ROUND_FREEDOM);
  const noToolsBlock = pick('noToolsBlock', AUTONOMY_ROUND_NO_TOOLS);
  const outputBlock = pick('outputBlock', AUTONOMY_ROUND_OUTPUT);

  return [
    personality,
    overrideBlock,
    situBlock,
    freedomBlock,
    topicBlock,
    banLine,
    noteHint,
    args.perceptionBlock ?? '',
    noToolsBlock,
    outputBlock,
  ].filter((block) => block.length > 0).join('\n\n');
}

// ─── P4：感知小快照（后台这一轮） ────────────────────────────────────────
//
// 后台只吃「已经随包带上来的」素材：角色时区（现在几点）与 fire_pack.scene 里当天的
// 日程槽位。天气/热搜/用户日历在前台链路由各自缓存的持有者归一后传进来（同一份
// perception 叶子），worker 不为了感知另起监控或抓取。

export async function buildAutonomyPerceptionBlock(args: {
  db: AutonomyDb;
  charId: string;
  pack: AmsgFirePack;
  nowMs: number;
}): Promise<string> {
  const events: AirpPerceptionEvent[] = [];
  try {
    events.push(clockPerception({ nowMs: args.nowMs, tzId: args.pack.tzId, subject: args.charId }));
  } catch { /* 时区坏掉时 perception 自己回落 UTC，这里不再兜 */ }

  try {
    const scene = args.pack.scene;
    if (scene && scene.dateKey === autonomyDateKey(args.nowMs, args.pack.tzId) && scene.schedule) {
      const p = wallClockPartsInZone(args.nowMs, { tzId: args.pack.tzId });
      const localNow = new Date(p.year, p.month - 1, p.day, p.hour, p.minute);
      const { current, next } = resolveScheduleSlots(scene.schedule, localNow);
      if (current?.activity) {
        events.push(activityPerception({
          label: current.activity,
          ...(current.startTime ? { startLabel: current.startTime } : {}),
          ...(next?.startTime ? { endLabel: next.startTime } : {}),
          observedAt: args.nowMs,
          subject: args.charId,
        }));
      }
    }
  } catch (error) {
    console.warn('[amsg:autonomy] 日程感知没读出来（这一轮少一段）', args.charId, error);
  }

  let seen: Awaited<ReturnType<typeof loadPerceptionSeen>> = [];
  try {
    seen = await loadPerceptionSeen(args.db, args.charId, args.nowMs);
  } catch { /* 读不到就当没喂过，最多重复一小段 */ }

  const filtered = filterPerceptionEvents({
    events,
    nowMs: args.nowMs,
    seen,
    subjectAllow: [args.charId, 'user'],
    maxItems: 4,
  });
  if (filtered.kept.length === 0) return '';

  try {
    await savePerceptionSeen(args.db, args.charId, perceptionDedupeRows(filtered.kept));
  } catch { /* best-effort：下一轮重复喂一次，不影响本轮 */ }

  return renderPerceptionSnapshot(filtered.kept, { nowMs: args.nowMs, maxItems: 4 });
}

// ─── P5：到点执行生活工作流 ──────────────────────────────────────────────
//
// 关键边界：这是**另起的一次后台请求**（与聊天首字无关），没有工具面、不推送、不向用户
// 报「任务完成」。产物只是角色自己账本里的一条虚拟经历（basis='virtual'）。

export const AUTONOMY_WORKFLOW_SKIP = {
  planMissing: 'autonomy-plan-missing',
  planNotPending: 'autonomy-plan-not-pending',
  planExpired: 'autonomy-plan-expired',
  planLeaseLost: 'autonomy-plan-lease-lost',
  badMeta: 'autonomy-plan-meta-invalid',
  badOutput: 'autonomy-workflow-bad-output',
} as const;

/** 执行租约：一轮后台生成（含一次 LLM）最多占用 10 分钟；超时由调度器按过期收。 */
export const AUTONOMY_PLAN_RUN_LEASE_MS = 10 * 60 * 1000;

const WORKFLOW_LABEL: Record<AutonomyWorkflowKind, string> = {
  diary: '私人日记',
  plan: '个人计划调整',
  interest_note: '阅读/兴趣笔记',
};

export function readAutonomyPlanMeta(taskMeta: Record<string, unknown> | undefined): AutonomyPlanMeta | null {
  const raw = taskMeta?.['amsgAutonomyPlan'];
  if (!isRecord(raw)) return null;
  const planId = typeof raw.planId === 'string' ? raw.planId.trim() : '';
  const kind = raw.kind;
  if (!planId) return null;
  if (kind !== 'diary' && kind !== 'plan' && kind !== 'interest_note') return null;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title) return null;
  const maxChars = typeof raw.maxChars === 'number' && Number.isFinite(raw.maxChars)
    ? Math.max(80, Math.min(1200, Math.trunc(raw.maxChars))) : 400;
  return {
    planId,
    kind,
    title,
    purpose: typeof raw.purpose === 'string' ? raw.purpose.trim() : '',
    ...(typeof raw.noteHint === 'string' && raw.noteHint.trim() ? { noteHint: raw.noteHint.trim() } : {}),
    maxChars,
  };
}

/**
 * 工作流这一轮的覆盖句：人格模板末尾的【开口之前】只服务实时聊天，这一轮的产出
 * 由工作流自己的契约决定（日记/笔记是散文，计划调整是 JSON）——不能借用回合那句
 * 「按 JSON 契约输出」，否则日记会被逼成 JSON。
 */
export const AUTONOMY_WORKFLOW_OVERRIDE =
  '注意：上面是你在正常聊天时的完整规矩，但【开口之前】那段只管实时聊天、不管这一轮——'
  + '这一轮按下面的产出要求写，不要输出空内容，也不要向任何人说话。';

/**
 * 这一轮「替自己做完一件小事」的提示词。
 * 顺序：人格全文 → 覆盖句 → 这一轮要做什么 → 感知 → 无工具 → 产出契约。
 */
export function buildWorkflowExecutionPrompt(args: {
  pack: AmsgFirePack;
  nowMs: number;
  plan: Pick<AutonomyPlanRecord, 'kind' | 'title' | 'purpose' | 'maxChars'> & { noteHint?: string };
  perceptionBlock?: string;
}): string {
  const personality = renderFirePack(args.pack, args.nowMs, '');
  const label = WORKFLOW_LABEL[args.plan.kind];
  const situ = [
    `【这一轮要替自己做完的一件事：${label}】`,
    `- 标题：${args.plan.title}`,
    args.plan.purpose ? `- 为什么想做：${args.plan.purpose}` : '',
    args.plan.noteHint ? `- 记录的语气：${args.plan.noteHint}` : '',
    '- 这是你自己想做的事，不是任务、不用向谁交代，也不发给任何人看。',
    '- 只写你这一轮真实做/想到的内容；没发生的事不要写成已经发生，也不要替对方决定感受。',
  ].filter(Boolean).join('\n');

  const output = args.plan.kind === 'plan'
    ? [
        '【这一轮的产出】',
        '只输出一个 JSON 对象：{"v":1,"text":"用第一人称说一句你此刻的想法","plans":[{"title":"之后想做的一件小事"}]}。',
        'plans 至少一条、最多三条；只写你自己之后想做的事，不要排对方的时间。',
      ].join('\n')
    : [
        '【这一轮的产出】',
        '只输出一段第一人称的文字（不要 JSON、不要解释、不要向任何人说话），'
          + `长度控制在 ${args.plan.maxChars} 字以内，像你私下随手记的那样。`,
      ].join('\n');

  return [
    personality,
    AUTONOMY_WORKFLOW_OVERRIDE,
    situ,
    args.perceptionBlock ?? '',
    AUTONOMY_ROUND_NO_TOOLS,
    output,
  ].filter((block) => block.length > 0).join('\n\n');
}

/** 把这一轮模型提的工作流降成计划行（P5 W1/W2）。返回真正落库的提议。 */
export async function persistWorkflowProposals(args: {
  db: AutonomyDb;
  charId: string;
  reply: AutonomyRoundReply;
  nowMs: number;
  tzId: string;
  lastUserMessageAt: number | null;
  sourceRef: string;
}): Promise<AutonomyPlannedWorkflow[]> {
  if (args.reply.workflowCandidates.length === 0) return [];
  const validated = validateAutonomyWorkflowProposals(args.reply.workflowCandidates, {
    nowMs: args.nowMs,
    source: 'autonomy_round',
    sourceRef: args.sourceRef,
    tzId: args.tzId,
  });
  const accepted: AutonomyPlannedWorkflow[] = [];
  for (const proposal of validated.accepted) {
    const scheduledAt = computeScheduledAt(proposal, {
      nowMs: args.nowMs,
      tzId: args.tzId,
      lastUserMessageAt: args.lastUserMessageAt,
    });
    const plan: AutonomyPlanRecord = {
      id: crypto.randomUUID(),
      charId: args.charId,
      kind: proposal.kind,
      status: 'proposed',
      purpose: proposal.purpose,
      title: proposal.action.title,
      ...(proposal.action.noteHint ? { noteHint: proposal.action.noteHint } : {}),
      maxChars: proposal.action.maxChars,
      trigger: proposal.trigger,
      scheduledAt,
      expiresAt: proposal.expiresAt,
      createdAt: args.nowMs,
      updatedAt: args.nowMs,
      source: 'autonomy_round',
      sourceRef: args.sourceRef,
      basis: proposal.basis,
      evidence: proposal.evidence,
      ...(proposal.predecessorId ? { predecessorId: proposal.predecessorId } : {}),
      dedupeKey: proposal.dedupeKey,
      attempts: 0,
      leaseUntil: 0,
    };
    try {
      const inserted = await insertAutonomyPlan(args.db, plan);
      if (!inserted) {
        // 同一天同类同目的已经提过：不重复建，也不报错。
        continue;
      }
      accepted.push({
        id: plan.id,
        kind: plan.kind,
        title: plan.title,
        purpose: plan.purpose,
        scheduledAt: plan.scheduledAt,
        expiresAt: plan.expiresAt,
        basis: plan.basis,
      });
    } catch (error) {
      console.warn('[amsg:autonomy] 生活工作流提议没落库（丢了这条，不影响本轮）', args.charId, error);
    }
  }
  return accepted;
}

// ─── 推送判定（纯） ──────────────────────────────────────────────────────

const parseHHMM = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** 静默段判定（含跨夜，start === end 视为没有静默段）。 */
export function isWithinQuietHours(
  quiet: { start: string; end: string } | undefined,
  minutes: number,
): boolean {
  if (!quiet) return false;
  const start = parseHHMM(quiet.start);
  const end = parseHHMM(quiet.end);
  if (start === null || end === null || start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

export interface AutonomyPushGateInput {
  /**
   * 推送参数原样透传：缺省、不是对象、字段不合形状（旧包 / 坏包）都可能出现在这里。
   * parseFirePack 不校验 autonomy，所以 handler 侧不能假设它一定合法。
   */
  push: unknown;
  /** 角色时区下的当日已推条数。 */
  pushedToday: number;
  lastPushAt: number;
  nowMs: number;
  quietHours?: { start: string; end: string };
  /** 角色当地时间的当日分钟数（0..1439）。 */
  minutesOfDay: number;
}

/**
 * 推送参数归一：push 缺失或不是对象、mode 不认识、配额/冷却不是有限数字，一律回 null
 * （= 不推）。坏包只该让这一轮不推，不该把整轮掀翻——调度器读 push 也是同一姿势
 * （`autonomy.push?.cooldownMinutes ?? 0`）。
 */
const readPushConfig = (raw: unknown): { maxPerDay: number; cooldownMinutes: number } | null => {
  if (!isRecord(raw)) return null;
  if (raw.mode !== 'big') return null;
  const { maxPerDay, cooldownMinutes } = raw;
  if (typeof maxPerDay !== 'number' || !Number.isFinite(maxPerDay)) return null;
  if (typeof cooldownMinutes !== 'number' || !Number.isFinite(cooldownMinutes)) return null;
  return { maxPerDay, cooldownMinutes };
};

/** big 才推；当日配额、冷却、静默段全过才推。 */
export function shouldPushAutonomy(input: AutonomyPushGateInput): boolean {
  const push = readPushConfig(input.push);
  if (!push) return false;
  if (input.pushedToday >= push.maxPerDay) return false;
  if (input.lastPushAt > 0 && push.cooldownMinutes > 0
    && input.nowMs - input.lastPushAt <= push.cooldownMinutes * 60_000) return false;
  return !isWithinQuietHours(input.quietHours, input.minutesOfDay);
}

// ─── 结果信封（锁定的 Task 18→19 契约） ──────────────────────────────────

export interface AutonomyResultExperience {
  /** D1 行的 id：客户端按它把 outbox 对账回这条经历。 */
  id: string;
  q: string;
  note: string;
  kind: string;
  /** 信封边界只分 big/small 两档；D1 行的 importance 仍是 0..3 数字（两种口径就此分开）。 */
  importance: 'big' | 'small';
  pushed: boolean;
}

export interface AutonomyUsage {
  prompt: number;
  completion: number;
  total: number;
}

/** P5：这一轮提出来、已经落库的计划（给客户端看「角色想做什么」，不是任务完成报告）。 */
export interface AutonomyPlannedWorkflow {
  id: string;
  kind: AutonomyWorkflowKind;
  title: string;
  purpose: string;
  scheduledAt: number;
  expiresAt: number;
  basis: 'inference' | 'virtual';
}

/** P5：一次已经完成/失败的工作流执行结果（默认不推送，只进角色账本与收件箱）。 */
export interface AutonomyWorkflowResult {
  planId: string;
  kind: AutonomyWorkflowKind;
  title: string;
  text: string;
  plans: string[];
  /** 虚拟经历：这是角色自己的私事，不是现实观测。 */
  basis: 'virtual';
}

export interface AutonomyResultPayload {
  resultKind: typeof AUTONOMY_RESULT_KIND;
  charId: string;
  experiences: AutonomyResultExperience[];
  proposedEvents: AutonomyProposedEvent[];
  usage: AutonomyUsage;
  /** 这一轮没有工具面，永远是空数组（字段留给接上工具的那一期）。 */
  toolsUsed: string[];
  did: string;
  rested: boolean;
  /** P5：这一轮顺带提的低风险生活工作流（已校验、已落库）。 */
  workflows?: AutonomyPlannedWorkflow[];
  /** P5：这一轮是「做完一件小事」的执行结果（与回合产物互斥）。 */
  workflow?: AutonomyWorkflowResult;
  /** P4/P5：产物认知档。回合产物 = virtual；workflow 同样是 virtual。 */
  basis?: 'virtual';
}

/** 信封只带 big/small：D1 保留 0..3 数字，跨边界的档位在这里收窄（>=2 视为 big）。 */
const toEmittedImportance = (value: number): 'big' | 'small' => (value >= 2 ? 'big' : 'small');

export function buildAutonomyResultPayload(args: {
  charId: string;
  experiences: AutonomyResultExperience[];
  proposedEvents: AutonomyProposedEvent[];
  usage: AutonomyUsage;
  did: string;
  rested: boolean;
  workflows?: AutonomyPlannedWorkflow[];
  workflow?: AutonomyWorkflowResult;
}): AutonomyResultPayload {
  return {
    resultKind: AUTONOMY_RESULT_KIND,
    charId: args.charId,
    experiences: args.experiences,
    proposedEvents: args.proposedEvents,
    usage: args.usage,
    toolsUsed: [],
    did: args.did,
    rested: args.rested,
    basis: 'virtual',
    ...(args.workflows && args.workflows.length > 0 ? { workflows: args.workflows } : {}),
    ...(args.workflow ? { workflow: args.workflow } : {}),
  };
}

/** 占主导的「做了什么」；多于一种就是 mixed；一条都没有就是 rest。 */
export function dominantAutonomyKind(experiences: readonly { kind: string }[]): string {
  if (experiences.length === 0) return 'rest';
  const kinds = new Set(experiences.map((item) => item.kind));
  if (kinds.size !== 1) return 'mixed';
  const only = [...kinds][0];
  return DID_KIND_SET.has(only) ? only : 'mixed';
}

// ─── llmOutput 的随身状态（beforeFire → llmOutput） ──────────────────────

interface AutonomyFireState {
  mode: 'round' | 'workflow';
  charId: string;
  autonomy: ResolvedAirpAutonomy;
  pages: RuminationPage[];
  tzId: string;
  dateKey: string;
  lastPushAt: number;
  nowMs: number;
  /** 回合的稳定引用：提议的 sourceRef 用它，便于回溯是哪一轮提的。 */
  roundRef: string;
  /** 打包那一刻用户最后一条消息的时间（idle 触发排期用）。 */
  lastUserMessageAt: number | null;
  /** workflow 模式专属。 */
  planId?: string;
  planTitle?: string;
  workflowKind?: AutonomyWorkflowKind;
  planMaxChars?: number;
  idempotencyKey?: string;
}

const readCarriedState = (state: unknown): AutonomyFireState | null => {
  if (!isRecord(state)) return null;
  const { charId, tzId, dateKey, nowMs } = state;
  if (typeof charId !== 'string' || !charId) return null;
  if (typeof tzId !== 'string' || !tzId) return null;
  if (typeof dateKey !== 'string' || !dateKey) return null;
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return null;
  if (!isRecord(state.autonomy)) return null;
  return {
    mode: state.mode === 'workflow' ? 'workflow' : 'round',
    charId,
    tzId,
    dateKey,
    nowMs,
    autonomy: state.autonomy as unknown as ResolvedAirpAutonomy,
    pages: Array.isArray(state.pages) ? (state.pages as RuminationPage[]) : [],
    lastPushAt: typeof state.lastPushAt === 'number' && Number.isFinite(state.lastPushAt) ? state.lastPushAt : 0,
    roundRef: typeof state.roundRef === 'string' ? state.roundRef : '',
    lastUserMessageAt: typeof state.lastUserMessageAt === 'number' && Number.isFinite(state.lastUserMessageAt)
      ? state.lastUserMessageAt : null,
    ...(typeof state.planId === 'string' ? { planId: state.planId } : {}),
    ...(typeof state.planTitle === 'string' ? { planTitle: state.planTitle } : {}),
    ...(state.workflowKind === 'diary' || state.workflowKind === 'plan' || state.workflowKind === 'interest_note'
      ? { workflowKind: state.workflowKind as AutonomyWorkflowKind } : {}),
    ...(typeof state.planMaxChars === 'number' ? { planMaxChars: state.planMaxChars } : {}),
    ...(typeof state.idempotencyKey === 'string' ? { idempotencyKey: state.idempotencyKey } : {}),
  };
};

const readUsage = (ctx: KindSessionCtx): AutonomyUsage => {
  const raw = (ctx as { usage?: Record<string, unknown> | null }).usage;
  const pick = (key: string): number => {
    const value = raw?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  };
  const prompt = pick('prompt_tokens');
  const completion = pick('completion_tokens');
  const total = pick('total_tokens') || prompt + completion;
  return { prompt, completion, total };
};

// ─── D1 读写（只经 holder） ──────────────────────────────────────────────

const readRecentExperiencePages = async (
  db: AutonomyDb,
  charId: string,
  sinceMs: number,
): Promise<RuminationPage[]> => {
  const rows = await db
    .prepare('SELECT q, created_at FROM autonomy_experiences WHERE char_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?')
    .bind(charId, sinceMs, RUMIN_PAGES)
    .all();
  return (rows.results ?? [])
    .filter(isRecord)
    .map((row) => ({
      q: typeof row.q === 'string' ? row.q : null,
      createdAt: typeof row.created_at === 'number' ? row.created_at : Number.NaN,
    }));
};

/** 角色时区下的当日推送条数。没有 pushes_today 列，就从经历行的 pushed 标记数。 */
const countPushedOnDate = async (
  db: AutonomyDb,
  charId: string,
  tzId: string,
  dateKey: string,
  nowMs: number,
): Promise<number> => {
  const rows = await db
    .prepare('SELECT created_at FROM autonomy_experiences WHERE char_id = ? AND pushed = 1 AND created_at >= ?')
    .bind(charId, nowMs - PUSH_COUNT_LOOKBACK_MS)
    .all();
  let count = 0;
  for (const row of rows.results ?? []) {
    if (!isRecord(row) || typeof row.created_at !== 'number') continue;
    try {
      if (autonomyDateKey(row.created_at, tzId) === dateKey) count += 1;
    } catch {
      /* 时区刚在 beforeFire 校验过；这里只是数数，读不出来就不算 */
    }
  }
  return count;
};

// ─── handler ─────────────────────────────────────────────────────────────

const findFirePackRow = (
  rows: Array<{ key: string; value: string }>,
): { key: string; value: string } | undefined => rows.find((row) => row.key === AMSG_FIRE_PACK_KEY);

/**
 * 这个角色属于哪个用户（共享护栏按 user_id 存，计划行里只有 char_id）。
 * 从 client_state 的角色命名空间反查：**这是 owner 的唯一可信来源**（服务端 D1 的行，
 * 不读 task metadata / 请求体里的任何 userId）。
 *
 * 查不到 / user_id 不是非空字符串 / 查询出错，一律回空串 = 「owner 未解析」。
 * 调用方必须据此 fail-closed：空串不是「新用户」，读不到 userId 就不可能证明用户没按暂停。
 */
const readAutonomyOwnerUserId = async (db: AutonomyDb, charId: string): Promise<string> => {
  try {
    const row = await db
      .prepare('SELECT user_id FROM client_state WHERE namespace = ? AND key = ?')
      .bind(amsgStateNamespace(charId), AMSG_FIRE_PACK_KEY)
      .first();
    const userId = (row as { user_id?: unknown } | null)?.user_id;
    return typeof userId === 'string' ? userId.trim() : '';
  } catch {
    return '';
  }
};

/**
 * 回账只记日志、不往外抛。
 *
 * 走到回账这一步时副作用已经落地（经历写进 D1、结果送进收件箱）。抛出去的话上游会把整轮
 * 判失败重跑：同一次 LLM 的产出再落一行经历、再发一次结果——比丢一次账严重得多。
 * 熔断那侧不用担心：D1 真坏了的话调度器自己的每一道闸也会一起失败。
 */
const reportOutcome = async (
  charId: string,
  outcome: Parameters<typeof reportAutonomyOutcome>[1],
  args: Parameters<typeof reportAutonomyOutcome>[2],
): Promise<void> => {
  try {
    await reportAutonomyOutcome(charId, outcome, args);
  } catch (error) {
    console.warn('[amsg:autonomy] 结局没记进 autonomy_state（不重跑，免得重复落经历行）', charId, error);
  }
};

// ─── home events 落盘（P2：直写 sullyos-home，失败回退旧链） ────────────────

let homeEnv: { HOME_URL?: string; AMSG_CLIENT_TOKEN?: string } | null = null;

/**
 * `buildWorkerConfig` 的写入口（同本文件 configureAutonomyFireDb 的 holder 惯例）：
 * handler 的 ctx 里没有 env（fireKinds 注册表形状冻结），所以 HOME 地址走模块级 holder。
 * 传 null / undefined 收成 null：没配时用本地默认，不抛。
 */
export function configureAutonomyHomeEnv(
  env: { HOME_URL?: string; AMSG_CLIENT_TOKEN?: string } | null | undefined,
): void {
  homeEnv = env ?? null;
}

async function persistHomeEvents(env: any, charId: string, events: Array<{ kind: string; payload: unknown }>) {
  if (events.length === 0) return;
  try {
    const res = await fetch(`${env.HOME_URL ?? 'http://127.0.0.1:8837'}/home/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-client-token': env.AMSG_CLIENT_TOKEN ?? '' },
      body: JSON.stringify({ charId, events }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.warn('[amsg:autonomy] home events 落盘被拒（回退旧链）', charId, res.status);
  } catch { /* 回退旧链：只 emitResult，不阻断 */ }
}

// ─── workflow 执行结果落账（P5） ─────────────────────────────────────────

/**
 * 到点执行完这一轮之后：解析产物 → 落一条虚拟经历 → 结算计划/预留 → 回结果。
 *
 * 三个「不」：
 *   - 不推送（W5：默认不新增推送，也不生成面向用户的「任务完成报告」）；
 *   - 不把失败/未知写成完成（状态机终态语义）；
 *   - 不在解析失败后重试（LLM 已经烧过一次，重试只会重复计费）。
 */
async function handleWorkflowOutput(
  db: AutonomyDb,
  ctx: KindSessionCtx,
  carried: AutonomyFireState,
): Promise<KindDecision> {
  const usage = readUsage(ctx);
  const planId = carried.planId ?? '';
  const kind = carried.workflowKind ?? 'diary';
  const idempotencyKey = carried.idempotencyKey ?? `plan:${planId}`;
  const maxChars = carried.planMaxChars ?? 400;

  const settle = async (status: 'completed' | 'failed' | 'unknown', error?: string): Promise<void> => {
    try {
      await updateAutonomyPlanRun(db, {
        idempotencyKey,
        status: status === 'completed' ? 'settled' : status === 'unknown' ? 'unknown' : 'failed',
        actualTokens: usage.total,
        error: error ?? null,
        nowMs: carried.nowMs,
      });
    } catch (runError) {
      console.warn('[amsg:autonomy] 工作流执行预留没结算', planId, runError);
    }
    try {
      await settleAutonomyPlan(db, {
        planId, status, nowMs: carried.nowMs, error: error ?? null,
      });
    } catch (planError) {
      console.warn('[amsg:autonomy] 计划状态没写进去（不再重跑）', planId, planError);
    }
  };

  const parsed = parseWorkflowExecutionOutput(ctx.llmOutputText || '', kind, maxChars);
  if (!parsed.ok) {
    console.warn('[amsg:autonomy] 工作流产物解析不出来（按失败收，不自动重试）', {
      charId: carried.charId, planId, reason: parsed.reason,
    });
    await settle('failed', `bad-output:${parsed.reason}`);
    await reportOutcome(
      carried.charId,
      { ok: false, tokens: usage.total },
      { db, dateKey: carried.dateKey, nowMs: carried.nowMs },
    );
    return { decision: 'skip-push', reason: AUTONOMY_WORKFLOW_SKIP.badOutput };
  }

  const note = parsed.text.trim() || `计划：${parsed.plans.join('、')}`;
  let experienceId = '';
  try {
    experienceId = await addAutonomyExperience(db, {
      charId: carried.charId,
      createdAt: carried.nowMs,
      q: carried.planTitle ?? '',
      note,
      kind,
      importance: 1,
      pushed: false,
      // 这是角色自己的虚拟经历，不是现实观测；客户端/投影不得当既成事实转述。
      basis: 'virtual',
      source: 'workflow',
      planId,
    });
  } catch (error) {
    console.warn('[amsg:autonomy] 工作流产物没落进经历表（计划仍按失败收）', planId, error);
    await settle('failed', 'experience-write-failed');
    await reportOutcome(
      carried.charId,
      { ok: false, tokens: usage.total },
      { db, dateKey: carried.dateKey, nowMs: carried.nowMs },
    );
    return { decision: 'skip-push', reason: 'autonomy-workflow-write-failed' };
  }

  await settle('completed');
  await reportOutcome(
    carried.charId,
    { ok: true, tokens: usage.total },
    { db, dateKey: carried.dateKey, nowMs: carried.nowMs },
  );

  const payload = buildAutonomyResultPayload({
    charId: carried.charId,
    experiences: [{
      id: experienceId,
      q: carried.planTitle ?? '',
      note,
      kind,
      importance: 'small',
      pushed: false,
    }],
    proposedEvents: [],
    usage,
    did: kind,
    rested: false,
    workflow: {
      planId,
      kind,
      title: carried.planTitle ?? '',
      text: parsed.text,
      plans: parsed.plans,
      basis: 'virtual',
    },
  });

  if (typeof ctx.emitResult !== 'function') {
    console.warn('[amsg:autonomy] 这台 worker 不支持 emitResult，工作流结果送不回去', carried.charId);
    return { decision: 'skip-push', reason: 'autonomy-emit-result-unsupported' };
  }

  try {
    await ctx.emitResult({
      ...payload,
      // 默认不推送：结果只进收件箱与角色账本，不响铃、不弹「任务完成」。
      notification: { show: false },
    });
  } catch (error) {
    console.warn('[amsg:autonomy] 工作流结果送不进收件箱（已经落库，不再重跑）', carried.charId, error);
    return { decision: 'skip-push', reason: 'autonomy-emit-result-failed' };
  }

  console.log('[amsg:autonomy] 工作流跑完', {
    charId: carried.charId, planId, kind, tokens: usage.total,
  });
  return { decision: 'skip-push', reason: 'autonomy-workflow-completed' };
}

export const autonomyRoundHandler: FireKindHandler = {
  async beforeFire({ ctx, charId, taskMeta }): Promise<KindFirePlan> {
    const db = fireDb;
    if (!db) return { skip: true, reason: AUTONOMY_FIRE_SKIP.dbUnavailable };

    const nowMs = ctx.now.getTime();
    const rows = await ctx.readState(amsgStateNamespace(charId));
    const row = findFirePackRow(rows);
    if (!row?.value) {
      console.warn('[amsg:autonomy] 云端没有这个角色的 fire_pack，这一轮跳过', charId);
      return { skip: true, reason: AUTONOMY_FIRE_SKIP.packMissing };
    }

    let pack: AmsgFirePack | null = null;
    try {
      pack = parseFirePack(await unpackStateValue(row.value));
    } catch (error) {
      console.warn('[amsg:autonomy] fire_pack 解压失败，这一轮跳过', charId, error);
      return { skip: true, reason: AUTONOMY_FIRE_SKIP.packUnreadable };
    }
    if (!pack) {
      console.warn('[amsg:autonomy] fire_pack 形状不认识，这一轮跳过', charId);
      return { skip: true, reason: AUTONOMY_FIRE_SKIP.packUnreadable };
    }
    // 调度器建任务前也判过同一个开关；到点再判一次，防的是「建完任务用户就关了」。
    const autonomy = pack.autonomy;
    if (!autonomy || autonomy.enabled !== true) {
      return { skip: true, reason: AUTONOMY_FIRE_SKIP.disabled };
    }

    let dateKey: string;
    try {
      dateKey = autonomyDateKey(nowMs, pack.tzId);
    } catch {
      return { skip: true, reason: AUTONOMY_FIRE_SKIP.tzInvalid };
    }

    await ensureAutonomySchema(db);

    // 用户级总暂停的**到点复核**：建任务时读到的 pack / 护栏都可能是几分钟前的旧值，
    // 用户在这中间按了暂停就必须立刻生效。读不出来（缺钥/密文坏/D1 错）一律按暂停处理
    // （fail-closed），绝不用「默认不暂停」放行。普通自主回合与生活工作流都走这里。
    const ownerUserId = await readAutonomyOwnerUserId(db, charId);
    // 空 = owner 未解析：没有 userId 就没有「用户级总暂停」这一行可读，读不到不等于没暂停
    // （readAutonomyGuardrailsForUserDetailed 会把它当成 absent 新用户 → paused:false 放行）。
    // 信任边界只在这里：owner 来自服务端 client_state 行，绝不从任务 metadata / 请求体取。
    // 普通自主回合与计划到点执行都必须停在这里。
    if (!ownerUserId) {
      console.warn('[amsg:autonomy] 认不出这个角色的 owner，这一轮暂停（fail-closed）', charId);
      return { skip: true, reason: AUTONOMY_FIRE_SKIP.ownerUnresolved };
    }
    const guardrailRead = await readAutonomyGuardrailsForUserDetailed(db, fireMasterKey, ownerUserId);
    if (guardrailRead.status === 'unreadable') {
      console.warn('[amsg:autonomy] 到点复核护栏读不出来，这一轮暂停', charId, guardrailRead.error);
      return { skip: true, reason: AUTONOMY_FIRE_SKIP.guardrailsUnreadable };
    }
    const userPaused = guardrailRead.guardrails.paused === true;

    // P5：这一条是不是「计划到点执行」？metadata 由调度器建任务时写入。
    // 走独立的一次后台请求：没有人格之外的聊天上下文，没有工具，也不推送。
    const planMeta = readAutonomyPlanMeta(taskMeta);
    if (planMeta) {
      const plan = await getAutonomyPlan(db, planMeta.planId);
      if (!plan || plan.charId !== charId) {
        console.warn('[amsg:autonomy] 计划行不在（任务与库对不上），这一轮跳过', charId, planMeta.planId);
        return { skip: true, reason: AUTONOMY_WORKFLOW_SKIP.planMissing };
      }
      if (userPaused) {
        // 建任务之后用户按了暂停：计划收成 cancelled（不生成、不推送），不假称已执行。
        try {
          await settleAutonomyPlan(db, { planId: plan.id, status: 'cancelled', nowMs, error: 'user-paused' });
        } catch { /* 下一跳再收 */ }
        return { skip: true, reason: AUTONOMY_FIRE_SKIP.pausedByUser };
      }
      if (plan.status !== 'scheduled' && plan.status !== 'running') {
        // 已被取消 / 已完成 / unknown：绝不重跑（unknown 不自动重试）。
        return { skip: true, reason: AUTONOMY_WORKFLOW_SKIP.planNotPending };
      }
      if (plan.expiresAt <= nowMs) {
        try {
          await settleAutonomyPlan(db, { planId: plan.id, status: 'failed', nowMs, error: 'expired' });
        } catch { /* 下一跳再收 */ }
        return { skip: true, reason: AUTONOMY_WORKFLOW_SKIP.planExpired };
      }
      // 后台同样尊重用户的能力白名单/全禁与写入总闸；不允许角色改配置。
      if (!canRunPrivateLifeAction(autonomy, plan.kind)) {
        try {
          await settleAutonomyPlan(db, { planId: plan.id, status: 'failed', nowMs, error: 'capability-not-allowed' });
        } catch { /* 下一跳再收 */ }
        return { skip: true, reason: AUTONOMY_WORKFLOW_SKIP.planNotPending };
      }
      const running = await markAutonomyPlanRunning(db, {
        planId: plan.id, nowMs, leaseMs: AUTONOMY_PLAN_RUN_LEASE_MS,
      });
      if (!running) {
        // 另一台设备/另一个 tick 已经把它拉起来：这次任务不重复生成。
        return { skip: true, reason: AUTONOMY_WORKFLOW_SKIP.planLeaseLost };
      }
      const perceptionBlock = await buildAutonomyPerceptionBlock({ db, charId, pack, nowMs });
      const prompt = buildWorkflowExecutionPrompt({
        pack,
        nowMs,
        plan: {
          kind: plan.kind,
          title: plan.title,
          purpose: plan.purpose,
          maxChars: plan.maxChars,
          ...(plan.noteHint ? { noteHint: plan.noteHint } : {}),
        },
        perceptionBlock,
      });
      return {
        messages: [{ role: 'user', content: prompt }],
        state: {
          mode: 'workflow',
          charId,
          autonomy,
          pages: [],
          tzId: pack.tzId,
          dateKey,
          lastPushAt: 0,
          nowMs,
          roundRef: `plan:${plan.id}`,
          lastUserMessageAt: typeof pack.lastUserMessageAt === 'number' ? pack.lastUserMessageAt : null,
          planId: plan.id,
          planTitle: plan.title,
          workflowKind: plan.kind,
          planMaxChars: plan.maxChars,
          idempotencyKey: `plan:${plan.id}`,
        } satisfies AutonomyFireState,
      };
    }

    if (userPaused) {
      return { skip: true, reason: AUTONOMY_FIRE_SKIP.pausedByUser };
    }

    const pages = await readRecentExperiencePages(db, charId, nowMs - RUMIN_WINDOW_H * HOUR_MS);
    const state = await getAutonomyState(db, charId);
    // P4：只把本地过滤后的相关小快照放进动态尾段（没有就不占位）。
    const perceptionBlock = await buildAutonomyPerceptionBlock({ db, charId, pack, nowMs });

    return {
      messages: [{ role: 'user', content: buildAutonomyRoundPrompt({ pack, nowMs, pages, autonomy, perceptionBlock }) }],
      state: {
        mode: 'round',
        charId,
        autonomy,
        pages,
        tzId: pack.tzId,
        dateKey,
        lastPushAt: state.lastPushAt,
        nowMs,
        roundRef: `round:${crypto.randomUUID()}`,
        lastUserMessageAt: typeof pack.lastUserMessageAt === 'number' ? pack.lastUserMessageAt : null,
      } satisfies AutonomyFireState,
    };
  },

  async llmOutput({ ctx, state }): Promise<KindDecision> {
    const db = fireDb;
    if (!db) return { decision: 'skip-push', reason: AUTONOMY_FIRE_SKIP.dbUnavailable };
    const carried = readCarriedState(state);
    if (!carried) return { decision: 'skip-push', reason: AUTONOMY_FIRE_SKIP.stateMissing };

    // P5：计划到点执行走独立分支——不产出经历列表/反刍闸/推送，只落一条虚拟经历并结算计划。
    if (carried.mode === 'workflow') return handleWorkflowOutput(db, ctx, carried);

    const reply = parseAutonomyRoundReply(ctx.llmOutputText || '');
    if (!reply) {
      console.warn('[amsg:autonomy] 这一轮的输出解析不出来（形状/版本对不上），判失败', carried.charId);
      await reportOutcome(
        carried.charId,
        { ok: false },
        { db, dateKey: carried.dateKey, nowMs: carried.nowMs },
      );
      return { decision: 'skip-push', reason: AUTONOMY_BAD_OUTPUT_REASON };
    }

    const usage = readUsage(ctx);

    // B7：这一轮角色有没有顺口说「想出去」。**不额外发模型请求**（就长在上面这份 JSON 里），
    // 落库前先过授权/预算复核；任何一步失败只记日志，绝不把整轮自主回合判失败。
    const travelIntent = parseTravelIntent(reply.travelIntent);
    if (travelIntent === null) {
      console.warn('[amsg:autonomy] 出行意图形状不合法（这一轮不建愿望）', carried.charId);
    } else if (travelIntent.kind !== 'none') {
      try {
        const ownerUserId = await readAutonomyOwnerUserId(db, carried.charId);
        if (ownerUserId) {
          await ensureTravelSchema(db as never);
          const intentResult = await recordTravelIntent(db as never, {
            userId: ownerUserId,
            charId: carried.charId,
            intent: travelIntent,
            nowMs: carried.nowMs,
          });
          console.log('[amsg:autonomy] travel-intent', {
            charId: carried.charId,
            kind: travelIntent.kind,
            written: intentResult.written,
            reason: intentResult.reason,
          });
        }
      } catch (error) {
        console.warn('[amsg:autonomy] 出行意愿没落进愿望表（这一轮其余照常）', error);
      }
    }

    // 反刍闸：模型报上来的选题逐条比近 96h / 12 页。全撞 = 这一轮收成 rest；
    // 只撞一部分就只丢撞的那些（模型可以在同一份输出里换个题）。
    let experiences = reply.experiences;
    let rested = reply.rested;
    if (experiences.length > 0) {
      const verdicts = experiences.map((item) =>
        ruminationVerdict(item.q, carried.pages, carried.nowMs));
      if (resolveRumination(verdicts) === 'rest') {
        console.warn('[amsg:autonomy] 选题全是最近写过的冷饭，这一轮收成 rest', carried.charId);
        experiences = [];
        rested = true;
      } else {
        experiences = experiences.filter((_, index) => !verdicts[index].blocked);
      }
    }

    const processed = experiences
      .map((item) => ({ ...item, note: postProcessNote(item.note) }))
      .filter((item) => item.note.length > 0);

    // 推送判定在写库之前：pushed 要跟着经历行一起落（客户端按它决定要不要转述）。
    // 只有 big（importance>=2）配推送；整轮全是 small 就一条都不推、也不响铃。
    const hasBig = processed.some((item) => item.importance >= 2);
    const pushedIndex = hasBig ? processed.findIndex((item) => item.importance >= 2) : -1;
    const parts = wallClockPartsInZone(carried.nowMs, { tzId: carried.tzId });
    const pushedToday = await countPushedOnDate(db, carried.charId, carried.tzId, carried.dateKey, carried.nowMs);
    const push = shouldPushAutonomy({
      push: carried.autonomy.push,
      pushedToday,
      lastPushAt: carried.lastPushAt,
      nowMs: carried.nowMs,
      ...(carried.autonomy.quietHours ? { quietHours: carried.autonomy.quietHours } : {}),
      minutesOfDay: parts.hour * 60 + parts.minute,
    }) && pushedIndex >= 0;

    const written: AutonomyResultExperience[] = [];
    for (const [index, item] of processed.entries()) {
      const isPushed = push && index === pushedIndex;
      const id = crypto.randomUUID();
      await addAutonomyExperience(db, {
        id,
        charId: carried.charId,
        createdAt: carried.nowMs,
        q: item.q,
        note: item.note,
        kind: item.kind,
        // D1 行的 importance 保持 0..3 数字（没有任何读侧按它分档）。
        importance: item.importance,
        pushed: isPushed,
        // P4：自主回合产物是角色的虚拟经历，不是现实观测。
        basis: 'virtual',
        source: 'autonomy_round',
      });
      written.push({
        id,
        q: item.q,
        note: item.note,
        kind: item.kind,
        // 信封边界：只送 big/small 两档给客户端。
        importance: toEmittedImportance(item.importance),
        pushed: isPushed,
      });
    }

    // 这一轮没产出任何可用经历（含被后处理削空）= 事实上的 rest。
    const finalRested = rested || written.length === 0;
    const did = dominantAutonomyKind(written);

    // P5 W1/W2：模型顺带提的生活工作流先过白名单校验再落计划；坏的逐条丢掉，不影响本轮。
    let plannedWorkflows: AutonomyPlannedWorkflow[] = [];
    if (reply.workflowCandidates.length > 0) {
      try {
        plannedWorkflows = await persistWorkflowProposals({
          db,
          charId: carried.charId,
          reply,
          nowMs: carried.nowMs,
          tzId: carried.tzId,
          lastUserMessageAt: carried.lastUserMessageAt,
          sourceRef: carried.roundRef || `round:${carried.nowMs}`,
        });
      } catch (error) {
        console.warn('[amsg:autonomy] 工作流提议处理失败（这一轮其余产物照发）', carried.charId, error);
      }
    }

    const payload = buildAutonomyResultPayload({
      charId: carried.charId,
      experiences: written,
      proposedEvents: reply.proposedEvents,
      usage,
      did,
      rested: finalRested,
      workflows: plannedWorkflows,
    });
    // P4 接线：wantToShare 命中走 instant-chat 信封的通知策略（一定弹/按角色折叠/
    // 前台静音），下发仍走现有 ctx.emitResult 出口，不新开通道。
    const notification = push
      ? (buildWantToSharePush({
          charId: carried.charId,
          title: written[pushedIndex].note,
          body: written[pushedIndex].note,
        }).notification as Record<string, unknown>)
      : { show: false as const };

    const outcome = async (): Promise<void> => {
      await reportOutcome(
        carried.charId,
        { ok: true, tokens: usage.total, ...(push ? { pushed: true } : {}) },
        { db, dateKey: carried.dateKey, nowMs: carried.nowMs },
      );
    };

    // P2：先把 proposedEvents 落一份到 sullyos-home；失败只回退旧链，不阻断 emitResult。
    await persistHomeEvents(
      homeEnv ?? {},
      carried.charId,
      reply.proposedEvents.map((e) => ({ kind: e.type, payload: e })),
    );

    if (typeof ctx.emitResult !== 'function') {
      // 老部署没有这个能力：经历已经落 D1（角色自己的账没白记），只是送不回客户端。
      console.warn('[amsg:autonomy] 这台 worker 不支持 emitResult，这一轮结果送不回去', carried.charId);
      await outcome();
      return { decision: 'skip-push', reason: 'autonomy-emit-result-unsupported' };
    }

    try {
      await ctx.emitResult({ ...payload, notification });
    } catch (error) {
      // 收件箱表缺列这类失败重试也送不回去（LLM 已经烧过一次），就地收成跳过。
      console.warn('[amsg:autonomy] 结果送不进收件箱（多半是收件箱表没建全）', carried.charId, error);
      await outcome();
      return { decision: 'skip-push', reason: 'autonomy-emit-result-failed' };
    }

    await outcome();
    console.log('[amsg:autonomy] 这一轮跑完', {
      charId: carried.charId,
      did,
      rested: finalRested,
      experiences: written.length,
      pushed: push,
      tokens: usage.total,
    });
    return { decision: 'skip-push', reason: finalRested ? 'autonomy-rested' : 'autonomy-result-emitted' };
  },
};
