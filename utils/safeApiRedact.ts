/**
 * 整字段保守隐藏（conservative-closeout）。
 *
 * 取代 redesign-v1 的值边界 lexer：不再猜测敏感值终点（引号/换行/括号/空
 * token 边界），只要整字段 / 整段 preview 命中任一敏感信号即整段输出中文
 * 固定文案「详情已隐藏」，不保留值前后片段。调用方仍先脱敏后截断。
 *
 * 敏感信号（均为纯检测，不消费边界）：
 *  - 认证头：authorization（含 Proxy-Authorization，大小写不敏感）
 *  - 凭据字段赋值：api_key / access_token / client_secret / password /
 *    passwd / secret / token 后跟可选引号与 `:` / `=`（`code=invalid_api_key`
 *    这类诊断因 key 后无分隔符而不命中，避免误杀兄弟诊断）
 *  - “API key”短语（含空格写法，如 Incorrect API key provided）
 *  - 认证 scheme 词：Bearer / Basic / Digest（单词边界）
 *  - 疑似高风险 token 前缀：sk-/rk-/pk-、gh[pousr]_、AIza、eyJ（短阈值兜底）
 *
 * 无信号的普通错误原文保留；兄弟 code/type/param 由 formatApiError 独立
 * 处理，不受本字段隐藏影响。成功 JSON / 有效 SSE 组装不走本函数。
 */

/** 整字段隐藏时的中文固定文案。 */
export const REDACTED_WHOLE_FIELD = '详情已隐藏';

/** 敏感键集合（对象形态直接整值替换用；比对前统一小写并去掉 -_）。 */
const SENSITIVE_KEYS = new Set([
    'authorization',
    'proxyauthorization',
    'apikey',
    'accesstoken',
    'clientsecret',
    'password',
    'passwd',
    'secret',
    'token',
]);

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[-_]/g, '');
const isSensitiveKey = (key: string): boolean => SENSITIVE_KEYS.has(normalizeKey(key));

/** 1. 认证头（含 Proxy-Authorization）：出现即整段隐藏，不问 scheme/引号/换行。 */
const AUTH_LABEL_RE = /authorization/i;
/** 2. “API key”空格写法（Incorrect API key provided 等），下划线写法走赋值规则以免误杀 code。 */
const API_KEY_PHRASE_RE = /api\s+key/i;
/** 3. 凭据字段赋值：key 后必须有 : 或 =，`invalid_api_key` 裸值不命中。
 * 允许 key 与分隔符之间夹带反斜杠/引号（双重转义 JSON 如 \\"api_key\\": 仍命中）。 */
const LABELED_ASSIGN_RE =
    /(?:api[_-]?key|access[_-]?token|client[_-]?secret|passw(?:or)?d|secret|token)\s*[\\"']*\s*[:=]/i;
const LABELED_ASSIGN_FLAT_RE =
    /(?:api[_-]?key|access[_-]?token|client[_-]?secret|passw(?:or)?d|secret|token)\s*["']?\s*[:=]/i;
/** 4. 认证 scheme 词：出现即视为凭据上下文。 */
const AUTH_SCHEME_RE = /\b(?:bearer|basic|digest)\b/i;
/** 5. 无标注高风险前缀兜底（短阈值，普通诊断文本不含此类形状）。 */
const HIGH_RISK_PREFIX_RE =
    /(?:\b(?:sk|rk|pk)-[A-Za-z0-9_\-]{2,}|\bgh[pousr]_[A-Za-z0-9]{2,}|\bAIza[A-Za-z0-9_\-]{2,}|\beyJ[A-Za-z0-9_\-]{2,})/i;

function hasSensitiveSignal(text: string): boolean {
    if (AUTH_LABEL_RE.test(text)) return true;
    if (API_KEY_PHRASE_RE.test(text)) return true;
    if (LABELED_ASSIGN_RE.test(text)) return true;
    // 双重转义 JSON（\\"api_key\\":）去反斜杠后再判一次，防转义夹带漏检。
    if (text.includes('\\') && LABELED_ASSIGN_FLAT_RE.test(text.replace(/\\+/g, ''))) return true;
    if (AUTH_SCHEME_RE.test(text)) return true;
    if (HIGH_RISK_PREFIX_RE.test(text)) return true;
    return false;
}

/**
 * 错误文本脱敏统一入口（纯函数）：命中敏感信号即整段返回「详情已隐藏」，
 * 否则原文返回。调用方在脱敏完成后才截断。
 */
export function redactApiErrorText(text: string, _depth?: number): string {
    if (typeof text !== 'string' || text.length === 0) return text;
    return hasSensitiveSignal(text) ? REDACTED_WHOLE_FIELD : text;
}

/**
 * 结构化值递归脱敏（纯函数，保持旧导出约定）：
 * 敏感 key 整值替换；字符串走整字段判定；数组/对象递归。
 */
export function redactStructuredValue(value: unknown, depth: number = 0): unknown {
    if (depth > 20) return REDACTED_WHOLE_FIELD;
    if (Array.isArray(value)) return value.map(item => redactStructuredValue(item, depth + 1));
    if (value !== null && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value)) {
            out[key] = isSensitiveKey(key) ? REDACTED_WHOLE_FIELD : redactStructuredValue(entry, depth + 1);
        }
        return out;
    }
    if (typeof value === 'string') return redactApiErrorText(value, depth + 1);
    return value;
}
