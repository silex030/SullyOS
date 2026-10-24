/**
 * 轻量卡片交付（返工 t_42231e16 · P1：内容理解真实链路被 light() 截断）。
 *
 * 背景：旧实现把所有响应里的 `contextProjection` 强制清成 null，理由是“只回轻量字段，
 * 不返回投影正文”（契约 4.2）。但 `contextProjection` **不是正文**——它是冻结的有界投影
 * （标题/作者之外的一句简介 ≤180 字、覆盖字段、字幕状态、内容版本号）。清成 null 的后果是：
 *   - `apps/Chat.tsx` 把响应附件原样存进 `metadata.shares`，于是 contentRevision 与
 *     transcriptState 一起丢失；
 *   - `utils/socialShareTool.ts` 只从 `contextProjection.contentRevision` 取版本，
 *     所有真实成功的卡都被判成 unreadable，`read_share_excerpts` 永远不注入；
 *   - `utils/socialShare.ts` 的投影拿不到 summaryText/transcriptState，把已完成的卡写成
 *     “解析中，尚未读取内容”。
 *
 * 现在：响应里带回**有界**投影（这里再做一次夹紧，不信任库里的历史长度），完整正文仍然
 * 留在内容库、只能经 `/items/:id/excerpts` 按需读取。所有对外轻量响应（resolve/list/get/retry
 * 与 worker 路由层）共用这一个函数，避免两套 light 语义再次分叉。
 */

import type { ContextProjection, ShareAttachment, TranscriptState } from '../../../utils/socialContent/types';

/** 交付上限：投影本来就是有界的，这里只是防御历史脏数据/未来字段膨胀。 */
export const PROJECTION_DELIVERY_LIMITS = {
  summaryChars: 400,
  coverageEntries: 8,
  coverageEntryChars: 24,
  reasonChars: 200,
} as const;

const TRANSCRIPT_STATES: ReadonlySet<string> = new Set<TranscriptState>([
  'available',
  'failed',
  'not_available',
  'not_requested',
  'absent',
]);

function clip(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  return Array.from(value).slice(0, maxChars).join('');
}

function finiteNumberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * 有界冻结投影：保留版本/状态/简介/覆盖/字幕语义，砍掉任何可膨胀的部分。
 * 注意不要“补造”缺失值：老卡没有 transcriptState 就不写这个字段，
 * 让 `renderShareCardProjection` 按 absent 的既有语义降级。
 */
export function boundedProjection(attachment: ShareAttachment): ContextProjection | null {
  const projection = attachment?.contextProjection;
  if (!projection) return null;
  const contentRevision =
    typeof projection.contentRevision === 'number' && Number.isFinite(projection.contentRevision)
      ? projection.contentRevision
      : null;
  const coverage = Array.isArray(projection.evidenceCoverage) ? projection.evidenceCoverage : [];
  const delivered: ContextProjection = {
    projectionVersion: finiteNumberOr(projection.projectionVersion, 1),
    shareRef: attachment.shareRef,
    contentId: typeof projection.contentId === 'string' ? projection.contentId : attachment.contentId,
    contentRevision,
    stateAtFreeze: projection.stateAtFreeze ?? attachment.state,
    summaryText: clip(projection.summaryText, PROJECTION_DELIVERY_LIMITS.summaryChars),
    evidenceCoverage: coverage
      .slice(0, PROJECTION_DELIVERY_LIMITS.coverageEntries)
      .map((entry) => clip(entry, PROJECTION_DELIVERY_LIMITS.coverageEntryChars))
      .filter(Boolean),
    reason: projection.reason ? clip(projection.reason, PROJECTION_DELIVERY_LIMITS.reasonChars) : null,
    frozenAt: finiteNumberOr(projection.frozenAt, 0),
  };
  if (typeof projection.transcriptState === 'string' && TRANSCRIPT_STATES.has(projection.transcriptState)) {
    delivered.transcriptState = projection.transcriptState;
  }
  return delivered;
}

/** 轻量响应：不返回正文/完整材料，但保留有界冻结投影（版本 + 字幕语义 + 简介）。 */
export function lightAttachment(attachment: ShareAttachment): ShareAttachment {
  return { ...attachment, contextProjection: boundedProjection(attachment) };
}
