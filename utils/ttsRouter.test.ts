import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertTtsLanguageSupported,
  canSynthesizeSpeech,
  characterHasVoice,
  cleanTextForTtsProvider,
  providerUsesRawVoiceMarkup,
  stripTtsMarkupForDisplay,
  synthesizeSpeechDetailed,
} from './ttsRouter';

describe('Genie 开关分流', () => {
  // 开：必须显式 true（阶段 A 是 opt-in）
  const ON = { genieVoiceEnabled: true, ttsProvider: 'minimax' } as any;
  // 关：未设置或显式 false，回退原 provider
  const OFF = { genieVoiceEnabled: false, ttsProvider: 'minimax' } as any;

  it('characterHasVoice 开启时无条件 true（无 per-char 音色配置）', () => {
    expect(characterHasVoice({ id: 'x' } as any, ON)).toBe(true);
  });

  it('characterHasVoice 关闭时回到原 provider 判定', () => {
    expect(characterHasVoice({ id: 'x' } as any, OFF)).toBe(false);
    expect(characterHasVoice({ id: 'x', voiceProfile: { voiceId: 'v' } } as any, OFF)).toBe(true);
  });

  it('canSynthesizeSpeech 开启时无条件 true（无 API Key）', () => {
    expect(canSynthesizeSpeech({ id: 'x' } as any, ON)).toBe(true);
  });

  it('providerUsesRawVoiceMarkup 开启时为 false（回归 Fish cue 被原样念出）', () => {
    expect(providerUsesRawVoiceMarkup(ON)).toBe(false);
    expect(providerUsesRawVoiceMarkup({ genieVoiceEnabled: false, ttsProvider: 'fishaudio' } as any)).toBe(true);
    expect(providerUsesRawVoiceMarkup({ genieVoiceEnabled: false, ttsProvider: 'elevenlabs' } as any)).toBe(true);
    expect(providerUsesRawVoiceMarkup({ genieVoiceEnabled: false, ttsProvider: 'minimax' } as any)).toBe(false);
  });

  it('cleanTextForTtsProvider 开启时只留 <语音> 块内正文', () => {
    const out = cleanTextForTtsProvider(
      '你说真的假的？<语音 emotion="surprised">(laughs)你认真的？</语音><字幕>等等</字幕>',
      ON,
    );
    expect(out).toBe('你认真的？');
    expect(out).not.toContain('laughs');
  });

  it('cleanTextForTtsProvider 关闭时按原 provider 走', () => {
    const out = cleanTextForTtsProvider('你好<#0.5#>世界', OFF);
    expect(typeof out).toBe('string');
  });

  it('stripTtsMarkupForDisplay 开启时移除 Genie 不支持的标记', () => {
    const out = stripTtsMarkupForDisplay(
      '<语音 emotion="happy">口语一(laughs)[whispering]</语音>',
      ON,
    );
    expect(out).toBe('口语一');
  });

  it('assertTtsLanguageSupported 开启时拒绝粤语', () => {
    expect(() => assertTtsLanguageSupported({ id: 'x' } as any, ON, 'yue')).toThrow();
    expect(() => assertTtsLanguageSupported({ id: 'x' } as any, OFF, 'yue')).not.toThrow();
  });

  // 本机 MOSS-TTS-Nano 只做中文（含中英混读）：任何 languageBoost 都在计费/排队前拒绝，
  // 且提示词里要能看出是 MOSS，不留给用户猜是哪家。
  it('assertTtsLanguageSupported 开启时对所有语种增强都拒绝，并点名 MOSS + 只支持中文', () => {
    for (const boost of ['yue', 'en', 'ja', 'auto']) {
      expect(() => assertTtsLanguageSupported({ id: 'x' } as any, ON, boost)).toThrow(/MOSS/);
      expect(() => assertTtsLanguageSupported({ id: 'x' } as any, ON, boost)).toThrow(/只支持中文/);
    }
    expect(() => assertTtsLanguageSupported({ id: 'x' } as any, ON, '')).not.toThrow();
    expect(() => assertTtsLanguageSupported({ id: 'x' } as any, ON, '   ')).not.toThrow();
  });

  // 阶段 A 没有 UI 开关，只有显式 true 才可能触发。这条是"链路真的接通"的唯一自动化证据。
  describe('真实分发', () => {
    beforeEach(() => {
      localStorage.setItem('os_api_config', JSON.stringify({
        agentUrl: 'https://agent.test',
        agentToken: 'tok',
      }));
      vi.stubGlobal('URL', {
        createObjectURL: () => 'blob:genie',
        revokeObjectURL: () => {},
      } as any);
    });
    afterEach(() => {
      localStorage.removeItem('os_api_config');
      vi.unstubAllGlobals();
    });

    it('显式 true 时 synthesizeSpeechDetailed 真正打 Genie', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => new ArrayBuffer(2048),
      } as unknown as Response));
      vi.stubGlobal('fetch', fetchMock);

      await synthesizeSpeechDetailed(
        '测试',
        { id: 'x' } as any,
        { genieVoiceEnabled: true, ttsProvider: 'minimax' } as any,
      );

      expect(String((fetchMock.mock.calls[0] as any)?.[0])).toBe('https://agent.test/agent/v1/tts');
    });

    it('未开启时不打 Genie（回退原 provider）', async () => {
      const fetchMock = vi.fn(async () => new Response('{}', {
        status: 500, headers: { 'content-type': 'application/json' },
      }));
      vi.stubGlobal('fetch', fetchMock);
      await synthesizeSpeechDetailed('测试', { id: 'x' } as any, { ttsProvider: 'minimax' } as any)
        .catch(() => {});
      expect(String((fetchMock.mock.calls[0] as any)?.[0] ?? '')).not.toContain('/agent/v1/tts');
    });
  });
});
