/**
 * ContentRecord 组装器（t_2c2dba79，契约 3.3）。
 *
 * 只允许这一处创建 ContentRecord：text 与 body.text 必须同一份，
 * images 与 media 引用同一批对象（不双存图片），fieldProvenance 逐字段如实标注。
 */

import type {
  CommentsSample,
  ContentAvailability,
  ContentMedia,
  ContentRecord,
  ContentSummary,
  FieldProvenance,
  ProvenanceField,
  SocialPlatform,
  Transcript,
} from '../../utils/socialContent/types';
import { SHARE_CONTENT_LIMITS, SHARE_SCHEMA_VERSION } from '../../utils/socialContent/types';
import { buildContentId } from '../../utils/socialContent/links';

export interface RecordInput {
  platform: SocialPlatform;
  sourceId: string;
  externalId: string;
  author: ContentRecord['author'];
  title: string | null;
  text: string;
  textTruncated?: boolean;
  textOriginalLength?: number | null;
  images: ContentMedia[];
  canonicalUrl: string;
  publishedAt: number | null;
  fetchedAt: number;
  updatedAt?: number | null;
  platformName: string;
  retrievalMethod: string;
  license?: string | null;
  status?: ContentAvailability;
  visibility?: 'public' | 'private';
  counts?: { likes: number | null; comments: number | null };
  transcripts?: Transcript[];
  commentsSample?: CommentsSample | null;
  summary?: ContentSummary | null;
  provenance?: Partial<Record<ProvenanceField, { retrievalMethod: string; fetchedAt: number; availability: ContentAvailability }>>;
  contentRevision?: number;
  notes?: string[];
}

/** 统一构造。id 由 platform/sourceId/externalId 决定，不接受调用方自定义。 */
export function buildRecord(input: RecordInput): ContentRecord {
  const id = buildContentId(input.platform, input.sourceId, input.externalId);
  const availability: ContentAvailability = input.status ?? 'available';
  const text = input.text ?? '';
  const limited = text.length > SHARE_CONTENT_LIMITS.maxTextChars;
  const bodyText = limited ? text.slice(0, SHARE_CONTENT_LIMITS.maxTextChars) : text;

  const provenance: Partial<Record<ProvenanceField, FieldProvenance>> = {};
  for (const [field, value] of Object.entries(input.provenance ?? {}) as Array<
    [ProvenanceField, { retrievalMethod: string; fetchedAt: number; availability: ContentAvailability }]
  >) {
    provenance[field] = {
      sourceRef: `${input.platform}:${input.sourceId}:${field}`,
      retrievalMethod: value.retrievalMethod,
      fetchedAt: value.fetchedAt,
      availability: value.availability,
    };
  }

  return {
    schemaVersion: SHARE_SCHEMA_VERSION,
    id,
    platform: input.platform,
    sourceId: input.sourceId,
    externalId: input.externalId,
    author: input.author,
    title: input.title,
    text: bodyText,
    media: input.images,
    canonicalUrl: input.canonicalUrl,
    publishedAt: input.publishedAt,
    fetchedAt: input.fetchedAt,
    updatedAt: input.updatedAt ?? null,
    attribution: {
      platformName: input.platformName,
      authorName: input.author.name,
      sourceUrl: input.canonicalUrl,
      retrievalMethod: input.retrievalMethod,
      license: input.license ?? null,
    },
    status: availability,
    visibility: input.visibility ?? 'public',
    counts: input.counts ?? { likes: null, comments: null },
    contentRevision: input.contentRevision ?? 1,
    body: {
      availability,
      text: bodyText,
      truncated: limited || input.textTruncated === true,
      originalLength: input.textOriginalLength ?? (limited ? text.length : null),
    },
    images: input.images,
    transcripts: input.transcripts ?? [],
    commentsSample: input.commentsSample ?? null,
    summary: input.summary ?? null,
    fieldProvenance: provenance,
    limits: {
      maxTextChars: SHARE_CONTENT_LIMITS.maxTextChars,
      maxResponseBytes: SHARE_CONTENT_LIMITS.maxDetailResponseBytes,
      truncated: limited || input.textTruncated === true,
      notes: input.notes ?? [],
    },
  };
}

/** 媒体条目：safeUrl 必须是已过白名单的 https 地址；未验证传 null。 */
export function mediaItem(input: {
  id: string;
  type: 'image' | 'video';
  safeUrl: string | null;
  alt?: string | null;
  width?: number | null;
  height?: number | null;
  expiresAt?: number | null;
  availability?: ContentAvailability;
}): ContentMedia {
  return {
    id: input.id,
    type: input.type,
    safeUrl: input.safeUrl,
    alt: input.alt ?? null,
    width: input.width ?? null,
    height: input.height ?? null,
    expiresAt: input.expiresAt ?? null,
    availability: input.availability ?? 'available',
  };
}
