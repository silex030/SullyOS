import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchMossVoicePreview, MAX_MOSS_PREVIEW_BYTES } from './genieTts';

const AGENT = 'https://agent.test';

function makeResponse(status: number, body: ArrayBuffer | string, contentType = 'audio/wav') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => (typeof body === 'string' ? new TextEncoder().encode(body).buffer : body),
    text: async () => (typeof body === 'string' ? body : new TextDecoder().decode(body)),
  } as unknown as Response;
}

/**
 * 试听是「选中音色的约 2 秒参考副本」，不是 demo:true 生成，也不是统一示例。
 * 走鉴权主代理，ID 只允许短安全标识符；错误必须说清是哪种失败。
 */
describe('fetchMossVoicePreview：按音色 ID 取 2 秒试听', () => {
  beforeEach(() => {
    localStorage.setItem('os_api_config', JSON.stringify({ agentUrl: `${AGENT}/`, agentToken: 'tok' }));
    vi.stubGlobal('URL', {
      createObjectURL: () => 'blob:preview',
      revokeObjectURL: () => {},
    } as any);
  });
  afterEach(() => {
    localStorage.removeItem('os_api_config');
    vi.unstubAllGlobals();
  });

  it('请求带 token 的预览端点，并 URL 编码音色 ID', async () => {
    const fetchMock = vi.fn(async () => makeResponse(200, new ArrayBuffer(4096)));
    vi.stubGlobal('fetch', fetchMock);
    const out = await fetchMossVoicePreview('ether');
    const [url, init] = fetchMock.mock.calls[0] as any[];
    expect(String(url)).toBe(`${AGENT}/agent/v1/tts/preview?voice=ether`);
    expect(String(url)).not.toContain('test//agent');
    expect((init.headers as Record<string, string>)['X-Client-Token']).toBe('tok');
    expect(out.url).toBe('blob:preview');
    expect(out.blob?.size).toBe(4096);
  });

  it('非法 ID 不发请求（本地先挡路径穿越/空值）', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchMossVoicePreview('../etc/passwd')).rejects.toThrow(/音色/);
    await expect(fetchMossVoicePreview('')).rejects.toThrow(/音色/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('鉴权失败（403）说清是访问权限问题，不提示「没有这个音色」', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(403, '{"error":"unauthorized"}', 'application/json')));
    await expect(fetchMossVoicePreview('ether')).rejects.toThrow(/鉴权|权限/);
  });

  it('404 表示该音色没有试听片段（不套用别的音色）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(404, '{"error":"no_preview"}', 'application/json')));
    await expect(fetchMossVoicePreview('ether')).rejects.toThrow(/试听/);
  });

  it('越界/未注册 ID（409/400）给出明确提示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(409, '{"error":"no_ref_voice"}', 'application/json')));
    await expect(fetchMossVoicePreview('ether')).rejects.toThrow(/音色/);
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(400, '{"error":"invalid_voice"}', 'application/json')));
    await expect(fetchMossVoicePreview('ether')).rejects.toThrow(/音色/);
  });

  it('非音频或超限响应被拒（不把坏字节/超大文件塞进播放器）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(200, 'not-audio', 'text/html')));
    await expect(fetchMossVoicePreview('ether')).rejects.toThrow(/音频/);
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(200, new ArrayBuffer(MAX_MOSS_PREVIEW_BYTES + 1))));
    await expect(fetchMossVoicePreview('ether')).rejects.toThrow(/音频/);
  });
});
