// features/friend-feed/controller.ts
// Bibi 可复用控制层：同一提交协议同时服务隔离 preview 与未来生产入口。
// redesign-v1 写能力规则（保护旧数据优先）：
// - 所有变更走 commit()：在真实跨文档锁（Web Locks 或显式注入的共享锁）覆盖的
//   临界区内完成 fresh-read → 严格校验 → mutation → save → 成功确认整个区间；
// - 锁内重读最新快照后直接应用变更，不做过期基线的三方合并、不报假成功；
// - 无安全写能力时（无 Web Locks 且无注入锁）拒绝一切写入，且在任何图片上传、
//   持久化、草稿清空之前拒绝；读（load/提醒/导出）不受影响；
// - 异步 get+set 永不视为 CAS；realm 内私用队列、租约/时间戳一律不冒充
//   跨文档保护，本文件不含这类回退、不触碰任何 Web 存储。
// 图片所有权规则（保守回收）：
// - 正式删帖只移除 feed 引用，不物理删除任何已发布/导入图片（含看似独占的），
//   留给已有全局 GC 判断；本模块不新增引用扫描 GC；
// - 失败批次仅在图片端口能证明 ref 系本批新建、未提交、独占时才回滚清理
//   （discardUncommitted）；无法证明的一律保留，不因清理半批误删存活图。
// 零 LLM 调用：全链路只有本地 JSON 与 Blob 读写。
import { MAX_IMAGES_PER_POST, MAX_POSTS } from './limits.js';
import type { FriendFeedIdentity, FriendFeedPost, FriendFeedState } from './types.js';
import {
    addComment as opAddComment,
    createPost as opCreatePost,
    createState,
    deletePost as opDeletePost,
    deserialize,
    getUnread as opGetUnread,
    markPostSeen as opMarkPostSeen,
    serialize,
    toggleLike as opToggleLike,
    type StringStoragePort,
} from './store.js';
import { cleanSnapshot } from './archive.js';
import { validateImageFile, validatePostText } from './validation.js';

/** 图片仓最小读写面：生产接 blob_assets，preview 接本地图片仓，单测用内存实现。 */
export interface ImageStorePort {
    saveImage: (file: Blob & { name: string }) => Promise<string>;
    loadImage: (ref: string) => Promise<Blob | null>;
    /**
     * 回滚本批新建、未提交、独占的图片（仅失败上传路径调用）。
     * 端口必须能证明待删 ref 系本批 saveImage 新建、从未进入任何已提交快照；
     * 无法证明（例如内容寻址去重、共享 Blob 池）时必须保留（直接返回），
     * 残留孤儿交已有全局 GC 处理。正式删帖永不经此删除已发布图片。
     */
    discardUncommitted?: (refs: string[]) => Promise<void>;
}

/** 文本端口的可选能力：资源键（锁粒度）与锁内复核用的乐观 CAS。 */
export interface CasTextPort extends StringStoragePort {
    /** 同一底层存档共享同一键；缺省全部归入模块默认键。 */
    resourceKey?: string;
    /**
     * 锁内复核优化：当前值与 expected 不一致时返回 false（不写入）。
     * 跨文档安全完全由 WriteLockProvider 保证；异步 get+set 永不视为 CAS，
     * 调用方不得仅凭本方法声称原子提交。
     */
    compareAndSet?: (expected: string | null, next: string) => Promise<boolean>;
}

/**
 * 真实跨文档写锁：同一 key 的临界区在多文档/多标签/多 realm 间互斥。
 * 生产与 preview 使用 Web Locks；单测显式传入同一共享对象模拟。
 */
export interface WriteLockProvider {
    withLock: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
}

/** 无安全写能力时的拒绝错误：调用方（UI）应显示只读提示，保留草稿与旧数据。 */
export class NoSafeWriteError extends Error {
    constructor() {
        super('当前环境没有跨文档写保护，已进入只读模式：可查看与导出，写入已禁用以保护旧数据');
        this.name = 'NoSafeWriteError';
    }
}

const DEFAULT_RESOURCE_KEY = 'bibi-friend-feed/snapshot';
const MAX_COMMIT_ATTEMPTS = 8;

/** 单测/内存图片仓：存真实 Blob 二进制（非 base64 字符串），按原样取回。 */
export function makeMemoryImagePort() {
    const kept = new Map<string, Blob>();
    let n = 0;
    let saves = 0;
    const port: ImageStorePort = {
        saveImage: async (f) => {
            saves += 1;
            n += 1;
            // ref 每次新建唯一且不可猜测：未提交前不可能被其他写入者引用，
            // 故 discardUncommitted 删除本批 ref 即为独占回滚。
            const ref = `blobref:mem_${n}`;
            kept.set(ref, f);
            return ref;
        },
        loadImage: async (ref) => kept.get(ref) ?? null,
        discardUncommitted: async (refs) => {
            for (const r of refs) kept.delete(r);
        },
    };
    return { port, saveCount: () => saves, has: (ref: string) => kept.has(ref) };
}

/**
 * 单测用共享锁：同一对象显式传给各控制器（可跨 vm realm 共享），
 * 同一 key 串行，不同 key 并行。生产请用 Web Locks，不要用本函数冒充。
 */
export function makeSharedTestLock(): WriteLockProvider {
    const tails = new Map<string, Promise<void>>();
    return {
        withLock: async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
            const prev = tails.get(key) ?? Promise.resolve();
            let release!: () => void;
            const turn = new Promise<void>((r) => {
                release = r;
            });
            tails.set(key, prev.then(() => turn));
            await prev;
            try {
                return await fn();
            } finally {
                release();
            }
        },
    };
}

function webLocksProvider(): WriteLockProvider | null {
    const nav = (globalThis as { navigator?: { locks?: { request: <T>(name: string, fn: () => Promise<T>) => Promise<T> } } })
        .navigator;
    if (nav?.locks?.request) {
        const request = nav.locks.request.bind(nav.locks);
        return { withLock: (key, fn) => request(key, fn) };
    }
    return null;
}

/** 落盘前统一校验：与读取端同一严格 schema + 容量上界；非法直接抛错、不落盘。 */
function assertWritable(next: FriendFeedState): void {
    cleanSnapshot(JSON.parse(serialize(next)));
}

export class FeedController {
    private memory: FriendFeedState = createState();
    private loadErr: Error | null = null;
    private ready = false;
    private readonly locks: WriteLockProvider | null;

    /**
     * @param locks 显式写锁（单测传入共享对象）；null 强制只读；
     *   缺省自动探测 Web Locks，有则用、无则只读。绝不回退到 realm 内队列。
     */
    constructor(
        private readonly textPort: StringStoragePort,
        private readonly imagePort: ImageStorePort,
        locks?: WriteLockProvider | null,
    ) {
        this.locks = locks === undefined ? webLocksProvider() : locks;
    }

    get state(): FriendFeedState {
        return this.memory;
    }

    get loadedOk(): boolean {
        return this.ready && this.loadErr === null;
    }

    get loadError(): Error | null {
        return this.loadErr;
    }

    /** 有真实跨文档写能力时为 true；false 时一切变更方法抛 NoSafeWriteError。 */
    get writable(): boolean {
        return this.locks !== null;
    }

    get images(): ImageStorePort {
        return this.imagePort;
    }

    private ensureWritable(): void {
        if (!this.locks) throw new NoSafeWriteError();
    }

    /** 读取远端快照进内存。损坏时 loadedOk=false 且内存保持旧态，绝不反写。 */
    async load(): Promise<FriendFeedState> {
        try {
            const raw = await this.textPort.load();
            this.memory = raw === null || raw === '' ? createState() : deserialize(raw);
            this.loadErr = null;
            this.ready = true;
            return this.memory;
        } catch (e) {
            this.loadErr = e instanceof Error ? e : new Error(String(e));
            this.ready = true;
            throw this.loadErr;
        }
    }

    /**
     * 核心提交：在跨文档锁临界区内重读远端→应用变更→严格校验→落盘。
     * CAS 端口在锁内做复核，冲突时重读重试；重试耗尽、坏档保护或无写能力时
     * 抛错（绝不报成功，远端旧字节不动）。
     */
    async commit(mutator: (base: FriendFeedState) => FriendFeedState): Promise<FriendFeedState> {
        if (!this.loadedOk) {
            throw new Error(`存档损坏已保护：拒绝写入（${this.loadErr?.message ?? '未加载'}），请先恢复备份`);
        }
        this.ensureWritable();
        const casPort = this.textPort as CasTextPort;
        const key = casPort.resourceKey ?? DEFAULT_RESOURCE_KEY;
        return (this.locks as WriteLockProvider).withLock(key, async () => {
            const attempts = casPort.compareAndSet ? MAX_COMMIT_ATTEMPTS : 1;
            let conflict: Error | null = null;
            for (let i = 0; i < attempts; i++) {
                const raw = await this.textPort.load();
                const latest = raw === null || raw === '' ? createState() : deserialize(raw);
                const mutated = mutator(latest);
                const next: FriendFeedState = { ...mutated, version: 1, rev: latest.rev + 1 };
                assertWritable(next);
                const nextRaw = serialize(next);
                if (casPort.compareAndSet) {
                    if (await casPort.compareAndSet(raw, nextRaw)) {
                        this.memory = next;
                        return next;
                    }
                    conflict = new Error('并发写入冲突，已自动重试');
                    continue;
                }
                await this.textPort.save(nextRaw);
                this.memory = next;
                return next;
            }
            throw conflict ?? new Error('提交失败：并发冲突，请重试');
        });
    }

    /** 发帖：写能力预检→容量预检→文本/数量/类型/体积全验→入库→提交；任一步失败都不动远端。 */
    async submitPost(author: FriendFeedIdentity, text: string, files: ReadonlyArray<Blob & { name: string }>): Promise<FriendFeedPost> {
        // 写能力必须在任何图片上传之前确认：无能力时 0 上传、草稿由调用方保留。
        this.ensureWritable();
        const textCheck = validatePostText(text);
        if (!textCheck.ok) throw new Error(textCheck.error);
        if (files.length > MAX_IMAGES_PER_POST) throw new Error(`图片最多 ${MAX_IMAGES_PER_POST} 张`);
        for (const f of files) {
            const c = validateImageFile({ name: f.name, type: f.type, size: f.size });
            if (!c.ok) throw new Error(c.error);
        }
        // 容量预检（最终以 commit 内 assertWritable 为准，此处避免先传大图再被拒）。
        const curRaw = await this.textPort.load();
        const cur = curRaw === null || curRaw === '' ? createState() : deserialize(curRaw);
        if (cur.posts.length >= MAX_POSTS) {
            throw new Error(`动态已达上限（${MAX_POSTS} 条），请删除旧动态后再发布`);
        }
        const refs: string[] = [];
        try {
            for (const f of files) {
                refs.push(await this.imagePort.saveImage(f));
            }
        } catch (e) {
            // 本批新建未提交：只有端口能证明独占时才回滚，否则保留交 GC。
            try {
                await this.imagePort.discardUncommitted?.(refs);
            } catch {
                /* 回滚失败则保留，不影响错误本身 */
            }
            throw e;
        }
        let created!: FriendFeedPost;
        try {
            await this.commit((base) => {
                const r = opCreatePost(base, { author, text, imageRefs: refs });
                created = r.post;
                return r.state;
            });
        } catch (e) {
            try {
                await this.imagePort.discardUncommitted?.(refs);
            } catch {
                /* 回滚失败则保留，不影响错误本身 */
            }
            throw e;
        }
        return created;
    }

    async addComment(postId: string, author: FriendFeedIdentity, text: string): Promise<FriendFeedState> {
        return this.commit((base) => opAddComment(base, postId, author, text));
    }

    async toggleLike(postId: string): Promise<FriendFeedState> {
        return this.commit((base) => opToggleLike(base, postId));
    }

    /**
     * 删除：仅作者可删。只移除 feed 引用，被删帖的图片引用原样保留
     * （含看似独占的），由已有全局 GC 后续判断；绝不物理删除。
     * 返回 removedImageRefs 仅供调用方展示/审计，不得据此删除 Blob。
     */
    async deletePost(postId: string, requesterId: string): Promise<{ state: FriendFeedState; removedImageRefs: string[] }> {
        let removed: string[] = [];
        const next = await this.commit((base) => {
            const r = opDeletePost(base, postId, requesterId);
            removed = r.removedImageRefs;
            return r.state;
        });
        return { state: next, removedImageRefs: removed };
    }

    /** 显式已读：只能由查看动作调用，禁止在收到他人评论时自动推进水位。 */
    async markPostRead(postId: string, now?: number): Promise<FriendFeedState> {
        return this.commit((base) => opMarkPostSeen(base, postId, now));
    }

    getUnread(myId: string): { count: number; postIds: string[] } {
        return opGetUnread(this.memory, myId);
    }
}
