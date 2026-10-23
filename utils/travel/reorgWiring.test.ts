import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

/**
 * 功能重组的所有权护栏（源码级）：防止下一轮又把出行设置抄回全局设置页，
 * 或把时区/保留期变成用户可填项。
 */
describe('travel settings ownership', () => {
  it('全局设置页不再有「角色自主出行」大面板，也没有时区/保留期输入', () => {
    const settings = read('apps/Settings.tsx');
    expect(settings.includes("title=\"角色自主出行\"")).toBe(false);
    expect(settings.includes('<TravelSettings')).toBe(false);
    expect(settings.includes('travel-budget-tz')).toBe(false);
    expect(settings.includes('travel-retention-trip')).toBe(false);
    expect(settings.includes('travel-retention-event')).toBe(false);
  });

  it('地图服务凭据只在实时感知里挂一处，且接线到唯一组件', () => {
    const settings = read('apps/Settings.tsx');
    expect(settings.match(/<TravelMapServiceCard/g)?.length ?? 0).toBe(1);
    expect(settings.includes('amapApiKey')).toBe(true); // 兼容旧值：只作为待迁移输入
  });

  it('神经链接角色页有本角色出行入口，固定地点沿用既有城市卡', () => {
    const character = read('apps/Character.tsx');
    expect(character.includes('<TravelCharCard charId={formData.id}')).toBe(true);
    expect(character.includes('地理位置（省市）')).toBe(true);
  });

  it('地图服务卡片显式迁移旧 Key，失败不覆盖、空值不写入', () => {
    const card = read('components/settings/TravelMapServiceCard.tsx');
    expect(card.includes('迁移本机旧 Key')).toBe(true);
    expect(card.includes('onLegacyMigrated')).toBe(true);
    expect(card.includes("if (webKey.trim()) patch.amapWebKey")).toBe(true);
  });
});
