/**
 * 角色自主出行 · 前端隐私层（B4）
 *
 * 一条硬线：坐标与原始 `address` 只允许活在地图渲染层（`components/travel/TravelMapCanvas`）。
 * 任何要离开那一层的对象（提示词、日志、备份、聊天卡片、诊断）都必须先过这里。
 *
 * 为什么是「结构性白名单」而不是正则清洗：
 * - `stripLocationFieldsDeep` 按字段名删，不靠「看起来像坐标」猜；
 * - `maskPlaceForPrompt` 只出 `label/city/district`，输入里的 address/lat/lng 根本不读；
 * - 文本级检测（`scanTextForLeak`）只作为最后一道断言，用来发现上游把坐标拼进句子的情况，
 *   有问题就整段拒绝（fail-closed），不做「悄悄替换成 ***」那种看起来成功的处理。
 */
import { sanitizeAnchorLabel, type MaskedPlace } from './core';

/** 一律不得出现在提示词 / 日志 / 备份里的字段名（大小写不敏感）。 */
const FORBIDDEN_KEYS = new Set([
    'lat',
    'lng',
    'latitude',
    'longitude',
    'coordsys',
    'coord_sys',
    'address',
    'addressline',
    'formattedaddress',
    'position',
    'route',
    'routeline',
    'polyline',
    'history',
    'trail',
    'path',
    'adcode',
]);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 深拷贝并删除所有位置字段。保留地名、阶段、时间与预算（这些不属于坐标隐私）。
 * 不修改入参。
 */
export const stripLocationFieldsDeep = <T>(value: T): T => {
    const walk = (node: unknown): unknown => {
        if (Array.isArray(node)) return node.map(walk);
        if (!isPlainObject(node)) return node;
        const out: Record<string, unknown> = {};
        for (const [key, v] of Object.entries(node)) {
            if (FORBIDDEN_KEYS.has(key.toLowerCase())) continue;
            out[key] = walk(v);
        }
        return out;
    };
    return walk(value) as T;
};

/** 小数坐标对（3 位以上小数）：模型/日志文本里出现就是泄露。 */
const COORD_PAIR = /-?\d{1,3}\.\d{3,}\s*[,，]\s*-?\d{1,3}\.\d{3,}/;
/** 带标签的单个坐标（`lat: 30.1234` / `纬度 30.1234`）。 */
const COORD_LABELLED = /(?:lat|lng|latitude|longitude|纬度|经度)\s*[:：=]?\s*-?\d{1,3}\.\d{2,}/i;

export const containsDecimalCoordinates = (text: string): boolean => {
    const s = String(text ?? '');
    return COORD_PAIR.test(s) || COORD_LABELLED.test(s);
};

/** 住户级细节：栋/幢/单元/层/室/房/户 + 「N号楼M」+ 门牌。公共门牌不在此列。 */
const HOUSEHOLD = /\d+\s*(栋|幢|单元|层|室|房|户)|\d+\s*号楼\s*\d+|门牌/;

export const containsHouseholdDetail = (text: string): boolean => HOUSEHOLD.test(String(text ?? ''));

export type LeakReason = 'COORDINATES' | 'HOUSEHOLD_DETAIL';

/** 扫描一段要离开渲染层的文本，返回所有命中的原因（空数组 = 干净）。 */
export const scanTextForLeak = (text: string): LeakReason[] => {
    const s = String(text ?? '');
    const reasons: LeakReason[] = [];
    if (containsDecimalCoordinates(s)) reasons.push('COORDINATES');
    if (containsHouseholdDetail(s)) reasons.push('HOUSEHOLD_DETAIL');
    return reasons;
};

export type PromptSafeResult =
    | { ok: true; text: string }
    | { ok: false; reasons: LeakReason[] };

/**
 * 断言发给模型的文本干净。命中就整段拒绝 —— 调用方必须降级成「本次不注入」，
 * 而不是删掉半句继续发（半句可能已经把「在哪」说出来了）。
 */
export const assertPromptSafe = (text: string): PromptSafeResult => {
    const s = String(text ?? '').trim();
    const reasons = scanTextForLeak(s);
    if (reasons.length) return { ok: false, reasons };
    return { ok: true, text: s };
};

/**
 * 地点 → 提示词可用的语义。住户级 label 直接丢掉（只留城市），
 * 因为「阳光花园5号楼2单元」这种字符串本身就是地址。
 */
export const maskPlaceForPrompt = (place: {
    label?: string;
    name?: string;
    city?: string;
    district?: string;
    address?: string;
    lat?: number;
    lng?: number;
}): MaskedPlace => {
    const rawLabel = String(place?.label ?? place?.name ?? '').trim();
    const city = String(place?.city ?? '').trim();
    const district = String(place?.district ?? '').trim();
    const checked = rawLabel ? sanitizeAnchorLabel(rawLabel) : null;
    const label = checked && checked.ok ? checked.label : '';
    const out: MaskedPlace = { label, city };
    if (district) out.district = district;
    return out;
};

/** 锚点（含 lat/lng/coordSys）→ 提示词视图。结构上只有三个字段。 */
export const maskAnchorForPrompt = (anchor: {
    label?: string;
    city?: string;
    district?: string;
    lat?: number;
    lng?: number;
    coordSys?: string;
    precision?: string;
    confirmedAt?: number;
    source?: string;
}): MaskedPlace => maskPlaceForPrompt(anchor);
