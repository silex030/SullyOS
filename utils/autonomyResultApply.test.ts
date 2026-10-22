/**
 * AIRP 自主生活结果落点（C1）：转述账本 / 日记 / 世界事件 / 心跳 + 降级改道 + 幂等。
 * IndexedDB 由 test-setup 的 fake-indexeddb 提供，走真实 DB 层（无 storage stub）。
 *
 * 说明：markEventsDisclosed 与 materializeCommittedEvents 的 authorityOverride 断言也收在这里，
 * 以保证本次提交的 staged 文件集合与 brief 一致（不额外改动 eventStore.test / worldStore.test）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DB, openDB } from './db';
import { applyAutonomyResult } from './autonomyResultApply';
import { listAirpEventsByChar, markEventsDisclosed, saveAirpEvents } from './airp/eventStore';
import { loadAirpWorld, materializeCommittedEvents } from './airp/worldStore';
import { knownBackupStoreFieldMap } from './backupCoverage';
import type { AirpCommittedEvent } from './airp/commit';

const STORES = [
  'autonomous_outbox',
  'autonomous_heartbeats',
  'airp_workflow_plans',
  'airp_events',
  'airp_world',
  'diaries',
  'characters',
];

async function clearStores(names: string[]): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(names, 'readwrite');
    for (const name of names) tx.objectStore(name).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

beforeEach(async () => {
  await clearStores(STORES);
});

const roundPayload = (overrides: Record<string, unknown> = {}) => ({
  resultKind: 'autonomy_result',
  charId: 'c1',
  experiences: [
    { id: 'exp-1', q: '想知道蝴蝶怎么过冬', note: '查了半天，蝴蝶会找树缝越冬。', kind: 'surf', importance: 'big', pushed: true },
    { id: 'exp-2', q: '试了新游戏', note: '玩了两小时，手感一般。', kind: 'game', importance: 'small', pushed: false },
  ],
  proposedEvents: [
    { type: 'activity', summary: '去河边跑步', impact: 'minor' },
    { type: 'discovery', summary: '翻到一本旧相册', impact: 'trace' },
  ],
  usage: { prompt: 120, completion: 80, total: 200 },
  toolsUsed: [],
  did: 'mixed',
  rested: false,
  ...overrides,
});

const seedChar = async (airp?: Record<string, unknown>): Promise<void> => {
  await DB.saveCharacter({ id: 'c1', name: '测试角色', avatar: '', ...(airp ? { airp } : {}) } as any);
};

const mkEvent = (id: string, disclosed: boolean, authority: AirpCommittedEvent['authority'] = 'confirmed_scene'): AirpCommittedEvent => ({
  id,
  charId: 'c1',
  type: 'activity',
  summary: `事件 ${id}`,
  participants: ['c1'],
  impact: 'minor',
  at: 100,
  authority,
  disclosedToUser: disclosed,
  source: { kind: 'runtime', label: 'airp-autonomy' },
});

describe('applyAutonomyResult — 完整一轮', () => {
  it('二经历 + 二提案：outbox / 日记 / 心跳 / 事件 / 世界事实全部落地', async () => {
    const before = Date.now();
    await expect(applyAutonomyResult(roundPayload())).resolves.toBe(true);
    const after = Date.now();

    // outbox：两条经历行，told=0，pushed 回显，importance 直接取信封字符串
    const outbox = await DB.getOutboxByChar('c1');
    expect(outbox.map((e) => e.id).sort()).toEqual(['exp-1', 'exp-2']);
    const byId = new Map(outbox.map((e) => [e.id, e]));
    expect(byId.get('exp-1')).toMatchObject({
      id: 'exp-1', charId: 'c1', q: '想知道蝴蝶怎么过冬', told: 0, pushed: 1, kind: 'surf', importance: 'big',
    });
    expect(byId.get('exp-2')).toMatchObject({ id: 'exp-2', told: 0, pushed: 0, kind: 'game', importance: 'small' });
    expect(outbox.every((e) => Array.isArray(e.eventIds) && e.eventIds.length === 0)).toBe(true);

    // 日记：角色侧落 note，用户侧空页
    const diaries = await DB.getDiariesByCharId('c1');
    expect(diaries.map((d) => d.id).sort()).toEqual(['airp-diary-exp-1', 'airp-diary-exp-2']);
    const diary = diaries.find((d) => d.id === 'airp-diary-exp-1')!;
    expect(diary.charPage?.text).toBe('查了半天，蝴蝶会找树缝越冬。');
    expect(diary.userPage.text).toBe('');
    expect(diary.isArchived).toBe(false);

    // 事件：未被改道 → 落库即 disclosed=true；authority runtime_state
    const events = await listAirpEventsByChar('c1');
    expect(events.map((e) => e.id).sort()).toEqual(['airp-c1-exp-1-0', 'airp-c1-exp-1-1']);
    // authority 已放宽为 AirpFactAuthority，事件行按 deviation-3 记 runtime_state。
    expect(events.every((e) => e.authority === 'runtime_state')).toBe(true);
    expect(events.every((e) => e.disclosedToUser === true)).toBe(true);
    expect(events.find((e) => e.id === 'airp-c1-exp-1-0')).toMatchObject({
      type: 'activity', summary: '去河边跑步', impact: 'minor', participants: [],
    });

    // 世界事实：物化 authority runtime_state、知识 known
    const world = await loadAirpWorld('c1');
    expect(world.facts.map((f) => f.id).sort()).toEqual(['airp-fact-airp-c1-exp-1-0', 'airp-fact-airp-c1-exp-1-1']);
    expect(world.facts.every((f) => f.authority === 'runtime_state')).toBe(true);
    expect(world.knowledge.every((k) => k.state === 'known' && k.knowerId === 'c1')).toBe(true);

    // 心跳：逐字段对齐面板契约
    const heartbeats = await DB.getHeartbeatsByChar('c1');
    expect(heartbeats).toHaveLength(1);
    const hb = heartbeats[0];
    expect(Object.keys(hb).sort()).toEqual(
      ['charId', 'did', 'id', 'outboxed', 'pushed', 'toolsUsed', 'ts', 'usage', 'wokeAt'],
    );
    expect(hb.id).toBe('airp-hb-c1-exp-1');
    expect(hb.charId).toBe('c1');
    expect(hb.did).toBe('mixed');
    expect(hb.toolsUsed).toEqual([]);
    expect(hb.usage).toEqual({ prompt: 120, completion: 80, total: 200 });
    expect(hb.pushed).toBe(1);
    expect(hb.outboxed).toBe(2);
    expect(hb.wokeAt).toBe(hb.ts);
    expect(hb.ts).toBeGreaterThanOrEqual(before);
    expect(hb.ts).toBeLessThanOrEqual(after);
  });
});

describe('applyAutonomyResult — importance 边界', () => {
  it('信封字符串直接透传；缺失 / 未知 / 旧数字一律 fail-safe 收成 small', async () => {
    await expect(applyAutonomyResult(roundPayload({
      experiences: [
        { id: 'exp-a', q: '', note: 'a', kind: 'surf', importance: 'big', pushed: false },
        { id: 'exp-b', q: '', note: 'b', kind: 'surf', importance: 2, pushed: false },
        { id: 'exp-c', q: '', note: 'c', kind: 'surf', pushed: false },
        { id: 'exp-d', q: '', note: 'd', kind: 'surf', importance: 'huge', pushed: false },
      ],
    }))).resolves.toBe(true);

    const byId = new Map((await DB.getOutboxByChar('c1')).map((e) => [e.id, e]));
    expect(byId.get('exp-a')!.importance).toBe('big');
    // 旧数字信封（>=2）不再被分档成 big——数值映射已下线。
    expect(byId.get('exp-b')!.importance).toBe('small');
    expect(byId.get('exp-c')!.importance).toBe('small');
    expect(byId.get('exp-d')!.importance).toBe('small');
  });
});

describe('applyAutonomyResult — 重投幂等', () => {
  it('同一份 payload 再投一次：outbox / 日记 / 心跳 / 事件 / 事实都不翻倍', async () => {
    const payload = roundPayload();
    await applyAutonomyResult(payload);
    const factsBefore = (await loadAirpWorld('c1')).facts.length;

    await expect(applyAutonomyResult(payload)).resolves.toBe(true);

    expect(await DB.getOutboxByChar('c1')).toHaveLength(2);
    expect(await DB.getDiariesByCharId('c1')).toHaveLength(2);
    expect(await DB.getHeartbeatsByChar('c1')).toHaveLength(1);
    expect(await listAirpEventsByChar('c1')).toHaveLength(2);
    expect((await loadAirpWorld('c1')).facts).toHaveLength(factsBefore);
  });
});

describe('applyAutonomyResult — 降级改道（major × 档位）', () => {
  it('major + L2 → 不物化，落【待定】outbox 行 + 事件 disclosed=false', async () => {
    await seedChar({ autonomyLevel: 2 });
    const payload = roundPayload({
      experiences: [{ id: 'exp-1', q: '念头', note: '想换个城市住。', kind: 'rest', importance: 'small', pushed: false }],
      proposedEvents: [{ type: 'movement', summary: '决定搬去另一个城市', impact: 'major' }],
      did: 'rest',
    });

    await expect(applyAutonomyResult(payload)).resolves.toBe(true);

    const outbox = await DB.getOutboxByChar('c1');
    const susp = outbox.find((e) => e.id === 'airp-c1-exp-1-susp-0');
    expect(susp).toMatchObject({
      charId: 'c1',
      q: '决定搬去另一个城市',
      note: '【待定】决定搬去另一个城市',
      kind: 'mixed',
      importance: 'big',
      told: 0,
      pushed: 0,
      eventIds: ['airp-c1-exp-1-0'],
    });

    const events = await listAirpEventsByChar('c1');
    expect(events).toHaveLength(1);
    expect(events[0].disclosedToUser).toBe(false);

    // 未物化：世界文档没有这条事实
    expect((await loadAirpWorld('c1')).facts).toHaveLength(0);

    const [hb] = await DB.getHeartbeatsByChar('c1');
    expect(hb.outboxed).toBe(2);
    expect(hb.pushed).toBe(0);
    expect(hb.did).toBe('rest');
  });

  it('major + L3 → 正常物化（authority runtime_state），无【待定】行', async () => {
    await seedChar({ autonomyLevel: 3 });
    const payload = roundPayload({
      experiences: [{ id: 'exp-1', q: '念头', note: '想换个城市住。', kind: 'rest', importance: 'small', pushed: false }],
      proposedEvents: [{ type: 'movement', summary: '决定搬去另一个城市', impact: 'major' }],
    });

    await expect(applyAutonomyResult(payload)).resolves.toBe(true);

    const outbox = await DB.getOutboxByChar('c1');
    expect(outbox.map((e) => e.id)).toEqual(['exp-1']);

    const events = await listAirpEventsByChar('c1');
    expect(events).toHaveLength(1);
    expect(events[0].disclosedToUser).toBe(true);

    const world = await loadAirpWorld('c1');
    expect(world.facts).toHaveLength(1);
    expect(world.facts[0]).toMatchObject({ authority: 'runtime_state', status: 'active' });
  });
});

describe('applyAutonomyResult — 坏载荷与存储契约', () => {
  it('非对象 / 缺 charId / 数组字段坏 → warn + 销账 true，零写入', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(applyAutonomyResult(null)).resolves.toBe(true);
      await expect(applyAutonomyResult({ charId: 'c1' })).resolves.toBe(true);
      await expect(applyAutonomyResult({ charId: 'c1', experiences: 'nope', proposedEvents: [] })).resolves.toBe(true);
      await expect(applyAutonomyResult({ charId: '', experiences: [], proposedEvents: [] })).resolves.toBe(true);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }

    expect(await DB.getOutboxByChar('c1')).toHaveLength(0);
    expect(await DB.getHeartbeatsByChar('c1')).toHaveLength(0);
    expect(await DB.getDiariesByCharId('c1')).toHaveLength(0);
    expect(await listAirpEventsByChar('c1')).toHaveLength(0);
  });

  it('rest 轮（空 experiences）也落心跳，锚点退化为处理时刻（不抛）', async () => {
    await expect(applyAutonomyResult(roundPayload({ experiences: [], proposedEvents: [], did: 'rest', rested: true }))).resolves.toBe(true);

    const [hb] = await DB.getHeartbeatsByChar('c1');
    expect(hb.did).toBe('rest');
    expect(hb.outboxed).toBe(0);
    expect(hb.id.startsWith('airp-hb-c1-')).toBe(true);
  });
});

describe('applyAutonomyResult — 同批同槽物化（批量单调时间戳）', () => {
  it('同一轮两条同 type 提案：最终只剩一条 active 事实（后者 replace 前者），知识指向赢家', async () => {
    const payload = roundPayload({
      experiences: [{ id: 'exp-1', q: '', note: 'a', kind: 'surf', importance: 'small', pushed: false }],
      proposedEvents: [
        { type: 'activity', summary: '去河边跑步', impact: 'minor' },
        { type: 'activity', summary: '改成去爬山', impact: 'minor' },
      ],
    });

    await expect(applyAutonomyResult(payload)).resolves.toBe(true);

    const world = await loadAirpWorld('c1');
    // 同槽两条事实：赢家 active、输家留痕 superseded（逐条物化会让两条都 active → dispute）
    expect(world.facts).toHaveLength(2);
    const active = world.facts.filter((f) => f.status === 'active');
    expect(active).toHaveLength(1);
    // 批内下标靠后的提案胜出
    expect(active[0].id).toBe('airp-fact-airp-c1-exp-1-1');
    expect(active[0].value).toBe('改成去爬山');
    expect(world.facts.find((f) => f.id === 'airp-fact-airp-c1-exp-1-0')!.status).toBe('superseded');
    // 知识指向赢家
    expect(world.knowledge.some((k) => k.factId === active[0].id && k.state === 'known' && k.knowerId === 'c1')).toBe(true);
  });
});

describe('applyAutonomyResult — 孤儿轮与缺角色', () => {
  it('零经历的孤儿轮：事件 disclosed=false 且物化，outbox 无对应行，心跳照写', async () => {
    const payload = roundPayload({
      experiences: [],
      proposedEvents: [
        { type: 'activity', summary: '独自去河边跑步', impact: 'minor' },
        { type: 'discovery', summary: '翻到一本旧相册', impact: 'trace' },
      ],
    });

    await expect(applyAutonomyResult(payload)).resolves.toBe(true);

    // 没有经历行 → 没有任何 outbox 行能转述这些事件，不能谎报已交代
    expect(await DB.getOutboxByChar('c1')).toHaveLength(0);

    const events = await listAirpEventsByChar('c1');
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.disclosedToUser === false)).toBe(true);

    const facts = (await loadAirpWorld('c1')).facts;
    expect(facts).toHaveLength(2);
    expect(facts.every((f) => f.status === 'active')).toBe(true);

    const [hb] = await DB.getHeartbeatsByChar('c1');
    expect(hb.outboxed).toBe(0);
    expect(hb.id.startsWith('airp-hb-c1-ts')).toBe(true);
  });

  it('角色不在库（零 seed）：major 默认档位 0 → 改道，不抛，outbox 有【待定】行，不物化', async () => {
    const payload = roundPayload({
      charId: 'ghost',
      experiences: [{ id: 'exp-1', q: '念头', note: '想搬走。', kind: 'rest', importance: 'small', pushed: false }],
      proposedEvents: [{ type: 'movement', summary: '决定搬去另一个城市', impact: 'major' }],
    });

    await expect(applyAutonomyResult(payload)).resolves.toBe(true);

    const outbox = await DB.getOutboxByChar('ghost');
    expect(outbox.map((e) => e.id).sort()).toEqual(['airp-ghost-exp-1-susp-0', 'exp-1']);
    expect(outbox.find((e) => e.id === 'airp-ghost-exp-1-susp-0')).toMatchObject({
      q: '决定搬去另一个城市', note: '【待定】决定搬去另一个城市', told: 0, pushed: 0,
    });

    const events = await listAirpEventsByChar('ghost');
    expect(events).toHaveLength(1);
    expect(events[0].disclosedToUser).toBe(false);

    expect((await loadAirpWorld('ghost')).facts).toHaveLength(0);
    expect(await DB.getHeartbeatsByChar('ghost')).toHaveLength(1);
  });
});

describe('markEventsDisclosed', () => {
  it('按 id 翻 disclosedToUser，空输入 no-op', async () => {
    await saveAirpEvents([mkEvent('e1', false), mkEvent('e2', false), mkEvent('e3', true)]);

    await markEventsDisclosed('c1', []);
    await markEventsDisclosed('c1', ['e1']);
    let events = await listAirpEventsByChar('c1');
    expect(events.find((e) => e.id === 'e1')!.disclosedToUser).toBe(true);
    expect(events.find((e) => e.id === 'e2')!.disclosedToUser).toBe(false);

    await markEventsDisclosed('c1', ['e2', 'missing']);
    events = await listAirpEventsByChar('c1');
    expect(events.find((e) => e.id === 'e2')!.disclosedToUser).toBe(true);
    expect(events.find((e) => e.id === 'e3')!.disclosedToUser).toBe(true);
  });
});

describe('materializeCommittedEvents — authorityOverride', () => {
  it('默认 confirmed_scene；override runtime_state 生效', async () => {
    await materializeCommittedEvents('c1', [mkEvent('d1', true)], 100);
    await materializeCommittedEvents('c2', [mkEvent('o1', true)], 200, 'runtime_state');

    expect((await loadAirpWorld('c1')).facts.find((f) => f.id === 'airp-fact-d1')!.authority).toBe('confirmed_scene');
    expect((await loadAirpWorld('c2')).facts.find((f) => f.id === 'airp-fact-o1')!.authority).toBe('runtime_state');
  });
});

describe('备份登记与往返', () => {
  it('KNOWN 映射登记两个 v77 store', () => {
    expect(knownBackupStoreFieldMap()['autonomous_outbox']).toBe('autonomousOutbox');
    expect(knownBackupStoreFieldMap()['autonomous_heartbeats']).toBe('autonomousHeartbeats');
  });

  it('exportFullData → importFullData 往返：outbox 与心跳整组清-加恢复', async () => {
    await applyAutonomyResult(roundPayload());

    const exported = await DB.exportFullData();
    expect((exported.autonomousOutbox ?? []).map((e) => e.id).sort()).toEqual(['exp-1', 'exp-2']);
    expect((exported.autonomousHeartbeats ?? []).map((h) => h.id)).toEqual(['airp-hb-c1-exp-1']);

    await clearStores(['autonomous_outbox', 'autonomous_heartbeats']);
    expect(await DB.getOutboxByChar('c1')).toHaveLength(0);

    await DB.importFullData({ ...exported } as any);

    expect((await DB.getOutboxByChar('c1')).map((e) => e.id).sort()).toEqual(['exp-1', 'exp-2']);
    expect((await DB.getHeartbeatsByChar('c1')).map((h) => h.id)).toEqual(['airp-hb-c1-exp-1']);
  });
});

// ─── P5：生活工作流的可查看记录（v79）─────────────────────────────────────

const planPayload = (overrides: Record<string, unknown> = {}) => roundPayload({
  // 这一测只关心工作流这一段：经历与事件清空，免得把「提议不是现实事件」的断言搅浑。
  experiences: [],
  proposedEvents: [],
  workflows: [
    {
      id: 'plan-1', kind: 'diary', title: '今天的一点小事', purpose: '把那句话记下来',
      scheduledAt: 1_700_000_000_000, expiresAt: 1_700_100_000_000, basis: 'virtual',
    },
  ],
  ...overrides,
});

describe('工作流记录 — 提议入册', () => {
  it('计划提案 → 一条 proposed 记录，来源与用途都在，basis 保持虚拟', async () => {
    await seedChar({ enabled: true, writable: true, autonomyLevel: 2 });
    await expect(applyAutonomyResult(planPayload())).resolves.toBe(true);

    const plans = await DB.getWorkflowPlansByChar('c1');
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      id: 'plan-1', charId: 'c1', kind: 'diary', status: 'proposed',
      title: '今天的一点小事', purpose: '把那句话记下来', basis: 'virtual',
      scheduledAt: 1_700_000_000_000, expiresAt: 1_700_100_000_000,
    });
    // 提议不是现实事件：世界事件流里一条都不许多
    expect(await listAirpEventsByChar('c1')).toHaveLength(0);
  });

  it('同一条结果重投两次：记录不翻倍，完成态不被降级回 proposed', async () => {
    await seedChar({ enabled: true, writable: true, autonomyLevel: 2 });
    await applyAutonomyResult(planPayload());
    await applyAutonomyResult(planPayload({
      workflow: { planId: 'plan-1', kind: 'diary', title: '今天的一点小事', text: '写了几句。', plans: [], basis: 'virtual' },
    }));
    await applyAutonomyResult(planPayload({
      workflow: { planId: 'plan-1', kind: 'diary', title: '今天的一点小事', text: '写了几句。', plans: [], basis: 'virtual' },
    }));

    const plans = await DB.getWorkflowPlansByChar('c1');
    expect(plans).toHaveLength(1);
    expect(plans[0].status).toBe('completed');
    expect(plans[0].resultText).toBe('写了几句。');
  });
});

describe('工作流记录 — 结果落点', () => {
  it('跑完的结果折到对应计划上，正文是虚拟经历；日记另有 charPage', async () => {
    await seedChar({ enabled: true, writable: true, autonomyLevel: 2 });
    await applyAutonomyResult(planPayload());
    await applyAutonomyResult(roundPayload({
      experiences: [
        { id: 'exp-wf', q: '今天的一点小事', note: '写了一小段，心里安静下来。', kind: 'diary', importance: 'small', pushed: false },
      ],
      workflows: [],
      workflow: {
        planId: 'plan-1', kind: 'diary', title: '今天的一点小事',
        text: '写了一小段，心里安静下来。', plans: ['明天想早点睡'], basis: 'virtual',
      },
    }));

    const plans = await DB.getWorkflowPlansByChar('c1');
    expect(plans[0]).toMatchObject({
      status: 'completed', resultText: '写了一小段，心里安静下来。', resultPlans: ['明天想早点睡'], basis: 'virtual',
    });
    const diaries = await DB.getDiariesByCharId('c1');
    expect(diaries.some((d) => d.id === 'airp-diary-exp-wf')).toBe(true);
  });

  it('找不到提议记录时补一条最小完成记录（别的设备提的也不丢结果）', async () => {
    await seedChar({ enabled: true, writable: true, autonomyLevel: 2 });
    await applyAutonomyResult(roundPayload({
      experiences: [],
      workflows: [],
      workflow: { planId: 'plan-x', kind: 'interest_note', title: '想读那本书', text: '读了两页。', plans: [], basis: 'virtual' },
    }));

    const plans = await DB.getWorkflowPlansByChar('c1');
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ id: 'plan-x', status: 'completed', resultText: '读了两页。', purpose: '' });
  });

  it('坏 workflows 段（不是数组）只丢这一段，经历照常落地', async () => {
    await seedChar({ enabled: true, writable: true, autonomyLevel: 2 });
    await expect(applyAutonomyResult(planPayload({
      workflows: 'nope',
      experiences: [{ id: 'exp-bad', q: 'q', note: 'n', kind: 'surf', importance: 'small', pushed: false }],
    }))).resolves.toBe(true);
    expect(await DB.getWorkflowPlansByChar('c1')).toHaveLength(0);
    expect((await DB.getOutboxByChar('c1')).length).toBeGreaterThan(0);
  });
});

describe('用量字段保真（C2）', () => {
  it('缓存读数随心跳保真：供应商报了就有，没报就不写成 0', async () => {
    await seedChar({ enabled: true, writable: true, autonomyLevel: 2 });
    await applyAutonomyResult(roundPayload({
      usage: { prompt: 100, completion: 20, total: 120, cachedTokens: 64, cacheReadTokens: 8 },
    }));
    const withCache = (await DB.getHeartbeatsByChar('c1'))[0];
    expect(withCache.usage).toMatchObject({ prompt: 100, completion: 20, total: 120, cachedTokens: 64, cacheReadTokens: 8 });
    expect('cacheWriteTokens' in withCache.usage).toBe(false);

    await clearStores(['autonomous_heartbeats']);
    await applyAutonomyResult(roundPayload({ usage: { prompt: 10, completion: 5 } }));
    const plain = (await DB.getHeartbeatsByChar('c1'))[0];
    expect(plain.usage.total).toBe(15);
    expect('cachedTokens' in plain.usage).toBe(false);
  });
});

describe('备份登记与往返（v79）', () => {
  it('KNOWN 映射登记工作流记录 store', () => {
    expect(knownBackupStoreFieldMap()['airp_workflow_plans']).toBe('autonomyWorkflowPlans');
  });

  it('exportFullData → importFullData 往返：工作流记录整组清-加恢复', async () => {
    await seedChar({ enabled: true, writable: true, autonomyLevel: 2 });
    await applyAutonomyResult(planPayload());

    const exported = await DB.exportFullData();
    expect((exported.autonomyWorkflowPlans ?? []).map((p) => p.id)).toEqual(['plan-1']);

    await clearStores(['airp_workflow_plans']);
    expect(await DB.getWorkflowPlansByChar('c1')).toHaveLength(0);

    await DB.importFullData({ ...exported } as any);
    expect((await DB.getWorkflowPlansByChar('c1')).map((p) => p.id)).toEqual(['plan-1']);
  });
});

