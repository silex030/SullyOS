/**
 * 入口迁移守卫：证明「自主生活」只有一个入口，且旧的多处入口没有回流。
 *
 * 这里刻意读源码而不是渲染 Character/Settings（两个文件都 8k 行、依赖整棵 OSContext）：
 * 卡片的验收点是「入口位置与删除范围」，源码级断言能稳定地钉住这件事。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const countOf = (source: string, needle: string) => source.split(needle).length - 1;

describe('自主生活入口迁移', () => {
  const character = read('apps/Character.tsx');
  const settings = read('apps/Settings.tsx');

  it('角色详情：一张状态入口卡 + 一个全屏工作区，且不再挂 AIRP 旧面板', () => {
    expect(countOf(character, '<AutonomyLifeEntryCard')).toBe(1);
    expect(countOf(character, '<AutonomyLifePanel')).toBe(1);
    expect(countOf(character, 'AutonomyLifeEntryCard,')).toBeLessThanOrEqual(1);
    // 旧 AIRP 档位/能力白名单面板是第二套自主入口，不能回流到设定页。
    expect(character).not.toContain('<AirpPanel');
    expect(character).not.toMatch(/import\s+AirpPanel\s+from/);
    // 旧的频率/模板面板也不许回来。
    expect(character).not.toContain('<AutonomyPanel');
  });

  it('设置页：只剩账号总览与总边界，旧的护栏/频率设置不再挂载', () => {
    expect(character.length).toBeGreaterThan(1000);
    expect(settings).toContain('<AutonomyAccountSection');
    expect(settings).not.toContain('AutonomyGuardrailsSettings');
    expect(settings).not.toMatch(/import\s+AutonomyGuardrailsSettings\s+from/);
  });

  it('旧组件文件确实已删除，不会留下两套实现', () => {
    const removed = [
      'components/character/AutonomyPanel.tsx',
      'components/character/AutonomyGuardrailsFields.tsx',
      'components/settings/AutonomyGuardrailsSettings.tsx',
    ];
    for (const rel of removed) {
      expect(fs.existsSync(path.join(ROOT, rel)), rel).toBe(false);
    }
  });

  it('新 UI 里没有任何频率 / 周期 / 同类冷却的可编辑输入', () => {
    const dir = path.join(ROOT, 'components/autonomy-life');
    const banned = /aria-label="[^"]*(频率|周期|活跃度|同类冷却|每小时)[^"]*"/;
    const offenders = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.tsx') && !name.endsWith('.test.tsx'))
      .filter((name) => banned.test(fs.readFileSync(path.join(dir, name), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
