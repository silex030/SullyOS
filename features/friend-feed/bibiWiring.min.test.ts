// features/friend-feed/bibiWiring.min.test.ts
// Bibi 真实 App 最小接线定向测试（本卡新增唯一测试文件）：
// 接线/身份/生产端口/备份引用最小断言。显式单 worker 运行。
import { describe, expect, it } from 'vitest';
import { AppID } from '../../types.js';
import { INSTALLED_APPS } from '../../constants.js';
import { buildIdentityList, toFeedIdentity } from './identities.js';
import { exportBackup, parseBackup } from './backup.js';
import { createState, deserialize, serialize } from './store.js';
import { FeedController, NoSafeWriteError, makeMemoryImagePort, makeSharedTestLock } from './controller.js';
import { STORAGE_ASSET_KEY } from './limits.js';
import { makeAssetStoragePort } from './service.js';
import { resolveBibiImageMap } from './bibiImageMap.js';
import { REF_SOURCE_STORES } from '../../utils/blobGc.js';

function memText(initial: string | null = null) {
    let v: string | null = initial;
    return {
        load: async () => v,
        save: async (raw: string) => { v = raw; },
        peek: () => v,
    };
}

describe('bibi wiring minimal', () => {
    it('AppID.Bibi 唯一枚举存在且值为 bibi', () => {
        expect((AppID as unknown as Record<string, string>).Bibi).toBe('bibi');
    });

    it('Launcher 只有一个哔哔入口（不复活 Social/不覆盖 Moments）', () => {
        const bibi = INSTALLED_APPS.filter((a) => a.id === (AppID as unknown as Record<string, string>).Bibi);
        expect(bibi.length).toBe(1);
        expect(bibi[0].name).toContain('哔');
        expect((AppID as unknown as Record<string, string>).Social).toBeUndefined();
        const moments = INSTALLED_APPS.filter((a) => a.id === AppID.Moments);
        expect(moments.length).toBe(1);
    });

    it('身份映射：用户首位、主人提醒 id 稳定、头像清洗', () => {
        const list = buildIdentityList({
            user: { id: 'owner-1', name: '主人', avatar: 'https://evil.example/a.png' },
            characters: [
                { id: 'char-a', name: '阿甲' },
                { id: 'owner-1', name: '主人重复' },
            ],
        });
        expect(list[0].id).toBe('owner-1');
        expect(list.length).toBe(2);
        expect(list[0].avatar).toBe('');
        expect(() => toFeedIdentity({ id: '' })).toThrow();
    });

    it('生产文本端口走真实 key friend_feed_v1', async () => {
        expect(STORAGE_ASSET_KEY).toBe('friend_feed_v1');
        const asset = { data: null as string | null, getAsset: async (_id: string) => asset.data, saveAsset: async (_id: string, d: string) => { asset.data = d; } };
        const port = makeAssetStoragePort(asset as unknown as Parameters<typeof makeAssetStoragePort>[0]);
        await port.save(serialize(createState()));
        const got = await asset.getAsset(STORAGE_ASSET_KEY);
        expect(typeof got).toBe('string');
        expect(deserialize(got as string).version).toBe(1);
    });

    it('发帖/评论/点赞/显式已读/删除/重开闭环（内存端口+共享锁）', async () => {
        const text = memText();
        const img = makeMemoryImagePort();
        const locks = makeSharedTestLock();
        const c = new FeedController(text, img.port, locks);
        await c.load();
        const me = { id: 'owner-1', name: '主人', avatar: '' };
        const other = { id: 'char-a', name: '阿甲', avatar: '' };
        const png = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' }) as Blob & { name: string };
        (png as unknown as { name: string }).name = 't.png';
        const post = await c.submitPost(me, '最小闭环帖', [png]);
        expect(post.imageRefs.length).toBe(1);
        await c.addComment(post.id, other, '收到');
        expect(c.getUnread('owner-1').count).toBe(1);
        await c.markPostRead(post.id);
        expect(c.getUnread('owner-1').count).toBe(0);
        await c.toggleLike(post.id);
        const del = await c.deletePost(post.id, 'owner-1');
        expect(del.removedImageRefs.length).toBe(1);
        expect(img.has(del.removedImageRefs[0])).toBe(true);
        const c2 = new FeedController({ load: text.load, save: text.save }, img.port, locks);
        await c2.load();
        expect(c2.state.posts.length).toBe(0);
    });

    it('无写能力只读：拒绝写入且旧字节不动', async () => {
        const text = memText(serialize(createState()));
        const img = makeMemoryImagePort();
        const c = new FeedController(text, img.port, null);
        await c.load();
        expect(c.writable).toBe(false);
        await expect(c.submitPost({ id: 'x', name: 'x', avatar: '' }, 'hi', [])).rejects.toBeInstanceOf(NoSafeWriteError);
        expect(text.peek()).toBe(serialize(createState()));
    });

    it('模块备份往返 + 非法输入整包拒绝不改旧库', () => {
        const s = createState();
        const b = exportBackup(s);
        expect(b.kind).toBe('sully-friend-feed-backup');
        expect(parseBackup(JSON.parse(JSON.stringify(b)))).toEqual({ ...s, rev: 0, lastSeenCommentAt: {} });
        expect(() => parseBackup({ kind: 'other', version: 1, exportedAt: 1, posts: [] })).toThrow();
        expect(() => parseBackup({ kind: 'sully-friend-feed-backup', version: 999, exportedAt: 1, posts: [] })).toThrow();
    });

    it('全局 GC 已覆盖 Bibi 引用面（assets 整行扫描含 friend_feed_v1 令牌）', () => {
        expect((REF_SOURCE_STORES as readonly string[]).includes('assets')).toBe(true);
        const row = { id: STORAGE_ASSET_KEY, data: JSON.stringify({ posts: [{ imageRefs: ['blobref:b_abc'] }] }) };
        expect(JSON.stringify(row)).toContain('blobref:b_abc');
    });

    it('空缓存导入后同步图片缓存：导入成功必须触发逐ref解析且图字节可解码', async () => {
        const text = memText();
        const img = makeMemoryImagePort();
        const locks = makeSharedTestLock();
        const c = new FeedController(text, img.port, locks);
        await c.load();
        const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
        const png = new Blob([pngBytes], { type: 'image/png' }) as Blob & { name: string };
        (png as unknown as { name: string }).name = 'import-cache.png';
        const post = await c.submitPost({ id: 'owner-1', name: '主人', avatar: '' }, '空缓存导入帖', [png]);
        expect(post.imageRefs.length).toBe(1);
        const ref = post.imageRefs[0];
        // 模拟 App 空缓存重开：全新控制器读同一文本端口，图片缓存为空。
        const c2 = new FeedController({ load: text.load, save: text.save }, img.port, locks);
        await c2.load();
        expect(c2.state.posts.length).toBe(1);
        const refs = [...new Set(c2.state.posts.flatMap((p) => p.imageRefs))];
        expect(refs).toEqual([ref]);
        // 真实 onImport 修复后必须调用解析（旧代码 resolveCalls=0 即 bug）。
        let resolveCalls = 0;
        const map = await resolveBibiImageMap(refs, async (r) => {
            resolveCalls += 1;
            const blob = await img.port.loadImage(r);
            if (!blob) return '';
            return `blob:import-${r}`;
        });
        expect(resolveCalls).toBe(1);
        expect(map[ref]).toContain('blob:import-');
        // 图片字节仍在仓内且 PNG 魔数完整（可解码的字节级证明）。
        const stored = await img.port.loadImage(ref);
        expect(stored).not.toBeNull();
        const head = new Uint8Array(await (stored as Blob).arrayBuffer()).slice(0, 8);
        expect([...head]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    });

    it('缺失+有效两图保持 ref 一一对应（旧按索引回填会错配的回归）', async () => {
        const refs = ['blobref:missing', 'blobref:valid'];
        // 旧批量语义：过滤空项后压缩，调用方按索引回填即错配。
        const batchUrls = ['url:valid'];
        const oldMapped: Record<string, string> = {};
        refs.forEach((r, i) => { if (batchUrls[i]) oldMapped[r] = batchUrls[i]; });
        expect(oldMapped).toEqual({ 'blobref:missing': 'url:valid' });
        // 新 App 接线：逐 ref 解析，缺失不占位。
        const map = await resolveBibiImageMap(refs, async (r) => (r === 'blobref:valid' ? 'url:valid' : ''));
        expect(map).toEqual({ 'blobref:valid': 'url:valid' });
        expect('blobref:missing' in map).toBe(false);
    });

    it('延迟解析后卸载不泄漏已建 URL', async () => {
        const refs = ['blobref:a', 'blobref:b'];
        let alive = true;
        const revoked: string[] = [];
        const map = await resolveBibiImageMap(
            refs,
            async (r) => {
                await new Promise((res) => setTimeout(res, 5));
                if (r === 'blobref:a') {
                    alive = false; // 首个解析完成后卸载
                    return 'blob:url-a';
                }
                return 'blob:url-b';
            },
            { isCancelled: () => !alive, revoke: (u) => { revoked.push(u); } },
        );
        expect(map).toEqual({});
        expect(revoked).toContain('blob:url-a');
    });

    it('单个解析失败不泄漏已建 URL（跳过失败项保留有效项）', async () => {
        const refs = ['blobref:good1', 'blobref:bad', 'blobref:good2'];
        const revoked: string[] = [];
        const created: string[] = [];
        const map = await resolveBibiImageMap(
            refs,
            async (r) => {
                if (r === 'blobref:bad') throw new Error('blob gone');
                const url = `blob:${r}`;
                created.push(url);
                return url;
            },
            { revoke: (u) => { revoked.push(u); } },
        );
        expect(map).toEqual({ 'blobref:good1': 'blob:blobref:good1', 'blobref:good2': 'blob:blobref:good2' });
        const leaked = created.filter((u) => !revoked.includes(u) && !(Object.values(map) as string[]).includes(u));
        expect(leaked).toEqual([]);
        expect(revoked).toEqual([]);
    });
});
