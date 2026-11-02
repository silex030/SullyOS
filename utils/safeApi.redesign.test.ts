/**
 * redesign-v1 A：字段边界解析和安全错误展示的契约测试（全为合成假值）。
 *
 * 覆盖：审查 #173 两类反例（Bearer 多词尾部、Digest 合成值）+ 短值/混合转义/
 * 未知 scheme/嵌套转义 JSON/未闭合截断/Proxy-Authorization/字段间隔离。
 * 断言：完整合成值与独立尾部标记都不出现；独立 code/type 仍在；
 * 无法安全判定尾部时出现中文「详情已隐藏」。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { safeFetchJson } from './safeApi';

const jsonResponse = (body: unknown, status: number) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
});

const textResponse = (body: string, status: number, contentType = 'text/plain') => new Response(body, {
    status,
    headers: { 'Content-Type': contentType },
});

afterEach(() => vi.restoreAllMocks());

const failureOfJson = async (status: number, body: unknown): Promise<Error> => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(body, status)));
    try {
        await safeFetchJson('https://api.test/v1/embeddings', { method: 'POST', body: '{}' }, 0);
    } catch (error) {
        return error as Error;
    }
    throw new Error('预期 safeFetchJson 抛错，实际成功返回');
};

const failureOfText = async (status: number, body: string, contentType?: string): Promise<Error> => {
    vi.stubGlobal('fetch', vi.fn(async () => textResponse(body, status, contentType)));
    try {
        await safeFetchJson('https://api.test/v1/embeddings', { method: 'POST', body: '{}' }, 0);
    } catch (error) {
        return error as Error;
    }
    throw new Error('预期 safeFetchJson 抛错，实际成功返回');
};

describe('redesign-v1 A：字段边界脱敏（全为合成假值）', () => {
    const BEARER_TAIL = '88442';
    const DIGEST_USER = 'SYNTHUSER';
    const DIGEST_RESP = 'SYNTHRESPONSE88442';
    const UNKNOWN_TAIL = '99117';
    const NEST_TAIL = '66554';
    const UNCLOSED_TAIL = '77331';

    it('R173-1：JSON 引号 Bearer 多词尾部整体遮盖，code 保留', async () => {
        const error = await failureOfJson(401, {
            error: {
                message: JSON.stringify({ Authorization: `Bearer fake "quoted" tail ${BEARER_TAIL}` }),
                code: 'invalid_api_key',
            },
        });

        expect(error.message.startsWith('API Error 401')).toBe(true);
        expect(error.message).not.toContain('quoted');
        expect(error.message).not.toContain(`tail ${BEARER_TAIL}`);
        expect(error.message).not.toContain(BEARER_TAIL);
        expect(error.message).toContain('invalid_api_key');
    });

    it('R173-2：明确标注 Digest 合成值整体遮盖', async () => {
        const error = await failureOfJson(401, {
            error: {
                message: JSON.stringify({
                    Authorization: `Digest username="${DIGEST_USER}", response="${DIGEST_RESP}"`,
                }),
                code: 'invalid_api_key',
            },
        });

        expect(error.message.startsWith('API Error 401')).toBe(true);
        expect(error.message).not.toContain(DIGEST_USER);
        expect(error.message).not.toContain(DIGEST_RESP);
        expect(error.message).not.toContain('88442');
        expect(error.message).toContain('invalid_api_key');
    });

    it('未知 scheme 不依赖白名单：Authorization 字段值整体遮盖', async () => {
        const error = await failureOfJson(401, {
            error: {
                message: JSON.stringify({ Authorization: `NewAuthScheme alpha beta ${UNKNOWN_TAIL}` }),
                code: 'invalid_api_key',
            },
        });

        expect(error.message).not.toContain(UNKNOWN_TAIL);
        expect(error.message).not.toContain('NewAuthScheme');
        expect(error.message).not.toContain('alpha beta');
        expect(error.message).toContain('invalid_api_key');
    });

    it('未知 scheme 未加引号头形式同样保守遮盖', async () => {
        const error = await failureOfJson(401, {
            error: {
                message: `Authorization: NewAuthScheme alpha beta ${UNKNOWN_TAIL}`,
                code: 'invalid_api_key',
            },
        });

        expect(error.message).not.toContain(UNKNOWN_TAIL);
        expect(error.message).not.toContain('alpha beta');
        expect(error.message).toContain('invalid_api_key');
    });

    it('嵌套转义 JSON 中的标注凭据被遮盖', async () => {
        const inner = JSON.stringify({ api_key: `nest secret ${NEST_TAIL}` });
        const error = await failureOfJson(401, {
            error: {
                message: `upstream said ${JSON.stringify({ inner })} please retry`,
                code: 'upstream_error',
            },
        });

        expect(error.message).not.toContain(NEST_TAIL);
        expect(error.message).not.toContain('nest secret');
        expect(error.message).toContain('upstream_error');
    });

    it('未闭合引号：不可信片段被丢弃并提示详情已隐藏', async () => {
        const error = await failureOfJson(401, {
            error: {
                message: `api_key="unclosed secret ${UNCLOSED_TAIL}`,
                code: 'invalid_api_key',
            },
        });

        expect(error.message).not.toContain(UNCLOSED_TAIL);
        expect(error.message).not.toContain('unclosed secret');
        expect(error.message).toContain('详情已隐藏');
        expect(error.message).toContain('invalid_api_key');
    });

    it('Proxy-Authorization 按完整字段值遮盖', async () => {
        const error = await failureOfJson(401, {
            error: {
                message: `Proxy-Authorization: Basic cHJveHl0b2tlbi0${UNKNOWN_TAIL}==`,
                code: 'proxy_auth_required',
            },
        });

        expect(error.message).not.toContain(UNKNOWN_TAIL);
        expect(error.message).not.toContain('cHJveHl0b2tlbi0');
        expect(error.message).toContain('proxy_auth_required');
    });

    it('message 尾部遮盖不吞掉兄弟字段 code/type', async () => {
        const error = await failureOfJson(401, {
            error: {
                message: `Authorization: X-Scheme secrettail44112`,
                type: 'auth_error',
                code: 'bad_auth',
            },
        });

        expect(error.message).not.toContain('secrettail44112');
        expect(error.message).toContain('bad_auth');
        expect(error.message).toContain('auth_error');
    });

    it('短 Bearer 无长度豁免（JSON 引号形式）', async () => {
        const error = await failureOfJson(401, {
            error: {
                message: JSON.stringify({ Authorization: 'Bearer qk9' }),
                code: 'invalid_api_key',
            },
        });

        expect(error.message).not.toContain('qk9');
        expect(error.message).toContain('invalid_api_key');
    });

    it('混合转义 api_key 整体消费，尾部不泄漏', async () => {
        const error = await failureOfJson(401, {
            error: { message: JSON.stringify({ api_key: 'fake "quoted" secret 77231' }) },
        });

        expect(error.message).not.toContain('quoted');
        expect(error.message).not.toContain('77231');
        expect(error.message).toContain('API Error 401');
    });

    it('HTML 预览：Digest 与未知 scheme 残片不泄漏', async () => {
        const inner = JSON.stringify({
            Authorization: `Digest username="${DIGEST_USER}", response="${DIGEST_RESP}"`,
        });
        const error = await failureOfText(
            502,
            `<html><head><title>Upstream ${inner} head Authorization: NewAuthScheme alpha ${UNKNOWN_TAIL}</title></head></html>`,
            'text/html',
        );

        expect(error.message).toContain('API返回了HTML');
        expect(error.message).not.toContain(DIGEST_USER);
        expect(error.message).not.toContain(DIGEST_RESP);
        expect(error.message).not.toContain(UNKNOWN_TAIL);
    });

    it('无效 JSON 预览：Bearer 多词尾部与嵌套密钥不泄漏', async () => {
        const inner = JSON.stringify({ Authorization: `Bearer fake "quoted" tail ${BEARER_TAIL}` });
        const body = `${'z'.repeat(150)}${inner} nest ${JSON.stringify({ api_key: `x ${NEST_TAIL}` })}${'w'.repeat(40)}`;
        const error = await failureOfText(500, body, 'text/plain');

        expect(error.message).toContain('API返回了无效JSON');
        expect(error.message).not.toContain(BEARER_TAIL);
        expect(error.message).not.toContain(NEST_TAIL);
    });

    it('SSE 预览：Digest 与未知 scheme 不泄漏', async () => {
        const inner = JSON.stringify({
            Authorization: `Digest username="${DIGEST_USER}", response="${DIGEST_RESP}"`,
        });
        const raw = `data: not-json{{{ ${inner} Authorization: NewAuthScheme zzz ${UNKNOWN_TAIL} trailing\n`;
        const error = await failureOfText(500, raw, 'text/event-stream');

        expect(error.message).toContain('API流式响应未返回有效数据');
        expect(error.message).not.toContain(DIGEST_USER);
        expect(error.message).not.toContain(DIGEST_RESP);
        expect(error.message).not.toContain(UNKNOWN_TAIL);
    });

    it('非敏感诊断原文保留：message/detail/type 共存', async () => {
        const error = await failureOfJson(401, {
            error: { message: 'denied by policy', detail: 'quota exhausted', type: 'policy_error' },
        });

        expect(error.message).toContain('denied by policy');
        expect(error.message).toContain('quota exhausted');
        expect(error.message).toContain('policy_error');
        expect(error.message.startsWith('API Error 401')).toBe(true);
    });
});

describe('redesign-v1 A-2：复审 #198 三类边界（全为合成假值）', () => {
    const AUTH_LT_TAIL = '88442';
    const AUTH_LT_TAIL_CRLF = '88443';
    const UNCLOSED_TAIL_LF = '80811';
    const UNCLOSED_TAIL_CRLF = '80711';
    const TRUNC_TAIL_LF = '80511';
    const TRUNC_TAIL_CRLF = '80611';
    const COMPOSITE_BRACE = '66117';
    const COMPOSITE_BRACKET = '66228';

    it('A2-1a：Authorization 含 < 时遮到行尾，尾部不泄漏，兄弟 code/type 保留', async () => {
        const error = await failureOfJson(401, {
            error: {
                message: `Authorization: Custom first <b>tailMARK${AUTH_LT_TAIL}`,
                code: 'invalid_api_key',
                type: 'auth_error',
            },
        });

        expect(error.message.startsWith('API Error 401')).toBe(true);
        expect(error.message).not.toContain(`tailMARK${AUTH_LT_TAIL}`);
        expect(error.message).not.toContain(AUTH_LT_TAIL);
        expect(error.message).toContain('invalid_api_key');
        expect(error.message).toContain('auth_error');
    });

    it('A2-1b：CRLF 下 Authorization 整字段隐藏（保守 closeout：同字段下一行不再保留）', async () => {
        const error = await failureOfJson(401, {
            error: {
                message: `Authorization: Custom first <i>tailMARK${AUTH_LT_TAIL_CRLF}\r\nnext line stays`,
                code: 'invalid_api_key',
            },
        });

        expect(error.message).not.toContain(`tailMARK${AUTH_LT_TAIL_CRLF}`);
        expect(error.message).not.toContain(AUTH_LT_TAIL_CRLF);
        // 保守整字段隐藏：同属敏感 message 字段的下一行不再保留，只留中文固定文案；
        // 兄弟 code 仍独立保留（formatApiError 按字段分别脱敏）。
        expect(error.message).toContain('详情已隐藏');
        expect(error.message).toContain('invalid_api_key');
    });

    it('A2-1c：HTML title 预览里 Authorization 的 < 尾部不泄漏', async () => {
        const error = await failureOfText(
            502,
            `<html><head><title>Upstream Authorization: Custom first <b>tailMARK${AUTH_LT_TAIL} end</title></head></html>`,
            'text/html',
        );

        expect(error.message).toContain('API返回了HTML');
        expect(error.message).not.toContain(`tailMARK${AUTH_LT_TAIL}`);
        expect(error.message).not.toContain(AUTH_LT_TAIL);
    });

    it('A2-1d：无效 JSON 预览里 Authorization 的 < 尾部不泄漏', async () => {
        const error = await failureOfText(
            500,
            `upstream err Authorization: Custom first <b>tailMARK${AUTH_LT_TAIL} tail`,
            'text/plain',
        );

        expect(error.message).toContain('API返回了无效JSON');
        expect(error.message).not.toContain(`tailMARK${AUTH_LT_TAIL}`);
        expect(error.message).not.toContain(AUTH_LT_TAIL);
    });

    it('A2-1e：SSE 预览里 Authorization 的 < 尾部不泄漏', async () => {
        const raw = `data: not-json Authorization: Custom first <b>tailMARK${AUTH_LT_TAIL} trailing\n`;
        const error = await failureOfText(500, raw, 'text/event-stream');

        expect(error.message).toContain('API流式响应未返回有效数据');
        expect(error.message).not.toContain(`tailMARK${AUTH_LT_TAIL}`);
        expect(error.message).not.toContain(AUTH_LT_TAIL);
    });

    it('A2-2a：未闭合双引号（LF）丢弃剩余不可信片段', async () => {
        const error = await failureOfJson(401, {
            error: {
                message: `api_key="first part UNCLOSED331\nsecond line secretTAIL${UNCLOSED_TAIL_LF}`,
                code: 'invalid_api_key',
            },
        });

        expect(error.message).not.toContain('UNCLOSED331');
        expect(error.message).not.toContain(`secretTAIL${UNCLOSED_TAIL_LF}`);
        expect(error.message).not.toContain(UNCLOSED_TAIL_LF);
        expect(error.message).toContain('详情已隐藏');
        expect(error.message).toContain('invalid_api_key');
    });

    it('A2-2b：未闭合单引号（CRLF）丢弃剩余不可信片段', async () => {
        const error = await failureOfJson(401, {
            error: {
                message: `api_key='single part UNCLOSED332\r\nsecond line secretTAIL${UNCLOSED_TAIL_CRLF}`,
                code: 'invalid_api_key',
            },
        });

        expect(error.message).not.toContain('UNCLOSED332');
        expect(error.message).not.toContain(`secretTAIL${UNCLOSED_TAIL_CRLF}`);
        expect(error.message).not.toContain(UNCLOSED_TAIL_CRLF);
        expect(error.message).toContain('详情已隐藏');
        expect(error.message).toContain('invalid_api_key');
    });

    it('A2-2c：截断 JSON（LF）丢弃剩余不可信片段', async () => {
        const error = await failureOfJson(401, {
            error: {
                message: `{"api_key": "truncated part TRUNC554\nsecretTAIL${TRUNC_TAIL_LF} more`,
                code: 'invalid_api_key',
            },
        });

        expect(error.message).not.toContain('TRUNC554');
        expect(error.message).not.toContain(`secretTAIL${TRUNC_TAIL_LF}`);
        expect(error.message).not.toContain(TRUNC_TAIL_LF);
        expect(error.message).toContain('详情已隐藏');
        expect(error.message).toContain('invalid_api_key');
    });

    it('A2-2d：截断 JSON（CRLF）丢弃剩余不可信片段', async () => {
        const error = await failureOfJson(401, {
            error: {
                message: `{"api_key": "truncated part TRUNC555\r\nsecretTAIL${TRUNC_TAIL_CRLF} more`,
                code: 'invalid_api_key',
            },
        });

        expect(error.message).not.toContain('TRUNC555');
        expect(error.message).not.toContain(`secretTAIL${TRUNC_TAIL_CRLF}`);
        expect(error.message).not.toContain(TRUNC_TAIL_CRLF);
        expect(error.message).toContain('详情已隐藏');
        expect(error.message).toContain('invalid_api_key');
    });

    it('A2-2e：无 title HTML 预览里未闭合引号尾部不泄漏', async () => {
        const error = await failureOfText(
            502,
            `<html><body>ERR api_key="unclosed part TRUNC801\nsecretTAIL80211 tail</body></html>`,
            'text/html',
        );

        expect(error.message).toContain('API返回了HTML');
        expect(error.message).not.toContain('TRUNC801');
        expect(error.message).not.toContain('secretTAIL80211');
        expect(error.message).not.toContain('80211');
        expect(error.message).toContain('详情已隐藏');
    });

    it('A2-2f：无效 JSON 预览里未闭合引号尾部不泄漏', async () => {
        const error = await failureOfText(
            500,
            `upstream failure api_key="unclosed part TRUNC804\nsecretTAIL80411 end`,
            'text/plain',
        );

        expect(error.message).toContain('API返回了无效JSON');
        expect(error.message).not.toContain('TRUNC804');
        expect(error.message).not.toContain('secretTAIL80411');
        expect(error.message).not.toContain('80411');
        expect(error.message).toContain('详情已隐藏');
    });

    it('A2-2g：SSE 预览里未闭合引号尾部不泄漏', async () => {
        const raw = `data: not-json\napi_key="unclosed part TRUNC803\nsecretTAIL80311 trailing\n`;
        const error = await failureOfText(500, raw, 'text/event-stream');

        expect(error.message).toContain('API流式响应未返回有效数据');
        expect(error.message).not.toContain('TRUNC803');
        expect(error.message).not.toContain('secretTAIL80311');
        expect(error.message).not.toContain('80311');
        expect(error.message).toContain('详情已隐藏');
    });

    it('A2-3a：花括号复合值被整体消费，内部残片不泄漏', async () => {
        const error = await failureOfJson(401, {
            error: {
                message: `api_key={nested: "inner", k: "COMPOSITE${COMPOSITE_BRACE}"}`,
                code: 'invalid_api_key',
            },
        });

        expect(error.message.startsWith('API Error 401')).toBe(true);
        expect(error.message).not.toContain(`COMPOSITE${COMPOSITE_BRACE}`);
        expect(error.message).not.toContain(COMPOSITE_BRACE);
        expect(error.message).not.toContain('nested');
        expect(error.message).toContain('invalid_api_key');
    });

    it('A2-3b：方括号复合值被整体消费，内部残片不泄漏', async () => {
        const error = await failureOfJson(401, {
            error: {
                message: `token=[alpha, "COMPOSITE${COMPOSITE_BRACKET}"]`,
                code: 'invalid_api_key',
            },
        });

        expect(error.message).not.toContain(`COMPOSITE${COMPOSITE_BRACKET}`);
        expect(error.message).not.toContain(COMPOSITE_BRACKET);
        expect(error.message).not.toContain('alpha');
        expect(error.message).toContain('invalid_api_key');
    });

    it('A2-3c：未闭合复合值丢弃剩余不可信片段', async () => {
        const error = await failureOfJson(401, {
            error: {
                message: `secret={unclosed COMPOSITE66339\nsecretTAIL66340`,
                code: 'invalid_api_key',
            },
        });

        expect(error.message).not.toContain('COMPOSITE66339');
        expect(error.message).not.toContain('secretTAIL66340');
        expect(error.message).not.toContain('66339');
        expect(error.message).not.toContain('66340');
        expect(error.message).toContain('详情已隐藏');
        expect(error.message).toContain('invalid_api_key');
    });

    it('A2-3d：HTML title 预览里花括号复合值不泄漏', async () => {
        const error = await failureOfText(
            502,
            `<html><head><title>Upstream api_key={k: "v", x: "COMPOSITE66441"} end</title></head></html>`,
            'text/html',
        );

        expect(error.message).toContain('API返回了HTML');
        expect(error.message).not.toContain('COMPOSITE66441');
        expect(error.message).not.toContain('66441');
    });

    it('A2-3e：无效 JSON 预览里花括号复合值不泄漏', async () => {
        const error = await failureOfText(
            500,
            `bad upstream api_key={k: "COMPOSITE66552"} tail end`,
            'text/plain',
        );

        expect(error.message).toContain('API返回了无效JSON');
        expect(error.message).not.toContain('COMPOSITE66552');
        expect(error.message).not.toContain('66552');
    });

    it('A2-3f：SSE 预览里花括号复合值不泄漏', async () => {
        const raw = `data: not-json api_key={k: "COMPOSITE66661"} trailing\n`;
        const error = await failureOfText(500, raw, 'text/event-stream');

        expect(error.message).toContain('API流式响应未返回有效数据');
        expect(error.message).not.toContain('COMPOSITE66661');
        expect(error.message).not.toContain('66661');
    });
});
