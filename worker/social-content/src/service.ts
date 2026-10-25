/**
 * 链接分享服务编排（集成卡 t_babca897）。
 *
 * 这一层把三块接起来：
 *   1. resolver（父卡交付的状态机）—— 只负责“跑解析”，不关心 HTTP/持久化细节；
 *   2. 持久化（src/store.ts）—— 唯一约束 + revision CAS + 租约恢复；
 *   3. 契约的开关/幂等/重试语义 —— 总开关、重复 POST 去重、人工 retry 真正重跑一次解析。
 *
 * 诚实性边界（与 docs/social-content/integration-v1.md 对齐）：
 *  - 没有持久绑定时返回 503 PERSISTENCE_UNAVAILABLE，仍把本次内存结果如实带回，但**不**声称已存；
 *  - retry 只重跑一次解析，不绕过限速；解析失败就继续是 failed，不编造内容；
 *  - 这里不做后台队列：v1 的 resolve 是请求内完成（20s 上限），晚到结果由前端轮询/事件消费。
 */

import {
  SHARE_REQUEST_LIMITS,
  type ContentRecord,
  type ExcerptsRequest,
  type ShareAttachment,
  type SocialPlatform,
} from '../../../utils/socialContent/types';
import { buildContentId, extractShareLinks } from '../../../utils/socialContent/links';
import type { ContentAdapter, SourceTarget } from '../adapter';
import { buildExcerpts } from '../excerpts';
import { asSocialError, RevisionConflictError, SocialError, VersionUnavailableError } from '../errors';
import { HTTP_BY_CODE } from '../handlers';
import { buildLocalSummary, planRetry, resolveShares, stateFromRecord } from '../resolver';
import type { ScopedSocialStore, SocialStoreRoot } from './store';
import { PersistenceUnavailable } from './store';
import { lightAttachment } from './delivery';
import type { SocialServiceConfig } from './config';
import { SHARE_SCHEMA_VERSION } from '../../../utils/socialContent/types';

export interface ServiceResult {
  status: number;
  body: unknown;
}

export interface SocialServiceDeps {
  config: SocialServiceConfig;
  store: SocialStoreRoot;
  adapters: Partial<Record<SocialPlatform, ContentAdapter>>;
  sourceIdFor: (platform: SocialPlatform) => string | null;
  now?: () => number;
  /** 每次状态变化的旁路回调（SSE/日志用）；默认无。 */
  onUpdate?: (attachment: ShareAttachment) => void;
}

function fail(err: unknown): ServiceResult {
  if (err instanceof PersistenceUnavailable) {
    return { status: 503, body: { error: 'PERSISTENCE_UNAVAILABLE' } };
  }
  if (err instanceof RevisionConflictError) {
    return { status: 409, body: { error: 'revision_conflict', reason: err.reason } };
  }
  if (err instanceof VersionUnavailableError) {
    return { status: 409, body: { error: 'VERSION_UNAVAILABLE', reason: err.reason } };
  }
  const social = asSocialError(err);
  return {
    status: HTTP_BY_CODE[social.code] ?? 500,
    body: {
      error: social.code,
      retryable: !['AUTH_REQUIRED', 'SOURCE_NOT_CONFIGURED', 'SHARE_LINKS_DISABLED'].includes(social.code),
    },
  };
}

/**
 * 轻量响应的口径：不返回正文/完整材料，但**必须**带回有界冻结投影（见 src/delivery.ts）。
 * 投影不是正文——它是版本号 + 字幕语义 + 一句简介；客户端要靠它注入 read_share_excerpts
 * 并渲染“字幕未提供/获取失败”的降级说明。清成 null 会让所有真实成功卡变成“不可读”。
 */

export function createSocialService(deps: SocialServiceDeps) {
  const now = deps.now ?? (() => Date.now());

  function gate(): ServiceResult | null {
    if (!deps.config.enabled) return { status: 503, body: { error: 'SHARE_LINKS_DISABLED' } };
    return null;
  }

  function scoped(scope: string): ScopedSocialStore {
    return deps.store.forScope(scope);
  }

  return {
    /**
     * POST /shares/resolve —— 幂等：同一 messageId + 同一链接只会有一张卡；
     * 已存在的卡（含另一进程刚建的）原样返回，不重复解析、不重复回模型。
     */
    async resolve(scope: string, body: Record<string, unknown>): Promise<ServiceResult> {
      const blocked = gate();
      if (blocked) return blocked;
      try {
        const text = body.text;
        if (typeof text !== 'string') throw new SocialError('INVALID_URL', 'missing_text');
        if (text.length > SHARE_REQUEST_LIMITS.maxTextUtf16Units) throw new SocialError('SIZE_LIMIT', 'text_too_long');
        const messageId = typeof body.messageId === 'string' ? body.messageId : '';
        const conversationId = typeof body.conversationId === 'string' ? body.conversationId : '';
        if (!messageId || !conversationId) throw new SocialError('INVALID_URL', 'missing_ids');

        const storeAvailable = deps.store.available;
        const st = storeAvailable ? scoped(scope) : null;
        // 同消息已有卡先读出来：终态直接复用、在途带租约的作业不重复抓（契约 4.1/4.3 幂等）
        const existing = st ? await st.listByMessage(messageId) : [];

        const result = await resolveShares(
          {
            messageId,
            conversationId,
            characterId: typeof body.characterId === 'string' ? body.characterId : null,
            text,
            scope,
            idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
          },
          {
            adapters: deps.adapters,
            sourceIdFor: deps.sourceIdFor,
            now,
            store: st,
            existing,
            rednoteEnabled: deps.config.rednoteEnabled,
            maxConcurrentPerScope: deps.config.maxConcurrentPerScope,
            resolveDeadlineMs: deps.config.resolveDeadlineMs,
          },
          { onUpdate: deps.onUpdate },
        );

        if (!st || result.persistence === 'unavailable') {
          return {
            status: 503,
            body: {
              error: 'PERSISTENCE_UNAVAILABLE',
              attachments: result.attachments.map(lightAttachment),
              pollAfterMs: result.pollAfterMs,
            },
          };
        }

        // 占位/终态都由 resolver 按 revision CAS 落库；这里不再重复写一遍（重复写只会多一次无谓 IO）
        return {
          status: 202,
          body: {
            attachments: result.attachments.map(lightAttachment),
            pollAfterMs: result.pollAfterMs,
            droppedOverLimit: result.droppedOverLimit,
          },
        };
      } catch (err) {
        return fail(err);
      }
    },

    /** GET /shares?conversationId=&messageId= */
    async list(scope: string, conversationId: string, messageId: string): Promise<ServiceResult> {
      const blocked = gate();
      if (blocked) return blocked;
      try {
        if (!conversationId || !messageId) throw new SocialError('INVALID_URL', 'missing_ids');
        const attachments = await scoped(scope).listByMessage(messageId);
        const filtered = attachments.filter((a) => a.conversationId === conversationId);
        return { status: 200, body: { attachments: filtered.map(lightAttachment) } };
      } catch (err) {
        return fail(err);
      }
    },

    /** GET /shares/:shareRef —— 跨 scope 一律 404，不透露存在性。 */
    async get(scope: string, shareRef: string): Promise<ServiceResult> {
      const blocked = gate();
      if (blocked) return blocked;
      try {
        const attachment = await scoped(scope).get(shareRef);
        if (!attachment) return { status: 404, body: { error: 'CONTENT_NOT_FOUND' } };
        return { status: 200, body: { attachment: lightAttachment(attachment) } };
      } catch (err) {
        return fail(err);
      }
    },

    /**
     * POST /shares/:shareRef/retry —— 递增 attempt 并**真的重跑一次**解析。
     * 冲突用 409；失败继续 failed，不把上次内容当新内容。
     */
    async retry(scope: string, shareRef: string, body: Record<string, unknown>): Promise<ServiceResult> {
      const blocked = gate();
      if (blocked) return blocked;
      try {
        const expectedRevision = Number(body.expectedRevision);
        if (!Number.isInteger(expectedRevision) || expectedRevision <= 0) {
          throw new SocialError('INVALID_URL', 'expected_revision_required');
        }
        const st = scoped(scope);
        const existing = await st.get(shareRef);
        if (!existing) return { status: 404, body: { error: 'CONTENT_NOT_FOUND' } };
        const planned = planRetry(existing, expectedRevision, now());
        const ok = await st.put(planned, existing.revision);
        if (!ok) return { status: 409, body: { error: 'revision_conflict' } };
        // retry 也是一次真实解析：先抢租约，避免两个重试请求同时打平台/互相覆盖
        let baseRevision = planned.revision;
        try {
          const claimed = await st.claim(planned.shareRef, now() + deps.config.resolveDeadlineMs + 5000, now());
          if (claimed) {
            baseRevision += 1;
          } else {
            // 另一个重试请求刚刚抢到租约：不要并发打平台，也不要假装重跑成功
            return { status: 409, body: { error: 'retry_in_flight' } };
          }
        } catch {
          // 租约不可用（存储异常）：照旧按 revision CAS 重跑，最坏是重复抓一次
        }
        const resolved = await resolveOne(st, planned, scope, baseRevision);
        return { status: 202, body: { attachment: lightAttachment(resolved) } };
      } catch (err) {
        return fail(err);
      }
    },

    /** GET /items/:contentId */
    async item(scope: string, contentId: string): Promise<ServiceResult> {
      const blocked = gate();
      if (blocked) return blocked;
      try {
        const record = await scoped(scope).getContent(contentId);
        if (!record) return { status: 404, body: { error: 'CONTENT_NOT_FOUND' } };
        return { status: 200, body: { content: record } };
      } catch (err) {
        return fail(err);
      }
    },

    /** POST /items/:contentId/excerpts —— 服务端夹紧字段/预算，只检索已授权内容。 */
    async excerpts(scope: string, contentId: string, body: Record<string, unknown>): Promise<ServiceResult> {
      const blocked = gate();
      if (blocked) return blocked;
      try {
        const record = await scoped(scope).getContent(contentId);
        if (!record) return { status: 404, body: { error: 'CONTENT_NOT_FOUND' } };
        const req: ExcerptsRequest = {
          contentRevision: Number(body.contentRevision),
          query: typeof body.query === 'string' ? body.query : null,
          fields: Array.isArray(body.fields) ? (body.fields as ExcerptsRequest['fields']) : ['text'],
          partKey: typeof body.partKey === 'string' ? body.partKey : null,
          cursor: typeof body.cursor === 'string' ? body.cursor : null,
          maxTokens: Number(body.maxTokens) || 0,
        };
        if (!Number.isFinite(req.contentRevision)) throw new SocialError('INVALID_URL', 'content_revision_required');
        return { status: 200, body: buildExcerpts(record, req) };
      } catch (err) {
        return fail(err);
      }
    },

    /** 重启恢复：把上次进程留下的 queued/resolving 明确标 failed（幂等，每次启动调用）。 */
    async recover(): Promise<number> {
      // 进程刚起：上一个持有者的租约即使“还没到期”也已经没人续了（单实例部署）。
      // 不收它就会让用户看到一条永远“解析中”的卡，所以这里 includeLive=true。
      return deps.store.recoverInterrupted(now(), { includeLive: true });
    },
  };

  /** retry 的重跑：从 originalUrl 重新识别 → 受控展开 → 抓取 → CAS 落库。 */
  async function resolveOne(
    st: ScopedSocialStore,
    planned: ShareAttachment,
    scope: string,
    recordRevision: number = planned.revision,
  ): Promise<ShareAttachment> {
    try {
      const extracted = extractShareLinks(planned.originalUrl, { rednoteEnabled: deps.config.rednoteEnabled });
      const candidate = extracted.ok ? extracted.candidates[0] : null;
      if (!candidate || !candidate.platform) {
        return await markFailed(st, planned, new SocialError('INVALID_URL', 'retry_unparsable'), recordRevision);
      }
      const sourceId = deps.sourceIdFor(candidate.platform);
      const adapter = deps.adapters[candidate.platform];
      if (!sourceId || !adapter) {
        return await markFailed(st, planned, new SocialError('SOURCE_NOT_CONFIGURED', 'no_source_for_platform'), recordRevision);
      }
      const deadline = now() + deps.config.resolveDeadlineMs;
      let target: SourceTarget;
      if (candidate.linkKind === 'short') {
        target = await adapter.expandShortLink(candidate.originalUrl, { scope, deadline, now });
      } else {
        target = {
          platform: candidate.platform,
          externalId: candidate.externalId as string,
          partKey: candidate.partKey,
          canonicalUrl: candidate.canonicalUrl ?? candidate.resolvedInput,
          resolvedUrl: candidate.resolvedInput,
        };
      }
      const record = await adapter.fetchContent(target, { scope, deadline, now });
      const { state, coverage, missing, transcriptState } = stateFromRecord(record);
      const contentId = buildContentId(record.platform, record.sourceId, record.externalId);
      const next: ShareAttachment = {
        ...planned,
        state,
        revision: recordRevision + 1,
        updatedAt: now(),
        contentId,
        resolvedUrl: target.resolvedUrl,
        canonicalUrl: target.canonicalUrl,
        openUrl: target.canonicalUrl,
        partKey: target.partKey,
        preview: {
          title: record.title,
          authorName: record.author.name,
          platformName: record.attribution.platformName,
          siteName: record.attribution.platformName,
          coverUrl: record.images.find((i) => i.type === 'image' && i.safeUrl)?.safeUrl ?? null,
          excerpt: record.body.text ? record.body.text.slice(0, 120) : null,
        },
        error: null,
        contextProjection: {
          projectionVersion: 1,
          shareRef: planned.shareRef,
          contentId,
          contentRevision: record.contentRevision,
          stateAtFreeze: state,
          summaryText: buildLocalSummary(record, coverage),
          evidenceCoverage: coverage,
          reason: missing.length ? `missing:${missing.join(',')}` : null,
          frozenAt: now(),
          transcriptState,
        },
      };
      const ok = await st.put(next, recordRevision);
      if (!ok) throw new RevisionConflictError('retry_cas_conflict');
      return next;
    } catch (err) {
      return markFailed(st, planned, err, recordRevision);
    }
  }

  async function markFailed(
    st: ScopedSocialStore,
    planned: ShareAttachment,
    err: unknown,
    expectedRevision: number,
  ): Promise<ShareAttachment> {
    const failed: ShareAttachment = {
      ...planned,
      state: 'failed',
      revision: expectedRevision + 1,
      updatedAt: now(),
      contentId: null,
      error: asSocialError(err).toShareError(null),
      preview: null,
      contextProjection: null,
    };
    await st.put(failed, expectedRevision);
    return failed;
  }
}

/**
 * 内容持久化装饰器：适配器拿到 ContentRecord 后立刻落内容库（cacheAllowed 由部署端决定）。
 * 落库失败不阻断解析结果返回（正文仍在本次响应里），但会记进 health 计数由运维排查。
 */
export function withContentPersistence(
  adapter: ContentAdapter,
  store: SocialStoreRoot,
  opts: { cacheAllowed: boolean; onPersistError?: (err: unknown) => void },
): ContentAdapter {
  return {
    ...adapter,
    async fetchContent(target: SourceTarget, ctx) {
      const record = await adapter.fetchContent(target, ctx);
      if (opts.cacheAllowed && store.available) {
        try {
          await store.forScope(ctx.scope).putContent(record);
        } catch (err) {
          opts.onPersistError?.(err);
        }
      }
      return record;
    },
  };
}

/** 供测试/自检：一条记录是否具备可投影的最小材料。 */
export function projectionMaterialOf(record: ContentRecord): { hasText: boolean; hasTranscript: boolean } {
  const caption = (record.transcripts ?? []).find((t) => t.kind === 'native_caption' && t.availability === 'available');
  return {
    hasText: record.body?.availability === 'available' && Boolean(record.body.text),
    hasTranscript: Boolean(caption && caption.plainText),
  };
}

export { SHARE_SCHEMA_VERSION };
