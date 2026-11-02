/**
 * 结构化 API 错误的展示回归。
 *
 * 现状痛点：非 2xx 时只取 `data.error.message`，没有 message 的结构化错误
 * （只带 code/type/param/detail 的代理、FastAPI 风格、Anthropic 风格）会被整对象
 * 塞进模板字符串，用户看到的是 `[object Object]`，等于没有任何诊断信息。
 *
 * 约束（保持与本文件相关调用点兼容）：
 *  - 错误文本仍以 `API Error <status>` 开头（StoryTheater / claudeProxyCompat 依赖这个前缀）
 *  - 聊天补全端点仍然 0 自动重试；其它端点重试策略不变
 *  - 服务端回显的凭据（sk-… / Bearer …）不得出现在错误文本里
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

const failureOf = async (url: string, status: number, body: unknown, maxRetries = 0): Promise<Error> => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(body, status)));
    try {
        await safeFetchJson(url, { method: 'POST', body: '{}' }, maxRetries);
    } catch (error) {
        return error as Error;
    }
    throw new Error('预期 safeFetchJson 抛错，实际成功返回');
};

describe('结构化 API 错误展示', () => {
    it('读出 message/type/code/param，不再显示 [object Object]', async () => {
        const error = await failureOf('https://api.test/v1/embeddings', 400, {
            error: {
                message: '模型不存在',
                type: 'invalid_request_error',
                param: 'model',
                code: 'model_not_found',
            },
        });

        expect(error.message.startsWith('API Error 400')).toBe(true);
        expect(error.message).toContain('模型不存在');
        expect(error.message).toContain('invalid_request_error');
        expect(error.message).toContain('model_not_found');
        expect(error.message).toContain('model');
        expect(error.message).not.toContain('[object Object]');
    });

    it('只有 code/type、没有 message 时仍给出可读诊断', async () => {
        const error = await failureOf('https://api.test/v1/embeddings', 422, {
            error: { type: 'invalid_request_error', code: 'unsupported_parameter' },
        });

        expect(error.message).toContain('API Error 422');
        expect(error.message).toContain('unsupported_parameter');
        expect(error.message).not.toContain('[object Object]');
    });

    it('detail 字段被读出（FastAPI 风格代理）', async () => {
        const error = await failureOf('https://api.test/v1/chat/completions', 403, {
            detail: '该 Key 没有访问此模型的权限',
        });

        expect(error.message).toContain('该 Key 没有访问此模型的权限');
        expect(error.message).not.toContain('[object Object]');
    });

    it('顶层 message+code 形态也能读（非 error 包裹的代理）', async () => {
        const error = await failureOf('https://api.test/v1/embeddings', 429, {
            message: '请求太频繁',
            code: 42901,
        });

        expect(error.message).toContain('请求太频繁');
        expect(error.message).toContain('42901');
        expect(error.message).not.toContain('[object Object]');
    });

    it('服务端回显的凭据不会进错误文本', async () => {
        const error = await failureOf('https://api.test/v1/embeddings', 401, {
            error: {
                message: 'Incorrect API key provided: sk-live-abc123def456. 请求头携带 Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
                type: 'invalid_request_error',
                code: 'invalid_api_key',
            },
        });

        expect(error.message).not.toContain('sk-live-abc123def456');
        expect(error.message).not.toContain('eyJhbGciOiJIUzI1NiJ9');
        expect(error.message).toContain('invalid_api_key');
        expect(error.message).toContain('API Error 401');
    });

    it('聊天补全端点 5xx 仍然 0 自动重试（计费语义不变）', async () => {
        const fetchMock = vi.fn(async () => jsonResponse({ error: { message: 'upstream boom' } }, 500));
        vi.stubGlobal('fetch', fetchMock);

        await expect(
            safeFetchJson('https://api.test/v1/chat/completions', { method: 'POST', body: '{}' }, 3),
        ).rejects.toThrow('API Error 500');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('非聊天端点仍按原策略重试（不改重试次数）', async () => {
        const fetchMock = vi.fn(async () => jsonResponse({ error: { message: 'temporary' } }, 503));
        vi.stubGlobal('fetch', fetchMock);

        await expect(
            safeFetchJson('https://api.test/v1/embeddings', { method: 'POST', body: '{}' }, 1),
        ).rejects.toThrow('API Error 503');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

describe('凭据脱敏与 detail 保留（第 2 轮返工反例，全为合成假值）', () => {
    const SHORT_KEY_VALUE = 'qk9';
    const TOKEN_VALUE = 'SYNTH-FAKE-TOKEN-918273645';
    const QUOTED_VALUE = 'fake quoted secret value 77231';
    const BASIC_VALUE = 'WmZha2U6cGFzczEyMzQ1Ng==';
    const SK_SECRET = 'sk-test-fakesecret1234567890';

    const failureOfText = async (status: number, body: string, contentType?: string): Promise<Error> => {
        vi.stubGlobal('fetch', vi.fn(async () => textResponse(body, status, contentType)));
        try {
            await safeFetchJson('https://api.test/v1/embeddings', { method: 'POST', body: '{}' }, 0);
        } catch (error) {
            return error as Error;
        }
        throw new Error('预期 safeFetchJson 抛错，实际成功返回');
    };

    it('message 与 detail 同时存在时两项都保留（不重复、不丢 detail）', async () => {
        const error = await failureOf('https://api.test/v1/embeddings', 401, {
            error: { message: 'denied', detail: 'quota exhausted' },
        });

        expect(error.message.startsWith('API Error 401')).toBe(true);
        expect(error.message).toContain('denied');
        expect(error.message).toContain('quota exhausted');
    });

    it('短 api_key 标注值也被遮盖（无长度豁免），code 诊断保留', async () => {
        const error = await failureOf('https://api.test/v1/embeddings', 401, {
            error: {
                message: `invalid api_key=${SHORT_KEY_VALUE}`,
                type: 'invalid_request_error',
                code: 'invalid_api_key',
            },
        });

        expect(error.message).not.toContain(SHORT_KEY_VALUE);
        expect(error.message).toContain('invalid_api_key');
        expect(error.message).toContain('invalid_request_error');
        expect(error.message).toContain('API Error 401');
    });

    it('token= 标注值被遮盖（完整值与数字残片都不出现），type 保留', async () => {
        const error = await failureOf('https://api.test/v1/embeddings', 401, {
            error: { message: `token=${TOKEN_VALUE} rejected`, type: 'invalid_request_error' },
        });

        expect(error.message).not.toContain(TOKEN_VALUE);
        expect(error.message).not.toContain('SYNTH-FAKE-TOKEN');
        expect(error.message).not.toContain('918273645');
        expect(error.message).toContain('invalid_request_error');
    });

    it('带引号且含空格的标注值被整体消费（后半段不泄漏）', async () => {
        const error = await failureOf('https://api.test/v1/embeddings', 401, {
            error: { message: `api_key="${QUOTED_VALUE}" invalid` },
        });

        expect(error.message).not.toContain(QUOTED_VALUE);
        expect(error.message).not.toContain('fake quoted');
        expect(error.message).not.toContain('77231');
        expect(error.message).not.toContain('secret value');
    });

    it('Authorization: Basic 值被完整遮盖', async () => {
        const error = await failureOf('https://api.test/v1/embeddings', 401, {
            error: { message: `Authorization: Basic ${BASIC_VALUE} rejected`, code: 'invalid_api_key' },
        });

        expect(error.message).not.toContain(BASIC_VALUE);
        expect(error.message).not.toContain('cGFzczEyMzQ1Ng');
        expect(error.message).toContain('invalid_api_key');
    });

    it('HTML 预览先脱敏后截断（被截断的 sk 短残片不泄漏）', async () => {
        const body = `<html><body>${'-'.repeat(104)}${SK_SECRET}</body></html>`;
        const error = await failureOfText(502, body, 'text/html');

        expect(error.message).not.toContain(SK_SECRET);
        expect(error.message).not.toContain('test-fakesecret');
        expect(error.message).not.toContain('sk-t');
    });

    it('无效 JSON 预览先脱敏后截断（token 值残片不泄漏）', async () => {
        const body = `${'z'.repeat(190)}token=${TOKEN_VALUE}`;
        const error = await failureOfText(500, body, 'text/plain');

        expect(error.message).toContain('API返回了无效JSON');
        expect(error.message).not.toContain(TOKEN_VALUE);
        expect(error.message).not.toContain('918273645');
        expect(error.message).not.toContain('token=SYN');
    });

    it('SSE 空组装预览里的 Basic 凭据被遮盖', async () => {
        const raw = `data: not-json{{{ Authorization: Basic ${BASIC_VALUE} trailing\n`;
        const error = await failureOfText(500, raw, 'text/event-stream');

        expect(error.message).toContain('API流式响应未返回有效数据');
        expect(error.message).not.toContain(BASIC_VALUE);
        expect(error.message).not.toContain('cGFzczEyMzQ1Ng');
    });
});

describe('凭据脱敏第 3 轮：JSON 引号与转义引号边界（全为合成假值）', () => {
    const SHORT_BEARER = 'qk9';
    const ESCAPED_TAIL = '77231';
    const SINGLE_QUOTE_TAIL = '55661';

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

    it('JSON 引号包裹的 Authorization 短 Bearer 被整体遮盖，code 保留', async () => {
        const error = await failureOfJson(401, {
            error: {
                message: JSON.stringify({ Authorization: `Bearer ${SHORT_BEARER}` }),
                code: 'invalid_api_key',
            },
        });

        expect(error.message.startsWith('API Error 401')).toBe(true);
        expect(error.message).not.toContain(SHORT_BEARER);
        expect(error.message).not.toContain(`Bearer ${SHORT_BEARER}`);
        expect(error.message).toContain('invalid_api_key');
    });

    it('含合法转义引号的 api_key 值被整体消费，尾部不泄漏', async () => {
        const error = await failureOfJson(401, {
            error: { message: JSON.stringify({ api_key: `fake "quoted" secret ${ESCAPED_TAIL}` }) },
        });

        expect(error.message).not.toContain('quoted');
        expect(error.message).not.toContain(`secret ${ESCAPED_TAIL}`);
        expect(error.message).not.toContain(ESCAPED_TAIL);
        expect(error.message).toContain('API Error 401');
    });

    it('单引号转义值同样整体消费（对称边界）', async () => {
        const error = await failureOfJson(
            401,
            { error: { message: "api_key='it\\'s fake tail " + SINGLE_QUOTE_TAIL + "'" } },
        );

        expect(error.message).not.toContain(SINGLE_QUOTE_TAIL);
        expect(error.message).not.toContain('fake tail');
        expect(error.message).toContain('API Error 401');
    });

    it('无效 JSON 预览里 JSON 形态 Authorization 短值不泄漏', async () => {
        const body = `${'z'.repeat(150)}${JSON.stringify({ Authorization: `Bearer ${SHORT_BEARER}` })}${'w'.repeat(100)}`;
        const error = await failureOfText(500, body, 'text/plain');

        expect(error.message).toContain('API返回了无效JSON');
        expect(error.message).not.toContain(SHORT_BEARER);
        expect(error.message).not.toContain(`Bearer ${SHORT_BEARER}`);
    });

    it('HTML 预览里转义引号密钥尾部不泄漏', async () => {
        const inner = JSON.stringify({ api_key: `fake "quoted" secret ${ESCAPED_TAIL}` });
        const error = await failureOfText(502, `<html><head><title>Upstream ${inner}</title></head></html>`, 'text/html');

        expect(error.message).toContain('API返回了HTML');
        expect(error.message).not.toContain('quoted');
        expect(error.message).not.toContain(ESCAPED_TAIL);
    });

    it('SSE 预览里 JSON 形态 Authorization 短值不泄漏', async () => {
        const raw = `data: not-json{{{ ${JSON.stringify({ Authorization: `Bearer ${SHORT_BEARER}` })} trailing\n`;
        const error = await failureOfText(500, raw, 'text/event-stream');

        expect(error.message).toContain('API流式响应未返回有效数据');
        expect(error.message).not.toContain(SHORT_BEARER);
    });
});

describe('凭据脱敏第 4 轮：Authorization 完整字段值边界（全为合成假值）', () => {
    const BEARER_TAIL = '88442';
    const DIGEST_USER = 'SYNTHUSER';
    const DIGEST_RESP = 'SYNTHRESPONSE88442';

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

    it('JSON 引号包裹的 Bearer 多词尾部被整体遮盖，code 保留', async () => {
        const error = await failureOfJson(401, {
            error: {
                message: JSON.stringify({ Authorization: `Bearer fake "quoted" tail ${BEARER_TAIL}` }),
                code: 'invalid_api_key',
            },
        });

        expect(error.message.startsWith('API Error 401')).toBe(true);
        expect(error.message).not.toContain('fake');
        expect(error.message).not.toContain('quoted');
        expect(error.message).not.toContain(`tail ${BEARER_TAIL}`);
        expect(error.message).not.toContain(BEARER_TAIL);
        expect(error.message).toContain('invalid_api_key');
    });

    it('明确标注的 Digest Authorization 合成值被整体遮盖', async () => {
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

    it('HTML 预览里 Bearer 多词尾部不泄漏', async () => {
        const inner = JSON.stringify({ Authorization: `Bearer fake "quoted" tail ${BEARER_TAIL}` });
        const error = await failureOfText(502, `<html><head><title>Upstream ${inner}</title></head></html>`, 'text/html');

        expect(error.message).toContain('API返回了HTML');
        expect(error.message).not.toContain('quoted');
        expect(error.message).not.toContain(`tail ${BEARER_TAIL}`);
        expect(error.message).not.toContain(BEARER_TAIL);
    });

    it('无效 JSON 预览里 Digest 合成值不泄漏', async () => {
        const inner = JSON.stringify({
            Authorization: `Digest username="${DIGEST_USER}", response="${DIGEST_RESP}"`,
        });
        const body = `${'z'.repeat(150)}${inner}${'w'.repeat(60)}`;
        const error = await failureOfText(500, body, 'text/plain');

        expect(error.message).toContain('API返回了无效JSON');
        expect(error.message).not.toContain(DIGEST_USER);
        expect(error.message).not.toContain(DIGEST_RESP);
    });

    it('SSE 预览里 Bearer 多词尾部不泄漏', async () => {
        const inner = JSON.stringify({ Authorization: `Bearer fake "quoted" tail ${BEARER_TAIL}` });
        const raw = `data: not-json{{{ ${inner} trailing\n`;
        const error = await failureOfText(500, raw, 'text/event-stream');

        expect(error.message).toContain('API流式响应未返回有效数据');
        expect(error.message).not.toContain('quoted');
        expect(error.message).not.toContain(BEARER_TAIL);
    });

    it('SSE 预览里 Digest 合成值不泄漏', async () => {
        const inner = JSON.stringify({
            Authorization: `Digest username="${DIGEST_USER}", response="${DIGEST_RESP}"`,
        });
        const raw = `data: not-json{{{ ${inner} trailing\n`;
        const error = await failureOfText(500, raw, 'text/event-stream');

        expect(error.message).toContain('API流式响应未返回有效数据');
        expect(error.message).not.toContain(DIGEST_USER);
        expect(error.message).not.toContain(DIGEST_RESP);
    });
});
