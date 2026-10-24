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
} from '../../utils/socialContent/types';
import { buildContentId, extractShareLinks, type LinkCandidate } from '../../utils/socialContent/links';
import type { ContentAdapter, SourceTarget } from './adapter';
import { asSocialError, RevisionConflictError, SocialError } from './errors';

/** 分享卡持久化接口。实现方负责唯一约束/租约；Map 实现只用于测试，不允许上线冒充持久化。 */
export interface ShareStore {
  /** CAS 写入：仅当现有 revision 等于 expectedRevision 时成功；不存在且 expectedRevision=0 时插入。 */
  put(attachment: ShareAttachment, expectedRevision: number): Promise<boolean>;
  get(shareRef: string, scope: string): Promise<ShareAttachment | null>;
  listByMessage(scope: string, messageId: string): Promise<ShareAttachment[]>;
}

export interface ResolveDeps {
  adapters: Partial<Record<SocialPlatform, ContentAdapter>>;
  /** 平台 → 配置好的 sourceId；缺配置返回 null（契约：未配置来源不自称可用）。 */
  sourceIdFor: (platform: SocialPlatform) => string | null;
  now?: () => number;
  newShareRef?: () => string;
  store?: ShareStore | null;
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
export function stateFromRecord(record: ContentRecord): { state: ShareState; coverage: string[]; missing: string[] } {
  const coverage: string[] = [];
  const missing: string[] = [];

  if (record.title) coverage.push('title');
  if (record.body.availability === 'available' && record.body.text) coverage.push('text');
  else if (record.body.availability !== 'available') missing.push('text');
  if (record.images.length > 0) coverage.push('images');

  const transcripts = record.transcripts ?? [];
  const captionOk = transcripts.some((t) => t.kind === 'native_caption' && t.availability === 'available');
  const captionFailed = transcripts.some((t) => t.kind === 'native_caption' && t.availability === 'failed');
  if (captionOk) coverage.push('transcript');
  else if (captionFailed) missing.push('transcript');

  const commentsAvailability = record.commentsSample?.availability ?? 'not_requested';
  if (commentsAvailability === 'available') coverage.push('comments');
  else if (commentsAvailability === 'failed') missing.push('comments');

  const state: ShareState = missing.length > 0 ? 'partial' : 'ready';
  return { state, coverage, missing };
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

  const persistence: ResolveResult['persistence'] = deps.store ? 'available' : 'unavailable';
  const now = nowFn();
  const drafts: ShareAttachment[] = [];
  const parseJobs: Array<() => Promise<void>> = [];

  extracted.candidates.forEach((candidate, index) => {
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
      return;
    }
    if (candidate.linkKind === 'unsupported') {
      const code =
        candidate.rejectCode === 'SIZE_LIMIT' || candidate.rejectCode === null
          ? 'UNSUPPORTED_LINK_TYPE'
          : candidate.rejectCode;
      const att = unsupportedAttachment(candidate, common, now, new SocialError(code, candidate.rejectReason ?? code).toShareError(null));
      drafts[index] = att;
      return;
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
      return;
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
      return;
    }

    // 3) 进队列：先落一张 queued 卡，再解析
    const queued: ShareAttachment = {
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
      error: null,
      preview: null,
      contextProjection: null,
    };
    drafts[index] = queued;

    parseJobs.push(async () => {
      let revision = 2;
      let current: ShareAttachment = { ...queued, state: 'resolving', revision, updatedAt: nowFn() };
      drafts[index] = current;
      hooks.onUpdate?.(current);

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
        const { state, coverage, missing } = stateFromRecord(record);
        const contentId = buildContentId(record.platform, record.sourceId, record.externalId);

        revision += 1;
        current = {
          ...current,
          state,
          revision,
          updatedAt: nowFn(),
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
          },
        };
        drafts[index] = current;
        hooks.onUpdate?.(current);
      } catch (err) {
        const social = asSocialError(err);
        revision += 1;
        current = failedAttachment(current, social.toShareError(null), nowFn(), revision);
        drafts[index] = current;
        hooks.onUpdate?.(current);
      }

    });
  });

  await runWithConcurrency(parseJobs, concurrency);

  const attachments = drafts.filter((a): a is ShareAttachment => Boolean(a));

  // 截止后仍未进入终态的（受并发限制没轮到）统一标 TIMEOUT，杜绝永久 resolving
  for (let i = 0; i < attachments.length; i += 1) {
    const att = attachments[i];
    if (att.state === 'queued' || att.state === 'resolving') {
      attachments[i] = failedAttachment(att, new SocialError('TIMEOUT', 'resolve_deadline').toShareError(null), nowFn(), att.revision + 1);
    }
  }

  // 只落终态：插入用 expectedRevision=0（不存在才写），重复/旧持有者不覆盖新 revision
  let persistenceFinal: ResolveResult['persistence'] = persistence;
  if (deps.store) {
    try {
      for (const attachment of attachments) {
        await deps.store.put(attachment, 0);
      }
    } catch {
      persistenceFinal = 'unavailable';
    }
  }

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
