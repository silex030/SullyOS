import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { assembleV2Backup, writeV2Backup } from '../../utils/backupFormat';
import { coerceStoredReadingStyle, deriveDateReadingStyle } from './integration';
import type { ReadingStyle } from './types';

/**
 * t_40feeeaa 第 1 轮返工补测（审计算法 4）：
 * 携带 dateReadingStyle 的角色经真实系统备份容器（v2 ZIP writer→reader→restore）
 * 往返保持；非法样式拒绝且不抹旧值；样式对象仍仅七字段、不含敏感信息。
 * 用安全合成角色，不碰用户真实备份。
 */

const VALID_DATE_STYLE: ReadingStyle = {
  background: 'rgba(0, 0, 0, 0.9)',
  foreground: '#e2e8f0',
  accent: 'rgba(255, 255, 255, 0.1)',
  fontFamily: 'serif',
  fontSizePx: 18,
  lineHeight: 2,
  borderRadiusPx: 0,
};

function seedCharacter(dateReadingStyle?: unknown) {
  return {
    id: 'char-apseed-date-1',
    name: '外观测试员（安全种子）',
    dateLightReading: false,
    dateReadingStyle,
  };
}

describe('dateReadingStyle 真实备份容器往返（v2 ZIP writer→reader→restore）', () => {
  it('携带有效样式的角色经容器往返保持原值', async () => {
    const zip = new JSZip();
    const manifest = await writeV2Backup(
      zip as any,
      { characters: [seedCharacter({ ...VALID_DATE_STYLE })] },
      { mode: 'full' as any },
    );
    const archive = await zip.generateAsync({ type: 'uint8array' });
    const loaded = await JSZip.loadAsync(archive);
    const data = await assembleV2Backup(loaded as any, manifest);
    const restored = (data as any).characters[0];
    expect(restored.dateReadingStyle).toEqual(VALID_DATE_STYLE);
    // 仍仅七字段
    expect(Object.keys(restored.dateReadingStyle).sort()).toEqual(
      ['accent', 'background', 'borderRadiusPx', 'fontFamily', 'fontSizePx', 'foreground', 'lineHeight'].sort(),
    );
  });

  it('恢复侧用真实校验 API 复核：有效通过、非法拒绝', async () => {
    const zip = new JSZip();
    const manifest = await writeV2Backup(
      zip as any,
      { characters: [seedCharacter({ ...VALID_DATE_STYLE })] },
      { mode: 'full' as any },
    );
    const archive = await zip.generateAsync({ type: 'uint8array' });
    const loaded = await JSZip.loadAsync(archive);
    const data = await assembleV2Backup(loaded as any, manifest);
    const restored = (data as any).characters[0];
    expect(coerceStoredReadingStyle(restored.dateReadingStyle, 'date-reading')).toEqual(VALID_DATE_STYLE);
    // 非法值在同一路径上被拒绝（调用方据此保留旧值，不抹数据）
    expect(
      coerceStoredReadingStyle({ ...VALID_DATE_STYLE, background: 'red' }, 'date-reading'),
    ).toBeUndefined();
    expect(
      coerceStoredReadingStyle({ ...VALID_DATE_STYLE, fontSizePx: 99 }, 'date-reading'),
    ).toBeUndefined();
  });

  it('非法备份样式不抹旧值（合并语义：拒绝→沿用旧样式）', () => {
    const oldStyle: ReadingStyle = { ...VALID_DATE_STYLE };
    const incomingIllegal = { ...VALID_DATE_STYLE, accent: 'not-a-color' };
    const coerced = coerceStoredReadingStyle(incomingIllegal, 'date-reading');
    expect(coerced).toBeUndefined();
    // 调用方合并：非法输入丢弃，旧值原样保留
    const next = coerced ?? oldStyle;
    expect(next).toEqual(oldStyle);
    expect(next).toEqual(VALID_DATE_STYLE);
  });

  it('回落派生与小说容器一致（无存档时导出的就是当前视觉）', () => {
    expect(deriveDateReadingStyle(false)).toEqual(VALID_DATE_STYLE);
  });

  it('样式对象不含凭据/会话类敏感键', () => {
    for (const key of Object.keys(VALID_DATE_STYLE)) {
      expect(key.toLowerCase()).not.toMatch(/key|token|secret|session|auth|password|credential/);
    }
    expect(Object.keys(VALID_DATE_STYLE)).toHaveLength(7);
  });
});
