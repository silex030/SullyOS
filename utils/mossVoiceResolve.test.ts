import { describe, expect, it } from 'vitest';
import { resolveMossVoiceId } from './genieTts';

/**
 * 角色音色的实际上行 ID：角色 > 全局 > 空（服务端默认）。
 * 两个角色各选各的，互不串音。
 */
describe('resolveMossVoiceId：角色选择与全局继承', () => {
  const apiConfig = { genieVoiceEnabled: true, mossVoiceId: 'ether' } as any;

  it('角色自己选了就用角色那份（覆盖全局）', () => {
    const char = { id: 'c1', voiceProfile: { mossVoiceId: 'official-sample' } } as any;
    expect(resolveMossVoiceId(char, apiConfig)).toBe('official-sample');
  });

  it('角色没选（缺字段 / 空串）时继承全局', () => {
    expect(resolveMossVoiceId({ id: 'c1' } as any, apiConfig)).toBe('ether');
    expect(resolveMossVoiceId({ id: 'c1', voiceProfile: { mossVoiceId: '  ' } } as any, apiConfig)).toBe('ether');
  });

  it('两角色分别选择不会串：各自返回自己的 ID', () => {
    const a = { id: 'a', voiceProfile: { mossVoiceId: 'ether' } } as any;
    const b = { id: 'b', voiceProfile: { mossVoiceId: 'official-sample' } } as any;
    expect(resolveMossVoiceId(a, { ...apiConfig, mossVoiceId: 'global-voice' })).toBe('ether');
    expect(resolveMossVoiceId(b, { ...apiConfig, mossVoiceId: 'global-voice' })).toBe('official-sample');
  });

  it('全局也没选时返回空串（交给服务端默认/报 no_ref_voice，不套别的角色音色）', () => {
    expect(resolveMossVoiceId({ id: 'c1' } as any, { genieVoiceEnabled: true } as any)).toBe('');
  });
});
