/**
 * shares/resolve 编排（t_2c2dba79，契约 3.2/3.4/4.1/4.3）。
 *
 * 负责：拆链接 → 建卡（queued）→ 并发受控解析（每 scope 2 并发）→ 状态机推进 →
 * 共享 store 的 CAS 写入。适配器只关心"怎么读一个平台"，这里只关心状态与预算。
 *
 * 硬约束：
 *  - 同一消息同链接只建一张卡，多 span 合并；
 *  - 单消息最多 5 条进入解析队列，超出逐项标 failed + SIZE_LIMIT，不静默丢；
 *  - 整体 20s 截止：到点还没跑完的卡标 TIMEOUT（failed），不留永久 resolving；
 *  - 失败不伪造内容：拿不到材料 state=failed，部分字段缺失 state=partial；
 *  - 没有持久 store 时明确返回 persistence='unavailable'，不拿进程 Map 冒充持久化。
 */

import {
  SHARE_REQUEST_LIMITS,
  SHARE_SCHEMA_VERSION,
  type ContentRecord,
  type ShareAttachment,
  type ShareError,
  type ShareState,
  type ShareUpdateEvent,
  type SocialPlatform,
  type TranscriptState,
} from '../../utils/socialContent/types';
import { buildContentId, extractShareLinks, type LinkCandidate } from '../../utils/socialContent/links';
import type { ContentAdapter, SourceTarget } from './adapter';
import { asSocialError, RevisionConflictError, SocialError } from './errors';
import { occurrenceKeyOf } from './src/store';

/**
 * 分享卡持久化接口。实现方负责唯一约束/租约；Map 实现只用于测试，不允许上线冒充持久化。
 *
 * claim/release 是可选的：只有真实 D1 store 提供租约。没有租约的实现（纯内存测试）
 * 仍然能跑，但“在途作业复用”只在有租约时生效——不假装跨进程单飞。
 */
export interface ShareStore {
  /** CAS 写入：仅当现有 revision 等于 expectedRevision 时成功；不存在且 expectedRevision=0 时插入。 */
  put(attachment: ShareAttachment, expectedRevision: number): Promise<boolean>;
  get(shareRef: string, scope: string): Promise<ShareAttachment | null>;
  listByMessage(scope: string, messageId: string): Promise<ShareAttachment[]>;
  /** 抢占租约：把 queued/resolving 且租约未占用/已过期的行推进到 resolving（revision+1）。 */
  claim?(shareRef: string, leaseUntil: number, now: number): Promise<boolean>;
  release?(shareRef: string): Promise<void>;
}

export interface ResolveDeps {
  adapters: Partial<Record<SocialPlatform, ContentAdapter>>;
  /** 平台 → 配置好的 sourceId；缺配置返回 null（契约：未配置来源不自称可用）。 */
  sourceIdFor: (platform: SocialPlatform) => string | null;
  now?: () => number;
  newShareRef?: () => string;
  store?: ShareStore | null;
  /** 同一消息已存在的卡（调用方在 resolve 前读出来）：终态复用、在途作业不重复抓。 */
  existing?: ShareAttachment[];
  /** 租约时长；默认 resolveDeadlineMs + 5s 宽限。 */
  leaseMs?: number;
  /** rednote.com 独立会话开关，默认 false。 */
  rednoteEnabled?: boolean;
  maxConcurrentPerScope?: number;
  resolveDeadlineMs?: number;
}

export interface ResolveRequest {
  messageId: string;
  conversationId: string;
  characterId: string | null;
  text: string;
  scope: string;
  idempotencyKey?: string;
}

export interface ResolveResult {
  attachments: ShareAttachment[];
  pollAfterMs: number;
  /** 本次请求的持久化能力，调用方必须如实展示，不能当持久成功。 */
  persistence: 'available' | 'unavailable';
  droppedOverLimit: number;
}

const POLL_AFTER_MS = 1000;
/** 租约宽限：解析期限之外再给 5s，避免收尾写入时被别的持有者判过期。 */
const LEASE_GRACE_MS = 5000;

function isTerminalState(state: ShareState): boolean {
  return state === 'ready' || state === 'partial' || state === 'failed' || state === 'cancelled';
}

/** 在途判定：有租约用租约，没有（老数据/无租约实现）退化为 updatedAt + leaseMs。 */
export function inFlightUntil(attachment: ShareAttachment, leaseMs: number): number {
  if (attachment.leaseUntil != null) return Number(attachment.leaseUntil);
  return (Number(attachment.updatedAt) || 0) + leaseMs;
}

function defaultShareRef(): string {
  // 随机稳定引用：不含会话/角色信息，避免从 ref 推断归属
  const bytes = new Uint8Array(16);
  const cryptoObj = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (cryptoObj?.getRandomValues) cryptoObj.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return `shr_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** 简单并发闸门：limit 个 worker 从队列里取任务；不做动态扩缩。 */
async function runWithConcurrency<T>(jobs: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, jobs.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= jobs.length) return;
      results[index] = await jobs[index]();
    }
  });
  await Promise.all(workers);
  return results;
}

/** 截止时间竞速：适配器单次 await 不能拖过整体期限（契约 4.1 的 20s 总期限）。 */
async function withDeadline<T>(promise: Promise<T>, deadline: number, now: () => number): Promise<T> {
  const remaining = Math.max(0, deadline - now());
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SocialError('TIMEOUT', 'resolve_deadline_exceeded')), remaining);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function unsupportedAttachment(
  candidate: LinkCandidate,
  base: Pick<ShareAttachment, 'messageId' | 'conversationId' | 'characterId' | 'shareRef'>,
  now: number,
  error: ShareError,
): ShareAttachment {
  return {
    schemaVersion: SHARE_SCHEMA_VERSION,
    shareRef: base.shareRef,
    messageId: base.messageId,
    conversationId: base.conversationId,
    characterId: base.characterId,
    occurrenceSpans: candidate.spans,
    originalUrl: candidate.originalUrl,
    platform: candidate.platform,
    sourceId: null,
    resolvedUrl: null,
    canonicalUrl: candidate.canonicalUrl,
    openUrl: null,
    contentId: null,
    partKey: candidate.partKey,
    state: 'failed',
    revision: 1,
    attempt: 1,
    createdAt: now,
    updatedAt: now,
    error,
    preview: null,
    contextProjection: null,
  };
}

/**
 * 由内容记录反推 ready 还是 partial（契约 3.9）。
 *
 * 只有"本来就该拿到、却失败了"的字段才降级：
 *  - 正文不可用（restricted/deleted）→ partial；
 *  - 原生字幕轨 failed → partial（明确 not_available 是合法状态，不算失败）；
 *  - 评论样本 failed → partial（not_requested 不算失败）。
 * 没有封面、没有标题、没有评论样本本身都不是失败，不能把 ready 降成 partial。
 */
export function stateFromRecord(record: ContentRecord): {
  state: ShareState;
  coverage: string[];
  missing: string[];
  transcriptState: TranscriptState;
} {
  const coverage: string[] = [];
  const missing: string[] = [];

  if (record.title) coverage.push('title');
  if (record.body.availability === 'available' && record.body.text) coverage.push('text');
  else if (record.body.availability !== 'available') missing.push('text');
  if (record.images.length > 0) coverage.push('images');

  const transcripts = record.transcripts ?? [];
  const captionOk = transcripts.some((t) => t.kind === 'native_caption' && t.availability === 'available');
  const captionFailed = transcripts.some((t) => t.kind === 'native_caption' && t.availability === 'failed');
  const captionTrack = transcripts.find((t) => t.kind === 'native_caption');
  const transcription = transcripts.find((t) => t.kind === 'speech_transcription');
  if (captionOk) coverage.push('transcript');
  else if (captionFailed) missing.push('transcript');

  /**
   * 字幕状态的唯一口径（契约 3.9）：不把“平台没给字幕”“我们没去取”“取失败”混成一个 null。
   * 只有 failed 会让整张卡降级成 partial；not_available / not_requested 是合法结论，
   * 但必须原样进投影，让模型知道自己手上只有简介，不能假装看过视频。
   */
  const transcriptState: TranscriptState = captionOk
    ? 'available'
    : captionFailed
      ? 'failed'
      : captionTrack
        ? 'not_available'
        : transcription
          ? (transcription.availability as TranscriptState)
          : 'absent';

  const commentsAvailability = record.commentsSample?.availability ?? 'not_requested';
  if (commentsAvailability === 'available') coverage.push('comments');
  else if (commentsAvailability === 'failed') missing.push('comments');

  const state: ShareState = missing.length > 0 ? 'partial' : 'ready';
  return { state, coverage, missing, transcriptState };
}

/** 预览：只放轻量字段，正文/评论正文不进卡片（契约 4.2 "仅轻量preview"）。 */
function previewOf(record: ContentRecord): ShareAttachment['preview'] {
  return {
    title: record.title,
    authorName: record.author.name,
    platformName: record.attribution.platformName,
    siteName: record.attribution.platformName,
    coverUrl: record.images.find((i) => i.type === 'image' && i.safeUrl)?.safeUrl ?? null,
    excerpt: record.body.text ? record.body.text.slice(0, 120) : null,
  };
}

function failedAttachment(
  draft: ShareAttachment,
  error: ShareError,
  now: number,
  revision: number,
): ShareAttachment {
  return {
    ...draft,
    state: 'failed',
    revision,
    updatedAt: now,
    error,
    contentId: null,
    contextProjection: null,
  };
}

export interface ResolveHooks {
  /** 每次状态变化后的回调（事件总线用）；抛错不影响主流程。 */
  onUpdate?: (attachment: ShareAttachment) => void;
}

/**
 * 解析一条消息里的全部链接。返回的 attachments 顺序与原文出现顺序一致。
 * 注意：返回时已跑完全部状态（不复用后台任务），因为 v1 的 resolve 是请求内完成；
 * 事件/轮询语义由上层按 revision 消费。
 */
export async function resolveShares(
  req: ResolveRequest,
  deps: ResolveDeps,
  hooks: ResolveHooks = {},
): Promise<ResolveResult> {
  const nowFn = deps.now ?? (() => Date.now());
  const newRef = deps.newShareRef ?? defaultShareRef;
  const startedAt = nowFn();
  const deadline = startedAt + (deps.resolveDeadlineMs ?? SHARE_REQUEST_LIMITS.resolveDeadlineMs);
  const concurrency = deps.maxConcurrentPerScope ?? SHARE_REQUEST_LIMITS.maxConcurrentPerScope;

  const extracted = extractShareLinks(req.text, { rednoteEnabled: deps.rednoteEnabled === true });
  if (!extracted.ok) {
    throw new SocialError(extracted.code, 'extract_failed');
  }

  const store = deps.store ?? null;
  const now = nowFn();
  /** 租约上限：比解析期限宽 5s，避免正常请求在收尾时被别的持有者当成“过期”抢走。 */
  const leaseMs = deps.leaseMs ?? (deps.resolveDeadlineMs ?? SHARE_REQUEST_LIMITS.resolveDeadlineMs) + LEASE_GRACE_MS;
  const existingByKey = new Map<string, ShareAttachment>();
  for (const att of deps.existing ?? []) existingByKey.set(occurrenceKeyOf(att), att);
  const drafts: ShareAttachment[] = [];
  const parseJobs: Array<() => Promise<void>> = [];
  /** 本次请求真正发起了抓取的卡：只有它们才允许被“兜底标 TIMEOUT”。 */
  const ownedJobs = new Set<number>();
  /** 已经落库或复用自库里的卡：收尾时不再重复写。 */
  const settled = new Set<number>();
  let writeFailed = false;

  /**
   * CAS 落库：成功返回传入值；被别人抢先写入（revision 已更大）时回读库里的新状态，
   * 绝不用迟到的旧结果覆盖新状态（契约 4.3/4.6 的单调性）。写库异常记 writeFailed。
   */
  const persist = async (attachment: ShareAttachment, expectedRevision: number): Promise<ShareAttachment> => {
    if (!store) return attachment;
    try {
      const ok = await store.put(attachment, expectedRevision);
      if (ok) return attachment;
      const fresh = await store.get(attachment.shareRef, req.scope);
      return fresh ?? attachment;
    } catch {
      writeFailed = true;
      return attachment;
    }
  };

  for (const [index, candidate] of extracted.candidates.entries()) {
    const shareRef = newRef();
    const common = {
      messageId: req.messageId,
      conversationId: req.conversationId,
      characterId: req.characterId,
      shareRef,
    };

    const sourceId = candidate.platform ? deps.sourceIdFor(candidate.platform) : null;

    // 1) 明确不可解析：立即终态 failed，带结构化 error
    if (candidate.overLimit) {
      const att = unsupportedAttachment(
        candidate,
        common,
        now,
        new SocialError('SIZE_LIMIT', 'over_link_limit').toShareError(null),
      );
      drafts[index] = att;
      continue;
    }
    if (candidate.linkKind === 'unsupported') {
      const code =
        candidate.rejectCode === 'SIZE_LIMIT' || candidate.rejectCode === null
          ? 'UNSUPPORTED_LINK_TYPE'
          : candidate.rejectCode;
      const att = unsupportedAttachment(candidate, common, now, new SocialError(code, candidate.rejectReason ?? code).toShareError(null));
      drafts[index] = att;
      continue;
    }
    // 2) 平台已识别但没有配置来源：失败而不是编造
    if (!sourceId || !candidate.platform) {
      const att = unsupportedAttachment(
        candidate,
        common,
        now,
        new SocialError('SOURCE_NOT_CONFIGURED', 'no_source_for_platform').toShareError(null),
      );
      drafts[index] = att;
      continue;
    }
    const adapter = deps.adapters[candidate.platform];
    if (!adapter) {
      const att = unsupportedAttachment(
        candidate,
        common,
        now,
        new SocialError('SOURCE_NOT_CONFIGURED', 'adapter_missing').toShareError(null),
      );
      drafts[index] = att;
      continue;
    }

    // 3) 幂等 + 租约（契约 4.1/4.3）：同 key 已有卡就先看能不能复用，绝不无条件重抓
    const occurrenceKey = occurrenceKeyOf({ originalUrl: candidate.originalUrl, occurrenceSpans: candidate.spans });
    const prior = existingByKey.get(occurrenceKey);
    // 3a) 终态：直接复用（重复 POST 不再打平台；要重跑只能走人工 retry）
    if (prior && isTerminalState(prior.state)) {
      drafts[index] = prior;
      settled.add(index);
      continue;
    }

    let baseRevision: number;
    let current: ShareAttachment;

    if (prior) {
      // 3b) queued/resolving：租约还活着说明别的请求正在解析 → 复用在途作业，不重复抓
      if (inFlightUntil(prior, leaseMs) > nowFn()) {
        drafts[index] = prior;
        settled.add(index);
        continue;
      }
      // 3c) 租约过期（进程崩了/请求超时）：当前持有者先抢租约，抢到才允许重跑
      let claimed = false;
      if (store?.claim) {
        try {
          claimed = await store.claim(prior.shareRef, nowFn() + leaseMs, nowFn());
        } catch {
          writeFailed = true;
          drafts[index] = prior;
          settled.add(index);
          continue;
        }
        if (!claimed) {
          // 别人刚接管：以库里的新持有者为结果，本次不抓
          const fresh = await store.get(prior.shareRef, req.scope).catch(() => null);
          drafts[index] = fresh ?? prior;
          settled.add(index);
          continue;
        }
      }
      baseRevision = prior.revision + (claimed ? 1 : 0);
      current = {
        ...prior,
        state: 'resolving',
        revision: baseRevision,
        updatedAt: nowFn(),
        leaseUntil: claimed ? nowFn() + leaseMs : (prior.leaseUntil ?? null),
      };
    } else {
      // 3d) 新卡：先落一张 queued 占位（这句话发生在任何出站请求之前，因此 >1500ms 的解析
      // 一定已经有可恢复的持久化状态），再抢租约；插入被唯一约束挡下说明别处刚建过同 key。
      current = {
        schemaVersion: SHARE_SCHEMA_VERSION,
        shareRef,
        messageId: req.messageId,
        conversationId: req.conversationId,
        characterId: req.characterId,
        occurrenceSpans: candidate.spans,
        originalUrl: candidate.originalUrl,
        platform: candidate.platform,
        sourceId,
        resolvedUrl: null,
        canonicalUrl: candidate.canonicalUrl,
        openUrl: candidate.openUrl,
        contentId: null,
        partKey: candidate.partKey,
        state: 'queued',
        revision: 1,
        attempt: 1,
        createdAt: now,
        updatedAt: now,
        leaseUntil: null,
        error: null,
        preview: null,
        contextProjection: null,
      };
      if (store) {
        let inserted = false;
        try {
          inserted = await store.put(current, 0);
        } catch {
          writeFailed = true;
        }
        if (!inserted) {
          let twin: ShareAttachment | undefined;
          try {
            twin = (await store.listByMessage(req.scope, req.messageId)).find((a) => occurrenceKeyOf(a) === occurrenceKey);
          } catch {
            twin = undefined;
          }
          if (twin) {
            // 别的进程/上一请求刚建过：复用它，绝不建第二张卡、也不重复抓
            drafts[index] = twin;
            settled.add(index);
            continue;
          }
        }
      }
      let claimed = false;
      if (store?.claim) {
        try {
          claimed = await store.claim(current.shareRef, nowFn() + leaseMs, nowFn());
        } catch {
          writeFailed = true;
        }
      }
      baseRevision = current.revision + (claimed ? 1 : 0);
      // claim 已经把行推进到 resolving；内存里的卡与之对齐（revision 必须一致，否则终态写不进）
      current = {
        ...current,
        state: 'resolving',
        revision: baseRevision,
        updatedAt: nowFn(),
        leaseUntil: claimed ? nowFn() + leaseMs : null,
      };
    }

    drafts[index] = current;
    ownedJobs.add(index);
    hooks.onUpdate?.(current);

    parseJobs.push(async () => {
      let revision = baseRevision;

      try {
        if (nowFn() >= deadline) throw new SocialError('TIMEOUT', 'deadline_before_start');
        let target: SourceTarget;
        if (candidate.linkKind === 'short') {
          // 短链必须经受控展开后才允许合并内容引用
          target = await withDeadline(
            adapter.expandShortLink(candidate.originalUrl, { scope: req.scope, deadline }),
            deadline,
            nowFn,
          );
        } else {
          target = {
            platform: candidate.platform as SocialPlatform,
            externalId: candidate.externalId as string,
            partKey: candidate.partKey,
            canonicalUrl: candidate.canonicalUrl ?? candidate.resolvedInput,
            resolvedUrl: candidate.resolvedInput,
          };
        }
        if (nowFn() >= deadline) throw new SocialError('TIMEOUT', 'deadline_before_fetch');
        const record = await withDeadline(adapter.fetchContent(target, { scope: req.scope, deadline }), deadline, nowFn);
        const { state, coverage, missing, transcriptState } = stateFromRecord(record);
        const contentId = buildContentId(record.platform, record.sourceId, record.externalId);

        revision += 1;
        const ready: ShareAttachment = {
          ...current,
          state,
          revision,
          updatedAt: nowFn(),
          leaseUntil: null,
          contentId,
          resolvedUrl: target.resolvedUrl,
          canonicalUrl: target.canonicalUrl,
          openUrl: target.canonicalUrl,
          partKey: target.partKey,
          preview: previewOf(record),
          error: null,
          contextProjection: {
            projectionVersion: 1,
            shareRef: current.shareRef,
            contentId,
            contentRevision: record.contentRevision,
            stateAtFreeze: state,
            summaryText: buildLocalSummary(record, coverage),
            evidenceCoverage: coverage,
            reason: missing.length ? `missing:${missing.join(',')}` : null,
            frozenAt: nowFn(),
            transcriptState,
          },
        };
        // 落库用 CAS：只有还持有 baseRevision 的持有者能写；被接管/被更新的主人抢先写过时
        // 回读新状态，迟到的结果不覆盖新状态。
        const stored = await persist(ready, baseRevision);
        drafts[index] = stored;
        settled.add(index);
        hooks.onUpdate?.(stored);
      } catch (err) {
        const social = asSocialError(err);
        revision += 1;
        const failed: ShareAttachment = {
          ...failedAttachment(current, social.toShareError(null), nowFn(), revision),
          leaseUntil: null,
        };
        // 迟到的失败也要能被用户看到（写回库），但同样不能盖掉别人更大的 revision。
        const stored = await persist(failed, baseRevision);
        drafts[index] = stored;
        settled.add(index);
        hooks.onUpdate?.(stored);
      }

    });
  }

  await runWithConcurrency(parseJobs, concurrency);

  const attachments = drafts.filter((a): a is ShareAttachment => Boolean(a));

  // 不进解析队列的卡（不支持的类型/超限/未配置来源）也必须落库：否则 GET /shares 看不到它们，
  // 重复 POST 每次都重建一张“新卡”。这里按唯一约束插入；冲突就复用它。
  if (store) {
    for (let i = 0; i < attachments.length; i += 1) {
      if (settled.has(i)) continue;
      const att = attachments[i];
      try {
        const ok = await store.put(att, 0);
        if (!ok) {
          const list = await store.listByMessage(req.scope, req.messageId);
          const twin = list.find((a) => occurrenceKeyOf(a) === occurrenceKeyOf(att));
          if (twin) {
            attachments[i] = twin;
            settled.add(i);
          }
        } else {
          settled.add(i);
        }
      } catch {
        writeFailed = true;
      }
    }
  }

  // 截止后仍未进入终态的（理论上每个 job 都会走完 catch，这里兜底）标 TIMEOUT 并落库，
  // 杜绝“永久 resolving”这种用户永远等不到结果的卡。
  for (let i = 0; i < attachments.length; i += 1) {
    const att = attachments[i];
    // 只兜底“本次请求自己发起、但没走到终态”的卡；复用别人的在途作业（resolving 且带租约）
    // 不是我们的，绝不能在这里替别人判死。
    if (!ownedJobs.has(i)) continue;
    if (att.state === 'queued' || att.state === 'resolving') {
      const failed: ShareAttachment = {
        ...failedAttachment(att, new SocialError('TIMEOUT', 'resolve_deadline').toShareError(null), nowFn(), att.revision + 1),
        leaseUntil: null,
      };
      attachments[i] = await persist(failed, att.revision);
    }
  }

  // 没有持久 store → 如实报 unavailable；有 store 但写过一次失败 → 也不谎称持久化成功。
  const persistenceFinal: ResolveResult['persistence'] = !deps.store ? 'unavailable' : writeFailed ? 'unavailable' : 'available';

  return {
    attachments,
    pollAfterMs: POLL_AFTER_MS,
    persistence: persistenceFinal,
    droppedOverLimit: extracted.droppedOverLimit,
  };
}

/** 本地摘录式简介，不额外调模型（契约 3.6 / 6.4）。 */
export function buildLocalSummary(record: ContentRecord, coverage: string[], maxChars = 180): string {
  const title = record.title ?? '';
  const author = record.author.name ?? '未知作者';
  const body = record.body.text.replace(/\s+/g, ' ').slice(0, maxChars);
  const bits = [`${record.attribution.platformName} · ${author}`, title, body].filter(Boolean);
  if (coverage.includes('transcript')) bits.push('（含原生字幕）');
  return bits.join('：');
}

/**
 * 唯一 UI 事件 social-share.updated（契约 4.6）。含完整 attachment，因此接收方可以
 * 只按 (attempt, revision) 单调比较后覆盖，不需要额外请求。
 */
export function buildShareUpdateEvent(attachment: ShareAttachment): ShareUpdateEvent {
  return {
    schemaVersion: SHARE_SCHEMA_VERSION,
    event: 'social-share.updated',
    shareRef: attachment.shareRef,
    messageId: attachment.messageId,
    attempt: attachment.attempt,
    revision: attachment.revision,
    state: attachment.state,
    attachment,
  };
}

/** 事件是否应被丢弃：旧 attempt 或同 attempt 下更旧 revision（契约 4.6）。 */
export function shouldIgnoreEvent(event: ShareUpdateEvent, current: Pick<ShareAttachment, 'attempt' | 'revision'> | null): boolean {
  if (!current) return false;
  if (event.attempt !== current.attempt) return event.attempt < current.attempt;
  return event.revision <= current.revision;
}

/** 人工 retry：递增 attempt、回到 queued；不绕过限速也不复用旧内容（契约 4.3）。 */
export function planRetry(existing: ShareAttachment, expectedRevision: number, now: number): ShareAttachment {
  if (existing.revision !== expectedRevision) {
    throw new RevisionConflictError('retry_revision_conflict');
  }
  return {
    ...existing,
    state: 'queued',
    attempt: existing.attempt + 1,
    revision: existing.revision + 1,
    updatedAt: now,
    error: null,
    contentId: null,
    preview: null,
    contextProjection: null,
  };
}
