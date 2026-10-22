/**
 * Memory Palace — 一键清空
 *
 * 把本地所有记忆宫殿数据清零；可选同步清空用户自己的 Supabase memory_vectors。
 *
 * 使用场景：
 *  - 用户想"重来"（比如改了 embedding 模型、或希望应用新版 boxId 体系）
 *  - 开发/测试重置
 *
 * 两条 P0 硬约束（改这里之前先读）：
 *  1. **两份水位一起清**：localStorage 的 `mp_lastMsgId_*` 与 IndexedDB assets 里的
 *     `mp_hwm_v1_*` 镜像必须同时清零，否则 `getReliableMemoryPalaceHighWaterMark`
 *     会把旧水位从镜像读回来，历史聊天永远不会被重新处理。
 *  2. **远端结果显式化**：成功 / 失败 / 跳过三态分开，行数未知就是 null，
 *     绝不能用 0 冒充"删了 0 行"的成功。本地清完、云端失败时允许只重试云端。
 */

import { openDB } from '../db';
import type { RemoteVectorConfig } from './types';
import { bm25Index } from './bm25Index';
import { clearAllMemoryPalaceHighWaterMarks } from './highWaterMark';
import { clearAllNegotiationLedgers } from './negotiationLedger';

const MP_STORES = [
    'memory_nodes',
    'memory_vectors',
    'memory_links',
    'memory_batches',
    'topic_boxes',
    'anticipations',
    'event_boxes',
    'room_plates',
    'digest_reports',
];

/** 清空本地 IndexedDB 的所有记忆宫殿表 */
async function clearLocalStores(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    const db = await openDB();

    // 只对实际存在的 store 操作（兼容旧版本未建 event_boxes 的情况）
    const presentStores = MP_STORES.filter(name => db.objectStoreNames.contains(name));
    if (presentStores.length === 0) return counts;

    return await new Promise<Record<string, number>>((resolve, reject) => {
        const tx = db.transaction(presentStores, 'readwrite');

        // 先异步收集每张表的行数，再清空；用嵌套 onsuccess 串起来
        let pending = presentStores.length;
        const checkDone = () => {
            if (pending === 0) {
                // 所有 count 回调完成，这里发起 clear
                for (const name of presentStores) {
                    try { tx.objectStore(name).clear(); } catch { /* ignore */ }
                }
            }
        };

        for (const name of presentStores) {
            const req = tx.objectStore(name).count();
            req.onsuccess = () => {
                counts[name] = req.result || 0;
                pending--;
                checkDone();
            };
            req.onerror = () => {
                counts[name] = 0;
                pending--;
                checkDone();
            };
        }

        tx.oncomplete = () => resolve(counts);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

export type RemoteWipeStatus = 'success' | 'failed' | 'skipped';

/** 远端清空的结果。`deleted` 只在 success 时可能是数字，其余一律 null（未知 / 没做）。 */
export interface RemoteWipeOutcome {
    status: RemoteWipeStatus;
    /** 服务端回报的删除行数；没给 count（或失败 / 跳过）时为 null，绝不填 0。 */
    deleted: number | null;
    /** HTTP 状态码；网络异常 / 跳过时为 null。 */
    httpStatus: number | null;
    /** 失败原因（已截断、不含凭据）；成功 / 跳过时缺省。 */
    error?: string;
}

const REMOTE_ERROR_MAX_CHARS = 200;

function skippedOutcome(): RemoteWipeOutcome {
    return { status: 'skipped', deleted: null, httpStatus: null };
}

/** 把服务端返回体压成一句能看的错误：截断、去掉 anon key、不留整段 HTML。 */
function describeFailure(status: number, body: string, anonKey: string): string {
    let text = body.replace(/\s+/g, ' ').trim();
    if (anonKey) text = text.split(anonKey).join('[key]');
    if (text.length > REMOTE_ERROR_MAX_CHARS) text = `${text.slice(0, REMOTE_ERROR_MAX_CHARS)}…`;
    return text.length > 0 ? `HTTP ${status}: ${text}` : `HTTP ${status}`;
}

/**
 * PostgREST 的删除行数在 `Content-Range` 里：
 *   - 给了 count 时形如 `0-9/10`（后者是总行数）
 *   - 没给 count 时两段都是星号，这时行数就是未知，不能当成 0
 */
function parseDeletedCount(headers: Headers): number | null {
    const range = headers.get('content-range');
    if (!range) return null;
    const match = range.match(/\/(\d+)\s*$/);
    if (!match) return null;
    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 清空远程 Supabase 向量表（全表删除，跨所有角色）。
 *
 * 单次 DELETE + `Prefer: count=exact`：原来先 HEAD 再 DELETE 那套有两个毛病——
 * 多打一个请求，且 HEAD 失败会被吞成 0 行，界面上看起来像「成功删了 0 行」。
 */
export async function retryRemoteWipe(config: RemoteVectorConfig): Promise<RemoteWipeOutcome> {
    if (!config?.enabled || !config?.initialized) return skippedOutcome();

    const headers = {
        apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${config.supabaseAnonKey}`,
        'Content-Type': 'application/json',
        Prefer: 'count=exact,return=minimal',
    };
    const base = `${config.supabaseUrl.replace(/\/+$/, '')}/rest/v1/memory_vectors`;

    let response: Response;
    try {
        // PostgREST 要求 DELETE 必须带过滤条件；用 "memory_id=not.is.null" 匹配全部行
        response = await fetch(`${base}?memory_id=not.is.null`, {
            method: 'DELETE',
            headers,
        });
    } catch (e: any) {
        const message = String(e?.message || e);
        console.warn(`🗑️ [Wipe] 远程删除异常: ${message}`);
        return { status: 'failed', deleted: null, httpStatus: null, error: message.slice(0, REMOTE_ERROR_MAX_CHARS) };
    }

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        const error = describeFailure(response.status, body, config.supabaseAnonKey);
        console.warn(`🗑️ [Wipe] 远程删除失败 ${error}`);
        return { status: 'failed', deleted: null, httpStatus: response.status, error };
    }

    return {
        status: 'success',
        deleted: parseDeletedCount(response.headers),
        httpStatus: response.status,
    };
}

export interface WipeResult {
    local: Record<string, number>;
    localRowsTotal: number;
    /** 两份水位（localStorage 键 + IndexedDB 镜像行）实际清掉的条目数 */
    highWatermarks: number;
    remote: RemoteWipeOutcome;
    /** 兼容旧字段：本次是否真的尝试过远端（= remote.status !== 'skipped'） */
    remoteAttempted: boolean;
}

/** 把远端结果压成一句人话，给清空结果的展示段直接用。 */
export function describeRemoteWipeOutcome(remote: RemoteWipeOutcome | null | undefined): string {
    if (!remote) return '云端未清';
    if (remote.status === 'skipped') return '云端未清';
    if (remote.status === 'failed') return `云端清空失败：${remote.error ?? '未知原因'}`;
    return remote.deleted === null ? '云端已清空（行数未提供）' : `云端向量 ${remote.deleted} 行`;
}

/**
 * 一键清空记忆宫殿数据。
 *
 * @param options.remoteConfig 若提供，会同时清空远程 Supabase memory_vectors（全表）
 * @param options.skipRemote  即使有 remoteConfig 也跳过远程（仅清本地）
 */
export async function wipeAllMemoryPalace(options: {
    remoteConfig?: RemoteVectorConfig;
    skipRemote?: boolean;
} = {}): Promise<WipeResult> {
    console.log(`🗑️ [Wipe] 开始一键清空记忆宫殿...`);

    const local = await clearLocalStores();
    const localRowsTotal = Object.values(local).reduce((s, v) => s + v, 0);

    // 两份水位一起清；这一步失败会抛出去（界面显示"清空失败"），不假装成功。
    const highWatermarks = await clearAllMemoryPalaceHighWaterMarks();
    clearAllNegotiationLedgers();

    // 同步清空内存中的 BM25 倒排索引（否则下次查询会拿到孤儿 nodeId）
    bm25Index.dropAll();

    // 本地清完再动云端：远端失败不回滚本地，结果里显式标 failed，可单独重试。
    const remote = options.remoteConfig && !options.skipRemote
        ? await retryRemoteWipe(options.remoteConfig)
        : skippedOutcome();

    const remoteAttempted = remote.status !== 'skipped';
    console.log(
        `🗑️ [Wipe] 完成：本地 ${localRowsTotal} 行、水位 ${highWatermarks} 条、云端 ${describeRemoteWipeOutcome(remote)}`,
    );
    return { local, localRowsTotal, highWatermarks, remote, remoteAttempted };
}
