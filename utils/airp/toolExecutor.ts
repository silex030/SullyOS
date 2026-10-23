import type { AgenticToolCtx, dispatchAgenticTool as DispatchFn } from '../agenticTools';
import type { AirpToolExecution, AirpToolExecutor } from './directorClient';
import { searchPlaces, type AmapAuth, type CityPlace, type PlaceCategory } from '../amapCore';
import { isAmapAuthReady } from '../amapCore';
import { resolveAmapAuth } from '../cityPlaces';
import { fetchWeatherWithFallback, generateWeatherAdvice, type WeatherData } from '../realtimeWorldCore';
import { DB } from '../db';

/**
 * AIRP 能力目录里的工具名 → 真工具名 / 内部 runner 派发键。
 *
 * 真名是 dispatcher 的 case 标签（recall / web_search / read_note）。目录名与真名
 * 分开是故意的：能力目录是给导演看的「能力」语言，两边演化节奏不同。
 *
 * weather_lookup_place / amap_search_places 的值不是共享面真工具名，而是本模块内部
 * 指向专用 runner 的派发键：仓库里没有对应 dispatchAgenticTool case，也不打算新建
 *（保持 AIRP 作用域，别的调用方行为不变），所以 executeTool 对它们分支到 runner，
 * 不走 dispatchAgenticTool。amap_route 故意不在表里——没有路线 helper，保持未接线。
 *
 * schedule_now / schedule_cancel / schedule_renew 是**真名**：主动消息 2.0 的工具桥
 * 已经实现了这三个（executeAmsg2Tool）。它们只是不走 dispatchAgenticTool，而由注入的
 * amsg2Execute 缝转交，复用聊天侧同一轮会话（见 AirpToolExecutorExtras）。
 * save_diary 没有共享面工具，用内部 runner 键（同 weather / amap 的写法）。
 */
const WEATHER_RUNNER = '__airp_weather_lookup_place__';
const AMAP_SEARCH_RUNNER = '__airp_amap_search_places__';
const SAVE_DIARY_RUNNER = '__airp_save_diary__';

const AIRP_SCHEDULE_REALS: ReadonlySet<string> = new Set([
    'schedule_active_message',
    'cancel_active_message',
    'renew_active_message',
]);

const CATALOG_TO_REAL: Record<string, string> = {
    recall_deep: 'recall',
    web_search: 'web_search',
    read_note: 'read_note',
    weather_lookup_place: WEATHER_RUNNER,
    amap_search_places: AMAP_SEARCH_RUNNER,
    schedule_now: 'schedule_active_message',
    schedule_cancel: 'cancel_active_message',
    schedule_renew: 'renew_active_message',
    save_diary: SAVE_DIARY_RUNNER,
    // Google 日历/待办：读侧主动查询 + 写侧 propose/execute 确认环（dispatchAgenticTool 真名）。
    google_calendar_query: 'google_calendar_events',
    google_task_query: 'google_tasks',
    google_create_propose: 'google_create_propose',
    google_create_execute: 'google_create_execute',
};

const TEXT_WEATHER_NEEDS_CITY = '缺少地点，无法查询天气';
const TEXT_WEATHER_UNAVAILABLE = '天气查询暂不可用';
const TEXT_AMAP_NEEDS_KEYWORDS = '缺少搜索关键词，无法查询地点';
const TEXT_AMAP_NEEDS_CITY = '缺少城市，无法查询地点';
const TEXT_AMAP_UNCONFIGURED = '地图服务未配置';
const TEXT_AMAP_EMPTY = '附近没搜到相关地点';
const TEXT_AMAP_UNAVAILABLE = '地点搜索暂不可用';
const TEXT_SCHEDULE_UNAVAILABLE = '排程工具暂不可用';
const TEXT_DIARY_NEEDS_TEXT = '缺少日记内容，无法记录';
const TEXT_DIARY_FAILED = '日记保存失败';
const TEXT_DIARY_SAVED = '已写入今天的日记';

/** 返回给导演的地点条数上限：导演只需要「大概有什么」，多了挤占上下文。 */
const AMAP_SEARCH_LIMIT = 5;

/**
 * 新增 runner 的注入缝（测试用）。生产由 useChatAI 注入 amsg2Execute；
 * weatherLookup / amapSearch 不传时走下面的真实默认实现。
 */
export interface AirpToolExecutorExtras {
    weatherLookup?: (city: string) => Promise<WeatherData | null>;
    /**
     * 地图取数凭证解析缝（单测注入用）。默认走 {@link resolveAmapAuth}：
     * 已签名出行会话 → 本站 REST 中转，浏览器不持有 Web 服务 Key。
     */
    amapAuth?: () => Promise<AmapAuth>;
    amapSearch?: (
        keywords: string,
        city: string,
        category: PlaceCategory,
        auth: AmapAuth,
    ) => Promise<CityPlace[]>;
    /**
     * 排程类工具的执行缝：把（真名, 参数）交给聊天侧同一轮的 amsg2 工具会话。
     * 缺席（没接上）时排程 runner 回确定性文案，不抛。
     */
    amsg2Execute?: (toolName: string, args: Record<string, unknown>) => Promise<string>;
}

function encodeResult(result: unknown): string {
    if (typeof result === 'string') return result;
    if (result === undefined || result === null) return '';
    try {
        const json = JSON.stringify(result);
        return typeof json === 'string' ? json : '';
    } catch {
        return '';
    }
}

function readArgText(args: Record<string, unknown>, key: string): string {
    const value = args[key];
    return typeof value === 'string' ? value : '';
}

/**
 * 查指定地点天气。city 必填（角色当前地已由 snapshot 场景固定注入，这里只查第三地）。
 * 全程不抛：校验不过/查不到/取数失败都回文本，让导演从文本里学。
 */
async function runWeatherLookup(
    args: Record<string, unknown>,
    extra: AirpToolExecutorExtras | undefined,
): Promise<AirpToolExecution> {
    const city = readArgText(args, 'city').trim();
    if (!city) return { ok: true, text: TEXT_WEATHER_NEEDS_CITY };

    // 不传 apiKey：Open-Meteo 回落免 key，工具不该替用户决定用哪把 OWM key。
    const lookup = extra?.weatherLookup ?? fetchWeatherWithFallback;
    let weather: WeatherData | null;
    try {
        weather = await lookup(city);
    } catch {
        return { ok: false, text: TEXT_WEATHER_UNAVAILABLE };
    }
    if (!weather) return { ok: true, text: `未查到${city}的天气` };

    return {
        ok: true,
        text: `${weather.city}${weather.description}，气温 ${weather.temp}°C（体感 ${weather.feelsLike}°C）\n${generateWeatherAdvice(weather)}`,
    };
}

/**
 * 按关键字搜地点。keywords 与 city 都必填——city 无 ctx 回落：导演的 snapshot
 * 场景里已经有角色当前城市，缺了就让它照 schema 重发，而不是猜一个城市搜错地方。
 * 全程不抛：校验不过/没配 key/搜不到/取数失败都回文本。
 */
async function runAmapSearch(
    args: Record<string, unknown>,
    extra: AirpToolExecutorExtras | undefined,
): Promise<AirpToolExecution> {
    const keywords = readArgText(args, 'keywords').trim();
    if (!keywords) return { ok: true, text: TEXT_AMAP_NEEDS_KEYWORDS };
    const city = readArgText(args, 'city').trim();
    if (!city) return { ok: true, text: TEXT_AMAP_NEEDS_CITY };

    // key 检查必须在调用前：searchPlaces 没 key 时静默返回 []，那会被导演误读成
    // 「这里确实没有咖啡馆」，比明说「没配置」糟得多。
    const auth = await (extra?.amapAuth ?? resolveAmapAuth)();
    if (!isAmapAuthReady(auth)) return { ok: true, text: TEXT_AMAP_UNCONFIGURED };

    // category 只是 App 侧的结果标签（PlaceCategory），从不作为参数进高德请求，
    // 也不在导演契约里；导演的关键字搜索没有类别概念，固定 'spot'。
    const search = extra?.amapSearch ?? searchPlaces;
    let places: CityPlace[];
    try {
        places = await search(keywords, city, 'spot', auth);
    } catch {
        return { ok: false, text: TEXT_AMAP_UNAVAILABLE };
    }
    if (places.length === 0) return { ok: true, text: TEXT_AMAP_EMPTY };

    const lines = places.slice(0, AMAP_SEARCH_LIMIT).map((place, index) => {
        const address = place.address ? ` — ${place.address}` : '';
        return `${index + 1}. ${place.name}${address}`;
    });
    return { ok: true, text: lines.join('\n') };
}

/**
 * 排程类工具：目录名（schedule_now / schedule_cancel / schedule_renew）翻成 amsg2 真名后，
 * 交给注入的 amsg2Execute。缝缺席 = 没接上（降级），回确定性文案而不是抛。
 * executeAmsg2Tool 自身从不抛、返回的也是给模型读的完整文本（含它自带的收尾/去重话），
 * 这里原样透传；长度由 directorClient 的中央 2000 截断负责。
 */
async function runScheduleTool(
    realName: string,
    args: Record<string, unknown>,
    extra: AirpToolExecutorExtras | undefined,
): Promise<AirpToolExecution> {
    const execute = extra?.amsg2Execute;
    if (!execute) return { ok: true, text: TEXT_SCHEDULE_UNAVAILABLE };
    try {
        const text = await execute(realName, args);
        return { ok: true, text: typeof text === 'string' ? text : '' };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, text: `执行失败：${message}` };
    }
}

const utcDateKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * 日记 id 的内容哈希：djb2 → 8 位十六进制。
 *
 * 特意没用 agenticToolFeedback 的 `toolCallFingerprint`：那是「工具名 + 参数」的调用指纹
 * （`name:JSON` 形状，不是字符串哈希），拿它当 `fingerprint(text)` 会把整段正文塞进 id。
 * djb2 短且确定，同一段文本每次都是同一个值——这正是内容寻址去重要求的。
 */
function hashDiaryText(text: string): string {
    let hash = 5381;
    for (let index = 0; index < text.length; index += 1) {
        hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

/**
 * AgenticToolCtx.char 是窄接口（只有 name 等字段，不含 id）；生产侧传进来的是完整
 * CharacterProfile，运行时 id 一定在。id 缺失就不落这条无主日记。
 */
function readCharId(ctx: AgenticToolCtx): string {
    const id = (ctx.char as { id?: unknown }).id;
    return typeof id === 'string' ? id : '';
}

/**
 * 日记 runner：按 Task-19 C1 的约定写角色侧一页——userPage 只是占位空页（grid），
 * charPage 存正文（plain），日期用 UTC 的 YYYY-MM-DD，不写 autoSync（自动同步时代的
 * 字段，这里没有）。空内容不写；DB 失败回文案，绝不抛给 directorClient。
 *
 * id 是内容寻址的：`airp-diary-tool-<UTC日期>-<正文哈希>`。同一天同样正文重复调用会
 * 命中同一个 id、被 IndexedDB 的 put 覆盖成一行（重滚一轮不会留重复日记）；正文变了
 * 或跨了 UTC 天就是新行。
 */
async function runSaveDiary(
    args: Record<string, unknown>,
    ctx: AgenticToolCtx,
): Promise<AirpToolExecution> {
    const text = readArgText(args, 'text').trim();
    if (!text) return { ok: true, text: TEXT_DIARY_NEEDS_TEXT };

    const charId = readCharId(ctx);
    if (!charId) return { ok: false, text: TEXT_DIARY_FAILED };

    const now = Date.now();
    const date = utcDateKey(now);
    try {
        await DB.saveDiary({
            id: `airp-diary-tool-${date}-${hashDiaryText(text)}`,
            charId,
            date,
            userPage: { text: '', paperStyle: 'grid', stickers: [] },
            charPage: { text, paperStyle: 'plain', stickers: [] },
            timestamp: now,
            isArchived: false,
        });
    } catch {
        return { ok: false, text: TEXT_DIARY_FAILED };
    }
    return { ok: true, text: TEXT_DIARY_SAVED };
}

/**
 * 给 `runAirpDirector` 用的工具执行器：把导演请求的工具名翻译真名后交给注入的
 * `dispatchAgenticTool`；天气 / 地点检索 / 日记没有共享面工具，分支到本模块的
 * runner；排程类走调用方注入的 amsg2Execute 缝（真名由主动消息工具桥执行）。
 *
 * `dispatch` 仍由调用方注入：本模块对 agenticTools 只做类型引用（import type），
 * 方便测试与后续换实现。
 */
export function createChatToolExecutor(
    dispatch: typeof DispatchFn,
    ctx: AgenticToolCtx,
    extra?: AirpToolExecutorExtras,
): AirpToolExecutor {
    return {
        async executeTool(toolName: string, args: Record<string, unknown>) {
            const real = CATALOG_TO_REAL[toolName];
            // 未接线 / 打错的名字：抛出去。directorClient 的 resolveToolIntentText 会兜成
            // 「执行失败」，正常路径上走不到（它已先按 AIRP_WIRED_TOOLS 过滤过）。
            if (real === undefined) throw new Error(`Unknown airp catalog tool: ${toolName}`);
            if (real === WEATHER_RUNNER) return runWeatherLookup(args, extra);
            if (real === AMAP_SEARCH_RUNNER) return runAmapSearch(args, extra);
            if (real === SAVE_DIARY_RUNNER) return runSaveDiary(args, ctx);
            if (AIRP_SCHEDULE_REALS.has(real)) return runScheduleTool(real, args, extra);
            try {
                const result = await dispatch(real, args, ctx);
                return { ok: true, text: encodeResult(result) };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return { ok: false, text: `执行失败：${message}` };
            }
        },
    };
}
