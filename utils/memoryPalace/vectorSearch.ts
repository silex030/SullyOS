/**
 * Memory Palace — 向量搜索（Web Worker 加速版）
 *
 * 查询文本 → 向量化 → 与该角色的 memory_vectors 做余弦相似度 → 阈值过滤
 *
 * 优化：
 * 1. 使用 charId 索引直查，不再全表扫描
 * 2. Float32Array 减少内存占用
 * 3. Web Worker 执行 cosine similarity，不阻塞主线程
 * 4. 回退：Worker 不可用时在主线程计算
 */

import type { MemoryNode, MemoryVector, RemoteVectorConfig } from './types';
import { MemoryNodeDB, MemoryVectorDB, ensureFloat32 } from './db';
import { cosineSimilarity } from './embedding';
import { isRemoteVectorDimensionCompatible, searchVectors as remoteSearch } from './supabaseVector';

export interface VectorSearchResult {
    node: MemoryNode;
    similarity: number;
}

/**
 * 按维度拆分候选向量（低层工具，只比维度）。
 *
 * 为什么需要：换了 embedding 模型（1024 → 本地 768）之后，库里必然有一段时间
 * 新旧向量共存。直接把 1024 维向量喂进 `cosineSimilarity` 会 throw
 * （"Vector dimension mismatch"），把用户整条检索打挂。
 *
 * ⚠️ 只按维度不够：两个恰好同维度的模型（或同模型不同前缀方案）会被判成同一个
 * 空间，相似度是纯噪声。检索路径必须用 `partitionVectorsForQuery`（带指纹），
 * 本函数只保留给尺寸相关的调用方/回归用例。
 */
export function partitionVectorsByDimension(
    vectors: MemoryVector[],
    queryDimensions: number,
): { compatible: MemoryVector[]; incompatible: MemoryVector[] } {
    const compatible: MemoryVector[] = [];
    const incompatible: MemoryVector[] = [];
    for (const vec of vectors) {
        (dimsOf(vec) === queryDimensions ? compatible : incompatible).push(vec);
    }
    return { compatible, incompatible };
}

function dimsOf(vec: MemoryVector): number {
    const declared = Number((vec as unknown as { dimensions?: number }).dimensions || 0);
    if (declared > 0) return declared;
    const raw = vec.vector as unknown;
    return Array.isArray(raw) ? raw.length : Number((raw as { length?: number })?.length || 0);
}

function storedFingerprintOf(vec: MemoryVector): string {
    const raw = (vec as unknown as { fingerprint?: unknown }).fingerprint;
    return typeof raw === 'string' ? raw.trim() : '';
}

function modelSegmentOf(fingerprint: string): string {
    const hit = fingerprint.split('|').find(part => part.startsWith('model:'));
    return hit ? hit.slice('model:'.length).trim().toLowerCase() : '';
}

/**
 * legacy（无 fingerprint）向量能不能当成本次查询的同一空间用？
 *
 * 只有一种情况可以：**云端同名同维度**。老版本的向量只写了 `model` + `dimensions`，
 * 云端路径的前缀方案固定为 none、revision 也从未记录，所以「模型名一致 + 维度一致」
 * 已经是我们能证明的最大范围。本地模型（provider:local-gemma）不在此列——它的前缀
 * 方案与 task 语义是后加的，没有指纹的旧向量无法证明是按同一规则生成的。
 */
function legacyMatchesExpectedCloud(fingerprint: string, vec: MemoryVector): boolean {
    if (!fingerprint.startsWith('provider:cloud|')) return false;
    const expectedModel = modelSegmentOf(fingerprint);
    if (!expectedModel) return false;
    const storedModel = String(vec.model || '').trim().toLowerCase();
    return !!storedModel && storedModel === expectedModel;
}

export interface VectorQueryIdentity {
    dimensions: number;
    /** 期望的向量空间指纹；缺省/空串 ⇒ 退回纯维度分区（老调用方） */
    fingerprint?: string;
}

/**
 * 按「向量空间身份」挑出可参与打分的子集。
 *
 * 规则（严格优先）：
 *   1. 维度不同 ⇒ 排除；
 *   2. 有指纹且与期望一致 ⇒ 参与；
 *   3. 有指纹但不一致 ⇒ 排除（同维度不同模型/前缀，绝不能混检）；
 *   4. 无指纹（legacy）⇒ 只有云端同名同维度才参与，其余一律排除（不能当成新模型）。
 */
export function partitionVectorsForQuery(
    vectors: MemoryVector[],
    query: VectorQueryIdentity,
): {
    compatible: MemoryVector[];
    incompatible: MemoryVector[];
    /** 被排除的 legacy（无指纹）条数 */
    legacy: number;
    /** 被排除的「有指纹但身份不一致」条数 */
    mismatchedFingerprint: number;
} {
    const expected = String(query.fingerprint || '').trim();
    const compatible: MemoryVector[] = [];
    const incompatible: MemoryVector[] = [];
    let legacy = 0;
    let mismatchedFingerprint = 0;

    for (const vec of vectors) {
        if (dimsOf(vec) !== query.dimensions) {
            incompatible.push(vec);
            continue;
        }
        if (!expected) {
            compatible.push(vec);
            continue;
        }
        const stored = storedFingerprintOf(vec);
        if (stored) {
            if (stored === expected) compatible.push(vec);
            else {
                mismatchedFingerprint++;
                incompatible.push(vec);
            }
            continue;
        }
        legacy++;
        if (legacyMatchesExpectedCloud(expected, vec)) compatible.push(vec);
        else incompatible.push(vec);
    }

    return { compatible, incompatible, legacy, mismatchedFingerprint };
}

// 身份不一致的告警只喊一次（每角色 + 每空间），避免每轮召回刷屏
const identityMismatchNotified = new Set<string>();

function notifyIdentityMismatch(
    charId: string,
    skipped: number,
    usable: number,
    query: VectorQueryIdentity,
    detail: { legacy: number; mismatchedFingerprint: number },
): void {
    const key = `${charId}:${query.fingerprint || `dim:${query.dimensions}`}`;
    if (identityMismatchNotified.has(key)) return;
    identityMismatchNotified.add(key);
    const parts: string[] = [];
    if (detail.mismatchedFingerprint > 0) parts.push(`${detail.mismatchedFingerprint} 条是另一个模型/前缀方案`);
    if (detail.legacy > 0) parts.push(`${detail.legacy} 条是旧数据（无身份指纹）`);
    console.warn(
        `🏰 [VectorSearch] ${skipped} 条向量与当前查询（${query.dimensions} 维）不是同一个向量空间，已跳过` +
        (query.fingerprint ? `【${parts.join('，')}】` : '') +
        (usable > 0
            ? `（本次只用 ${usable} 条身份一致的向量检索）`
            : '（本次向量检索结果为空，已降级为词法/关键词检索）') +
        '。请到记忆宫殿设置里「重建向量索引」以恢复完整召回',
    );
}

/** 供测试重置「只喊一次」的告警去重（生产代码不调用）。 */
export function __resetVectorIdentityNoticesForTest(): void {
    identityMismatchNotified.clear();
}

// Worker 单例（懒初始化）
let worker: Worker | null = null;
let workerFailed = false;

// 远程向量搜索会话级熔断：一旦 Supabase RPC 抛网络错误（CORS / fetch TypeError / 500
// 无 CORS 头）就关闭整个会话的远程路径，避免后续每条查询都踩一遍 CORS 然后回退本地，
// 15 次冗余加载全量向量库把 V8 typed-array arena 撕碎。
let remoteSearchBroken = false;

/** 把 worker 标记为坏掉并终止，确保不再被 getWorker() 拿到。 */
function markWorkerBroken(reason: string): void {
    if (workerFailed) return;
    console.warn(`[vectorSearch] disabling worker for this session: ${reason}`);
    workerFailed = true;
    if (worker) {
        try { worker.terminate(); } catch { /* ignore */ }
        worker = null;
    }
    // 同时清空等待中的 worker 请求，免得 Promise 挂死
    for (const resolve of workerPending.values()) resolve([]);
    workerPending.clear();
}

/** 供 relatedMemories 等上层快速判断本会话是否该跳过远程路径。 */
export function isRemoteSearchBroken(): boolean {
    return remoteSearchBroken;
}

function markRemoteBroken(reason: string): void {
    if (remoteSearchBroken) return;
    console.warn(`[vectorSearch] disabling remote search for this session: ${reason}`);
    remoteSearchBroken = true;
}

// Worker 多路复用：以 requestId 分发响应，避免并发时后一个 onmessage
// 覆盖前一个 handler、导致前面的 Promise 永挂。
const workerPending = new Map<number, (results: { memoryId: string; similarity: number }[]) => void>();
let nextWorkerRequestId = 1;

function attachWorkerHandlers(w: Worker): void {
    w.onmessage = (e: MessageEvent) => {
        const { requestId, results } = e.data || {};
        if (typeof requestId !== 'number') return;
        const resolve = workerPending.get(requestId);
        if (resolve) {
            workerPending.delete(requestId);
            resolve(results || []);
        }
    };
    w.onerror = () => markWorkerBroken('worker.onerror fired');
}

function getWorker(): Worker | null {
    if (workerFailed) return null;
    if (worker) return worker;
    try {
        worker = new Worker(
            new URL('./vectorSearchWorker.ts', import.meta.url),
            { type: 'module' }
        );
        attachWorkerHandlers(worker);
        return worker;
    } catch {
        workerFailed = true;
        return null;
    }
}

/**
 * 向量搜索：在指定角色的所有已向量化记忆中搜索
 *
 * @param queryVector 查询向量（已向量化）
 * @param charId 角色 ID
 * @param threshold 相似度阈值，默认 0.3
 * @param topK 返回最多 topK 条，默认 20
 * @param remoteConfig 远程向量存储配置（可选，有配置时优先走远程）
 */
export async function vectorSearch(
    queryVector: number[] | Float32Array,
    charId: string,
    threshold: number = 0.3,
    topK: number = 20,
    remoteConfig?: RemoteVectorConfig,
    /**
     * 可选：预取好的向量列表（角色全量）。
     * 同次 retrieve 内多路并行检索时，上游预取一次传下来避免 K 次 getAllByCharId。
     * 远程路径不消费这个字段。
     */
    prefetchedVectors?: MemoryVector[],
    /**
     * 期望的向量空间指纹（provider|model|revision|dim|prefix|norm）。
     * 传了就按指纹严格隔离；不传（老调用方）退回维度分区，但仍不做跨维混算。
     */
    queryFingerprint?: string,
): Promise<VectorSearchResult[]> {
    // ─── 远程路径：Supabase pgvector ─────────────────
    // 注意：远程 RPC 已内置 archived=false 过滤
    // 远端表是 vector(1024)（schema v1）：查询向量不是 1024 维时不能发过去。
    // 这不是「远程坏了」，所以不熔断；直接走本地路径，由本地降级策略决定怎么检索。
    if (remoteConfig?.enabled && remoteConfig.initialized && !remoteSearchBroken
        && isRemoteVectorDimensionCompatible(queryVector.length)) {
        try {
            const remoteResults = await remoteSearch(remoteConfig, queryVector, charId, threshold, topK);
            if (remoteResults.length > 0) {
                // 远程结果已包含内容，构建轻量 MemoryNode（带 EventBox 字段 + Russell 情感 + 置顶 + 衍生来源）
                return remoteResults.map(r => ({
                    node: {
                        id: r.memoryId,
                        charId,
                        content: r.content,
                        room: r.room as any,
                        tags: r.tags,
                        importance: r.importance,
                        mood: r.mood,
                        valence: r.valence ?? undefined,
                        arousal: r.arousal ?? undefined,
                        embedded: true,
                        createdAt: r.createdAt || Date.now(),
                        lastAccessedAt: r.lastAccessedAt || r.createdAt || Date.now(),
                        accessCount: r.accessCount || 0,
                        pinnedUntil: r.pinnedUntil,
                        sourceId: r.sourceId,
                        origin: (r.origin as any) ?? undefined,
                        eventBoxId: r.eventBoxId,
                        archived: r.archived,
                        isBoxSummary: r.isSummary,
                    },
                    similarity: r.similarity,
                }));
            }
            // 远程正常但这次没命中：直接返回空，不要再跑一遍本地（避免双倍耗时）。
            return [];
        } catch (e: any) {
            // 远程坏了（CORS / 500 无 CORS 头 / DNS 等网络错）：熔断整个会话的远程路径
            const msg = e?.message || String(e);
            markRemoteBroken(msg);
            // 本次查询回退到本地
        }
    }

    // ─── 本地路径：IndexedDB + Worker ────────────────
    const allVectors = prefetchedVectors ?? await MemoryVectorDB.getAllByCharId(charId);
    if (allVectors.length === 0) return [];

    // 新旧向量共存期：只喂「身份一致」的子集打分（维度 + 指纹；legacy 不能当新模型），
    // 其余计数并提示重建。一条都不剩 ⇒ 返回空，hybridSearch 自然融合成纯 BM25。
    const identity: VectorQueryIdentity = { dimensions: queryVector.length, fingerprint: queryFingerprint };
    const { compatible, incompatible, legacy, mismatchedFingerprint } = partitionVectorsForQuery(allVectors, identity);
    if (incompatible.length > 0) {
        notifyIdentityMismatch(charId, incompatible.length, compatible.length, identity, { legacy, mismatchedFingerprint });
    }
    if (compatible.length === 0) return [];
    const vectors = compatible;

    // 尝试使用 Worker 计算
    let scored: { memoryId: string; similarity: number }[];
    const w = getWorker();

    if (w) {
        // 当 vectors 来自 prefetch 时，同一份数组会被 K 路 vectorSearch 并发
        // 消费；Transfer list 会 neuter 首个调用的 buffer，后续调用读到全 0
        // 静默返空。这种情况下禁止把候选向量 buffer 列入 transfer list，
        // 改走 postMessage 的 structured clone（内部 memcpy）。query 向量
        // 是单路独占，始终可以 transfer。
        const canTransferCandidates = !prefetchedVectors;
        scored = await runInWorker(w, queryVector, vectors, threshold, topK, canTransferCandidates);
    } else {
        scored = mainThreadSearch(queryVector, vectors, threshold, topK);
    }

    // 加载对应的 MemoryNode（过滤 archived 节点）
    //
    // 性能：原来是 for-await 串行 getById，30 条候选 × 每次一个 IDB 事务
    // ≈ 300–900ms。改成 Promise.all 让所有 get 并发入队，浏览器可以在
    // 同一个事件循环内把它们调度到 IDB，主线程等待从 O(N) 降到 O(1)。
    // 顺序通过 map 的 index 天然保留，过滤 archived 后仍是 similarity 降序。
    const nodes = await Promise.all(scored.map(item => MemoryNodeDB.getById(item.memoryId)));
    const results: VectorSearchResult[] = [];
    for (let i = 0; i < scored.length; i++) {
        const node = nodes[i];
        if (node && !node.archived) {
            results.push({ node, similarity: scored[i].similarity });
        }
    }

    return results;
}

/** Worker 通信 — 支持并发多路复用（用 requestId 区分响应） */
function runInWorker(
    w: Worker,
    queryVector: number[] | Float32Array | Uint8Array,
    vectors: { memoryId: string; vector: number[] | Float32Array | Uint8Array }[],
    threshold: number,
    topK: number,
    canTransferCandidates: boolean = true,
): Promise<{ memoryId: string; similarity: number }[]> {
    return new Promise((resolve) => {
        // 全部归一到 Float32Array，准备走 transfer list 零拷贝。
        // 注意：transfer 后主线程这些 buffer 会被 neuter，所以 timeout 兜底
        // 不能再用 mainThreadSearch（会读到全 0 buffer 静默返空）。
        // 策略：超时时 resolve([]) 让当次查询退化成 BM25-only，同时把 worker
        // 标记为坏掉 —— 下一次 vectorSearch 在 getWorker() 处拿到 null，
        // 走主线程正确路径（无 transfer，无 neuter）。这样单次 worker 故障
        // 不会变成"永远静默少结果"的长期状态。
        // ensureFloat32 兼容三种存储形态（number[] / Float32Array / Uint8Array）。
        // 即使上游 DB 改了存储格式也不会因为 `new Float32Array(uint8)` 把字节
        // 当成 number 误读出 4× 长的错误向量。
        const qv = ensureFloat32(queryVector);
        const fvs = vectors.map(v => ({
            memoryId: v.memoryId,
            vector: ensureFloat32(v.vector),
        }));

        const requestId = nextWorkerRequestId++;
        const timeout = setTimeout(() => {
            if (!workerPending.has(requestId)) return; // 已完成
            workerPending.delete(requestId);
            markWorkerBroken('timeout 10s — buffers neutered, cannot run mainThreadSearch on this call; subsequent calls will use main thread');
            resolve([]);
        }, 10000);

        workerPending.set(requestId, (results) => {
            clearTimeout(timeout);
            resolve(results);
        });

        // Transfer list：query 向量是本次调用独占的一次性 buffer，始终 transfer。
        // 候选向量仅在上游确认它们不会被并发复用时才 transfer——否则 K 路并发
        // vectorSearch 共享同一份 prefetched 向量数组时，首个 transfer 会 neuter
        // buffer 让后续路径读到全 0 静默返空。
        const transfers: Transferable[] = [qv.buffer];
        if (canTransferCandidates) {
            for (const v of fvs) transfers.push((v.vector as Float32Array).buffer);
        }
        try {
            w.postMessage({ requestId, queryVector: qv, vectors: fvs, threshold, topK }, transfers);
        } catch (e: any) {
            clearTimeout(timeout);
            workerPending.delete(requestId);
            markWorkerBroken(`postMessage failed: ${e?.message || e}`);
            resolve([]);
        }
    });
}

/** 主线程回退计算 */
function mainThreadSearch(
    queryVector: number[] | Float32Array | Uint8Array,
    vectors: { memoryId: string; vector: number[] | Float32Array | Uint8Array }[],
    threshold: number,
    topK: number,
): { memoryId: string; similarity: number }[] {
    const scored: { memoryId: string; similarity: number }[] = [];

    const qv = ensureFloat32(queryVector);
    for (const vec of vectors) {
        const sim = cosineSimilarity(qv, ensureFloat32(vec.vector));
        if (sim >= threshold) {
            scored.push({ memoryId: vec.memoryId, similarity: sim });
        }
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
}
