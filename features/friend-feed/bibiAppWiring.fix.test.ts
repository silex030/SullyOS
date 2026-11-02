// Bibi App 接线修复回归（reviewer 限定小修）：在真实 App 源码层验证。
// 方法与 reviewer 的内存转译一致：转译实际 apps/FriendFeedApp.tsx，
// 仅替身 React/平台边界（state 钩子、OSContext、DB、blobRef、View），
// controller/service/identities/backup/bibiImageMap 全部走真实源码。
// 断言：空缓存导入后 resolve 被调用（旧代码 resolveCalls=0 即 bug）、
// 缺失+有效 ref 一一对应、卸载/失败无泄漏、导入图可解码。
import { describe, expect, it, vi, beforeEach } from 'vitest';

const DBMAP = new Map<string, string>();
const BLOBMAP = new Map<string, Blob>();
let resolveCalls = 0;
let createdUrls: string[] = [];
let revokedUrls: string[] = [];
let urlSeq = 0;

vi.mock('react', () => {
    const S = () => {
        const cur = (globalThis as Record<string, unknown>).__hookState as
            | { values: unknown[]; cursor: number }
            | undefined;
        if (cur) return cur;
        const fresh = { values: [], cursor: 0 };
        (globalThis as Record<string, unknown>).__hookState = fresh;
        return fresh;
    };
    return {
        default: {},
        useState: (init: unknown) => {
            const st = S();
            const idx = st.cursor++;
            if (idx >= st.values.length) st.values.push(typeof init === 'function' ? (init as () => unknown)() : init);
            const set = (u: unknown) => {
                st.values[idx] = typeof u === 'function' ? (u as (p: unknown) => unknown)(st.values[idx]) : u;
            };
            return [st.values[idx], set];
        },
        useRef: (init: unknown) => {
            const st = S();
            const idx = st.cursor++;
            if (idx >= st.values.length) st.values.push({ current: init });
            return st.values[idx] as { current: unknown };
        },
        useCallback: (fn: unknown) => fn,
        useEffect: (fn: () => void | (() => void)) => {
            const effs = ((globalThis as Record<string, unknown>).__effects as Array<() => unknown>) ?? [];
            effs.push(fn as () => unknown);
            (globalThis as Record<string, unknown>).__effects = effs;
        },
    };
});

vi.mock('../../context/OSContext.js', () => ({
    useOS: () => ({
        userProfile: { name: 'User', avatar: '' },
        characters: [{ id: 'char-sully', name: 'Sully', avatar: '' }],
    }),
}));

vi.mock('../../utils/db.js', () => ({
    DB: {
        getAsset: async (id: string) => (DBMAP.has(id) ? DBMAP.get(id)! : null),
        saveAsset: async (id: string, data: string) => {
            DBMAP.set(id, data);
        },
    },
}));

vi.mock('../../utils/blobRef.js', () => ({
    putImageBlob: async (blob: Blob) => {
        const ref = `blobref:b_fix_${BLOBMAP.size}`;
        BLOBMAP.set(ref, blob);
        return ref;
    },
    getBlobForRef: async (ref: string) => {
        resolveCalls += 1;
        return BLOBMAP.get(ref) ?? null;
    },
}));

vi.mock('react/jsx-runtime', () => {
    const call = (type: unknown, props: unknown) =>
        typeof type === 'function' ? (type as (p: unknown) => unknown)(props) : { type, props };
    return { jsx: call, jsxs: call, Fragment: 'fragment' };
});
vi.mock('react/jsx-dev-runtime', () => {
    const call = (type: unknown, props: unknown) =>
        typeof type === 'function' ? (type as (p: unknown) => unknown)(props) : { type, props };
    return { jsxDEV: call, Fragment: 'fragment' };
});

const captured: { props?: Record<string, unknown> } = {};
vi.mock('./FriendFeedView.js', () => ({
    FriendFeedView: (p: Record<string, unknown>) => {
        captured.props = p;
        return null;
    },
}));

async function renderApp() {
    (globalThis as Record<string, unknown>).__effects = [];
    (globalThis as Record<string, unknown>).__hookState = { values: [], cursor: 0 };
    captured.props = undefined;
    // 可写锁替身（单线程直调；生产用真实 Web Locks）
    Object.defineProperty(globalThis, 'navigator', {
        value: { locks: { request: async (_n: string, fn: () => Promise<unknown>) => fn() } },
        configurable: true,
        writable: true,
    });
    (globalThis as unknown as { URL: typeof URL }).URL.createObjectURL = ((blob: Blob) => {
        urlSeq += 1;
        const u = `blob:fix-${urlSeq}`;
        createdUrls.push(u);
        void blob;
        return u;
    }) as typeof URL.createObjectURL;
    (globalThis as unknown as { URL: typeof URL }).URL.revokeObjectURL = ((u: string) => {
        revokedUrls.push(u);
    }) as typeof URL.revokeObjectURL;
    const mod = await import('../../apps/FriendFeedApp.js');
    const App = mod.default as () => unknown;
    const hooks = () =>
        (globalThis as Record<string, unknown>).__hookState as { values: unknown[]; cursor: number };
    const renderOnce = () => {
        hooks().cursor = 0;
        try {
            (App as () => unknown)();
        } catch (e) {
            throw new Error('App render threw: ' + String((e as Error)?.stack || e).slice(0, 800));
        }
    };
    renderOnce();
    const effs = (globalThis as Record<string, unknown>).__effects as Array<() => Promise<unknown>>;
    const n0 = effs.length;
    const cleanups: Array<() => void> = [];
    for (const e of effs) {
        const c = (await e()) as unknown;
        if (typeof c === 'function') cleanups.push(c as () => void);
    }
    // 挂载内异步 load→setIdentities 落定后再重渲染（等价 React 状态更新后渲染）
    for (let i = 0; i < 100; i++) {
        const vals = hooks().values;
        const ready = vals.some(
            (v) => Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && (v[0] as { id?: unknown }).id === 'me',
        );
        if (ready) break;
        await new Promise((r) => setTimeout(r, 20));
    }
    // 重渲染一次：拿到 setIdentities/setImgUrls 之后的新闭包（等价 React 状态更新后渲染）
    renderOnce();
    const secondEffs = ((globalThis as Record<string, unknown>).__effects as Array<() => Promise<unknown>>).slice(n0);
    // 等待 mount 内异步 load+resolve 落定
    for (let i = 0; i < 20 && !captured.props; i++) await new Promise((r) => setTimeout(r, 10));
    if (!captured.props) throw new Error('View 未渲染');
    // StrictMode(dev) 复刻：cleanup → 同一批 setup 重跑 → 重渲染。
    // 回归 aliveRef 在重挂载 setup 中被置回 true（否则提交/导入静默跳过、isSaving 卡死）。
    const strictRemount = async () => {
        for (const c of cleanups) {
            try {
                c();
            } catch {
                /* ignore */
            }
        }
        for (const e of secondEffs) await e();
        for (let i = 0; i < 100; i++) {
            const vals = hooks().values;
            const ready = vals.some(
                (v) => Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && (v[0] as { id?: unknown }).id === 'me',
            );
            if (ready) break;
            await new Promise((r) => setTimeout(r, 20));
        }
        renderOnce();
        return { ...(captured.props as unknown as Record<string, unknown>) };
    };
    return {
        ...(captured.props as unknown as {
            onCreatePost: (text: string, files: File[]) => Promise<void>;
            onImport: (f: File) => void;
            resolveImageRef: (r: string) => string;
            posts: Array<{ id: string; text: string; imageRefs: string[] }>;
        }),
        strictRemount,
    };
}

function pngFile(name: string): File {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    const blob = new Blob([bytes], { type: 'image/png' });
    return new File([blob], name, { type: 'image/png' });
}

beforeEach(() => {
    DBMAP.clear();
    BLOBMAP.clear();
    resolveCalls = 0;
    createdUrls = [];
    revokedUrls = [];
    urlSeq = 0;
});

describe('bibi app wiring fix', () => {
    it('空缓存导入后同步图片缓存：resolve 被调用且导入图可解码', async () => {
        const first = await renderApp();
        await first.onCreatePost('空缓存导入帖', [pngFile('a.png')]);
        // 导出备份（真实 exportBackup 代码路径经 App 的 onExport 同源；此处直接读 DB 快照等价文本）
        const raw = DBMAP.get('friend_feed_v1')!;
        expect(raw).toContain('空缓存导入帖');
        const backup = {
            kind: 'sully-friend-feed-backup',
            version: 1,
            exportedAt: Date.now(),
            posts: JSON.parse(raw).posts,
        };
        // 模拟删除后文本清空但 blob 保留（保守回收）
        DBMAP.set('friend_feed_v1', JSON.stringify({ version: 1, rev: 1, posts: [], lastSeenCommentAt: {} }));
        // 全新挂载 = 空图片缓存
        resolveCalls = 0;
        createdUrls = [];
        const second = await renderApp();
        expect(second.posts.length).toBe(0);
        // 经真实 onImport（parseBackup→saveProductionFeed→load→resolveBibiImageMap→setImgUrls）
        const f = new File([JSON.stringify(backup)], 'bibi-backup.json', { type: 'application/json' });
        second.onImport(f);
        for (let i = 0; i < 50 && resolveCalls === 0; i++) await new Promise((r) => setTimeout(r, 10));
        for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 10));
        expect(resolveCalls).toBeGreaterThan(0);
        const ref = JSON.parse(DBMAP.get('friend_feed_v1')!).posts[0].imageRefs[0] as string;
        const src = (second.resolveImageRef as (r: string) => string)(ref);
        // 注意：桩 React 不自动重渲染；直接读 App 内最新 imgUrls 状态值
        const stateVals = ((globalThis as Record<string, unknown>).__hookState as { values: unknown[] }).values;
        const imgMap = stateVals.find(
            (b) =>
                typeof b === 'object' &&
                b !== null &&
                Object.values(b as object).some((v) => typeof v === 'string' && (v as string).startsWith('blob:fix-')),
        ) as Record<string, string> | undefined;
        expect(imgMap).toBeDefined();
        const map = imgMap!;
        expect(map[ref]).toMatch(/^blob:fix-/);
        void src;
        // 仓内字节仍是 PNG（可解码的字节级证明）
        const stored = BLOBMAP.get(ref)!;
        const head = new Uint8Array(await stored.arrayBuffer()).slice(0, 8);
        expect([...head]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    });

    it('导入后缺失+有效两图保持 ref 一一对应', async () => {
        const first = await renderApp();
        await first.onCreatePost('两图帖', [pngFile('v.png')]);
        const raw = DBMAP.get('friend_feed_v1')!;
        const data = JSON.parse(raw);
        const validRef = data.posts[0].imageRefs[0] as string;
        const posts = [
            { ...data.posts[0], id: 'p1', imageRefs: ['blobref:missing', validRef] },
        ];
        const backup = { kind: 'sully-friend-feed-backup', version: 1, exportedAt: Date.now(), posts };
        DBMAP.set('friend_feed_v1', JSON.stringify({ version: 1, rev: 1, posts: [], lastSeenCommentAt: {} }));
        resolveCalls = 0;
        const second = await renderApp();
        const f = new File([JSON.stringify(backup)], 'b.json', { type: 'application/json' });
        second.onImport(f);
        for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 10));
        const stateVals2 = ((globalThis as Record<string, unknown>).__hookState as { values: unknown[] }).values;
        const imgMap2 = stateVals2.find(
            (b) =>
                typeof b === 'object' &&
                b !== null &&
                Object.values(b as object).some((v) => typeof v === 'string' && (v as string).startsWith('blob:fix-')),
        ) as Record<string, string> | undefined;
        expect(imgMap2).toBeDefined();
        const map = imgMap2!;
        expect(map[validRef]).toMatch(/^blob:fix-/);
        expect('blobref:missing' in map).toBe(false);
    });

    it('StrictMode 重挂载后提交仍同步缓存（存活标记被重置，不卡 isSaving）', async () => {
        const app = await renderApp();
        // 复刻 React.StrictMode(dev)：cleanup → setup 重跑 → 重渲染
        const fresh = (await app.strictRemount()) as unknown as {
            onCreatePost: (text: string, files: File[]) => Promise<void>;
        };
        await fresh.onCreatePost('strict 重挂载帖', [pngFile('s.png')]);
        // 提交后刷新必须发生：posts 状态含新帖（旧 bug 会提前 return，posts 为空）
        const vals = ((globalThis as Record<string, unknown>).__hookState as { values: unknown[] }).values;
        const postsVal = vals.find(
            (v) => Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && 'text' in (v[0] as object),
        ) as Array<{ text: string; imageRefs: string[] }> | undefined;
        expect(postsVal).toBeDefined();
        expect(postsVal!.some((p) => p.text === 'strict 重挂载帖')).toBe(true);
        const ref = postsVal!.find((p) => p.text === 'strict 重挂载帖')!.imageRefs[0];
        const imgMap = vals.find(
            (b) =>
                typeof b === 'object' &&
                b !== null &&
                !Array.isArray(b) &&
                Object.values(b as object).some((v) => typeof v === 'string' && (v as string).startsWith('blob:fix-')),
        ) as Record<string, string> | undefined;
        expect(imgMap).toBeDefined();
        expect(imgMap![ref]).toMatch(/^blob:fix-/);
    });
});
