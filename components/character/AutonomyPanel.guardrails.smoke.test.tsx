// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('../../utils/mcpClient', () => ({ getEnabledMcpServers: () => [] }));
vi.mock('../../utils/db', () => ({ openDB: async () => { throw new Error('no db'); } }));

import AutonomyPanel from './AutonomyPanel';

const char: any = {
  id: 'c1',
  name: '测试',
  activeMsg2Config: { enabled: true },
  airp: {
    enabled: true,
    autonomyLevel: 2,
    capabilities: [],
    mcpAllow: [],
    writable: false,
    version: 1,
    autonomy: { enabled: true, templateId: 'custom', overrides: {}, version: 1 },
  },
};

describe('AutonomyPanel 生活护栏渲染', () => {
  it('渲染出三个护栏输入，默认 2 / 2 / 1600', () => {
    const html = renderToStaticMarkup(React.createElement(AutonomyPanel, { char, onChange: () => {} }));
    expect(html).toContain('生活护栏');
    expect(html).toContain('每天最多几次');
    expect(html).toContain('同类动作最少隔多久');
    expect(html).toContain('每次预留 token');
    expect(html).toContain('value="2"');
    expect(html).toContain('value="1600"');
  });

  it('云端护栏未确认时不显示默认 6，也不假装「未暂停」', () => {
    // 没有已确认基线 = 不知道云端是什么（不是「默认 6 次/天」）。
    localStorage.removeItem('os_autonomy_guardrails');
    const html = renderToStaticMarkup(React.createElement(AutonomyPanel, { char, onChange: () => {} }));
    expect(html).toContain('后台未确认');
    expect(html).not.toContain('每天最多 6 次');
    expect(html).not.toContain('每天最多 0 次');
  });

  it('已有 guardrails（0 次/天）→ 显示 0 与暂停提示', () => {
    const paused = {
      ...char,
      airp: {
        ...char.airp,
        autonomy: {
          enabled: false,
          templateId: 'custom',
          overrides: {},
          guardrails: { version: 1, perCharPerDay: 0, sameKindMinGapMinutes: 120, reserveTokensPerRun: 1600, globalPerDay: 6, paused: false },
          version: 1,
        },
      },
    };
    const html = renderToStaticMarkup(React.createElement(AutonomyPanel, { char: paused, onChange: () => {} }));
    expect(html).toContain('value="0"');
    expect(html).toContain('已暂停');
  });
});
