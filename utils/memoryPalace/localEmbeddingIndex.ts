/**
 * 本地向量索引的「身份」与迁移状态机
 *
 * 背景（现状）：换 embedding 模型时，管线只比对模型名，然后**自动全量重建**该角色的
 * 所有向量。对本地 768 维模型来说这条路有两个致命问题：
 *   1. 维度从 1024 变 768，自动重建会先把用户真实索引整片重编码，中途关页面就半新半旧；
 *   2. 只要有一条旧向量没重编码，`cosineSimilarity` 在长度不等时直接 throw，检索报错。
 *
 * 这里改成显式迁移：
 *   - 身份指纹（模型/revision/维度/前缀/归一化）不一致 ⇒ 状态 `pending_rebuild`，**不动数据**；
 *   - 检索只消费身份一致的向量子集（数量为 0 时全量降级词法）并给出提示；
 *   - 重建由用户显式开始，可中断（cancel）、可恢复（cursor）、逐条落库，失败保留旧向量；
 *   - 从不删除节点或向量（本模块不提供任何 delete 调用）。
 */

import type { MemoryVector } from './types';

export type IndexState = 'ready' | 'pending_rebuild' | 'rebuilding' | 'cancelled' | 'failed';

export interface LocalIndexStatus {
    charId: string;
    state: IndexState;
    expectedFingerprint: string;
    expectedDimensions: number;
    /** 该角色向量总数（最近一次 survey/rebuild 时的快照） */
    total: number;
    done: number;
    failed: number;
    /** 已跳过（身份不一致）的旧向量条数 */
    skipped: number;
    /** 断点：已完成到第几条（恢复时从这里继续） */
    cursor: number;
    startedAt?: number;
    updatedAt: number;
    lastError?: string;
    /** 给用户看的一句话（待重建原因 / 进度） */
    notice?: string;
}

export function newIndexStatus(charId: string, expectedFingerprint: string, expectedDimensions: number): LocalIndexStatus {
    return {
        charId,
        state: 'ready',
        expectedFingerprint,
        expectedDimensions,
        total: 0,
        done: 0,
        failed: 0,
        skipped: 0,
        cursor: 0,
        updatedAt: 0,
    };
}

export interface VectorIndexSurvey {
    total: number;
    /** 指纹与维度都与期望一致的条数 */
    matches: number;
    mismatches: number;
    /** 老数据：没有 fingerprint 字段（我们无法证明它属于当前空间） */
    legacy: number;
    byFingerprint: Record<string, number>;
    byDimensions: Record<string, number>;
}

const STORAGE_KEY = 'mp_local_index_status_v1';

interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

function defaultStorage(): StorageLike | null {
    try {
        if (typeof localStorage === 'undefined') return null;
        return localStorage;
    } catch {
        return null; // SSR / 隐私模式
    }
}

/** 状态存储（按 charId 一条记录）。storage 可注入，便于测试与内存态回退。 */
export class IndexStatusStore {
    private storage: StorageLike | null;
    private memory = new Map<string, LocalIndexStatus>();
    private persistEnabled: boolean;

    constructor(storage?: StorageLike | null) {
        this.storage = storage === undefined ? defaultStorage() : storage;
        this.persistEnabled = !!this.storage;
    }

    private readAll(): Record<string, LocalIndexStatus> {
        if (!this.persistEnabled || !this.storage) {
            return Object.fromEntries(this.memory);
        }
        try {
            const raw = this.storage.getItem(STORAGE_KEY);
            const parsed = raw ? JSON.parse(raw) : {};
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            return {};
        }
    }

    get(charId: string): LocalIndexStatus | undefined {
        const all = this.readAll();
        return all[charId] ?? this.memory.get(charId);
    }

    set(charId: string, status: LocalIndexStatus): void {
        this.memory.set(charId, status);
        if (!this.persistEnabled || !this.storage) return;
        try {
            const all = this.readAll();
            all[charId] = status;
            this.storage.setItem(STORAGE_KEY, JSON.stringify(all));
        } catch {
            // 配额/隐私模式：内存态仍然有效，不阻塞重建
        }
    }

    clear(charId: string): void {
        this.memory.delete(charId);
        if (!this.persistEnabled || !this.storage) return;
        try {
            const all = this.readAll();
            delete all[charId];
            this.storage.setItem(STORAGE_KEY, JSON.stringify(all));
        } catch { /* ignore */ }
    }
}

function fingerprintOf(vec: MemoryVector): string | undefined {
    return typeof vec.fingerprint === 'string' && vec.fingerprint ? vec.fingerprint : undefined;
}

function dimsOf(vec: MemoryVector): number {
    const raw = vec as unknown as { dimensions?: number };
    const declared = Number(raw.dimensions || 0);
    if (declared > 0) return declared;
    const v = vec.vector as unknown;
    if (Array.isArray(v)) return v.length;
    const len = (v as { length?: number })?.length;
    return Number(len || 0);
}

/** 统计该角色向量索引的身份分布（不改数据）。 */
export function surveyVectorIndex(
    vectors: MemoryVector[],
    expectedFingerprint: string,
    expectedDimensions: number,
): VectorIndexSurvey {
    const survey: VectorIndexSurvey = {
        total: vectors.length,
        matches: 0,
        mismatches: 0,
        legacy: 0,
        byFingerprint: {},
        byDimensions: {},
    };
    for (const vec of vectors) {
        const fp = fingerprintOf(vec);
        const dims = dimsOf(vec);
        survey.byDimensions[String(dims)] = (survey.byDimensions[String(dims)] || 0) + 1;
        if (!fp) {
            survey.legacy++;
            survey.mismatches++;
            survey.byFingerprint.legacy = (survey.byFingerprint.legacy || 0) + 1;
            continue;
        }
        survey.byFingerprint[fp] = (survey.byFingerprint[fp] || 0) + 1;
        if (fp === expectedFingerprint && dims === expectedDimensions) {
            survey.matches++;
        } else {
            survey.mismatches++;
        }
    }
    return survey;
}

export type VectorUsageReason = 'ready' | 'partial' | 'pending_rebuild' | 'empty';

export interface VectorUsageDecision {
    useVectors: boolean;
    reason: VectorUsageReason;
    compatibleCount: number;
    skippedCount: number;
    notice?: string;
}

/**
 * 决定这次检索能不能用向量、能用多少。
 * 原则：只用身份一致的子集；一条都不剩就降级词法，并且**明确告诉用户为什么**。
 */
export function decideVectorUsage(survey: VectorIndexSurvey): VectorUsageDecision {
    if (survey.total === 0) {
        return { useVectors: false, reason: 'empty', compatibleCount: 0, skippedCount: 0 };
    }
    if (survey.mismatches === 0) {
        return { useVectors: true, reason: 'ready', compatibleCount: survey.matches, skippedCount: 0 };
    }
    if (survey.matches > 0) {
        return {
            useVectors: true,
            reason: 'partial',
            compatibleCount: survey.matches,
            skippedCount: survey.mismatches,
            notice:
                `记忆宫殿：有 ${survey.mismatches} 条旧向量与当前 embedding 身份不一致，本次已跳过（只用 ${survey.matches} 条一致向量）。` +
                `请到设置里「重建向量索引」后恢复完整检索`,
        };
    }
    return {
        useVectors: false,
        reason: 'pending_rebuild',
        compatibleCount: 0,
        skippedCount: survey.mismatches,
        notice:
            `记忆宫殿：本地 embedding 与已有 ${survey.mismatches} 条向量不是同一个向量空间，` +
            `本次检索已降级为词法/关键词匹配（不影响记忆读写）。请到设置里显式「重建向量索引」`,
    };
}

export function describeIndexStatus(status: LocalIndexStatus | undefined): string {
    if (!status) return '向量索引身份未知（尚未检查）';
    switch (status.state) {
        case 'ready':
            return status.total > 0 ? `向量索引就绪（${status.total} 条）` : '暂无向量（新记忆会按当前模型生成）';
        case 'pending_rebuild':
            return `待重建：${status.total} 条旧向量与当前 embedding 身份不一致，检索暂用词法`;
        case 'rebuilding':
            return `重建中 ${status.done}/${status.total}${status.failed ? `（失败 ${status.failed}）` : ''}`;
        case 'cancelled':
            return `重建已取消，进度 ${status.done}/${status.total}（可继续）`;
        case 'failed':
            return `重建中断：${status.done}/${status.total} 完成，${status.failed} 条失败${status.lastError ? `（${status.lastError}）` : ''}`;
        default:
            return '向量索引身份未知';
    }
}

export interface CheckIndexIdentityArgs {
    charId: string;
    expectedFingerprint: string;
    expectedDimensions: number;
    vectors: MemoryVector[];
    store: IndexStatusStore;
    now?: number;
}

/**
 * 换身份后**只标记**待重建，绝不在这里触发重建。
 * 返回 status：ready / pending_rebuild / empty。
 */
export async function checkIndexIdentity(
    args: CheckIndexIdentityArgs,
): Promise<{ status: 'ready' | 'pending_rebuild' | 'empty'; survey: VectorIndexSurvey; decision: VectorUsageDecision }> {
    const now = args.now ?? Date.now();
    const survey = surveyVectorIndex(args.vectors, args.expectedFingerprint, args.expectedDimensions);
    const decision = decideVectorUsage(survey);
    const previous = args.store.get(args.charId);

    const base: LocalIndexStatus = {
        ...newIndexStatus(args.charId, args.expectedFingerprint, args.expectedDimensions),
        ...(previous && previous.expectedFingerprint === args.expectedFingerprint ? previous : {}),
        charId: args.charId,
        expectedFingerprint: args.expectedFingerprint,
        expectedDimensions: args.expectedDimensions,
        total: survey.total,
        skipped: survey.mismatches,
        updatedAt: now,
    };

    if (survey.total === 0) {
        args.store.set(args.charId, { ...base, state: 'ready', done: 0, notice: undefined });
        return { status: 'empty', survey, decision };
    }

    if (survey.mismatches === 0) {
        args.store.set(args.charId, { ...base, state: 'ready', done: survey.matches, notice: undefined });
        return { status: 'ready', survey, decision };
    }

    // 正在跑的重建不要被一次 survey 打回 pending（否则进度条会自己跳回去）
    if (previous?.state === 'rebuilding' && previous.expectedFingerprint === args.expectedFingerprint) {
        return { status: 'pending_rebuild', survey, decision };
    }

    args.store.set(args.charId, {
        ...base,
        state: 'pending_rebuild',
        done: survey.matches,
        notice: decision.notice,
    });
    return { status: 'pending_rebuild', survey, decision };
}

export interface RebuildDeps {
    /** 该角色全部已向量化的节点（按稳定顺序） */
    listNodes: (charId: string) => Promise<{ id: string; content: string }[]>;
    /** 文档侧向量化（必须是 task=document） */
    embed: (texts: string[]) => Promise<Float32Array[]>;
    /** 写回单条向量 + 指纹 + 实际维度（不删除任何东西） */
    save: (node: { id: string; content: string }, vector: Float32Array, fingerprint: string, dimensions: number) => Promise<void>;
    now?: () => number;
}

export interface RunIndexRebuildArgs {
    charId: string;
    expectedFingerprint: string;
    expectedDimensions: number;
    store: IndexStatusStore;
    deps: RebuildDeps;
    batchSize?: number;
    signal?: AbortSignal;
    /** 从上次 cursor 继续（cancelled/failed/pending_rebuild 均适用） */
    resume?: boolean;
    onProgress?: (status: LocalIndexStatus) => void;
}

/**
 * 显式重建：逐批向量化并落库。
 * - 取消：检查 signal，状态置 cancelled，cursor 保留；
 * - 失败：单条失败只计 failed，其余继续，最后状态 failed（可恢复）；
 * - 恢复：resume=true 时跳过已完成的前 cursor 条，不重编码。
 */
export async function runIndexRebuild(args: RunIndexRebuildArgs): Promise<LocalIndexStatus> {
    const now = args.deps.now ?? Date.now;
    const batchSize = Math.max(1, args.batchSize ?? 5);
    const previous = args.store.get(args.charId);
    const canResume = args.resume
        && !!previous
        && previous.expectedFingerprint === args.expectedFingerprint
        && ['cancelled', 'failed', 'pending_rebuild'].includes(previous.state);

    const nodes = await args.deps.listNodes(args.charId);
    const total = nodes.length;

    let status: LocalIndexStatus = {
        ...newIndexStatus(args.charId, args.expectedFingerprint, args.expectedDimensions),
        total,
        state: 'rebuilding',
        cursor: canResume ? Math.min(previous!.cursor, total) : 0,
        done: canResume ? Math.min(previous!.done, total) : 0,
        failed: canResume ? previous!.failed : 0,
        startedAt: canResume ? previous!.startedAt : now(),
        updatedAt: now(),
        notice: undefined,
        lastError: undefined,
    };
    args.store.set(args.charId, status);
    args.onProgress?.(status);

    let cancelled = false;
    while (status.cursor < total) {
        if (args.signal?.aborted) { cancelled = true; break; }

        const batch = nodes.slice(status.cursor, Math.min(status.cursor + batchSize, total));
        let vectors: Float32Array[] = [];
        try {
            vectors = await args.deps.embed(batch.map(node => node.content));
            if (vectors.length !== batch.length) {
                throw new Error(`向量化返回 ${vectors.length} 条，期望 ${batch.length} 条`);
            }
        } catch (err: any) {
            // 整批失败：不推进 cursor，让用户重试/恢复；旧向量全部保留
            status = {
                ...status,
                state: 'failed',
                failed: status.failed + batch.length,
                lastError: err?.message || String(err),
                updatedAt: now(),
            };
            args.store.set(args.charId, status);
            args.onProgress?.(status);
            return status;
        }

        for (let i = 0; i < batch.length; i++) {
            if (args.signal?.aborted) { cancelled = true; break; }
            try {
                await args.deps.save(batch[i], vectors[i], args.expectedFingerprint, args.expectedDimensions);
                status.done++;
            } catch (err: any) {
                status.failed++;
                status.lastError = err?.message || String(err);
            }
            status.cursor++;
        }

        status.updatedAt = now();
        args.store.set(args.charId, status);
        args.onProgress?.(status);
        if (cancelled) break;
    }

    status = {
        ...status,
        state: cancelled ? 'cancelled' : (status.failed > 0 ? 'failed' : 'ready'),
        updatedAt: now(),
    };
    args.store.set(args.charId, status);
    args.onProgress?.(status);
    return status;
}
