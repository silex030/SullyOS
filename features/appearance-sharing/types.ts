/**
 * 网页外观与阅读样式 · 本地可移植包：自有 typed 数据合同。
 *
 * 设计说明：
 * - 只覆盖「明确外观字段」：配色、字体选择、字号、行距、圆角。绝不包含
 *   API/代理/Weibo/session/作者 token/聊天内容，也不含壁纸 blob、自定义图标、
 *   自定义 CSS、字体文件。
 * - 首版仅支持 typed 样式，不支持自定义 CSS（见 package.ts 的拒绝逻辑）。
 *   既有各 App 的用户自定义 CSS / 字体 / 图标 / EPUB 设置走原路径，本模块不碰。
 * - 不修改 Appearance / StudyApp / EpubReader / collaboration 既有 store 或 types。
 */

export const SHARE_PACKAGE_KIND = 'sully-appearance-share' as const;
export const SHARE_SCHEMA_VERSION = 1 as const;

/** 可分享目标：协作界面 + story/date 阅读样式。EPUB 阅读器不在本包范围内。 */
export type ShareTarget = 'collaboration' | 'story-reading' | 'date-reading';

export const SHARE_TARGETS: readonly ShareTarget[] = ['collaboration', 'story-reading', 'date-reading'] as const;

/** 字体只允许预设的安全栈，不允许外链字体 URL（防外部请求）。 */
export type ShareFontFamily = 'sans' | 'serif' | 'rounded' | 'mono';

export const SHARE_FONT_FAMILIES: readonly ShareFontFamily[] = ['sans', 'serif', 'rounded', 'mono'] as const;

/** 字体栈映射：只用系统本地字体，不发起网络请求。 */
export const SHARE_FONT_STACKS: Record<ShareFontFamily, string> = {
  sans: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
  serif: 'Georgia, "Songti SC", "SimSun", serif',
  rounded: '"Yuanti SC", "Rounded Mplus 1c", system-ui, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};

/** 白名单外观字段（上限即全部允许字段）。 */
export interface ReadingStyle {
  background: string;
  foreground: string;
  accent: string;
  fontFamily: ShareFontFamily;
  fontSizePx: number;
  lineHeight: number;
  borderRadiusPx: number;
}

export const READING_STYLE_FIELDS: readonly (keyof ReadingStyle)[] = [
  'background',
  'foreground',
  'accent',
  'fontFamily',
  'fontSizePx',
  'lineHeight',
  'borderRadiusPx',
] as const;

/** 数字字段边界。 */
export const STYLE_NUMERIC_BOUNDS = {
  fontSizePx: { min: 12, max: 24 },
  lineHeight: { min: 1.4, max: 2.2 },
  borderRadiusPx: { min: 0, max: 24 },
} as const;

export interface SharePackage {
  kind: typeof SHARE_PACKAGE_KIND;
  schemaVersion: typeof SHARE_SCHEMA_VERSION;
  target: ShareTarget;
  style: ReadingStyle;
  exportedAt: number;
  label?: string;
}

export type ParseShareResult =
  | { ok: true; target: ShareTarget; style: ReadingStyle; label?: string }
  | { ok: false; error: string; style?: undefined; target?: undefined };
