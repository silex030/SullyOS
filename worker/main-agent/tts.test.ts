// worker/main-agent/tts.test.ts
// MOSS-TTS-Nano 本机 runtime 的鉴权中转契约。
// 只测主代理这一层（不联网、不启模型）：上行只发 {text, demo_id?}，下行接 base64 或裸 WAV，
// 422 必须翻成 no_ref_voice（绝不返回假音频），上游地址只来自 env（防 SSRF）。
import { describe, expect, it, vi, afterEach } from 'vitest';
// @ts-ignore 单文件 worker（手写 ESM，无类型声明）
import mainAgent from './src/index.js';

type Env = Record<string, string>;

const TOKEN = 'tok';
const BASE_ENV: Env = {
  AMSG_CLIENT_TOKEN: TOKEN,
  NANO_TTS_URL: 'http://127.0.0.1:19890/api/generate',
  NANO_VOICE_ID: 'ether',
  NANO_VOICE_IDS: 'ether',
};

/** 44 字节 RIFF 头 + PCM 数据，byteRate=16000 便于算时长。 */
function wavBytes(seconds = 1): Uint8Array {
  const byteRate = 16000;
  const dataSize = byteRate * seconds;
  const buf = new Uint8Array(44 + dataSize);
  const dv = new DataView(buf.buffer);
  const ascii = (off: number, s: string) => { for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i); };
  ascii(0, 'RIFF');
  dv.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, 8000, true);
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  ascii(36, 'data');
  dv.setUint32(40, dataSize, true);
  return buf;
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

const post = (body: unknown, env: Env = BASE_ENV, headers: Record<string, string> = { 'x-client-token': TOKEN }) =>
  mainAgent.fetch(new Request('http://127.0.0.1:8830/v1/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }), env);

afterEach(() => { vi.unstubAllGlobals(); });

describe('main-agent /v1/tts：MOSS-TTS-Nano 中转', () => {
  it('鉴权先行：没有 token 一律 403，且不触上游', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await post({ text: '你好' }, { AMSG_CLIENT_TOKEN: TOKEN }, {});
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('上行只发 text/demo_id，忽略 emotion / 任意 voice 或 URL 字段（防 SSRF）', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ audio_base64: b64(wavBytes(1)) }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await post({
      text: '你好',
      emotion: 'happy',
      voice_id: '../../etc/passwd',
      url: 'http://evil.example/api/generate',
      demo_id: 'private-owner-voice',
    });
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as any[];
    expect(String(url)).toBe('http://127.0.0.1:19890/api/generate');
    const sent = JSON.parse(String(init.body));
    expect(Object.keys(sent).sort()).toEqual(['text']);
    expect(sent.text).toBe('你好');
  });

  it('公开演示只在显式 demo:true 时带上服务端 env 的 demo_id（浏览器不能自选）', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ audio_base64: b64(wavBytes(1)) }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    await post({ text: '试听', demo: true }, { ...BASE_ENV, NANO_DEMO_ID: 'public-demo' });
    const sent = JSON.parse(String((fetchMock.mock.calls[0] as any[])[1].body));
    expect(sent.demo_id).toBe('public-demo');

    fetchMock.mockClear();
    await post({ text: '试听', demo: true }, BASE_ENV);
    // env 没配也要有明确的公开演示 id，不能变成空字符串
    expect(JSON.parse(String((fetchMock.mock.calls[0] as any[])[1].body)).demo_id).toBe('public-demo');
  });

  it('base64 → 裸 WAV，content-type 正确', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ audio_base64: b64(wavBytes(1)) }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
    const res = await post({ text: '你好' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect(new Uint8Array(await res.arrayBuffer()).byteLength).toBeGreaterThan(44);
  });

  it('上游直接回二进制 audio/wav 也能透传（兼容两种实现，不必先问清）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(wavBytes(1).buffer as ArrayBuffer, {
      status: 200, headers: { 'content-type': 'audio/wav' },
    })));
    const res = await post({ text: '你好' });
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer()).slice(0, 4)).toEqual(new Uint8Array([82, 73, 70, 70]));
  });

  it('422 缺参考音频 → no_ref_voice（前端据此显示待配置，不能假装成功）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'no_ref_voice' }), {
      status: 422, headers: { 'content-type': 'application/json' },
    })));
    const res = await post({ text: '你好' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('no_ref_voice');
  });

  it('上游 5xx / 网络失败 → nano_unavailable；空文本 → empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    expect((await post({ text: '你好' })).status).toBe(503);

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const res = await post({ text: '你好' });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('nano_unavailable');

    expect((await post({ text: '   ' })).status).toBe(400);
  });

  it('非 WAV 的 200 响应被拒（不把坏字节当音频发出去）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(100), {
      status: 200, headers: { 'content-type': 'audio/wav' },
    })));
    const res = await post({ text: '你好' });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('synth_failed');
  });

  it('文本超长（413 text_too_long）单独报，不折成「参考音频超过 10MB」', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'text_too_long' }), {
      status: 413, headers: { 'content-type': 'application/json' },
    })));
    const res = await post({ text: '长'.repeat(401) });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe('text_too_long');
  });

  it('JSON 里没有 audio_base64 时按 synth_failed 处理', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
    const res = await post({ text: '你好' });
    expect(res.status).toBe(502);
  });
});

describe('main-agent /v1/tts/health：状态来自 runtime 真实探活', () => {
  const healthEnv: Env = { ...BASE_ENV };

  it('需要鉴权（本地语音状态不能匿名读，也不暴露上游地址）', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await mainAgent.fetch(new Request('http://127.0.0.1:8830/v1/tts/health'), healthEnv);
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('健康时只回 ready/model/referenceConfigured/demoAvailable，不带本机路径', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ready: true, model: 'moss-tts-nano', referenceConfigured: false, path: '/srv/secret/ref.wav',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await mainAgent.fetch(new Request('http://127.0.0.1:8830/v1/tts/health', {
      headers: { 'x-client-token': TOKEN },
    }), healthEnv);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({
      ready: true,
      model: 'moss-tts-nano',
      referenceConfigured: false,
      demoAvailable: true,
      voices: ['ether'],
      voiceOptions: [{ id: 'ether', label: 'ether', origin: '', preview: false, registered: false }],
    });
    expect(JSON.stringify(body)).not.toContain('secret');
    // 探活打的是派生出来的 /health，不是生成端点
    expect(String((fetchMock.mock.calls[0] as any[])[0])).toBe('http://127.0.0.1:19890/health');
  });

  it('runtime 不可达 → 503 nano_unavailable（前端据此显示未连接，不显示已成功）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const res = await mainAgent.fetch(new Request('http://127.0.0.1:8830/v1/tts/health', {
      headers: { 'x-client-token': TOKEN },
    }), healthEnv);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('nano_unavailable');
  });

  it('上游返回非 JSON / 缺字段时按未就绪处理，不抛 500', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not-json', { status: 200 })));
    const res = await mainAgent.fetch(new Request('http://127.0.0.1:8830/v1/tts/health', {
      headers: { 'x-client-token': TOKEN },
    }), healthEnv);
    expect(res.status).toBe(200);
    expect((await res.json()).ready).toBe(false);
  });
});

// ───────────── 音色白名单 + relay 共享密钥（本机单用户 scope 的授权边界）─────────────
describe('main-agent /v1/tts：音色 ID 白名单与 relay 密钥', () => {
  const okFetch = () => vi.fn(async () => new Response(
    JSON.stringify({ audio_base64: b64(wavBytes(1)) }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ));
  const headersOf = (mock: any) => (mock.mock.calls[0] as any[])[1].headers as Record<string, string>;

  it('默认音色取自服务端 env：上行带 x-voice-id，请求体仍只有 text', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const res = await post({ text: '你好' });
    expect(res.status).toBe(200);
    expect(headersOf(fetchMock)['x-voice-id']).toBe('ether');
    expect(Object.keys(JSON.parse(String((fetchMock.mock.calls[0] as any[])[1].body)))).toEqual(['text']);
  });

  it('显式选白名单内音色可以切；白名单外一律 409 no_ref_voice 且不触上游', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const res = await post({ text: '你好', voice: 'other' }, { ...BASE_ENV, NANO_VOICE_IDS: 'ether,other' });
    expect(res.status).toBe(200);
    expect(headersOf(fetchMock)['x-voice-id']).toBe('other');

    fetchMock.mockClear();
    const bad = await post({ text: '你好', voice: 'someone-else' });
    expect(bad.status).toBe(409);
    expect((await bad.json()).error).toBe('no_ref_voice');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('路径穿越/非法字符的音色 ID 不转发（不变成任意文件读）', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    for (const voice of ['../../etc/passwd', 'ether.wav', 'a b', 'x'.repeat(40), 'ether/../pub']) {
      const res = await post({ text: '你好', voice });
      expect(res.status).toBe(409);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('没有默认音色且请求不带 voice → 409 no_ref_voice（不回落 demo、不串别的音色）', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const res = await post({ text: '你好' }, { AMSG_CLIENT_TOKEN: TOKEN, NANO_TTS_URL: BASE_ENV.NANO_TTS_URL });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('no_ref_voice');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('配置 NANO_RELAY_KEY 时上行带 x-relay-key；未配置时不带该头', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    await post({ text: '你好' }, { ...BASE_ENV, NANO_RELAY_KEY: 'k-shared' });
    expect(headersOf(fetchMock)['x-relay-key']).toBe('k-shared');

    fetchMock.mockClear();
    await post({ text: '你好' }, BASE_ENV);
    expect(headersOf(fetchMock)['x-relay-key']).toBeUndefined();
  });

  it('demo:true 走公开演示音色，不带 x-voice-id（试听不能被当成角色音色）', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    await post({ text: '试听', demo: true });
    expect(headersOf(fetchMock)['x-voice-id']).toBeUndefined();
    expect(JSON.parse(String((fetchMock.mock.calls[0] as any[])[1].body)).demo_id).toBe('public-demo');
  });

  it('health 的 voices 只含白名单内的安全 ID，不含路径或非法字符', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ready: true, referenceConfigured: true, queue_depth: 0, threads: 4,
      voices: ['ether'], ref_path: '/srv/model-tests/moss-nano/refs/ether.wav',
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const res = await mainAgent.fetch(new Request('http://127.0.0.1:8830/v1/tts/health', {
      headers: { 'x-client-token': TOKEN },
    }), { ...BASE_ENV, NANO_VOICE_IDS: 'ether, ../bad ,other' });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.voices).toEqual(['ether', 'other']);
    expect(JSON.stringify(body)).not.toContain('/srv');
  });
});

// ───────────── 音色目录元数据 + 2 秒试听（同一套鉴权与白名单）─────────────
describe('main-agent /v1/tts/health：音色目录元数据', () => {
  const metaEnv: Env = {
    ...BASE_ENV,
    NANO_VOICE_IDS: 'ether,official-sample',
    NANO_VOICE_META: JSON.stringify([
      { id: 'ether', label: 'ether（我的声音）', origin: '用户本人提供' },
      { id: 'official-sample', label: '公开语料示例', origin: 'AISHELL-3（Apache-2.0）' },
      // 白名单外的 ID 不能出现在目录里
      { id: 'sneaky', label: '不该出现', origin: 'x' },
    ]),
  };
  const healthOf = () =>
    mainAgent.fetch(new Request('http://127.0.0.1:8830/v1/tts/health', {
      headers: { 'x-client-token': TOKEN },
    }), metaEnv);

  it('只回白名单内的 ID，并带中文展示名/来源/试听与注册状态（来自 relay）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ready: true, referenceConfigured: true, model: 'moss-tts-nano',
      voices: ['ether', 'official-sample', '../bad'],
      previews: ['official-sample'],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const res = await healthOf();
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.voices).toEqual(['ether', 'official-sample']);
    expect(body.voiceOptions).toEqual([
      { id: 'ether', label: 'ether（我的声音）', origin: '用户本人提供', preview: false, registered: true },
      { id: 'official-sample', label: '公开语料示例', origin: 'AISHELL-3（Apache-2.0）', preview: true, registered: true },
    ]);
    expect(JSON.stringify(body)).not.toContain('sneaky');
    expect(JSON.stringify(body)).not.toContain('/srv');
  });

  it('relay 没给 voices/previews 时 preview 一律 false（不假装有试听）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ready: true, referenceConfigured: true,
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const body = await (await healthOf()).json() as any;
    expect(body.voiceOptions.every((v: any) => v.preview === false)).toBe(true);
    expect(body.voiceOptions.every((v: any) => v.registered === true)).toBe(true);
  });
});

describe('main-agent /v1/tts/preview：按音色取 2 秒试听', () => {
  const PREVIEW_ENV: Env = {
    ...BASE_ENV,
    NANO_VOICE_IDS: 'ether,official-sample',
    NANO_RELAY_KEY: 'relay-key',
  };
  const get = (query: string, env: Env = PREVIEW_ENV, headers: Record<string, string> = { 'x-client-token': TOKEN }) =>
    mainAgent.fetch(new Request(`http://127.0.0.1:8830/v1/tts/preview${query}`, { headers }), env);

  it('鉴权先行：没有 token 一律 403，不触上游', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await get('?voice=ether', PREVIEW_ENV, {});
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('非法 ID（路径/空值/超长）400，且不转发', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const q of ['', '?voice=', '?voice=../../etc/passwd', '?voice=ether.wav', '?voice=a%20b', `?voice=${'x'.repeat(40)}`]) {
      const res = await get(q);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('invalid_voice');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('形状合法但不在白名单 → 409 no_ref_voice（不回落 demo/别的音色）', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await get('?voice=someone-else');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('no_ref_voice');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('成功时只转发 ID（带 relay key），回 audio/wav 且禁止缓存', async () => {
    const fetchMock = vi.fn(async () => new Response(new Blob([wavBytes(2) as unknown as BlobPart]), {
      status: 200, headers: { 'content-type': 'audio/wav' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await get('?voice=official-sample');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const [url, init] = fetchMock.mock.calls[0] as any[];
    expect(String(url)).toBe('http://127.0.0.1:19890/api/preview');
    expect(init.method).toBe('GET');
    expect(init.headers['x-voice-id']).toBe('official-sample');
    expect(init.headers['x-relay-key']).toBe('relay-key');
    expect(String(url)).not.toContain('official-sample');
    expect((await res.arrayBuffer()).byteLength).toBe(wavBytes(2).length);
  });

  it('relay 说没有预览片段 → 404 no_preview（不换个音色顶上）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'no_preview' }), { status: 404 })));
    const res = await get('?voice=ether');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('no_preview');
  });

  it('relay 返回坏字节 / 非 2 秒音频 → 502 preview_invalid（不把坏文件发给浏览器）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not-audio', { status: 200 })));
    let res = await get('?voice=ether');
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('preview_invalid');

    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob([wavBytes(9) as unknown as BlobPart]), { status: 200 })));
    res = await get('?voice=ether');
    expect(res.status).toBe(502);
  });

  it('relay 不可达 → 503 nano_unavailable；relay 401/500 → 502 preview_failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    let res = await get('?voice=ether');
    expect(res.status).toBe(503);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    res = await get('?voice=ether');
    expect(res.status).toBe(502);
  });
});

