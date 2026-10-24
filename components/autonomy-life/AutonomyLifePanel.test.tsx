// @vitest-environment jsdom
/**
 * 统一「自主生活」UI（角色详情 → 自主生活 → 概况/活动/边界；设置 → 自主生活）测试。
 *
 * 数据用 fixtures.ts 的演示 API（内存、不发网络请求）。这些用例证明 UI 在契约的每种状态下
 * 说人话、不伪造成功、不出现人工频率输入；真实后端联调证据另见 docs/autonomy-life/。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import AutonomyLifePanel, { type AutonomyTab } from './AutonomyLifePanel';
import AutonomyLifeEntryCard from './AutonomyLifeEntryCard';
import AutonomyAccountSection from './AutonomyAccountSection';
import { createFixtureAutonomyLifeApi, type FixtureScenario } from './fixtures';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const NOW = 1_793_000_000_000;
const text = () => container?.textContent ?? '';

async function flush(times = 6) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(node: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
  await flush();
}

async function clickByText(label: string) {
  const target = Array.from(container!.querySelectorAll('button')).find(
    (btn) => (btn.textContent ?? '').trim().includes(label),
  );
  expect(target, `找不到按钮：${label}`).toBeTruthy();
  await act(async () => {
    target!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

async function clickByAria(label: string) {
  const target = container!.querySelector(`[aria-label="${label}"]`);
  expect(target, `找不到 aria-label：${label}`).toBeTruthy();
  await act(async () => {
    target!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

function mountPanel(
  scenario: FixtureScenario,
  tab: AutonomyTab = 'overview',
  hooks: { onOpenApp?: (app: string, ctx?: Record<string, unknown>) => void; onClose?: () => void } = {},
) {
  return mount(
    React.createElement(AutonomyLifePanel, {
      charId: 'fixture-char-1',
      charName: '林夏',
      onClose: hooks.onClose ?? (() => {}),
      onOpenApp: hooks.onOpenApp ?? (() => {}),
      onOpenSettings: () => {},
      fixtureScenario: scenario,
      initialTab: tab,
      nowMs: NOW,
    }),
  );
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  root = null;
  if (container?.parentNode) container.parentNode.removeChild(container);
  container = null;
});

beforeEach(() => {
  localStorage.clear();
});

describe('自主生活 · 概况', () => {
  it('正常状态：显示当前阶段、最近一件事、额度水位与就地入口', async () => {
    await mountPanel('ready', 'overview');
    expect(text()).toContain('TA 现在');
    expect(text()).toContain('最近一件事');
    expect(text()).toContain('你说在加班，TA 留了一条不打扰的消息');
    expect(text()).toContain('模型调用');
    expect(text()).toContain('数字来自服务端账本');
    expect(text()).toContain('就地入口');
    // 时机由人设/情境决定，不是用户排的时间表
    expect(text()).toContain('你只设边界，不排时间表');
  });

  it('空记录：说「尚无自主活动」，不编内容', async () => {
    await mountPanel('empty', 'overview');
    expect(text()).toContain('尚无自主活动');
  });

  it('加载失败：状态暂无法确认 + 可重新读取，不显示绿色运行', async () => {
    await mountPanel('load_error', 'overview');
    expect(text()).toContain('状态暂无法确认');
    expect(text()).toContain('重新读取');
    expect(text()).not.toContain('一切正常');
  });

  it('额度耗尽：显示受限与「今天已经用完」，不伪装成角色不想动', async () => {
    await mountPanel('budget_exhausted', 'overview');
    expect(text()).toContain('受限');
    expect(text()).toContain('今天已经用完');
    expect(text()).toContain('今天额度用完，明天自动重置');
  });

  it('设备离线：等待设备而不是宣称已完成', async () => {
    await mountPanel('waiting_device', 'overview');
    expect(text()).toContain('执行设备不在线');
    expect(text()).toContain('不会假装已经完成');
  });

  it('已暂停：显示已暂停与恢复入口', async () => {
    await mountPanel('paused', 'overview');
    expect(text()).toContain('已暂停');
    expect(text()).toContain('暂停期间不会产生新动作');
    expect(text()).toContain('去边界恢复');
  });

  it('待外传确认：首屏就展示用途 / 目标 / 字段 / 有效期，可批准或拒绝', async () => {
    await mountPanel('pending_confirmation', 'overview');
    expect(text()).toContain('待确认的外部数据请求');
    expect(text()).toContain('为写日记查一条公开店铺信息');
    expect(text()).toContain('www.xiaohongshu.com');
    expect(text()).toContain('兴趣词：咖啡');
    expect(text()).toContain('批准这次外传');
    await clickByText('批准这次外传');
    // 批准后服务端回的是动作记录，待确认卡不再挂着。
    expect(text()).not.toContain('批准这次外传');
  });

  it('最近一件事可跳回原 App，并带上 actionId/resultRef 深链上下文', async () => {
    const onOpenApp = vi.fn();
    await mountPanel('ready', 'overview', { onOpenApp });
    const link = Array.from(container!.querySelectorAll('button')).find((btn) =>
      (btn.textContent ?? '').includes('你说在加班'),
    );
    expect(link).toBeTruthy();
    await act(async () => {
      link!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenApp).toHaveBeenCalledTimes(1);
    const [appId, ctx] = onOpenApp.mock.calls[0];
    expect(appId).toBe('chat');
    expect(ctx).toMatchObject({ charId: 'fixture-char-1', actionId: expect.any(String) });
  });
});

describe('自主生活 · 活动', () => {
  it('时间线区分 OS 内模拟、通知未送达与待核对，不提供盲重试', async () => {
    await mountPanel('ready', 'activity');
    expect(text()).toContain('OS 内模拟订单，不是现实订单');
    expect(text()).toContain('活动已保存，通知未送达');
    expect(text()).toContain('待核对');
    expect(text()).toContain('没有盲重试按钮');
  });

  it('空记录：活动页也不编内容', async () => {
    await mountPanel('empty', 'activity');
    expect(text()).not.toContain('今天写日记');
    expect(text()).toContain('还没有');
  });
});

describe('自主生活 · 边界', () => {
  it('边界页没有任何人工频率 / 活跃度输入，只有上限与只读运行保护', async () => {
    await mountPanel('ready', 'boundary');
    const inputs = Array.from(container!.querySelectorAll('input'));
    const banned = inputs.filter((input) =>
      /频率|周期|活跃度|冷却|间隔|每天几次|每小时/.test(
        `${input.getAttribute('aria-label') ?? ''}${input.getAttribute('placeholder') ?? ''}`,
      ),
    );
    expect(banned).toEqual([]);
    expect(text()).toContain('不提供人工频率输入');
    expect(text()).toContain('旧版「每天几次 / 同类冷却 / 预留 token / 活跃度」已退役');
    // 上限仍然可调（只是天花板）
    expect(text()).toContain('上限只是天花板，不要求用满');
  });

  it('暂停先显示「正在停止」，等云端 quiesced 才算全部暂停', async () => {
    await mountPanel('ready', 'boundary');
    await clickByAria('总暂停');
    expect(text()).toContain('正在停止，还有一些动作在收尾');
    expect(text()).not.toContain('全部已暂停');
  });

  it('能力门槛未通过时逐条说明原因（地图未配置 / 未授权只读）', async () => {
    await mountPanel('capability_unavailable', 'boundary');
    expect(text()).toContain('地图服务未配置');
    expect(text()).toContain('未授予只读访问');
    expect(text()).toContain('本期未开放');
    // 不提供任何「假的确认」动作：文案可以说明"没有假确认按钮"，但 DOM 里不能真出现这个按钮。
    const fakeConfirm = Array.from(container!.querySelectorAll('button')).filter((btn) =>
      (btn.textContent ?? '').includes('假确认'),
    );
    expect(fakeConfirm).toEqual([]);
  });

  it('平台硬禁不可取消，用户只能追加禁止方向', async () => {
    await mountPanel('ready', 'boundary');
    expect(text()).toContain('平台硬禁不能取消');
    expect(text()).toContain('赌博');
    expect(text()).toContain('真实金融交易');
  });
});

describe('角色详情入口卡', () => {
  it('只读展示状态 + 最近一件事，点进去才到工作区', async () => {
    const onOpen = vi.fn();
    const api = createFixtureAutonomyLifeApi('ready', { now: () => NOW });
    await mount(
      React.createElement(AutonomyLifeEntryCard, {
        charId: 'fixture-char-1',
        charName: '林夏',
        onOpen,
        onOpenAccountSettings: () => {},
        api,
      }),
    );
    expect(text()).toContain('自主生活');
    expect(text()).toContain('一切正常');
    expect(text()).toContain('最近：发消息');
    expect(text()).toContain('由 TA 的人设和当下情境决定');
    // 入口卡不出现任何设置控件（开关 / 数字输入）
    expect(container!.querySelectorAll('input').length).toBe(0);
    expect(container!.querySelectorAll('[role="switch"]').length).toBe(0);
    await clickByText('进入自主生活');
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('读不到状态时显示错误，不假装正常运行', async () => {
    const api = createFixtureAutonomyLifeApi('load_error', { now: () => NOW });
    await mount(
      React.createElement(AutonomyLifeEntryCard, {
        charId: 'fixture-char-1',
        charName: '林夏',
        onOpen: () => {},
        onOpenAccountSettings: () => {},
        api,
      }),
    );
    expect(text()).toContain('状态暂无法确认');
    expect(text()).not.toContain('一切正常');
  });
});

describe('设置 → 自主生活（账号总览）', () => {
  it('只做账号层：总暂停 / 总额度 / 角色只读状态 / 未接入说明', async () => {
    const api = createFixtureAutonomyLifeApi('ready', { now: () => NOW });
    await mount(
      React.createElement(AutonomyAccountSection, {
        characters: [{ id: 'fixture-char-1', name: '林夏' }],
        onOpenApp: () => {},
        api,
        nowMs: NOW,
      }),
    );
    expect(text()).toContain('账号允许自主生活');
    expect(text()).toContain('账号每天模型调用');
    expect(text()).toContain('角色状态');
    expect(text()).toContain('林夏');
    // 未接入自主调度的 App 只给说明与手动入口
    expect(text()).toContain('暂未接入自主调度');
    expect(text()).toContain('彼方');
    // 账号层同样不给频率输入
    const banned = Array.from(container!.querySelectorAll('input')).filter((input) =>
      /频率|周期|活跃度|冷却/.test(input.getAttribute('aria-label') ?? ''),
    );
    expect(banned).toEqual([]);
  });
});
