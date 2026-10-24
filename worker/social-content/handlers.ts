/**
 * /v1/social/* 处理器（t_2c2dba79，契约 4.1-4.5）。
 *
 * 只做协议层：校验入参、取可信 scope、委托 resolver/store、把错误翻译成 HTTP 语义。
 * **不在这里挂路由**：worker/main-agent/src/index.js 是集成人独占热点，接线由集成人做
 * （checkAuth 之后挂 /v1/social/*，外部 /agent/v1/social/* 沿用现有前缀剥离规则）。
 *
 * 安全口径：
 *  - scope 只从服务端鉴权上下文取，绝不读 body/query 的 ownerId/characterId（契约 5.2）；
 *  - 跨 scope 的 shareRef 一律 404，不透露是否存在（契约 4.6）；
 *  - 401/403/404/409/422/429/503 一律如实返回，不伪装成功。
 */

import type { ContentRecord, ExcerptsRequest, ShareAttachment } from '../../utils/socialContent/types';
import { SHARE_REQUEST_LIMITS } from '../../utils/socialContent/types';
import type { ResolveDeps, ShareStore } from './resolver';
import { planRetry, resolveShares } from './resolver';
import { buildExcerpts } from './excerpts';
import { asSocialError, RevisionConflictError, SocialError, VersionUnavailableError } from './errors';

export interface HandlerDeps extends ResolveDeps {
  store: ShareStore;
  /** 内容库读取（集成人接共享 ContentItem 表）；不存在返回 null。 */
  getContent: (contentId: string, scope: string) => Promise<ContentRecord | null>;
  now?: () => number;
}

export interface HandlerResult {
  status: number;
  body: unknown;
}

const HTTP_BY_CODE: Record<string, number> = {
  INVALID_URL: 422,
  UNSUPPORTED_PLATFORM: 422,
  UNSUPPORTED_LINK_TYPE: 422,
  UNSUPPORTED_REGION_OR_PRODUCT: 422,
  AUTH_REQUIRED: 401,
  ACCESS_DENIED: 403,
  PAYWALL: 402,
  REGION_RESTRICTED: 451,
  CONTENT_NOT_FOUND: 404,
  CONTENT_DELETED: 410,
  RATE_LIMITED: 429,
  TIMEOUT: 504,
  NETWORK_ERROR: 502,
  UPSTREAM_CHANGED: 502,
  UNSAFE_URL: 422,
  SIZE_LIMIT: 413,
  SOURCE_NOT_CONFIGURED: 503,
  PERSISTENCE_UNAVAILABLE: 503,
  CANCELLED: 409,
};

function fail(err: unknown): HandlerResult {
  if (err instanceof RevisionConflictError) {
    return { status: 409, body: { error: 'revision_conflict', reason: err.reason } };
  }
  if (err instanceof VersionUnavailableError) {
    return { status: 409, body: { error: 'VERSION_UNAVAILABLE', reason: err.reason } };
  }
  const social = asSocialError(err);
  return {
    status: HTTP_BY_CODE[social.code] ?? 500,
    body: { error: social.code, retryable: !['AUTH_REQUIRED', 'SOURCE_NOT_CONFIGURED'].includes(social.code) },
  };
}

/** 只回轻量字段：GET /shares 不返回正文（契约 4.2）。 */
function lightAttachment(a: ShareAttachment): ShareAttachment {
  return { ...a, contextProjection: null };
}

export function createSocialHandlers(deps: HandlerDeps) {
  const now = deps.now ?? (() => Date.now());

  return {
    /** POST /shares/resolve */
    async resolve(scope: string, body: Record<string, unknown>): Promise<HandlerResult> {
      try {
        const text = body.text;
        if (typeof text !== 'string') throw new SocialError('INVALID_URL', 'missing_text');
        if (text.length > SHARE_REQUEST_LIMITS.maxTextUtf16Units) {
          throw new SocialError('SIZE_LIMIT', 'text_too_long');
        }
        const messageId = typeof body.messageId === 'string' ? body.messageId : '';
        const conversationId = typeof body.conversationId === 'string' ? body.conversationId : '';
        if (!messageId || !conversationId) throw new SocialError('INVALID_URL', 'missing_ids');

        // 幂等：同一 idempotencyKey 重复 POST 由 store 的唯一约束兜底；
        // 这里至少保证不会因为重复调用产生不同 shareRef（同消息同链接合并）。
        const result = await resolveShares(
          {
            messageId,
            conversationId,
            characterId: typeof body.characterId === 'string' ? body.characterId : null,
            text,
            scope,
            idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
          },
          deps,
        );
        if (result.persistence === 'unavailable') {
          // 没有持久绑定：明确告诉调用方本次结果只在响应里有效（契约 5.3）
          return {
            status: 503,
            body: { error: 'PERSISTENCE_UNAVAILABLE', attachments: result.attachments, pollAfterMs: result.pollAfterMs },
          };
        }
        return { status: 202, body: { attachments: result.attachments, pollAfterMs: result.pollAfterMs } };
      } catch (err) {
        return fail(err);
      }
    },

    /** GET /shares?conversationId=&messageId= */
    async list(scope: string, conversationId: string, messageId: string): Promise<HandlerResult> {
      try {
        if (!conversationId || !messageId) throw new SocialError('INVALID_URL', 'missing_ids');
        const attachments = await deps.store.listByMessage(scope, messageId);
        const filtered = attachments.filter((a) => a.conversationId === conversationId);
        return { status: 200, body: { attachments: filtered.map(lightAttachment) } };
      } catch (err) {
        return fail(err);
      }
    },

    /** GET /shares/:shareRef */
    async get(scope: string, shareRef: string): Promise<HandlerResult> {
      try {
        const attachment = await deps.store.get(shareRef, scope);
        if (!attachment) return { status: 404, body: { error: 'CONTENT_NOT_FOUND' } };
        return { status: 200, body: { attachment: lightAttachment(attachment) } };
      } catch (err) {
        return fail(err);
      }
    },

    /** POST /shares/:shareRef/retry */
    async retry(scope: string, shareRef: string, body: Record<string, unknown>): Promise<HandlerResult> {
      try {
        const expectedRevision = Number(body.expectedRevision);
        if (!Number.isInteger(expectedRevision) || expectedRevision <= 0) {
          throw new SocialError('INVALID_URL', 'expected_revision_required');
        }
        const existing = await deps.store.get(shareRef, scope);
        if (!existing) return { status: 404, body: { error: 'CONTENT_NOT_FOUND' } };
        const next = planRetry(existing, expectedRevision, now());
        const ok = await deps.store.put(next, existing.revision);
        if (!ok) return { status: 409, body: { error: 'revision_conflict' } };
        return { status: 202, body: { attachment: next } };
      } catch (err) {
        return fail(err);
      }
    },

    /** GET /items/:contentId */
    async item(scope: string, contentId: string): Promise<HandlerResult> {
      try {
        const record = await deps.getContent(contentId, scope);
        if (!record) return { status: 404, body: { error: 'CONTENT_NOT_FOUND' } };
        return { status: 200, body: { content: record } };
      } catch (err) {
        return fail(err);
      }
    },

    /** POST /items/:contentId/excerpts */
    async excerpts(scope: string, contentId: string, body: Record<string, unknown>): Promise<HandlerResult> {
      try {
        const record = await deps.getContent(contentId, scope);
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
  };
}
