import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  cleanTextForTtsGenie,
  isGenieVoiceEnabled,
  isMossVoiceUsableSync,
  probeMossVoiceStatus,
  refreshMossVoiceStatus,
  resolveGenieEmotion,
  synthesizeSpeechGenieDetailed,
} from './genieTts';

const AGENT = 'https://agent.test';

function makeResponse(status: number, body: ArrayBuffer | string, contentType = 'audio/wav') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => contentType },
    arrayBuffer: async () => (typeof body === 'string' ? new TextEncoder().encode(body).buffer : body),
    text: async () => (typeof body === 'string' ? body : new TextDecoder().decode(body)),
    json: async () => JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body)),
  } as unknown as Response;
}

describe('synthesizeSpeechGenieDetailed', () => {
  // Genie 是独立开关，不进 TtsProvider；阶段 A 是 opt-in，测试里必须显式写 true。
  const apiConfig = { genieVoiceEnabled: true, ttsProvider: 'minimax' } as any;
  const char = { id: 'c1' } as any;

  beforeEach(() => {
    localStorage.setItem('os_api_config', JSON.stringify({ agentUrl: AGENT, agentToken: 'tok' }));
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:genie-1', revokeObjectURL: () => {} } as any);
  });
  afterEach(() => {
    localStorage.removeItem('os_api_config');
    vi.unstubAllGlobals();
  });

  it('成功时返回 url 与 blob 两个字段', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(200, new ArrayBuffer(2048))));
    const res = await synthesizeSpeechGenieDetailed('你好', char, apiConfig, { emotion: 'happy' });
    expect(res.url).toBe('blob:genie-1');
    expect(res.blob).toBeInstanceOf(Blob);
  });

  it('agentUrl 结尾带斜杠时不产生双斜杠', async () => {
    localStorage.setItem('os_api_config', JSON.stringify({ agentUrl: `${AGENT}/`, agentToken: 'tok' }));
    const fetchMock = vi.fn(async () => makeResponse(200, new ArrayBuffer(2048)));
    vi.stubGlobal('fetch', fetchMock);
    await synthesizeSpeechGenieDetailed('测试', char, apiConfig);
    const [url] = fetchMock.mock.calls[0] as any;
    expect(String(url)).toBe(`${AGENT}/agent/v1/tts`);
    // 注意不能断言 not.toContain('//agent')：AGENT 是 https://agent.test，
    // 协议后的 // 紧跟主机名 agent，这个子串天然存在，与实现无关。
    // 真正要防的是 host 与 path 之间出现双斜杠（test//agent）。
    expect(String(url)).not.toContain('test//agent');
  });

  it('带上 X-Client-Token 鉴权头，不再发 emotion（Nano 无情绪参数）', async () => {
    const fetchMock = vi.fn(async () => makeResponse(200, new ArrayBuffer(2048)));
    vi.stubGlobal('fetch', fetchMock);
    await synthesizeSpeechGenieDetailed('测试文本', char, apiConfig, { emotion: 'sad' });
    const [, init] = fetchMock.mock.calls[0] as any;
    expect(init.headers['X-Client-Token']).toBe('tok');
    const body = JSON.parse(init.body);
    expect(body.text).toBe('测试文本');
    expect(body).not.toHaveProperty('emotion');
  });

  it('发送前已剥掉语音标签与字幕，只剩正文', async () => {
    const fetchMock = vi.fn(async () => makeResponse(200, new ArrayBuffer(2048)));
    vi.stubGlobal('fetch', fetchMock);
    await synthesizeSpeechGenieDetailed(
      '<语音 emotion="happy">(laughs)今天真开心</语音><字幕>今天真开心</字幕>',
      char,
      apiConfig,
    );
    const [, init] = fetchMock.mock.calls[0] as any;
    expect(JSON.parse(init.body).text).toBe('今天真开心');
  });

  it('503 synth_failed 抛出合成失败错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(503, '{"error":"synth_failed"}', 'application/json')));
    await expect(synthesizeSpeechGenieDetailed('x', char, apiConfig)).rejects.toThrow(/失败/);
  });

  it('504 nano_unavailable 抛出服务暂时不可用错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(504, '{"error":"nano_unavailable"}', 'application/json')));
    await expect(synthesizeSpeechGenieDetailed('x', char, apiConfig)).rejects.toThrow(/暂时不可用/);
  });

  it('413 bad_request 抛出请求格式不正确错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(413, '{"error":"bad_request"}', 'application/json')));
    await expect(synthesizeSpeechGenieDetailed('x', char, apiConfig)).rejects.toThrow(/格式不正确/);
  });

  // 本地 GPT-SoVITS relay 的细码：没配参考音频时绝不能返回假音频，只能明确报「待配置」。
  it('409 no_ref_voice 提示参考音频待配置（不是笼统失败）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(409, '{"error":"no_ref_voice"}', 'application/json')));
    await expect(synthesizeSpeechGenieDetailed('x', char, apiConfig)).rejects.toThrow(/还没有配置本地声音/);
  });

  it('503 model_loading 提示模型正在加载', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(503, '{"error":"model_loading"}', 'application/json')));
    await expect(synthesizeSpeechGenieDetailed('x', char, apiConfig)).rejects.toThrow(/正在加载/);
  });

  it('429 busy 提示排队已满（快速失败，不干等）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(429, '{"error":"busy"}', 'application/json')));
    await expect(synthesizeSpeechGenieDetailed('x', char, apiConfig)).rejects.toThrow(/正在忙/);
  });

  it('把用户选的本机音色 ID 放进请求体 voice（不带路径、不进 header）', async () => {
    const fetchMock = vi.fn(async () => makeResponse(200, new ArrayBuffer(2048)));
    vi.stubGlobal('fetch', fetchMock);
    await synthesizeSpeechGenieDetailed('测试', char, { ...apiConfig, mossVoiceId: 'ether' } as any);
    const [, init] = fetchMock.mock.calls[0] as any;
    const body = JSON.parse(init.body);
    expect(body.voice).toBe('ether');
    expect(JSON.stringify(body)).not.toContain('/');
  });

  it('没选音色时不发 voice（由服务端默认决定，前端不猜也不串）', async () => {
    const fetchMock = vi.fn(async () => makeResponse(200, new ArrayBuffer(2048)));
    vi.stubGlobal('fetch', fetchMock);
    await synthesizeSpeechGenieDetailed('测试', char, apiConfig);
    const [, init] = fetchMock.mock.calls[0] as any;
    expect(JSON.parse(init.body)).not.toHaveProperty('voice');
  });

  it('试听 demo:true 时不带 voice（公开演示不能被当成角色音色）', async () => {
    const fetchMock = vi.fn(async () => makeResponse(200, new ArrayBuffer(2048)));
    vi.stubGlobal('fetch', fetchMock);
    await synthesizeSpeechGenieDetailed('测试', char, { ...apiConfig, mossVoiceId: 'ether' } as any, { demo: true });
    const [, init] = fetchMock.mock.calls[0] as any;
    const body = JSON.parse(init.body);
    expect(body.demo).toBe(true);
    expect(body).not.toHaveProperty('voice');
  });

  it('角色单独指定的本机音色优先于全局音色', async () => {
    const fetchMock = vi.fn(async () => makeResponse(200, new ArrayBuffer(2048)));
    vi.stubGlobal('fetch', fetchMock);
    await synthesizeSpeechGenieDetailed('测试', { id: 'c1', voiceProfile: { mossVoiceId: 'char-voice' } } as any,
      { ...apiConfig, mossVoiceId: 'ether' } as any);
    const [, init] = fetchMock.mock.calls[0] as any;
    expect(JSON.parse(init.body).voice).toBe('char-voice');
  });
});

describe('isMossVoiceUsableSync（自动合成的真实门）', () => {
  beforeEach(() => {
    localStorage.setItem('os_api_config', JSON.stringify({ agentUrl: AGENT, agentToken: 'tok' }));
  });
  afterEach(() => {
    localStorage.removeItem('os_api_config');
    vi.unstubAllGlobals();
  });

  const health = (body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => makeResponse(200, JSON.stringify(body), 'application/json')));

  it('模型 ready 但没有参考音频 → 不自动合成（避免每条消息都失败一次）', async () => {
    health({ ready: true, referenceConfigured: false });
    await refreshMossVoiceStatus(0);
    expect(isMossVoiceUsableSync()).toBe(false);
  });

  it('ready + 有参考音频 → 允许自动合成', async () => {
    health({ ready: true, referenceConfigured: true, voices: ['ether'] });
    await refreshMossVoiceStatus(0);
    expect(isMossVoiceUsableSync()).toBe(true);
  });

  it('探不通 → 门关闭，不猜成可用', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    await refreshMossVoiceStatus(0);
    expect(isMossVoiceUsableSync()).toBe(false);
  });
});

describe('isGenieVoiceEnabled', () => {
  it('阶段 A 是 opt-in：undefined 不算开启（老用户零行为变化）', () => {
    expect(isGenieVoiceEnabled({} as any)).toBe(false);
    expect(isGenieVoiceEnabled({ genieVoiceEnabled: undefined } as any)).toBe(false);
  });
  it('只有显式 true 才开启', () => {
    expect(isGenieVoiceEnabled({ genieVoiceEnabled: true } as any)).toBe(true);
    expect(isGenieVoiceEnabled({ genieVoiceEnabled: false } as any)).toBe(false);
  });
});

describe('resolveGenieEmotion', () => {
  it('auto 模式跟随 options.emotion', () => {
    expect(resolveGenieEmotion({ emotion: 'sad' }, {} as any)).toBe('sad');
  });
  it('auto 模式遇非白名单回落 calm', () => {
    expect(resolveGenieEmotion({ emotion: 'disgusted' }, {} as any)).toBe('calm');
    expect(resolveGenieEmotion(undefined, {} as any)).toBe('calm');
  });
  it('fixed 模式忽略 options.emotion，用配置值', () => {
    expect(resolveGenieEmotion(
      { emotion: 'sad' },
      { genieEmotionMode: 'fixed', genieEmotion: 'angry' } as any,
    )).toBe('angry');
  });
  it('fixed 模式配置值非法时回落 calm', () => {
    expect(resolveGenieEmotion(
      undefined,
      { genieEmotionMode: 'fixed', genieEmotion: 'nope' } as any,
    )).toBe('calm');
  });
});

describe('cleanTextForTtsGenie', () => {
  it('只保留 <语音> 块内的正文', () => {
    expect(cleanTextForTtsGenie('你说真的假的？<语音 emotion="surprised">Wait, are you serious?</语音><字幕>等等……你是认真的？</字幕>'))
      .toBe('Wait, are you serious?');
  });

  it('剥掉 MiniMax 停顿标记与动作词', () => {
    expect(cleanTextForTtsGenie('你好<#0.5#>世界')).toBe('你好世界');
  });
});

describe('MOSS-TTS-Nano 请求体：显式演示 vs 角色音色', () => {
  const apiConfig = { genieVoiceEnabled: true, ttsProvider: 'minimax' } as any;
  const char = { id: 'c1' } as any;

  beforeEach(() => {
    localStorage.setItem('os_api_config', JSON.stringify({ agentUrl: AGENT, agentToken: 'tok' }));
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:moss', revokeObjectURL: () => {} } as any);
  });
  afterEach(() => {
    localStorage.removeItem('os_api_config');
    vi.unstubAllGlobals();
  });

  it('默认只发 {text}，不带 demo 字段（用户没配参考音频时由 relay 报 no_ref_voice）', async () => {
    const fetchMock = vi.fn(async () => makeResponse(200, new ArrayBuffer(2048)));
    vi.stubGlobal('fetch', fetchMock);
    await synthesizeSpeechGenieDetailed('你好', char, apiConfig);
    const body = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    expect(body).toEqual({ text: '你好' });
  });

  it('试听公开演示时显式 demo:true，且不夹带任何 id 字段（id 由服务端 env 决定）', async () => {
    const fetchMock = vi.fn(async () => makeResponse(200, new ArrayBuffer(2048)));
    vi.stubGlobal('fetch', fetchMock);
    await synthesizeSpeechGenieDetailed('试听一句', char, apiConfig, { demo: true });
    const body = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    expect(body).toEqual({ text: '试听一句', demo: true });
    expect(body).not.toHaveProperty('demo_id');
    expect(body).not.toHaveProperty('voice_id');
  });

  it('422 no_ref_voice 必须说清「待配置」，而不是笼统失败', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(422, '{"error":"no_ref_voice"}', 'application/json')));
    await expect(synthesizeSpeechGenieDetailed('x', char, apiConfig)).rejects.toThrow(/还没有配置本地声音/);
  });

  it('参考音频不合规 / 过大给出可操作提示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(422, '{"error":"reference_invalid"}', 'application/json')));
    await expect(synthesizeSpeechGenieDetailed('x', char, apiConfig)).rejects.toThrow(/3.{0,4}15/);
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(413, '{"error":"payload_too_large"}', 'application/json')));
    await expect(synthesizeSpeechGenieDetailed('x', char, apiConfig)).rejects.toThrow(/10\s?MB/i);
  });
});

describe('probeMossVoiceStatus', () => {
  const apiConfig = { genieVoiceEnabled: true, ttsProvider: 'minimax' } as any;

  beforeEach(() => {
    localStorage.setItem('os_api_config', JSON.stringify({ agentUrl: AGENT, agentToken: 'tok' }));
  });
  afterEach(() => {
    localStorage.removeItem('os_api_config');
    vi.unstubAllGlobals();
  });

  it('读主代理的 /agent/v1/tts/health（带 token），把真实字段规整成状态', async () => {
    const fetchMock = vi.fn(async () => makeResponse(
      200,
      JSON.stringify({ ready: true, model: 'moss-tts-nano', referenceConfigured: false, demoAvailable: true }),
      'application/json',
    ));
    vi.stubGlobal('fetch', fetchMock);
    const out = await probeMossVoiceStatus(apiConfig);
    expect(String((fetchMock.mock.calls[0] as any)[0])).toBe(`${AGENT}/agent/v1/tts/health`);
    expect((fetchMock.mock.calls[0] as any)[1].headers['X-Client-Token']).toBe('tok');
    expect(out.reachable).toBe(true);
    expect(out.status.state).toBe('needs_reference');
  });

  it('主代理 503 时 reachable=false（UI 说未连接，不说已成功）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(503, '{"error":"nano_unavailable"}', 'application/json')));
    const out = await probeMossVoiceStatus(apiConfig);
    expect(out.reachable).toBe(false);
    expect(out.status.state).toBe('offline');
  });

  it('网络异常也不抛，返回 offline 供 UI 展示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
    const out = await probeMossVoiceStatus(apiConfig);
    expect(out.reachable).toBe(false);
    expect(out.status.state).toBe('offline');
  });

  it('没配主代理地址时不发请求，直接 offline', async () => {
    localStorage.removeItem('os_api_config');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const out = await probeMossVoiceStatus(apiConfig);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.status.state).toBe('offline');
  });
});
