import { describe, it, expect, beforeEach } from 'vitest';
import { CollaborationStore } from './store';
import { DEFAULT_COLLABORATION_SETTINGS } from './types';

const VALID_STYLE = {
  background: '#1e2321',
  foreground: '#e2e8f0',
  accent: '#6ee7b7',
  fontFamily: 'sans',
  fontSizePx: 16,
  lineHeight: 1.8,
  borderRadiusPx: 12,
} as const;

beforeEach(async () => {
  // 每个用例从干净 settings 起步：直接存一份默认设置。
  await CollaborationStore.saveSettings({ ...DEFAULT_COLLABORATION_SETTINGS });
});

describe('collaboration settings readingStyle 持久化', () => {
  it('onApply 后的 readingStyle 经 save/load 往返保持', async () => {
    await CollaborationStore.saveSettings({
      ...DEFAULT_COLLABORATION_SETTINGS,
      readingStyle: { ...VALID_STYLE },
    });
    const loaded = await CollaborationStore.loadSettings();
    expect(loaded.readingStyle).toEqual(VALID_STYLE);
  });

  it('历史数据无 readingStyle 时保持缺省（原视觉不变）', async () => {
    const loaded = await CollaborationStore.loadSettings();
    expect(loaded.readingStyle).toBeUndefined();
    expect(loaded.uiTheme).toBe('sully');
  });

  it('非法 readingStyle 存档被丢弃，不污染设置', async () => {
    await CollaborationStore.saveSettings({
      ...DEFAULT_COLLABORATION_SETTINGS,
      readingStyle: { ...VALID_STYLE, background: 'red' } as any,
    });
    const loaded = await CollaborationStore.loadSettings();
    expect(loaded.readingStyle).toBeUndefined();
    // 主题等其它字段不受影响
    expect(loaded.uiTheme).toBe('sully');
  });

  it('exportBackup 透传有效 readingStyle（备份→恢复保持）', async () => {
    await CollaborationStore.saveSettings({
      ...DEFAULT_COLLABORATION_SETTINGS,
      readingStyle: { ...VALID_STYLE },
    });
    const snapshot = await CollaborationStore.exportBackup(false, true);
    expect(snapshot.settings?.readingStyle).toEqual(VALID_STYLE);
    // 恢复：凭据字段仍是站位值，分享包字段只有七个外观值
    await CollaborationStore.saveSettings({ ...DEFAULT_COLLABORATION_SETTINGS });
    await CollaborationStore.importBackup({ settings: snapshot.settings });
    const reloaded = await CollaborationStore.loadSettings();
    expect(reloaded.readingStyle).toEqual(VALID_STYLE);
    expect(Object.keys(reloaded.readingStyle ?? {}).sort()).toEqual(
      ['accent', 'background', 'borderRadiusPx', 'fontFamily', 'fontSizePx', 'foreground', 'lineHeight'].sort(),
    );
  });
});
