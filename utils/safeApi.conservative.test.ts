/**
 * conservative-closeout：整字段保守隐藏（全为合成假值）。
 *
 * 覆盖 review #198 / 评论 #201 两类实际反例：
 *  - 带单双引号未闭合 Authorization / Proxy-Authorization（LF / CRLF / 转义）
 *  - api_key=(...)、token=<...> 等歧义起始及空 token
 * 经 formatApiError（结构化）及 HTML / 无效 JSON / 无有效 SSE 三条 preview，
 * 断言完整合成值与尾部标记均不出现，兄弟 code/type 仍在；整字段退化为中文
 * 「详情已隐藏」，不再保留值前后片段、不猜引号/换行/括号边界。
 * 另含干净错误与成功 JSON / 有效 SSE 控制各一个。
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

describe('conservative-closeout 整字段隐藏（合成假值）', () => {
    const AUTH_TAIL_LF = '77001';
    const AUTH_TAIL_CRLF = '77002';
    const AUTH_TAIL_ESC = '77003';
    const BRACE_TAIL = '77004';
    const ANGLE_TAIL = '77005';

    it('C1 format：双引号未闭合 Authorization（LF）整字段隐藏，code/type 保留', async () => {
        const error = await failureOfJson(401, {
            error: {
                message: `Authorization: "first\nsecretTAIL${AUTH_TAIL_LF}`,
                code: 'invalid_api_key',
                type: 'auth_error',
            },
        });
        expect(error.message.startsWith('API Error 401')).toBe(true);
        expect(error.message).not.toContain(`secretTAIL${AUTH_TAIL_LF}`);
        expect(error.message).not.toContain(AUTH_TAIL_LF);
        expect(error.message).not.toContain('first');
        expect(error.message).toContain('详情已隐藏');
        expect(error.message).toContain('invalid_api_key');
        expect(error.message).toContain('auth_error');
    });

    it('C2 format：单引号未闭合 Proxy-Authorization（CRLF）整字段隐藏', async () => {
        const error = await failureOfJson(401, {
            error: {
                message: `Proxy-Authorization: 'first\r\nsecretTAIL${AUTH_TAIL_CRLF}`,
                code: 'invalid_api_key',
                type: 'auth_error',
            },
        });
        expect(error.message).not.toContain(`secretTAIL${AUTH_TAIL_CRLF}`);
        expect(error.message).not.toContain(AUTH_TAIL_CRLF);
        expect(error.message).toContain('详情已隐藏');
        expect(error.message).toContain('invalid_api_key');
        expect(error.message).toContain('auth_error');
    });

    it('C3 format：转义引号 Authorization 整字段隐藏', async () => {
        const error = await failureOfJson(401, {
            error: {
                message: `Authorization: "esc \\"q\\" tail secretTAIL${AUTH_TAIL_ESC}`,
                code: 'invalid_api_key',
            },
        });
        expect(error.message).not.toContain(`secretTAIL${AUTH_TAIL_ESC}`);
        expect(error.message).not.toContain(AUTH_TAIL_ESC);
        expect(error.message).toContain('详情已隐藏');
        expect(error.message).toContain('invalid_api_key');
    });

    it('C4 format：api_key=(...) 歧义起始整字段隐藏，空 token 同样隐藏', async () => {
        const error = await failureOfJson(401, {
            error: {
                message: `api_key=(secretVAL${BRACE_TAIL})`,
                code: 'invalid_api_key',
            },
        });
        expect(error.message).not.toContain(`secretVAL${BRACE_TAIL}`);
        expect(error.message).not.toContain(BRACE_TAIL);
        expect(error.message).toContain('详情已隐藏');
        expect(error.message).toContain('invalid_api_key');

        const emptyErr = await failureOfJson(401, {
            error: { message: 'api_key=', code: 'invalid_api_key' },
        });
        expect(emptyErr.message).toContain('详情已隐藏');
        expect(emptyErr.message).toContain('invalid_api_key');
    });

    it('C5 format：token=<...> 歧义起始整字段隐藏，空 token 同样隐藏', async () => {
        const error = await failureOfJson(401, {
            error: {
                message: `token=<secretVAL${ANGLE_TAIL}>`,
                type: 'invalid_request_error',
            },
        });
        expect(error.message).not.toContain(`secretVAL${ANGLE_TAIL}`);
        expect(error.message).not.toContain(ANGLE_TAIL);
        expect(error.message).toContain('详情已隐藏');
        expect(error.message).toContain('invalid_request_error');

        const emptyErr = await failureOfJson(401, {
            error: { message: 'token=', type: 'invalid_request_error' },
        });
        expect(emptyErr.message).toContain('详情已隐藏');
    });

    it('C6 HTML preview：未闭合 Authorization 尾部不泄漏', async () => {
        const error = await failureOfText(
            502,
            `<html><head><title>Upstream Authorization: "first\nsecretTAIL${AUTH_TAIL_LF} end</title></head></html>`,
            'text/html',
        );
        expect(error.message).toContain('API返回了HTML');
        expect(error.message).not.toContain(`secretTAIL${AUTH_TAIL_LF}`);
        expect(error.message).not.toContain(AUTH_TAIL_LF);
        expect(error.message).toContain('详情已隐藏');
    });

    it('C7 invalidJSON preview：Proxy 单引号 CRLF 尾部不泄漏', async () => {
        const error = await failureOfText(
            500,
            `upstream failure Proxy-Authorization: 'first\r\nsecretTAIL${AUTH_TAIL_CRLF} tail`,
            'text/plain',
        );
        expect(error.message).toContain('API返回了无效JSON');
        expect(error.message).not.toContain(`secretTAIL${AUTH_TAIL_CRLF}`);
        expect(error.message).not.toContain(AUTH_TAIL_CRLF);
        expect(error.message).toContain('详情已隐藏');
    });

    it('C8 SSE preview：转义 Authorization 尾部不泄漏', async () => {
        const raw = `data: not-json Authorization: "esc \\"q\\" tail secretTAIL${AUTH_TAIL_ESC} trailing\n`;
        const error = await failureOfText(500, raw, 'text/event-stream');
        expect(error.message).toContain('API流式响应未返回有效数据');
        expect(error.message).not.toContain(`secretTAIL${AUTH_TAIL_ESC}`);
        expect(error.message).not.toContain(AUTH_TAIL_ESC);
        expect(error.message).toContain('详情已隐藏');
    });

    it('C9 HTML preview：api_key 歧义起始不泄漏', async () => {
        const error = await failureOfText(
            502,
            `<html><head><title>Upstream api_key=(secretVAL${BRACE_TAIL}) end</title></head></html>`,
            'text/html',
        );
        expect(error.message).toContain('API返回了HTML');
        expect(error.message).not.toContain(`secretVAL${BRACE_TAIL}`);
        expect(error.message).not.toContain(BRACE_TAIL);
        expect(error.message).toContain('详情已隐藏');
    });

    it('C10 invalidJSON+SSE preview：token 歧义起始不泄漏', async () => {
        const bad = await failureOfText(500, `bad upstream token=<secretVAL${ANGLE_TAIL}> tail`, 'text/plain');
        expect(bad.message).toContain('API返回了无效JSON');
        expect(bad.message).not.toContain(ANGLE_TAIL);
        expect(bad.message).toContain('详情已隐藏');

        const raw = `data: not-json token=<secretVAL${ANGLE_TAIL}> trailing\n`;
        const sse = await failureOfText(500, raw, 'text/event-stream');
        expect(sse.message).toContain('API流式响应未返回有效数据');
        expect(sse.message).not.toContain(ANGLE_TAIL);
        expect(sse.message).toContain('详情已隐藏');
    });

    it('C11 控制：干净错误原文保留，不误隐藏', async () => {
        const error = await failureOfJson(401, {
            error: { message: 'denied by policy', detail: 'quota exhausted', type: 'policy_error' },
        });
        expect(error.message).toContain('denied by policy');
        expect(error.message).toContain('quota exhausted');
        expect(error.message).toContain('policy_error');
        expect(error.message).not.toContain('详情已隐藏');
        expect(error.message.startsWith('API Error 401')).toBe(true);
    });

    it('C12 控制：成功 JSON 与有效 SSE 不被脱敏吞掉', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ choices: [{ message: { content: '正常模型回复' } }] }, 200)));
        const data: any = await safeFetchJson('https://api.test/v1/chat/completions', { method: 'POST', body: '{}' }, 0);
        expect(data.choices[0].message.content).toBe('正常模型回复');

        const sseBody = (events: string[]) => new ReadableStream<Uint8Array>({
            start(controller) {
                const enc = new TextEncoder();
                for (const e of events) controller.enqueue(enc.encode(e));
                controller.close();
            },
        });
        const sseResp = new Response(sseBody([
            'data: {"choices":[{"delta":{"content":"有效流式正文"}}]}\n\n',
            'data: [DONE]\n',
        ]), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        vi.stubGlobal('fetch', vi.fn(async () => sseResp));
        const sseData: any = await safeFetchJson('https://api.test/v1/chat/completions', { method: 'POST', body: '{}' }, 0);
        expect(sseData.choices[0].message.content).toBe('有效流式正文');
    });
});
