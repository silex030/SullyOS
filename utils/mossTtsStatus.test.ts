import { describe, expect, it } from 'vitest';
import {
  describeMossVoiceStatus,
  normalizeMossVoiceHealth,
  type MossVoiceStatus,
} from './mossTtsStatus';

/**
 * 本地 MOSS-TTS-Nano 的状态必须来自 runtime 的真实 /health（ready + referenceConfigured），
 * 不能写成静态「已成功」。这里锁三件事：
 *   1. 未配置参考音频 → 明确「待配置」，不许显示成功；
 *   2. 模型没 ready → 未就绪，不宣称可用；
 *   3. 公开演示音色只是试听，不是角色音色。
 */
describe('normalizeMossVoiceHealth', () => {
  it('ready + 有参考音频 = ready', () => {
    const s = normalizeMossVoiceHealth({ ready: true, model: 'moss-nano', referenceConfigured: true });
    expect(s.state).toBe('ready');
    expect(s.referenceConfigured).toBe(true);
    expect(s.ready).toBe(true);
    expect(s.model).toBe('moss-nano');
  });

  it('ready 但没参考音频 = needs_reference（不能算已成功）', () => {
    const s = normalizeMossVoiceHealth({ ready: true, referenceConfigured: false });
    expect(s.state).toBe('needs_reference');
    expect(s.ready).toBe(true);
  });

  it('ready=false = starting（模型还在加载/未就绪）', () => {
    expect(normalizeMossVoiceHealth({ ready: false, referenceConfigured: true }).state).toBe('starting');
  });

  it('非对象/空值 = unknown，不猜成 ready', () => {
    expect(normalizeMossVoiceHealth(null).state).toBe('unknown');
    expect(normalizeMossVoiceHealth('oops').state).toBe('unknown');
    expect(normalizeMossVoiceHealth({}).state).toBe('unknown');
  });

  it('model 只接受字符串，其它类型丢弃（不把对象塞进 UI）', () => {
    expect(normalizeMossVoiceHealth({ ready: true, model: { a: 1 } }).model).toBeUndefined();
    expect(normalizeMossVoiceHealth({ ready: true, model: '  ' }).model).toBeUndefined();
  });

  it('demoAvailable 只在 ready 时为 true（没有 demo 字段可依，不虚构）', () => {
    expect(normalizeMossVoiceHealth({ ready: true, referenceConfigured: false }).demoAvailable).toBe(true);
    expect(normalizeMossVoiceHealth({ ready: false }).demoAvailable).toBe(false);
  });

  it('voices 只接受服务端白名单里的安全 ID（过滤路径、去重、保序）', () => {
    const s = normalizeMossVoiceHealth({
      ready: true,
      referenceConfigured: true,
      voices: ['ether', '../etc', 'ether', 'a b', 'other', 'x'.repeat(40), 42],
    });
    expect(s.voices).toEqual(['ether', 'other']);
  });

  it('voices 缺失/非数组 → 空数组（不凭空造音色选项）', () => {
    expect(normalizeMossVoiceHealth({ ready: true }).voices).toEqual([]);
    expect(normalizeMossVoiceHealth({ ready: true, voices: 'ether' }).voices).toEqual([]);
  });
});

describe('describeMossVoiceStatus', () => {
  const mk = (p: Partial<MossVoiceStatus>): MossVoiceStatus =>
    ({ state: 'unknown', ready: false, referenceConfigured: false, demoAvailable: false, ...p } as MossVoiceStatus);

  it('ready 时才说「使用中」，且点明用的是本机参考音频', () => {
    const d = describeMossVoiceStatus(mk({ state: 'ready', ready: true, referenceConfigured: true, demoAvailable: true }));
    expect(d.badge).toBe('使用中');
    expect(d.detail).toContain('参考音频');
  });

  it('needs_reference 明确「待配置参考音频」并给出文件要求', () => {
    const d = describeMossVoiceStatus(mk({ state: 'needs_reference', ready: true, demoAvailable: true }));
    expect(d.badge).toContain('待配置');
    expect(d.detail).toContain('3');
    expect(d.detail).toContain('15');
    expect(d.detail).toContain('WAV');
    expect(d.badge).not.toContain('成功');
  });

  it('starting 说模型未就绪，不宣称可用', () => {
    const d = describeMossVoiceStatus(mk({ state: 'starting' }));
    expect(d.badge).toContain('未就绪');
  });

  it('unknown / offline 给出可执行的下一步（检查本机服务 / 主代理地址）', () => {
    expect(describeMossVoiceStatus(mk({ state: 'offline' })).detail).toContain('主代理');
    expect(describeMossVoiceStatus(mk({ state: 'unknown' })).detail).toContain('主代理');
  });

  it('任何状态都不会把公开演示音色说成角色音色', () => {
    for (const state of ['ready', 'needs_reference', 'starting', 'offline', 'unknown'] as const) {
      const d = describeMossVoiceStatus(mk({ state, ready: state === 'ready', demoAvailable: state === 'ready' }));
      expect(d.detail).not.toContain('克隆完成');
      expect(d.badge).not.toContain('已成功');
    }
  });
});
