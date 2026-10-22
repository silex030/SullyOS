// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AutonomyGuardrailsSettings from './AutonomyGuardrailsSettings';
import {
  AUTONOMY_GUARDRAILS_DRAFT_KEY,
  bindGuardrailCloudSync,
  resetGlobalGuardrailsState,
} from '../../utils/airp/autonomyGuardrailsClient';

const confirmedCache = (patch: { globalPerDay: number; paused: boolean }) => JSON.stringify({
  v: 1,
  confirmed: {
    version: 1,
    perCharPerDay: 2,
    sameKindMinGapMinutes: 120,
    globalPerDay: patch.globalPerDay,
    reserveTokensPerRun: 1600,
    paused: patch.paused,
  },
  savedAt: 10,
  confirmedAt: 10,
});

beforeEach(() => {
  bindGuardrailCloudSync(null);
  resetGlobalGuardrailsState();
  localStorage.removeItem(AUTONOMY_GUARDRAILS_DRAFT_KEY);
});

describe('AutonomyGuardrailsSettings 渲染', () => {
  it('还没读到云端值时：显示「未确认」并禁止保存，不把默认 paused:false 当成可保存的权威值', () => {
    const html = renderToStaticMarkup(React.createElement(AutonomyGuardrailsSettings));
    expect(html).toContain('允许角色自主生活');
    expect(html).toContain('全部角色每天合计');
    expect(html).toContain('未确认');
    expect(html).not.toContain('value="6"');
    expect(html).toContain('disabled');
    // 绝对不能出现「已同步到后台」这种假确认
    expect(html).not.toContain('已同步到后台');
  });

  it('已确认的云端值可以编辑，保存按钮按 dirty 控制', () => {
    localStorage.setItem(AUTONOMY_GUARDRAILS_DRAFT_KEY, confirmedCache({ globalPerDay: 4, paused: true }));
    const html = renderToStaticMarkup(React.createElement(AutonomyGuardrailsSettings));
    expect(html).toContain('value="4"');
    expect(html).toContain('已同步到后台');
    expect(html).toContain('当前是暂停状态');
  });

  it('云端确认的次数为 0 → 显示 0 且标明这就是暂停（不显示默认 6）', () => {
    localStorage.setItem(AUTONOMY_GUARDRAILS_DRAFT_KEY, confirmedCache({ globalPerDay: 0, paused: true }));
    const html = renderToStaticMarkup(React.createElement(AutonomyGuardrailsSettings));
    expect(html).toContain('value="0"');
    expect(html).toContain('当前是暂停状态');
    expect(html).not.toContain('value="6"');
  });
});
