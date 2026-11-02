// features/friend-feed/validation.ts
// Bibi 纯校验：无 React、无存储、无网络，可单测。
import {
    ACCEPTED_IMAGE_MIMES,
    ARCHIVE_ID_RE,
    MAX_COMMENT_LENGTH,
    MAX_IMAGES_PER_POST,
    MAX_IMAGE_BYTES,
    MAX_TEXT_LENGTH,
    PERSISTED_IMAGE_REF_RE,
} from './limits.js';

export interface ValidationResult {
    ok: boolean;
    error?: string;
}

export function normalizeText(t: string): string {
    return t.replace(/\s+/g, ' ').trim();
}

export function validatePostText(text: string): ValidationResult {
    const t = normalizeText(text);
    if (!t) return { ok: false, error: '写点什么再发布吧' };
    if (t.length > MAX_TEXT_LENGTH) return { ok: false, error: `内容过长（最多 ${MAX_TEXT_LENGTH} 字）` };
    return { ok: true };
}

export function validateCommentText(text: string): ValidationResult {
    const t = normalizeText(text);
    if (!t) return { ok: false, error: '评论不能为空' };
    if (t.length > MAX_COMMENT_LENGTH) return { ok: false, error: `评论过长（最多 ${MAX_COMMENT_LENGTH} 字）` };
    return { ok: true };
}

export interface ImageFileLike {
    name: string;
    type: string;
    size: number;
}

export function validateImageFile(f: ImageFileLike): ValidationResult {
    if (!(ACCEPTED_IMAGE_MIMES as readonly string[]).includes(f.type)) {
        return { ok: false, error: `不支持的图片类型：${f.type || '未知'}（仅 PNG/JPEG/GIF/WebP）` };
    }
    if (!Number.isFinite(f.size) || f.size <= 0) return { ok: false, error: '图片文件无效' };
    if (f.size > MAX_IMAGE_BYTES) {
        return { ok: false, error: `图片过大（单图上限 ${MAX_IMAGE_BYTES / 1024 / 1024}MB）` };
    }
    return { ok: true };
}

export function validateImageRefs(refs: string[]): ValidationResult {
    if (refs.length > MAX_IMAGES_PER_POST) {
        return { ok: false, error: `图片最多 ${MAX_IMAGES_PER_POST} 张` };
    }
    for (const r of refs) {
        // 仅接受持久化可信令牌；blob:/data:/http(s):/ 等渲染期瞬时值一律拒绝写入。
        if (typeof r !== 'string' || !PERSISTED_IMAGE_REF_RE.test(r)) {
            return { ok: false, error: '图片引用不合法（仅 blobref:/localimg: 可信令牌）' };
        }
    }
    return { ok: true };
}

/** 身份 id 的形态校验（供控制层复用）。 */
export function validateIdentityId(id: string): ValidationResult {
    if (typeof id !== 'string' || !ARCHIVE_ID_RE.test(id)) {
        return { ok: false, error: '身份非法' };
    }
    return { ok: true };
}
