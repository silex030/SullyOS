/**
 * 自主背景生活结果在客户端的落点（C1）。
 *
 * worker 跑完一轮 `autonomous_round` 后把结果信封（resultKind='autonomy_result'）送回
 * 收件箱；这里把它折成客户端的三份账：
 *   - 转述账本 `autonomous_outbox`：每条经历一行（id = D1 行 id，重投 put 覆盖去重），
 *     外加被降级改道的大事件行（`【待定】` + summary）；
 *   - 日记 `diaries`：每条经历在当天写一页，角色侧 charPage 落 note；
 *   - 世界事件 `airp_events` + 物化 `airp_world`：proposedEvents 里未被降级的事件。
 * 另写一条 `autonomous_heartbeats` 心跳（面板只读）。
 *
 * 幂等：outbox / 事件 / 日记 / 心跳全部按确定性 id put 覆盖，同一份 payload 重投不翻倍。
 *
 * 返回契约同 dispatchAmsgResult：`true` = 销账（含「形状坏了，留着也没用」的坏载荷），
 * `false` = 这次没落地（存储抛错），账留着下次上线重试。
 *
 * 降级改道（deviation 2）：`impact==='major' && autonomyLevel < 3` 的事件不物化世界
 * 事实，改落一条 importance=big、told=0 的 outbox 待定行（等用户 engage 再交代），
 * 事件行仍按历史落库但 disclosedToUser=false；其余事件仅在本轮有经历行（即确有 outbox
 * 转述账同期落库）时 disclosed=true，零经历的孤儿轮记 false，由 outbox 的 told 标记
 * 单独追踪是否被转述（refined disclosed-rule）。
 */

import { DB } from './db';
import { mergeAutonomySettings } from './airp/autonomySettings';
import { saveAirpEvents } from './airp/eventStore';
import { materializeCommittedEvents } from './airp/worldStore';
import type { AirpCommittedEvent } from './airp/commit';
import type { AutonomousOutboxEntry, AutonomyHeartbeat, AutonomyWorkflowPlanRecord } from '../types';

const HEADER = '[airp:autonomy]';

const AUTONOMY_DID_KINDS = ['surf', 'game', 'forum', 'rest', 'mixed'] as const;
type AutonomyDid = (typeof AUTONOMY_DID_KINDS)[number];

const OUTBOX_KINDS = ['surf', 'game', 'forum', 'rest'] as const;
type OutboxKind = 'surf' | 'game' | 'forum' | 'rest' | 'mixed';

const EVENT_TYPES: ReadonlySet<string> = new Set([
  'conversation', 'activity', 'movement', 'schedule', 'relationship', 'discovery', 'social_trace',
]);

const EVENT_IMPACTS = ['trace', 'minor', 'major'] as const;
type EventImpact = (typeof EVENT_IMPACTS)[number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

/** 信封已把档位收成 'big'|'small' 字符串；不认识 / 缺失一律 fail-safe 收成 small（兜住版本错位）。 */
const toOutboxImportance = (value: unknown): 'big' | 'small' =>
  value === 'big' ? 'big' : 'small';

const toOutboxKind = (value: unknown): OutboxKind =>
  typeof value === 'string' && (OUTBOX_KINDS as readonly string[]).includes(value)
    ? (value as OutboxKind)
    : 'mixed';

const toEventImpact = (value: unknown): EventImpact =>
  typeof value === 'string' && (EVENT_IMPACTS as readonly string[]).includes(value)
    ? (value as EventImpact)
    : 'trace';

const toDid = (value: unknown): AutonomyDid =>
  typeof value === 'string' && (AUTONOMY_DID_KINDS as readonly string[]).includes(value)
    ? (value as AutonomyDid)
    : 'mixed';

/** 日记日用 UTC YYYY-MM-DD（确定性选择：payload 不带角色时区日期）。 */
const utcDateKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const readUsage = (raw: unknown): AutonomyHeartbeat['usage'] => {
  const rec = isRecord(raw) ? raw : {};
  const pick = (key: string): number | undefined => {
    const value = rec[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  };
  const prompt = pick('prompt');
  const completion = pick('completion');
  const total = pick('total') ?? (prompt ?? 0) + (completion ?? 0);
  // P1/C2：缓存的读/写计数原样带过去；供应商没报就**不写这个字段**（缺失 ≠ 0）。
  const cachedTokens = pick('cachedTokens');
  const cacheReadTokens = pick('cacheReadTokens');
  const cacheWriteTokens = pick('cacheWriteTokens');
  return {
    ...(prompt !== undefined ? { prompt } : {}),
    ...(completion !== undefined ? { completion } : {}),
    total,
    ...(cachedTokens !== undefined ? { cachedTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
  };
};

const WORKFLOW_KINDS = ['diary', 'plan', 'interest_note'] as const;
type WorkflowKind = (typeof WORKFLOW_KINDS)[number];

const TERMINAL_PLAN_STATUSES: ReadonlySet<string> = new Set([
  'completed', 'cancelled', 'failed', 'unknown',
]);

const toWorkflowKind = (value: unknown): WorkflowKind =>
  typeof value === 'string' && (WORKFLOW_KINDS as readonly string[]).includes(value)
    ? (value as WorkflowKind)
    : 'diary';

const toBasis = (value: unknown): 'inference' | 'virtual' =>
  value === 'inference' ? 'inference' : 'virtual';

const finite = (value: unknown, fallback: number): number =>
  (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/** 结果正文与「后续打算」都只是角色自己的话：限长入库，别让一条结果撑爆一条记录。 */
const RESULT_TEXT_MAX_CHARS = 2000;
const RESULT_PLANS_MAX = 8;
const RESULT_PLAN_MAX_CHARS = 200;

interface NormalizedWorkflowProposal {
  id: string;
  kind: WorkflowKind;
  title: string;
  purpose: string;
  scheduledAt: number;
  expiresAt: number;
  basis: 'inference' | 'virtual';
}

interface NormalizedWorkflowResult {
  planId: string;
  kind: WorkflowKind;
  title: string;
  text: string;
  plans: string[];
  basis: 'inference' | 'virtual';
}

/** 这一轮提出来、已落库的计划（给「角色想做什么」用）；坏条目只丢自己。 */
const normalizeWorkflowProposal = (raw: unknown, atMs: number): NormalizedWorkflowProposal | null => {
  if (!isRecord(raw) || !isNonEmptyString(raw.id)) return null;
  const scheduledAt = finite(raw.scheduledAt, atMs);
  return {
    id: raw.id,
    kind: toWorkflowKind(raw.kind),
    title: typeof raw.title === 'string' ? raw.title.slice(0, 120) : '',
    purpose: typeof raw.purpose === 'string' ? raw.purpose.slice(0, 240) : '',
    scheduledAt,
    expiresAt: finite(raw.expiresAt, scheduledAt),
    basis: toBasis(raw.basis),
  };
};

/** 一次已经跑完的工作流结果；没有 planId 就没法对上计划，丢掉。 */
const normalizeWorkflowResult = (raw: unknown): NormalizedWorkflowResult | null => {
  if (!isRecord(raw) || !isNonEmptyString(raw.planId)) return null;
  const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, RESULT_TEXT_MAX_CHARS) : '';
  const plans = Array.isArray(raw.plans)
    ? raw.plans
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim().slice(0, RESULT_PLAN_MAX_CHARS))
      .filter(Boolean)
      .slice(0, RESULT_PLANS_MAX)
    : [];
  if (!text && plans.length === 0) return null;
  return {
    planId: raw.planId,
    kind: toWorkflowKind(raw.kind),
    title: typeof raw.title === 'string' ? raw.title.slice(0, 120) : '',
    text,
    plans,
    basis: toBasis(raw.basis),
  };
};

interface NormalizedExperience {
  id: string;
  q: string;
  note: string;
  kind: OutboxKind;
  importance: 'big' | 'small';
  pushed: 0 | 1;
}

const normalizeExperience = (raw: unknown): NormalizedExperience | null => {
  if (!isRecord(raw)) return null;
  if (!isNonEmptyString(raw.id)) return null;
  return {
    id: raw.id,
    q: typeof raw.q === 'string' ? raw.q : '',
    note: typeof raw.note === 'string' ? raw.note : '',
    kind: toOutboxKind(raw.kind),
    importance: toOutboxImportance(raw.importance),
    pushed: raw.pushed === true ? 1 : 0,
  };
};

interface NormalizedProposedEvent {
  type: AirpCommittedEvent['type'];
  summary: string;
  participants: string[];
  locationLabel?: string;
  impact: EventImpact;
}

const normalizeProposedEvent = (raw: unknown): NormalizedProposedEvent | null => {
  if (!isRecord(raw)) return null;
  const type = raw.type;
  const summary = raw.summary;
  if (typeof type !== 'string' || !EVENT_TYPES.has(type)) return null;
  if (typeof summary !== 'string' || summary.length === 0) return null;
  const participants = Array.isArray(raw.participants)
    ? raw.participants.filter((item): item is string => typeof item === 'string')
    : [];
  const event: NormalizedProposedEvent = {
    type: type as AirpCommittedEvent['type'],
    summary,
    participants,
    impact: toEventImpact(raw.impact),
  };
  if (typeof raw.locationLabel === 'string' && raw.locationLabel.length > 0) {
    event.locationLabel = raw.locationLabel;
  }
  return event;
};

/**
 * 自主生活结果落点。坏载荷（非对象 / 缺 charId / experiences、proposedEvents 不是数组）
 * 打 warn 后销账（true），不写任何东西；存储抛错回 false 留账重试。
 */
export async function applyAutonomyResult(payload: unknown): Promise<boolean> {
  if (!isRecord(payload)) {
    console.warn(`${HEADER} 载荷不是对象，丢弃`, payload);
    return true;
  }
  const charId = payload.charId;
  if (!isNonEmptyString(charId)) {
    console.warn(`${HEADER} 载荷缺 charId，丢弃`, payload);
    return true;
  }
  const experiencesRaw = payload.experiences;
  const proposedRaw = payload.proposedEvents;
  if (!Array.isArray(experiencesRaw) || !Array.isArray(proposedRaw)) {
    console.warn(`${HEADER} experiences/proposedEvents 不是数组，丢弃`, charId);
    return true;
  }

  const workflowsRaw = payload.workflows;
  if (workflowsRaw !== undefined && !Array.isArray(workflowsRaw)) {
    // 形状坏了只丢这一段，不影响经历/事件的落点（与 worker 侧「坏条目只丢自己」一致）。
    console.warn(`${HEADER} workflows 不是数组，这一段丢掉`, charId);
  }

  try {
    await landAutonomyResult({
      charId,
      experiences: experiencesRaw.map(normalizeExperience).filter((item): item is NormalizedExperience => item !== null),
      proposedEvents: proposedRaw.map(normalizeProposedEvent).filter((item): item is NormalizedProposedEvent => item !== null),
      workflows: Array.isArray(workflowsRaw)
        ? workflowsRaw.map((item) => normalizeWorkflowProposal(item, Date.now()))
          .filter((item): item is NormalizedWorkflowProposal => item !== null)
        : [],
      workflow: normalizeWorkflowResult(payload.workflow),
      usage: readUsage(payload.usage),
      toolsUsed: Array.isArray(payload.toolsUsed)
        ? payload.toolsUsed.filter((item): item is string => typeof item === 'string')
        : [],
      did: toDid(payload.did),
      anchorFromFirstExperience: isRecord(experiencesRaw[0]) && isNonEmptyString(experiencesRaw[0].id)
        ? experiencesRaw[0].id
        : undefined,
    });
    return true;
  } catch (error) {
    console.warn(`${HEADER} 落库失败，账没销，下次上线重试`, charId, error);
    return false;
  }
}

interface LandInput {
  charId: string;
  experiences: NormalizedExperience[];
  proposedEvents: NormalizedProposedEvent[];
  /** P5：这一轮顺带提的计划（可查看记录）。 */
  workflows: NormalizedWorkflowProposal[];
  /** P5：一次跑完的工作流结果（虚拟经历）。 */
  workflow: NormalizedWorkflowResult | null;
  usage: AutonomyHeartbeat['usage'];
  toolsUsed: string[];
  did: AutonomyDid;
  anchorFromFirstExperience?: string;
}

async function landAutonomyResult(input: LandInput): Promise<void> {
  const { charId } = input;
  const atMs = Date.now();
  // rest 轮（无经历）没有 D1 行 id 可锚，退化成处理时刻；重投会换锚（崩溃窗口内的
  // 残留重复，记录在案）。有经历时锚定首条 D1 id，重投稳定。
  const roundAnchor = input.anchorFromFirstExperience ?? `ts${atMs}`;

  const level = await readAutonomyLevel(charId);

  const outboxEntries: AutonomousOutboxEntry[] = input.experiences.map((exp) => ({
    id: exp.id,
    charId,
    ts: atMs,
    q: exp.q,
    note: exp.note,
    kind: exp.kind,
    importance: exp.importance,
    told: 0,
    pushed: exp.pushed,
    // 经历行与 proposedEvents 之间没有 per-proposal 关联（信封里就没有），
    // 不做粗粒度的整轮关联——只有改道行带精确的 1:1 eventIds。
    eventIds: [],
  }));

  const events: AirpCommittedEvent[] = [];
  const materializeQueue: AirpCommittedEvent[] = [];

  for (const [index, proposal] of input.proposedEvents.entries()) {
    const eventId = `airp-${charId}-${roundAnchor}-${index}`;
    const rerouted = proposal.impact === 'major' && level < 3;
    const event: AirpCommittedEvent = {
      id: eventId,
      charId,
      type: proposal.type,
      summary: proposal.summary,
      participants: [...proposal.participants],
      ...(proposal.locationLabel !== undefined ? { locationLabel: proposal.locationLabel } : {}),
      impact: proposal.impact,
      at: atMs,
      // 自主事件没人目击：按 deviation-3 记 runtime_state（authority 已放宽为 AirpFactAuthority）。
      authority: 'runtime_state',
      // 落地即有经历 outbox 行（同轮同批落库）的事件视为已交代，told 标记才是真正的追踪面；
      // 改道的大事件没人知道，等 told-flip 翻；孤儿轮（零经历 → 永无 outbox 行转述）也按没人知道记，
      // 否则会谎报「已交代」。
      disclosedToUser: !rerouted && input.experiences.length > 0,
      source: { kind: 'runtime', label: 'airp-autonomy' },
    };
    events.push(event);

    if (rerouted) {
      outboxEntries.push({
        id: `airp-${charId}-${roundAnchor}-susp-${index}`,
        charId,
        ts: atMs,
        q: proposal.summary.slice(0, 80),
        note: `【待定】${proposal.summary}`,
        kind: 'mixed',
        importance: 'big',
        told: 0,
        pushed: 0,
        eventIds: [eventId],
      });
    } else {
      materializeQueue.push(event);
    }
  }

  // 1. 转述账本（经历行 + 改道行）
  await DB.saveOutboxEntries(outboxEntries);

  // 2. 日记：每条经历在当天写一页角色侧（userPage 只是占位空页）
  for (const exp of input.experiences) {
    await DB.saveDiary({
      id: `airp-diary-${exp.id}`,
      charId,
      date: utcDateKey(atMs),
      userPage: { text: '', paperStyle: 'grid', stickers: [] },
      charPage: { text: exp.note, paperStyle: 'plain', stickers: [] },
      timestamp: atMs,
      isArchived: false,
    });
  }

  // 3. 世界事件 + 物化（改道的事件不物化）
  await saveAirpEvents(events);
  // 整批一次物化：批量内 updatedAt 按输入下标单调递增（worldStore），同槽同位事件才能收敛
  // （后到的 replace 前者）；逐条调用会让每条都停在 index 0，同批同槽互相 dispute。
  if (materializeQueue.length > 0) {
    await materializeCommittedEvents(charId, materializeQueue, atMs, 'runtime_state');
  }

  // 4. 心跳（字段与面板只读行逐一对齐）
  const heartbeat: AutonomyHeartbeat = {
    id: `airp-hb-${charId}-${roundAnchor}`,
    charId,
    ts: atMs,
    wokeAt: atMs,
    did: input.did,
    toolsUsed: input.toolsUsed,
    usage: input.usage,
    pushed: input.experiences.some((exp) => exp.pushed === 1) ? 1 : 0,
    outboxed: outboxEntries.length,
  };
  await DB.saveHeartbeat(heartbeat);

  // 5. 生活工作流的可查看记录（P5）：角色「想做 / 做过什么」。
  //    只写这一份客户端投影 + 结果走上面已有的日记页；**不写 airp_events**（那是现实世界事实），
  //    也不进 outbox（inbox 是「要不要跟对方提」的账，这里不催角色报告）。
  await landWorkflowRecords({
    charId,
    atMs,
    workflows: input.workflows,
    workflow: input.workflow,
  });
}

interface LandWorkflowInput {
  charId: string;
  atMs: number;
  workflows: NormalizedWorkflowProposal[];
  workflow: NormalizedWorkflowResult | null;
}

/**
 * 把「这一轮提的计划」与「跑完的结果」折进同一个 store。
 *
 * 三条纪律：
 *   - 终态不倒退：重投同一份信封时，已经 completed/failed 的记录不会被重新写成 proposed；
 *   - 结果只落在对应计划上：找不到提议记录（别的设备提的 / 本地清过）就补一条最小记录，
 *     免得结果凭空消失，但绝不因此伪造「计划是这台设备提的」以外的字段；
 *   - 失败不写结果：failed/unknown 不带 resultText。
 */
async function landWorkflowRecords(input: LandWorkflowInput): Promise<void> {
  if (input.workflows.length === 0 && !input.workflow) return;

  let existing: AutonomyWorkflowPlanRecord[] = [];
  try {
    existing = await DB.getWorkflowPlansByChar(input.charId, 200);
  } catch (error) {
    // 读不出来不该挡住写：下面按「全新建记录」继续，put 是覆盖语义，不会写坏已有行。
    console.warn(`${HEADER} 读工作流记录失败，按新建继续`, input.charId, error);
  }
  const byId = new Map(existing.map((record) => [record.id, record]));
  const next: AutonomyWorkflowPlanRecord[] = [];

  for (const proposal of input.workflows) {
    const prev = byId.get(proposal.id);
    if (prev && TERMINAL_PLAN_STATUSES.has(prev.status)) continue; // 终态不倒退
    next.push({
      id: proposal.id,
      charId: input.charId,
      kind: proposal.kind,
      status: prev?.status ?? 'proposed',
      title: proposal.title || prev?.title || '',
      purpose: proposal.purpose || prev?.purpose || '',
      basis: proposal.basis,
      source: prev?.source ?? 'autonomy_round',
      sourceRef: prev?.sourceRef ?? '',
      scheduledAt: proposal.scheduledAt,
      expiresAt: proposal.expiresAt,
      createdAt: prev?.createdAt ?? input.atMs,
      updatedAt: input.atMs,
      ...(prev?.resultText !== undefined ? { resultText: prev.resultText } : {}),
      ...(prev?.resultPlans !== undefined ? { resultPlans: prev.resultPlans } : {}),
      ...(prev?.lastError !== undefined ? { lastError: prev.lastError } : {}),
    });
  }

  const result = input.workflow;
  if (result) {
    const prev = byId.get(result.planId);
    next.push({
      id: result.planId,
      charId: input.charId,
      kind: result.kind,
      // 结果只可能是「跑完了」：失败的轮次 worker 不会发 workflow 段。
      status: 'completed',
      title: result.title || prev?.title || '',
      purpose: prev?.purpose ?? '',
      basis: 'virtual',
      source: prev?.source ?? 'autonomy_round',
      sourceRef: prev?.sourceRef ?? '',
      scheduledAt: prev?.scheduledAt ?? input.atMs,
      expiresAt: prev?.expiresAt ?? input.atMs,
      createdAt: prev?.createdAt ?? input.atMs,
      updatedAt: input.atMs,
      ...(result.text ? { resultText: result.text } : {}),
      ...(result.plans.length > 0 ? { resultPlans: result.plans } : {}),
    });
  }

  if (next.length > 0) await DB.saveWorkflowPlans(next);
}

/** 读角色的自主档位；角色不在库里按 0（改道，不物化）。存取器缺表时 getAllCharacters 仍可用。 */
async function readAutonomyLevel(charId: string): Promise<number> {
  const characters = await DB.getAllCharacters();
  const character = characters.find((item) => item.id === charId);
  if (!character) return 0;
  return mergeAutonomySettings(character).autonomyLevel;
}
