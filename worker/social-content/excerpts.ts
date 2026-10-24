/**
 * items/:contentId/excerpts（t_2c2dba79，契约 4.5）。
 *
 * 只从**已授权内容**里切片，不接受任意 URL；服务端夹紧字段与预算；
 * 旧 contentRevision 直接 VERSION_UNAVAILABLE，绝不把新正文混进旧请求。
 *
 * token 估算：仓库没有 tokenizer 依赖，按每 Unicode 码点 ≈ 1 token 保守估算，
 * 响应里 estimateMethod='codepoint_approx'，不声称精确（契约 6.3）。
 */

import {
  SHARE_BUDGETS,
  type ContentRecord,
  type ExcerptSegment,
  type ExcerptsRequest,
  type ExcerptsResponse,
} from '../../utils/socialContent/types';
import { VersionUnavailableError } from './errors';

export type ExcerptField = 'text' | 'transcript' | 'comments';

const ALLOWED_FIELDS: ExcerptField[] = ['text', 'transcript', 'comments'];
/** 单条切片上限，避免一句话把整段预算吃光后无法继续。 */
const MAX_SEGMENT_CHARS = 400;

/** 以码点估算 token（代理对按 1 个码点算）。 */
export function estimateTokens(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/** 把正文切成可寻址的切片：先按段落，超长再按句子/硬切。 */
export function chunkText(text: string, maxChars = MAX_SEGMENT_CHARS): string[] {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  for (const para of paragraphs) {
    if (para.length <= maxChars) {
      out.push(para);
      continue;
    }
    const sentences = para.split(/(?<=[。！？!?；;.\n])/).filter((s) => s.trim());
    let buf = '';
    for (const sentence of sentences) {
      if (sentence.length > maxChars) {
        if (buf) {
          out.push(buf);
          buf = '';
        }
        for (let i = 0; i < sentence.length; i += maxChars) out.push(sentence.slice(i, i + maxChars));
        continue;
      }
      if (buf.length + sentence.length > maxChars) {
        out.push(buf);
        buf = sentence;
      } else {
        buf += sentence;
      }
    }
    if (buf) out.push(buf);
  }
  return out;
}

/** 不透明游标：只编码切片序号，不含正文/URL/凭据；不用 Buffer，保证 Workers 可运行。 */
function encodeCursor(index: number): string {
  return `i${index}`;
}

/** cursor 非法时从 0 开始（不报错、也不跳内容），并把它当作"从头读"。 */
function decodeCursor(cursor: string | null): number {
  if (!cursor) return 0;
  const m = /^i(\d{1,7})$/.exec(cursor);
  if (!m) return 0;
  const i = Number(m[1]);
  return Number.isInteger(i) && i >= 0 ? i : 0;
}

function normalizeFields(fields: unknown): ExcerptField[] {
  const list = Array.isArray(fields) ? fields.filter((f): f is string => typeof f === 'string') : [];
  const valid = list.filter((f): f is ExcerptField => (ALLOWED_FIELDS as string[]).includes(f));
  return valid.length > 0 ? [...new Set(valid)] : ['text'];
}

interface Candidate extends ExcerptSegment {
  /** 稳定排序用：字段顺序 → 原始顺序 */
  order: number;
}

/** 组装全部候选切片（未裁剪预算）。query 命中优先，但保持原文顺序。 */
export function collectCandidates(record: ContentRecord, fields: ExcerptField[], partKey: string | null, query: string | null): Candidate[] {
  const candidates: Candidate[] = [];
  const sourceRef = `${record.platform}:${record.sourceId}:${record.externalId}`;
  const q = query?.trim().toLocaleLowerCase() ?? '';
  const match = (text: string) => (q ? text.toLocaleLowerCase().includes(q) : true);

  for (const field of fields) {
    if (field === 'text') {
      chunkText(record.body.text).forEach((chunk, i) => {
        if (!match(chunk)) return;
        candidates.push({
          id: `text-${i}`,
          field: 'text',
          text: chunk,
          startMs: null,
          endMs: null,
          sourceRef: `${sourceRef}#text`,
          order: candidates.length,
        });
      });
    }
    if (field === 'transcript') {
      for (const track of record.transcripts ?? []) {
        if (track.availability !== 'available') continue;
        if (partKey && track.partKey !== partKey) continue;
        track.segments.forEach((seg, i) => {
          if (!match(seg.text)) return;
          candidates.push({
            id: `${track.id}-${seg.id || i}`,
            field: 'transcript',
            text: seg.text,
            startMs: seg.startMs,
            endMs: seg.endMs,
            sourceRef: `${sourceRef}#transcript`,
            order: candidates.length,
          });
        });
      }
    }
    if (field === 'comments') {
      const sample = record.commentsSample;
      if (sample?.availability === 'available') {
        sample.items.forEach((item, i) => {
          if (!match(item.text)) return;
          candidates.push({
            id: `comment-${item.id || i}`,
            field: 'comments',
            text: item.text,
            startMs: null,
            endMs: null,
            sourceRef: item.sourceRef,
            order: candidates.length,
          });
        });
      }
    }
  }
  return candidates;
}

/**
 * 生成摘录。超出预算时按候选顺序截断并给 nextCursor，由客户端显式续读，
 * 不静默丢弃剩余内容。
 */
export function buildExcerpts(record: ContentRecord, req: ExcerptsRequest): ExcerptsResponse {
  if (record.contentRevision !== req.contentRevision) {
    throw new VersionUnavailableError(`content_revision_${record.contentRevision}_requested_${req.contentRevision}`);
  }
  const fields = normalizeFields(req.fields);

  // 服务端夹紧：请求的 maxTokens 只是"希望值"，上限由契约预算决定
  const budget = Math.max(
    1,
    Math.min(req.maxTokens && req.maxTokens > 0 ? req.maxTokens : SHARE_BUDGETS.excerptsPerCallTokens, SHARE_BUDGETS.excerptsPerCallTokens),
  );

  const all = collectCandidates(record, fields, req.partKey, req.query);
  const start = Math.min(decodeCursor(req.cursor), all.length);

  const segments: ExcerptSegment[] = [];
  let used = 0;
  let index = start;
  while (index < all.length) {
    const candidate = all[index];
    const cost = estimateTokens(candidate.text);
    // 至少放一条：否则单个超长切片会永远返回空
    if (segments.length > 0 && used + cost > budget) break;
    segments.push({
      id: candidate.id,
      field: candidate.field,
      text: candidate.text,
      startMs: candidate.startMs,
      endMs: candidate.endMs,
      sourceRef: candidate.sourceRef,
    });
    used += cost;
    index += 1;
    if (used >= budget) break;
  }

  const nextCursor = index < all.length ? encodeCursor(index) : null;
  return {
    contentId: record.id,
    contentRevision: record.contentRevision,
    segments,
    nextCursor,
    truncated: nextCursor !== null,
    tokenEstimate: used,
    estimateMethod: 'codepoint_approx',
  };
}
