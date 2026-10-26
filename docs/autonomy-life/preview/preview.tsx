/**
 * 截图用预览壳：只挂自主生活的新组件，数据来自 fixtures.ts 的演示 API。
 *
 * 用途只有一个 —— 让审查者能在不看真机的情况下目视到各状态的真实 DOM 渲染。
 * 页面顶部固定挂红色「测试数据」横幅（组件内部的 FixtureBanner），
 * 这些截图不能当作后端联调证据，也不允许进产品包（只在 vite dev 下按路径访问）。
 *
 * 参数：
 *   mode=card|panel|account
 *   tab=overview|activity|boundary        (mode=panel)
 *   scenario=ready|empty|paused|budget_exhausted|waiting_device|
 *            pending_confirmation|capability_unavailable|load_error
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import AutonomyLifeEntryCard from '../../../components/autonomy-life/AutonomyLifeEntryCard';
import AutonomyLifePanel, { type AutonomyTab } from '../../../components/autonomy-life/AutonomyLifePanel';
import AutonomyAccountSection from '../../../components/autonomy-life/AutonomyAccountSection';
import { createFixtureAutonomyLifeApi, FIXTURE_NOW, type FixtureScenario } from '../../../components/autonomy-life/fixtures';

const params = new URLSearchParams(location.search);
const mode = params.get('mode') ?? 'panel';
const tab = (params.get('tab') ?? 'overview') as AutonomyTab;
const scenario = (params.get('scenario') ?? 'ready') as FixtureScenario;
const api = createFixtureAutonomyLifeApi(scenario);
// 用 fixture 自己的「现在」，避免预览里出现比今天更晚的时间戳。
const nowMs = FIXTURE_NOW;
const charId = 'fixture-char-1';
const charName = '林夏';

const noop = () => {};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-100 flex justify-center">
      <div className="w-full max-w-md bg-slate-50 min-h-screen shadow-xl">{children}</div>
    </div>
  );
}

function App() {
  if (mode === 'card') {
    return (
      <Shell>
        <div className="p-4 space-y-3">
          <p className="text-[10px] font-bold text-slate-400">角色详情 · 只读状态入口卡</p>
          <AutonomyLifeEntryCard
            charId={charId}
            charName={charName}
            onOpen={noop}
            onOpenAccountSettings={noop}
            api={api}
            nowMs={nowMs}
          />
        </div>
      </Shell>
    );
  }

  if (mode === 'account') {
    return (
      <Shell>
        <div className="p-1">
          <AutonomyAccountSection characters={[{ id: charId, name: charName }]} onOpenApp={noop} api={api} nowMs={nowMs} />
        </div>
      </Shell>
    );
  }

  return (
    <AutonomyLifePanel
      charId={charId}
      charName={charName}
      onClose={noop}
      onOpenApp={noop}
      onOpenSettings={noop}
      api={api}
      fixtureScenario={scenario}
      initialTab={tab}
      nowMs={nowMs}
    />
  );
}

createRoot(document.getElementById('root')!).render(<App />);
