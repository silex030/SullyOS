/**
 * 可移植外观包的构建与导入校验（纯逻辑，无网络、无存储副作用）。
 *
 * 安全边界：
 * - JSON 包上限 64KB，超大直接拒绝；
 * - 白名单字段过滤，未知字段（含 apiKey/session/token/聊天内容/customCss/壁纸等）一律丢弃；
 * - 禁止原型污染：跳过 __proto__/constructor/prototype 键；
 * - 颜色只接受 hex / rgb() / hsl() 安全形式；数字越界即整包拒绝（不静默钳制，避免用户误以为已应用）；
 * - 首版仅支持 typed 样式：包内出现 customCss/customCssUrl 等直接拒绝并指引既有路径。
 */

export type { ParseShareResult, SharePackage } from './types';
import {
  SHARE_PACKAGE_KIND,
  SHARE_SCHEMA_VERSION,
  SHARE_TARGETS,
  SHARE_FONT_FAMILIES,
  READING_STYLE_FIELDS,
  STYLE_NUMERIC_BOUNDS,
  type ShareTarget,
  type ReadingStyle,
  type SharePackage,
  type ParseShareResult,
} from './types';

/** 导入包体积上限：64KB。样式包正常只有 ~1KB，超限视为异常。 */
export const MAX_SHARE_PACKAGE_BYTES = 64 * 1024;

/** 首版不支持、且必须明确拒绝的自定义 CSS 相关键。 */
const CUSTOM_CSS_KEYS = new Set(['customCss', 'customcss', 'customCssUrl', 'stylesheet', 'cssText']);

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const RGB_COLOR = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/;
const HSL_COLOR = /^hsla?\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/;

function isSafeColor(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length > 64) return false;
  return HEX_COLOR.test(v) || RGB_COLOR.test(v) || HSL_COLOR.test(v);
}

function isShareTarget(value: unknown): value is ShareTarget {
  return typeof value === 'string' && (SHARE_TARGETS as readonly string[]).includes(value);
}

function fail(error: string): ParseShareResult {
  return { ok: false, error };
}

/**
 * 对版本号做安全展示：绝不调用 String() / 模板插值处理任意对象
 *（schemaVersion={toString:null} 会让 String() 抛 TypeError）。
 */
function formatVersionForError(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v)) return `v${v}`;
  if (typeof v === 'string' && v.length > 0 && v.length <= 20) return `v${v}`;
  return '未知版本';
}

/** UTF-8 字节长度（64KB 上限按字节执行；中文 1 字=3 字节）。 */
function utf8ByteLength(text: string): number {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    // 极端环境无 TextEncoder 时退化为 code unit 长度（只会更宽松，不会更严）。
    return text.length;
  }
}

/**
 * 从任意输入中按白名单提取并校验样式；返回错误信息（中文）或干净样式。
 *
 * 注意：只浅读 7 个白名单字段与顶层自定义 CSS 键，不递归未知值。
 * 未知字段（含深层嵌套/大文本）直接忽略，无栈溢出风险，也无原型污染面
 *（从不以未知键写入对象，白名单键均为安全字面量）。
 */
function sanitizeStyle(input: unknown): { style?: ReadingStyle; error?: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { error: '分享包里的样式不是有效的对象' };
  }
  const src = input as Record<string, unknown>;

  const ownKeys: string[] = Object.keys(src);
  for (const key of ownKeys) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const lower = key.toLowerCase();
    if (CUSTOM_CSS_KEYS.has(key) || CUSTOM_CSS_KEYS.has(lower)) {
      return {
        error: '首版仅支持预设外观字段，不支持自定义 CSS；已有各 App 的自定义 CSS 请继续走原设置路径',
      };
    }
  }

  const style: Record<string, unknown> = {};
  for (const field of READING_STYLE_FIELDS) {
    const value = (src as Record<string, unknown>)[field];
    if (value === undefined) return { error: `样式缺少字段：${field}` };
    style[field] = value;
  }

  for (const colorField of ['background', 'foreground', 'accent'] as const) {
    if (!isSafeColor(style[colorField])) return { error: `颜色字段不合法：${colorField}（仅支持 #hex / rgb() / hsl()）` };
  }
  if (!SHARE_FONT_FAMILIES.includes(style.fontFamily as any)) {
    return { error: '字体选择不合法（仅支持 sans / serif / rounded / mono）' };
  }
  const numericChecks: Array<{ field: 'fontSizePx' | 'lineHeight' | 'borderRadiusPx'; label: string }> = [
    { field: 'fontSizePx', label: '字号' },
    { field: 'lineHeight', label: '行距' },
    { field: 'borderRadiusPx', label: '圆角' },
  ];
  for (const { field, label } of numericChecks) {
    const v = style[field];
    if (typeof v !== 'number' || !Number.isFinite(v)) return { error: `${label}必须是数字` };
    const { min, max } = STYLE_NUMERIC_BOUNDS[field];
    if (v < min || v > max) return { error: `${label}超出允许范围（${min}～${max}）` };
  }

  return { style: style as unknown as ReadingStyle };
}

/** 构建本地分享包（调用方只传入白名单字段；多余字段不会被读取）。 */
export function buildSharePackage(style: ReadingStyle, target: ShareTarget, label?: string): SharePackage {
  const clean: ReadingStyle = {
    background: style.background,
    foreground: style.foreground,
    accent: style.accent,
    fontFamily: style.fontFamily,
    fontSizePx: style.fontSizePx,
    lineHeight: style.lineHeight,
    borderRadiusPx: style.borderRadiusPx,
  };
  const pkg: SharePackage = {
    kind: SHARE_PACKAGE_KIND,
    schemaVersion: SHARE_SCHEMA_VERSION,
    target,
    style: clean,
    exportedAt: Date.now(),
  };
  if (label !== undefined) pkg.label = String(label).slice(0, 80);
  return pkg;
}

/** 导出为可下载的 JSON 文本。 */
export function serializeSharePackage(pkg: SharePackage): string {
  return JSON.stringify(pkg, null, 2);
}

/**
 * 导入校验：损坏 / 超大 / 未知版本 / 非法目标 / 非法样式一律中文错误，
 * 且失败时不返回任何样式（调用方不得覆盖旧设置）。
 * 永不抛出：任何意外（含 JSON.parse 深层嵌套栈溢出）都转为中文失败结果。
 */
export function parseSharePackage(text: unknown): ParseShareResult {
  try {
    if (typeof text !== 'string') return fail('请选择分享包文件');
    if (text.length === 0) return fail('文件是空的，请重新选择分享包');
    if (utf8ByteLength(text) > MAX_SHARE_PACKAGE_BYTES) {
      return fail(`分享包过大（上限 ${MAX_SHARE_PACKAGE_BYTES / 1024}KB，按 UTF-8 字节计算），已拒绝导入，当前设置未改变`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return fail('文件不是有效的 JSON，无法导入；当前设置未改变');
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return fail('分享包格式不正确，无法导入；当前设置未改变');
    }
    const obj = raw as Record<string, unknown>;
    if (obj.kind !== SHARE_PACKAGE_KIND) return fail('这不是外观分享包（kind 不匹配），已拒绝导入；当前设置未改变');
    if (obj.schemaVersion !== SHARE_SCHEMA_VERSION) {
      return fail(
        `不支持的分享包版本（${formatVersionForError(obj.schemaVersion)}），当前仅支持 v${SHARE_SCHEMA_VERSION}；请用新版重新导出；当前设置未改变`,
      );
    }
    if (!isShareTarget(obj.target)) return fail('分享包的目标页不合法（仅支持 collaboration / story-reading / date-reading）；当前设置未改变');
    const checked = sanitizeStyle(obj.style);
    if (!checked.style) return fail(`${checked.error}；当前设置未改变`);
    const label = typeof obj.label === 'string' ? obj.label.slice(0, 80) : undefined;
    return { ok: true, target: obj.target, style: checked.style, label };
  } catch {
    return fail('分享包解析失败（内容异常），已拒绝导入；当前设置未改变');
  }
}
