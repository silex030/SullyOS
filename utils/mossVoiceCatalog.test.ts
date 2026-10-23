import { describe, expect, it } from 'vitest';
import { normalizeMossVoiceHealth, voiceOptionById } from './mossTtsStatus';

/**
 * 音色目录只由鉴权后端（/agent/v1/tts/health）给出。
 * 前端只做形状收敛：非法 ID / 路径 / 超长 label 一律丢弃，绝不自己造音色。
 */
describe('normalizeMossVoiceHealth：后端权威音色目录', () => {
  const base = {
    ready: true,
    referenceConfigured: true,
    model: 'moss-tts-nano',
    voices: ['ether', 'official-sample'],
  };

  it('voiceOptions 解析出 id / 中文 label / 来源 / 试听可用 / 是否已注册', () => {
    const status = normalizeMossVoiceHealth({
      ...base,
      voiceOptions: [
        { id: 'ether', label: 'ether（我的声音）', origin: '用户本人提供', preview: true, registered: true },
        { id: 'official-sample', label: '公开语料示例', origin: 'AISHELL-3（Apache-2.0）', preview: true, registered: true },
      ],
    });
    expect(status.voiceOptions).toEqual([
      { id: 'ether', label: 'ether（我的声音）', origin: '用户本人提供', preview: true, registered: true },
      { id: 'official-sample', label: '公开语料示例', origin: 'AISHELL-3（Apache-2.0）', preview: true, registered: true },
    ]);
    // ids 与 options 保持一致，兼容旧调用方
    expect(status.voices).toEqual(['ether', 'official-sample']);
    expect(voiceOptionById(status, 'official-sample')?.label).toBe('公开语料示例');
  });

  it('非法 ID、路径、重复项、非对象条目全部丢弃（不让服务端/网络污染选项）', () => {
    const status = normalizeMossVoiceHealth({
      ...base,
      voiceOptions: [
        { id: '../../etc/passwd', label: 'x', preview: true },
        { id: 'ether.wav', label: 'x' },
        { id: 'a b', label: 'x' },
        { id: 'ether', label: 'ether', preview: true, registered: true },
        { id: 'ether', label: '重复项', preview: true },
        'junk',
        null,
        { id: 'ok_2', label: '第二个', preview: false, registered: false },
      ],
    });
    expect(status.voices).toEqual(['ether', 'ok_2']);
    expect(status.voiceOptions.map((v) => v.id)).toEqual(['ether', 'ok_2']);
    // 重复 id 保留第一条
    expect(status.voiceOptions[0].label).toBe('ether');
    expect(status.voiceOptions[1]).toMatchObject({ preview: false, registered: false });
  });

  it('缺 label / label 非字符串 / 含控制字符时回退为 ID，且长度受限', () => {
    const long = '音'.repeat(80);
    const status = normalizeMossVoiceHealth({
      ...base,
      voices: ['ether', 'long-label', 'weird'],
      voiceOptions: [
        { id: 'ether' },
        { id: 'long-label', label: long },
        { id: 'weird', label: 'a\u0000b\nc' },
      ],
    });
    expect(status.voiceOptions[0].label).toBe('ether');
    expect(status.voiceOptions[1].label.length).toBeLessThanOrEqual(40);
    expect(status.voiceOptions[2].label).not.toMatch(/[\u0000-\u001f]/);
  });

  it('后端只给旧版 voices[] 时仍能构造选项，且 preview=false（不假装有试听）', () => {
    const status = normalizeMossVoiceHealth({ ...base, voices: ['ether', '../bad'] });
    expect(status.voiceOptions).toEqual([
      { id: 'ether', label: 'ether', origin: '', preview: false, registered: false },
    ]);
    expect(status.voices).toEqual(['ether']);
  });

  it('空响应时不返回任何音色选项（不预置、不猜）', () => {
    expect(normalizeMossVoiceHealth(null).voiceOptions).toEqual([]);
    expect(normalizeMossVoiceHealth({ ready: true }).voiceOptions).toEqual([]);
  });
});
