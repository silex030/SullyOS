import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DB } from './db';
import { MIRRORED_KEYS, MIRROR_ASSET_ID, healLocalStorageMirror, snapshotLocalStorageMirror } from './lsMirror';
import { LS_MIRROR_ASSET_ID } from './backupSecrets';

// localStorage 镜像：模拟"浏览器清了 localStorage 但 IndexedDB 幸存"的用户现场
// （主题回初始 / 盲盒收藏册清空 / API 配置丢失导致「更新这一天」无反应）。
describe('localStorage IndexedDB 镜像 (lsMirror)', () => {
    beforeEach(async () => {
        localStorage.clear();
        await DB.saveAssetRaw('ls_mirror_v1', null as any).catch(() => {});
    });

    it('镜像资产 id 与备份脱敏用的是同一个常量（防两边各写一份漂掉）', () => {
        expect(MIRROR_ASSET_ID).toBe('ls_mirror_v1');
        expect(MIRROR_ASSET_ID).toBe(LS_MIRROR_ASSET_ID);
    });

    it('快照 → localStorage 被清 → 回填恢复', async () => {
        localStorage.setItem('os_theme', '{"hue":300}');
        localStorage.setItem('os_api_config', '{"baseUrl":"https://x","apiKey":"sk-1","model":"m"}');
        localStorage.setItem('os_dream_collection', '{"sweet":{"firstAt":1,"count":2}}');
        await snapshotLocalStorageMirror();

        localStorage.clear(); // 模拟浏览器驱逐

        const restored = await healLocalStorageMirror();
        expect(restored.sort()).toEqual(['os_api_config', 'os_dream_collection', 'os_theme']);
        expect(localStorage.getItem('os_theme')).toBe('{"hue":300}');
        expect(localStorage.getItem('os_dream_collection')).toBe('{"sweet":{"firstAt":1,"count":2}}');
    });

    it('localStorage 已有值时回填不覆盖（真值永远是 localStorage）', async () => {
        localStorage.setItem('os_theme', '{"hue":1}');
        await snapshotLocalStorageMirror();

        localStorage.setItem('os_theme', '{"hue":2}'); // 用户之后又改了主题
        const restored = await healLocalStorageMirror();
        expect(restored).toEqual([]);
        expect(localStorage.getItem('os_theme')).toBe('{"hue":2}');
    });

    it('removeItem 语义：新快照不再含已删除的键，回填不会复活它', async () => {
        localStorage.setItem('study_api_config', '{"baseUrl":"https://private"}');
        localStorage.setItem('os_theme', '{"hue":9}');
        await snapshotLocalStorageMirror();

        localStorage.removeItem('study_api_config'); // 用户点了「恢复使用全局 API」
        await snapshotLocalStorageMirror();          // 页面隐藏/定时快照跟进

        localStorage.clear();
        const restored = await healLocalStorageMirror();
        expect(restored).toEqual(['os_theme']);
        expect(localStorage.getItem('study_api_config')).toBeNull();
    });

    it('localStorage 全空时不写快照（不拿空覆盖有效镜像）', async () => {
        localStorage.setItem('os_theme', '{"hue":7}');
        await snapshotLocalStorageMirror();

        localStorage.clear();
        await snapshotLocalStorageMirror(); // 空的，应当被忽略

        const restored = await healLocalStorageMirror();
        expect(restored).toEqual(['os_theme']);
    });

    it('没有镜像时回填静默返回空数组', async () => {
        const restored = await healLocalStorageMirror();
        expect(restored).toEqual([]);
    });

    it('局部读取异常不等于用户删除：快照不会抹掉这次读不到的键', async () => {
        localStorage.setItem('os_theme', '{"hue":3}');
        localStorage.setItem('os_api_config', '{"baseUrl":"https://x","apiKey":"sk-2"}');
        await snapshotLocalStorageMirror();

        // 隐私模式 / 个别 WebView 里 getItem 会直接抛错。这不是「用户删了这个键」
        // （删除是返回 null），快照若按缺失处理，就会把镜像里唯一一份配置抹掉。
        const store: any = globalThis.localStorage;
        const original = store.getItem;
        store.getItem = (key: string) => {
            if (key === 'os_api_config') throw new Error('SecurityError');
            if (key === 'os_theme') return '{"hue":3}';
            return null;
        };
        try {
            await snapshotLocalStorageMirror();
        } finally {
            store.getItem = original;
        }

        localStorage.clear();
        const restored = await healLocalStorageMirror();
        expect(restored.sort()).toEqual(['os_api_config', 'os_theme']);
    });

    it('整轮读取都异常时不写快照（不让一次异常把镜像换成空壳）', async () => {
        localStorage.setItem('os_theme', '{"hue":5}');
        await snapshotLocalStorageMirror();

        const store: any = globalThis.localStorage;
        const original = store.getItem;
        store.getItem = () => { throw new Error('SecurityError'); };
        try {
            await snapshotLocalStorageMirror();
        } finally {
            store.getItem = original;
        }

        localStorage.clear();
        expect(await healLocalStorageMirror()).toEqual(['os_theme']);
    });

    it('旧镜像读失败 + 局部读取异常时保守跳过写入（未知≠删除，不丢旧配置）', async () => {
        // 复现场景：os_api_config 的 getItem 抛错、os_theme 可读，本轮
        // DB.getAssetRaw 短暂失败但 saveAssetRaw 会成功。旧语义会写入只含
        // os_theme 的快照，丢掉镜像里唯一一份 os_api_config。
        const oldPayload = { savedAt: 1, data: { os_theme: 'old-theme', os_api_config: 'synthetic-config' } };
        await DB.saveAssetRaw('ls_mirror_v1', oldPayload as any);

        const store: any = globalThis.localStorage;
        const original = store.getItem;
        store.getItem = (key: string) => {
            if (key === 'os_api_config') throw new Error('SecurityError');
            if (key === 'os_theme') return 'new-theme';
            return null;
        };
        const getSpy = vi.spyOn(DB, 'getAssetRaw').mockRejectedValueOnce(new Error('transient IDB failure'));
        const saveSpy = vi.spyOn(DB, 'saveAssetRaw');
        const writesBefore = saveSpy.mock.calls.length;
        try {
            await snapshotLocalStorageMirror();
        } finally {
            store.getItem = original;
            getSpy.mockRestore();
            saveSpy.mockRestore();
        }

        expect(saveSpy.mock.calls.length).toBe(writesBefore); // 0 次覆盖
        expect(await DB.getAssetRaw('ls_mirror_v1')).toEqual(oldPayload); // 旧载荷原样保留
    });

    it('镜像键名单不含大体积键（data URI 类必须走 assets）', () => {
        for (const k of MIRRORED_KEYS) {
            expect(k).not.toMatch(/wallpaper|font|sprite|image|blob/i);
        }
    });
});
