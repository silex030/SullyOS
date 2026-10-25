/**
 * 链接分享持久化（集成卡 t_babca897，契约 5.1/5.3/5.5）。
 *
 * 只用 D1 兼容 SQL（CF D1 / vps-backend/src/shim/d1.js 的 better-sqlite3 适配器）：
 *  - 唯一索引 (scope, message_id, occurrence_key) 保证“同消息同链接只一张卡”；
 *  - revision 单调：写入用 `WHERE revision = ?` 做 CAS，旧持有者写不进去；
 *  - queued/resolving 带 lease_until：进程重启后由 recoverInterrupted() 明确标 failed，
 *    不会永久停在 resolving；
 *  - 没有绑定 DB 时抛 PersistenceUnavailable，绝不退回进程 Map 冒充持久化。
 *
 * scope 语义（契约 5.2）：scope 只能来自服务端鉴权上下文，因此本模块要求调用方先用
 * `forScope(scope)` 拿到绑定 scope 的视图；接口里不出现 scope 参数，避免有人从 body/query 透传。
 *
 * 表结构见 worker/social-content/schema.sql（宿主启动时 exec 一次）。
 */

import type { ContentRecord, ShareAttachment, ShareState } from '../../../utils/socialContent/types';

export interface D1StatementLike {
  bind(...args: unknown[]): D1StatementLike;
  run(): Promise<{ meta?: { changes?: number } } | unknown>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
}
export interface D1Like {
  prepare(sql: string): D1StatementLike;
  exec?(sql: string): Promise<unknown>;
}

export class PersistenceUnavailable extends Error {
  constructor(message = 'social_content_db_not_bound') {
    super(message);
    this.name = 'PersistenceUnavailable';
  }
}

/** 绑定 scope 之后的持久化视图（就绪给 resolver 的 ShareStore 用）。 */
export interface ScopedSocialStore {
  scope: string;
  put(attachment: ShareAttachment, expectedRevision: number): Promise<boolean>;
  get(shareRef: string): Promise<ShareAttachment | null>;
  listByMessage(messageId: string): Promise<ShareAttachment[]>;
  putContent(record: ContentRecord): Promise<void>;
  getContent(contentId: string): Promise<ContentRecord | null>;
  claim(shareRef: string, leaseUntil: number, now: number): Promise<boolean>;
  release(shareRef: string): Promise<void>;
}

export interface SocialStoreRoot {
  forScope(scope: string): ScopedSocialStore;
  /**
   * 启动恢复：把上次进程留下的 queued/resolving 明确标 failed(TIMEOUT)。
   * includeLive=true 时连“租约还没到期”的行也一起收（进程已经重启，旧持有者不可能还活着；
   * 单实例部署下这是正确语义）；默认 false 只收过期租约，留给多副本/在线重试路径。
   */
  recoverInterrupted(now: number, opts?: { includeLive?: boolean }): Promise<number>;
  /** 持久化能力自检：准备好表但没绑 DB 时为 false。 */
  readonly available: boolean;
}

interface AttachmentRow {
  share_ref: string;
  scope: string;
  message_id: string;
  conversation_id: string;
  character_id: string | null;
  occurrence_key: string;
  occurrence_spans: string;
  original_url: string;
  platform: string | null;
  source_id: string | null;
  resolved_url: string | null;
  canonical_url: string | null;
  open_url: string | null;
  content_id: string | null;
  part_key: string | null;
  state: string;
  revision: number;
  attempt: number;
  lease_until: number | null;
  error_code: string | null;
  error_json: string | null;
  preview_json: string | null;
  projection_json: string | null;
  created_at: number;
  updated_at: number;
}

/** 同消息同链接的稳定键：原始 URL + 首个 span 起点（多 span 合并成一行）。 */
export function occurrenceKeyOf(attachment: Pick<ShareAttachment, 'originalUrl' | 'occurrenceSpans'>): string {
  const first = attachment.occurrenceSpans[0]?.start ?? 0;
  return `${attachment.originalUrl}#${first}`;
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function rowToAttachment(row: AttachmentRow): ShareAttachment {
  return {
    schemaVersion: 1,
    shareRef: row.share_ref,
    messageId: row.message_id,
    conversationId: row.conversation_id,
    characterId: row.character_id,
    occurrenceSpans: parseJson<ShareAttachment['occurrenceSpans']>(row.occurrence_spans) ?? [],
    originalUrl: row.original_url,
    platform: (row.platform as ShareAttachment['platform']) ?? null,
    sourceId: row.source_id,
    resolvedUrl: row.resolved_url,
    canonicalUrl: row.canonical_url,
    openUrl: row.open_url,
    contentId: row.content_id,
    partKey: row.part_key,
    state: row.state as ShareState,
    revision: Number(row.revision) || 1,
    attempt: Number(row.attempt) || 1,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    leaseUntil: row.lease_until == null ? null : Number(row.lease_until),
    error: parseJson(row.error_json),
    preview: parseJson(row.preview_json),
    contextProjection: parseJson(row.projection_json),
  };
}

const COLUMNS = [
  'share_ref', 'scope', 'message_id', 'conversation_id', 'character_id', 'occurrence_key',
  'occurrence_spans', 'original_url', 'platform', 'source_id', 'resolved_url', 'canonical_url',
  'open_url', 'content_id', 'part_key', 'state', 'revision', 'attempt', 'lease_until',
  'error_code', 'error_json', 'preview_json', 'projection_json', 'created_at', 'updated_at',
] as const;

function insertValues(attachment: ShareAttachment, scope: string): unknown[] {
  return [
    attachment.shareRef,
    scope,
    attachment.messageId,
    attachment.conversationId,
    attachment.characterId,
    occurrenceKeyOf(attachment),
    JSON.stringify(attachment.occurrenceSpans ?? []),
    attachment.originalUrl,
    attachment.platform,
    attachment.sourceId,
    attachment.resolvedUrl,
    attachment.canonicalUrl,
    attachment.openUrl,
    attachment.contentId,
    attachment.partKey,
    attachment.state,
    attachment.revision,
    attachment.attempt,
    attachment.leaseUntil ?? null,
    attachment.error?.code ?? null,
    attachment.error ? JSON.stringify(attachment.error) : null,
    attachment.preview ? JSON.stringify(attachment.preview) : null,
    attachment.contextProjection ? JSON.stringify(attachment.contextProjection) : null,
    attachment.createdAt,
    attachment.updatedAt,
  ];
}

function changesOf(res: unknown): number {
  const meta = (res as { meta?: { changes?: number } } | null)?.meta;
  const n = Number(meta?.changes ?? 0);
  return Number.isFinite(n) ? n : 0;
}

class ScopedStore implements ScopedSocialStore {
  constructor(private readonly db: D1Like, readonly scope: string) {}

  async put(attachment: ShareAttachment, expectedRevision: number): Promise<boolean> {
    if (expectedRevision === 0) {
      const placeholders = COLUMNS.map(() => '?').join(', ');
      const res = await this.db
        .prepare(`INSERT OR IGNORE INTO social_share_attachments (${COLUMNS.join(', ')}) VALUES (${placeholders})`)
        .bind(...insertValues(attachment, this.scope))
        .run();
      return changesOf(res) > 0;
    }
    const res = await this.db
      .prepare(
        `UPDATE social_share_attachments SET
           state = ?, revision = ?, attempt = ?, lease_until = NULL,
           resolved_url = ?, canonical_url = ?, open_url = ?, content_id = ?, part_key = ?,
           error_code = ?, error_json = ?, preview_json = ?, projection_json = ?, updated_at = ?
         WHERE share_ref = ? AND scope = ? AND revision = ?`,
      )
      .bind(
        attachment.state,
        attachment.revision,
        attachment.attempt,
        attachment.resolvedUrl,
        attachment.canonicalUrl,
        attachment.openUrl,
        attachment.contentId,
        attachment.partKey,
        attachment.error?.code ?? null,
        attachment.error ? JSON.stringify(attachment.error) : null,
        attachment.preview ? JSON.stringify(attachment.preview) : null,
        attachment.contextProjection ? JSON.stringify(attachment.contextProjection) : null,
        attachment.updatedAt,
        attachment.shareRef,
        this.scope,
        expectedRevision,
      )
      .run();
    return changesOf(res) > 0;
  }

  async get(shareRef: string): Promise<ShareAttachment | null> {
    const row = await this.db
      .prepare('SELECT * FROM social_share_attachments WHERE share_ref = ? AND scope = ?')
      .bind(shareRef, this.scope)
      .first<AttachmentRow>();
    return row ? rowToAttachment(row) : null;
  }

  async listByMessage(messageId: string): Promise<ShareAttachment[]> {
    const res = await this.db
      .prepare(
        'SELECT * FROM social_share_attachments WHERE scope = ? AND message_id = ? ORDER BY created_at ASC, share_ref ASC',
      )
      .bind(this.scope, messageId)
      .all<AttachmentRow>();
    return (res?.results ?? []).map(rowToAttachment);
  }

  async putContent(record: ContentRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO social_content_items (content_id, scope, platform, content_revision, record_json, fetched_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, content_id) DO UPDATE SET
           platform = excluded.platform,
           content_revision = excluded.content_revision,
           record_json = excluded.record_json,
           fetched_at = excluded.fetched_at,
           updated_at = excluded.updated_at
         WHERE excluded.content_revision >= social_content_items.content_revision`,
      )
      .bind(
        record.id,
        this.scope,
        record.platform,
        Number(record.contentRevision) || 1,
        JSON.stringify(record),
        Number(record.fetchedAt) || Date.now(),
        Number(record.updatedAt) || Date.now(),
      )
      .run();
  }

  async getContent(contentId: string): Promise<ContentRecord | null> {
    const row = await this.db
      .prepare('SELECT record_json FROM social_content_items WHERE scope = ? AND content_id = ?')
      .bind(this.scope, contentId)
      .first<{ record_json: string }>();
    return row ? parseJson<ContentRecord>(row.record_json) : null;
  }

  async claim(shareRef: string, leaseUntil: number, now: number): Promise<boolean> {
    const res = await this.db
      .prepare(
        `UPDATE social_share_attachments
            SET state = 'resolving', revision = revision + 1, lease_until = ?, updated_at = ?
          WHERE share_ref = ? AND scope = ?
            AND state IN ('queued','resolving')
            AND (lease_until IS NULL OR lease_until < ?)`,
      )
      .bind(leaseUntil, now, shareRef, this.scope, now)
      .run();
    return changesOf(res) > 0;
  }

  async release(shareRef: string): Promise<void> {
    await this.db
      .prepare('UPDATE social_share_attachments SET lease_until = NULL WHERE share_ref = ? AND scope = ?')
      .bind(shareRef, this.scope)
      .run();
  }
}

export class D1SocialStore implements SocialStoreRoot {
  constructor(private readonly db: D1Like | null | undefined) {}

  get available(): boolean {
    return Boolean(this.db && typeof (this.db as D1Like).prepare === 'function');
  }

  forScope(scope: string): ScopedSocialStore {
    if (!this.available) throw new PersistenceUnavailable();
    return new ScopedStore(this.db as D1Like, scope);
  }

  async recoverInterrupted(now: number, opts: { includeLive?: boolean } = {}): Promise<number> {
    if (!this.available) return 0;
    const error = JSON.stringify({
      code: 'TIMEOUT',
      retryable: true,
      retryAfterMs: null,
      userMessage: '解析中断（服务重启或租约过期），可手动重试',
      safeDiagnosticId: null,
    });
    const leaseClause = opts.includeLive ? '' : 'AND (lease_until IS NULL OR lease_until < ?)';
    const res = await (this.db as D1Like)
      .prepare(
        `UPDATE social_share_attachments
            SET state = 'failed', error_code = 'TIMEOUT', error_json = ?,
                revision = revision + 1, lease_until = NULL, updated_at = ?
          WHERE state IN ('queued','resolving')
            ${leaseClause}`,
      )
      .bind(...(opts.includeLive ? [error, now] : [error, now, now]))
      .run();
    return changesOf(res);
  }
}
