// features/friend-feed/bibiImageMap.ts
// Bibi App 接线层图片引用→URL 映射（生产 App 专用，非核心）。
// 背景：service.resolveImageRefs(refs) 为批量接口，内部过滤空项后返回压缩数组，
// 调用方若按索引回填（refs[i] ↔ urls[i]）会在缺失图在前时把有效图绑到错误 ref。
// 本 helper 逐 ref 单独解析，保持 ref→URL 一一对应；单个失败视为缺失跳过，
// 已建 URL 全部纳入同一可释放集合：取消时全部 revoke 后返回空，失败项不丢已建。
// 核心 service.ts 不动。
import { resolveImageRefs } from './service.js';

export type BibiResolveOne = (ref: string) => Promise<string>;
export type BibiRevoke = (url: string) => void;

function defaultRevoke(url: string): void {
    try {
        URL.revokeObjectURL(url);
    } catch {
        /* ignore */
    }
}

/**
 * 逐 ref 解析为可渲染 URL 的映射表（缺失/非法返回空则跳过，不占位）。
 * - 去重后按原序逐个解析，保证 missing 在前时 valid 仍绑到正确 ref；
 * - isCancelled() 为 true 时：撤销本次已建全部 URL（含刚建的这一个）后返回空表，
 *   调用方不得再 setState；
 * - 单个 ref 解析抛错视为缺失继续，不丢弃之前已建（无泄漏：已建要么在表内、要么已撤销）。
 */
export async function resolveBibiImageMap(
    refs: string[],
    resolveOne: BibiResolveOne = (r) => resolveImageRefs([r]).then((a) => a[0] ?? ''),
    opts?: { isCancelled?: () => boolean; revoke?: BibiRevoke },
): Promise<Record<string, string>> {
    const revoke = opts?.revoke ?? defaultRevoke;
    const isCancelled = opts?.isCancelled;
    const uniq = [...new Set(refs)];
    const map: Record<string, string> = {};
    const created: string[] = [];
    for (const r of uniq) {
        if (isCancelled?.()) break;
        let url = '';
        try {
            url = await resolveOne(r);
        } catch {
            continue;
        }
        if (isCancelled?.()) {
            if (url) {
                try {
                    revoke(url);
                } catch {
                    /* ignore */
                }
            }
            break;
        }
        if (url) {
            map[r] = url;
            created.push(url);
        }
    }
    if (isCancelled?.()) {
        for (const u of created) {
            try {
                revoke(u);
            } catch {
                /* ignore */
            }
        }
        return {};
    }
    return map;
}
