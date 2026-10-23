import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createChatToolExecutor } from './toolExecutor';
import type { AgenticToolCtx } from '../agenticTools';
import type { AirpToolExecutor } from './directorClient';
import type { CityPlace } from '../amapCore';
import type { WeatherData } from '../realtimeWorldCore';
import { DB, openDB } from '../db';

// 注入桩 dispatch：不 mock 真实工具，只验证「目录名 → 仓库真名」的映射与结果编码。
const ctx = { char: { name: 'Aria' }, userProfile: { name: '小明' } } as unknown as AgenticToolCtx;

function makeExecutor(dispatchImpl: (...args: any[]) => any): {
    executor: AirpToolExecutor;
    dispatch: ReturnType<typeof vi.fn>;
} {
    const dispatch = vi.fn(dispatchImpl);
    return { executor: createChatToolExecutor(dispatch as any, ctx), dispatch };
}

describe('createChatToolExecutor —— AIRP 目录名映射到仓库工具', () => {
    it('recall_deep → recall，实参 / ctx 原样透传', async () => {
        const { executor, dispatch } = makeExecutor(async () => '回忆文本');
        const args = { year: '2026', month: '06' };

        const result = await executor.executeTool('recall_deep', args);

        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(dispatch).toHaveBeenCalledWith('recall', args, ctx);
        expect(result).toEqual({ ok: true, text: '回忆文本' });
    });

    it('web_search / read_note 走同名真工具', async () => {
        const web = makeExecutor(async () => '搜索结果');
        expect(await web.executor.executeTool('web_search', { q: 'x' }))
            .toEqual({ ok: true, text: '搜索结果' });
        expect(web.dispatch).toHaveBeenCalledWith('web_search', { q: 'x' }, ctx);

        const note = makeExecutor(async () => '笔记');
        expect(await note.executor.executeTool('read_note', { id: 'n1' }))
            .toEqual({ ok: true, text: '笔记' });
        expect(note.dispatch).toHaveBeenCalledWith('read_note', { id: 'n1' }, ctx);
    });

    it('对象结果序列化成 JSON 字符串', async () => {
        const { executor } = makeExecutor(async () => ({ ok: true, items: [1, 2] }));

        const result = await executor.executeTool('recall_deep', {});

        expect(result).toEqual({ ok: true, text: JSON.stringify({ ok: true, items: [1, 2] }) });
    });

    it('无法序列化的结果回落空串，不抛', async () => {
        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;
        const { executor } = makeExecutor(async () => cycle);

        expect(await executor.executeTool('read_note', {})).toEqual({ ok: true, text: '' });
    });

    it('真工具抛错 → ok:false，text 带「执行失败：」与原因', async () => {
        const { executor } = makeExecutor(async () => { throw new Error('boom'); });

        expect(await executor.executeTool('web_search', {})).toEqual({ ok: false, text: '执行失败：boom' });
    });

    it('非 Error 抛值也编码成失败文本', async () => {
        const { executor } = makeExecutor(async () => { throw 'plain'; });

        expect(await executor.executeTool('web_search', {})).toEqual({ ok: false, text: '执行失败：plain' });
    });

    it('未知目录名直接抛错、不派发（directorClient 的 catch 会落成「执行失败」）', async () => {
        const { executor, dispatch } = makeExecutor(async () => 'never');

        await expect(executor.executeTool('weather_elsewhere', {})).rejects.toThrow(/weather_elsewhere/);
        expect(dispatch).not.toHaveBeenCalled();
    });
});

// 两个新工具没有共享面真工具可派发，executor 分支到专用 runner；第三个参数是测试用注入缝。
const HANGZHOU_WEATHER: WeatherData = {
    temp: 26,
    feelsLike: 28,
    humidity: 60,
    description: '晴',
    icon: '01d',
    city: '杭州',
};

describe('createChatToolExecutor —— weather_lookup_place runner', () => {
    function makeWeatherExecutor(impl: (city: string) => Promise<WeatherData | null>): {
        executor: AirpToolExecutor;
        weatherLookup: ReturnType<typeof vi.fn>;
        dispatch: ReturnType<typeof vi.fn>;
    } {
        const weatherLookup = vi.fn(impl);
        const dispatch = vi.fn(async () => 'never');
        const executor = createChatToolExecutor(dispatch as any, ctx, { weatherLookup });
        return { executor, weatherLookup, dispatch };
    }

    it('命中：渲染 peek 格式那一行 + 建议行，且不派发共享面工具', async () => {
        const { executor, weatherLookup, dispatch } = makeWeatherExecutor(async () => HANGZHOU_WEATHER);

        const result = await executor.executeTool('weather_lookup_place', { city: '杭州' });

        expect(weatherLookup).toHaveBeenCalledTimes(1);
        expect(weatherLookup).toHaveBeenCalledWith('杭州');
        expect(dispatch).not.toHaveBeenCalled();
        expect(result).toEqual({
            ok: true,
            text: '杭州晴，气温 26°C（体感 28°C）\n天气不错，适合出门，阳光明媚',
        });
    });

    it('取数返回 null：报「未查到」而不是抛错', async () => {
        const { executor } = makeWeatherExecutor(async () => null);

        expect(await executor.executeTool('weather_lookup_place', { city: '杭州' }))
            .toEqual({ ok: true, text: '未查到杭州的天气' });
    });

    it('city 缺失或全空白：返回确定性提示，不调取数', async () => {
        const { executor, weatherLookup } = makeWeatherExecutor(async () => HANGZHOU_WEATHER);

        expect(await executor.executeTool('weather_lookup_place', {}))
            .toEqual({ ok: true, text: '缺少地点，无法查询天气' });
        expect(await executor.executeTool('weather_lookup_place', { city: '   ' }))
            .toEqual({ ok: true, text: '缺少地点，无法查询天气' });
        expect(weatherLookup).not.toHaveBeenCalled();
    });

    it('取数抛错：降级成文本，不把异常抛给 directorClient', async () => {
        const { executor } = makeWeatherExecutor(async () => { throw new Error('offline'); });

        expect(await executor.executeTool('weather_lookup_place', { city: '杭州' }))
            .toEqual({ ok: false, text: '天气查询暂不可用' });
    });
});

describe('createChatToolExecutor —— amap_search_places runner', () => {
    // 凭证来源已是「出行会话 → 本站 REST 中转」，不再读 localStorage 旧 Key。
    // 单测通过注入缝给一个已就绪的中转 auth（key 恒为空，浏览器不见 Web 服务 Key）。
    const RELAY_AUTH = {
        proxyUrl: 'https://app.example/travel/map/rest',
        key: '',
        relay: true,
        headers: { Authorization: 'Bearer test-session-token-0123456789' },
    };

    function makeAmapExecutor(impl: (
        keywords: string,
        city: string,
        category: unknown,
        auth: unknown,
    ) => Promise<CityPlace[]>, auth: unknown = RELAY_AUTH): {
        executor: AirpToolExecutor;
        amapSearch: ReturnType<typeof vi.fn>;
        dispatch: ReturnType<typeof vi.fn>;
    } {
        const amapSearch = vi.fn(impl);
        const dispatch = vi.fn(async () => 'never');
        const executor = createChatToolExecutor(dispatch as any, ctx, {
            amapSearch,
            amapAuth: async () => auth as never,
        });
        return { executor, amapSearch, dispatch };
    }

    function makePlaces(count: number): CityPlace[] {
        return Array.from({ length: count }, (_, i) => ({
            name: `地点${i + 1}`,
            type: '餐饮服务;咖啡厅',
            typeShort: '咖啡厅',
            category: 'cafe',
            address: `街${i + 1}`,
            lat: 30 + i,
            lng: 120 + i,
        }));
    }

    it('命中：固定 spot 类别、带中转 auth 调取数（不含明文 Key），最多渲染 5 行 name — address', async () => {
        const { executor, amapSearch, dispatch } = makeAmapExecutor(async () => makePlaces(6));

        const result = await executor.executeTool('amap_search_places', { keywords: '咖啡馆', city: '杭州' });

        expect(amapSearch).toHaveBeenCalledTimes(1);
        const call = amapSearch.mock.calls[0];
        expect(call[0]).toBe('咖啡馆');
        expect(call[1]).toBe('杭州');
        expect(call[2]).toBe('spot');
        expect(call[3]).toEqual(RELAY_AUTH);
        expect((call[3] as { key: string }).key).toBe('');
        expect(dispatch).not.toHaveBeenCalled();
        expect(result).toEqual({
            ok: true,
            text: '1. 地点1 — 街1\n2. 地点2 — 街2\n3. 地点3 — 街3\n4. 地点4 — 街4\n5. 地点5 — 街5',
        });
    });

    it('结果为空：报「附近没搜到相关地点」', async () => {
        const { executor } = makeAmapExecutor(async () => []);

        expect(await executor.executeTool('amap_search_places', { keywords: '咖啡馆', city: '杭州' }))
            .toEqual({ ok: true, text: '附近没搜到相关地点' });
    });

    it('keywords / city 空白：点名缺的那一项，不调取数（city 无 ctx 回落）', async () => {
        const { executor, amapSearch } = makeAmapExecutor(async () => []);

        expect(await executor.executeTool('amap_search_places', { city: '杭州' }))
            .toEqual({ ok: true, text: '缺少搜索关键词，无法查询地点' });
        expect(await executor.executeTool('amap_search_places', { keywords: '咖啡馆' }))
            .toEqual({ ok: true, text: '缺少城市，无法查询地点' });
        expect(await executor.executeTool('amap_search_places', { keywords: '  ', city: '  ' }))
            .toEqual({ ok: true, text: '缺少搜索关键词，无法查询地点' });
        expect(amapSearch).not.toHaveBeenCalled();
    });

    it('没有可用凭证（无会话/未配对）：报「地图服务未配置」，不让空结果冒充搜过了', async () => {
        const { executor, amapSearch } = makeAmapExecutor(async () => [], { proxyUrl: '', key: '' });

        expect(await executor.executeTool('amap_search_places', { keywords: '咖啡馆', city: '杭州' }))
            .toEqual({ ok: true, text: '地图服务未配置' });
        expect(amapSearch).not.toHaveBeenCalled();
    });

    it('取数抛错：降级成文本，不把异常抛给 directorClient', async () => {
        const { executor } = makeAmapExecutor(async () => { throw new Error('proxy down'); });

        expect(await executor.executeTool('amap_search_places', { keywords: '咖啡馆', city: '杭州' }))
            .toEqual({ ok: false, text: '地点搜索暂不可用' });
    });

    it('amap_route 保持未接线：目录里没有它，执行直接抛错', async () => {
        const { executor, amapSearch, dispatch } = makeAmapExecutor(async () => []);

        await expect(executor.executeTool('amap_route', { from: 'A', to: 'B' }))
            .rejects.toThrow(/amap_route/);
        expect(amapSearch).not.toHaveBeenCalled();
        expect(dispatch).not.toHaveBeenCalled();
    });
});

// 排程三件套：目录名翻成 amsg2 真名后，经注入的 amsg2Execute 缝执行（不走 dispatchAgenticTool）。
describe('createChatToolExecutor —— schedule 目录名走 amsg2 缝', () => {
    function makeScheduleExecutor(
        impl: (toolName: string, args: Record<string, unknown>) => Promise<string>,
    ): {
        executor: AirpToolExecutor;
        amsg2Execute: ReturnType<typeof vi.fn>;
        dispatch: ReturnType<typeof vi.fn>;
    } {
        const amsg2Execute = vi.fn(impl);
        const dispatch = vi.fn(async () => 'never');
        const executor = createChatToolExecutor(dispatch as any, ctx, { amsg2Execute });
        return { executor, amsg2Execute, dispatch };
    }

    it.each<[string, string]>([
        ['schedule_now', 'schedule_active_message'],
        ['schedule_cancel', 'cancel_active_message'],
        ['schedule_renew', 'renew_active_message'],
    ])('%s → %s：参数原样透传、结果原样返回、不派发共享面工具', async (catalog, real) => {
        const { executor, amsg2Execute, dispatch } = makeScheduleExecutor(async () => '排程结果文本');
        const args = { send_at: '2026-09-18T09:00:00', mode: 'auto' };

        const result = await executor.executeTool(catalog, args);

        expect(amsg2Execute).toHaveBeenCalledTimes(1);
        expect(amsg2Execute).toHaveBeenCalledWith(real, args);
        expect(dispatch).not.toHaveBeenCalled();
        expect(result).toEqual({ ok: true, text: '排程结果文本' });
    });

    it('缝缺席：回「排程工具暂不可用」，不抛、不派发', async () => {
        const dispatch = vi.fn(async () => 'never');
        const executor = createChatToolExecutor(dispatch as any, ctx);

        await expect(executor.executeTool('schedule_now', { send_at: '2026-09-18T09:00:00' }))
            .resolves.toEqual({ ok: true, text: '排程工具暂不可用' });
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('缝抛错：降级成失败文本，不把异常抛给 directorClient', async () => {
        const { executor } = makeScheduleExecutor(async () => { throw new Error('boom'); });

        expect(await executor.executeTool('schedule_cancel', {}))
            .toEqual({ ok: false, text: '执行失败：boom' });
    });
});

// 日记 runner：IndexedDB 由 test-setup 的 fake-indexeddb 提供，走真实 DB 层（同 C1 落点测试）。
describe('createChatToolExecutor —— save_diary runner', () => {
    const diaryCtx = {
        char: { id: 'char-diary', name: 'Aria' },
        userProfile: { name: '小明' },
    } as unknown as AgenticToolCtx;

    function makeDiaryExecutor(): { executor: AirpToolExecutor; dispatch: ReturnType<typeof vi.fn> } {
        const dispatch = vi.fn(async () => 'never');
        return { executor: createChatToolExecutor(dispatch as any, diaryCtx), dispatch };
    }

    async function clearDiaries(): Promise<void> {
        const db = await openDB();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('diaries', 'readwrite');
            tx.objectStore('diaries').clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    beforeEach(async () => { await clearDiaries(); });

    it('text 缺失或全空白：回「缺少日记内容，无法记录」，零写入', async () => {
        const { executor, dispatch } = makeDiaryExecutor();

        expect(await executor.executeTool('save_diary', {}))
            .toEqual({ ok: true, text: '缺少日记内容，无法记录' });
        expect(await executor.executeTool('save_diary', { text: '   ' }))
            .toEqual({ ok: true, text: '缺少日记内容，无法记录' });

        expect(dispatch).not.toHaveBeenCalled();
        expect(await DB.getDiariesByCharId('char-diary')).toEqual([]);
    });

    it('写一行可读日记，字段逐项符合 C1 约定（charPage 正文、UTC 日期、无 autoSync）', async () => {
        const before = Date.now();
        const { executor } = makeDiaryExecutor();

        const result = await executor.executeTool('save_diary', { text: '今天聊了咖啡。' });
        const after = Date.now();

        expect(result).toEqual({ ok: true, text: '已写入今天的日记' });

        const rows = await DB.getDiariesByCharId('char-diary');
        expect(rows).toHaveLength(1);
        const row = rows[0];
        expect(row.id).toMatch(/^airp-diary-tool-/);
        expect(row.charId).toBe('char-diary');
        expect(row.date).toBe(new Date().toISOString().slice(0, 10));
        expect(row.userPage).toEqual({ text: '', paperStyle: 'grid', stickers: [] });
        expect(row.charPage).toEqual({ text: '今天聊了咖啡。', paperStyle: 'plain', stickers: [] });
        expect(row.timestamp).toBeGreaterThanOrEqual(before);
        expect(row.timestamp).toBeLessThanOrEqual(after);
        expect(row.isArchived).toBe(false);
        expect('autoSync' in row).toBe(false);
    });

    it('同一天同样正文重复调用：内容寻址命中同一 id，put 覆盖成一行', async () => {
        const { executor } = makeDiaryExecutor();

        await executor.executeTool('save_diary', { text: '同样的咖啡记录。' });
        await executor.executeTool('save_diary', { text: '同样的咖啡记录。' });

        expect(await DB.getDiariesByCharId('char-diary')).toHaveLength(1);
    });

    it('同一天不同正文：留下两行', async () => {
        const { executor } = makeDiaryExecutor();

        await executor.executeTool('save_diary', { text: '第一件事。' });
        await executor.executeTool('save_diary', { text: '第二件事。' });

        expect(await DB.getDiariesByCharId('char-diary')).toHaveLength(2);
    });

    it('同样正文跨 UTC 天：日期进了 id，留下两行', async () => {
        const { executor } = makeDiaryExecutor();
        const nowSpy = vi.spyOn(Date, 'now');

        try {
            nowSpy.mockReturnValue(Date.UTC(2026, 8, 17, 12, 0, 0));
            await executor.executeTool('save_diary', { text: '跨天也要记。' });
            nowSpy.mockReturnValue(Date.UTC(2026, 8, 18, 12, 0, 0));
            await executor.executeTool('save_diary', { text: '跨天也要记。' });
        } finally {
            nowSpy.mockRestore();
        }

        const rows = await DB.getDiariesByCharId('char-diary');
        expect(rows).toHaveLength(2);
        expect(new Set(rows.map((row) => row.date))).toEqual(new Set(['2026-09-17', '2026-09-18']));
        expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    });

    it('正文哈希确定性：同文本两次调用产出同一个 id，形状为日期 + 8 位十六进制', async () => {
        const { executor } = makeDiaryExecutor();

        await executor.executeTool('save_diary', { text: '确定性的正文。' });
        const [first] = await DB.getDiariesByCharId('char-diary');

        await clearDiaries();
        await executor.executeTool('save_diary', { text: '确定性的正文。' });
        const [second] = await DB.getDiariesByCharId('char-diary');

        expect(first.id).toBe(second.id);
        expect(first.id).toMatch(/^airp-diary-tool-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);
    });
});

// 验收要求「loop test covering 9 wired names」：这里在 executor 层锁住全部 9 个目录名
// 都能端到端执行（5 个走 dispatch、4 个走 runner/缝），与 directorClient 的 5 名循环互补。
describe('createChatToolExecutor —— 9 个已接线目录名端到端', () => {
    const loopCtx = {
        char: { id: 'char-loop', name: 'Aria' },
        userProfile: { name: '小明' },
    } as unknown as AgenticToolCtx;

    const WIRED_NAMES: Array<[string, Record<string, unknown>, number]> = [
        ['recall_deep', { year: '2026', month: '9' }, 1],
        ['web_search', { query: '咖啡' }, 1],
        ['read_note', { keyword: '咖啡' }, 1],
        ['weather_lookup_place', { city: '杭州' }, 0],
        ['amap_search_places', { keywords: '咖啡馆', city: '杭州' }, 0],
        ['schedule_now', { send_at: '2026-09-18T09:00:00' }, 0],
        ['schedule_cancel', { task_id: 'abcd1234' }, 0],
        ['schedule_renew', { send_at: '2026-09-18T09:00:00', task_id: 'abcd1234' }, 0],
        ['save_diary', { text: '记一笔' }, 0],
    ];

    it.each(WIRED_NAMES)('%s 端到端可执行', async (toolName, args, dispatchCalls) => {
        const dispatch = vi.fn(async () => 'X');
        const executor = createChatToolExecutor(dispatch as any, loopCtx, {
            weatherLookup: async () => HANGZHOU_WEATHER,
            amapSearch: async () => [],
            amsg2Execute: async () => 'X',
        });

        const result = await executor.executeTool(toolName, args);

        expect(result.ok).toBe(true);
        expect(dispatch).toHaveBeenCalledTimes(dispatchCalls);
    });
});
