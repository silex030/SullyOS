/**
 * 出行 · 闲逛分段 / 停留 / 返程（真实 SQLite + 真实 provider 代码 + 注入 fetch）
 *
 * 这组回归回答四个问题：
 * 1. 到点停留之后，**由角色自己**决定继续走 / 换一站 / 再待会儿 / 回家 / 就在这儿结束；
 * 2. 没有模型端口或预算就**安全暂停**（行程停在 dwelling、愿望保留），不伪造心理；
 * 3. 换站要真实候选 + 真实路线（沿道路折线，不是两点直线），同一段不重复烧地图；
 * 4. 返程沿真实路线回到**用户确认过的锚点**，不是原地标 returned；
 *    在外结束是独立终态 `stopped`，不瞬移回家、也不假装回到家。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { TRAVEL_SCHEMA_SQL } from '../../../../contracts/travel';
import { createSqliteD1, openTestSqlite, type TestSqlite } from '../test/d1-sqlite';
import { createAmapProvider } from './providerAmap';
import { ensureTravelBudgetRow, type TravelLlmLedgerPort } from './budget';
import {
  ensureTravelSchema,
  listTravelWishes,
  getActiveTravelTrip,
  getLatestTripForWish,
  getTravelTrip,
  insertTravelWish,
  listTripEvents,
  putTravelAnchor,
  resetTravelSchemaCacheForTesting,
  setTravelCharEnabled,
  upsertTravelSettings,
  type TravelDb,
} from './store';
import { runTravelTickForSubject, type TravelTickOutcome, type TravelTickWiring } from './tick';
import type { TravelDecisionPort } from './decision';

const T0 = Date.parse('2026-10-23T01:00:00.000Z');
const MIN = 60_000;
const USER = '22222222-2222-4222-8222-222222222222';
const CHAR = 'char-w';
const WISH = `tw:${USER}:${CHAR}:w1`;
const ANCHOR = { lat: 30.100000, lng: 120.100000 };
const POI_A = { lat: 30.120000, lng: 120.140000 };
const POI_B = { lat: 30.150000, lng: 120.170000 };

let sql: TestSqlite;
let db: TravelDb;

/** 离线高德桩：walking 折线由请求里的起终点生成 3 个点（中点偏移，证明不是两点直线）。 */
const amapFetch = (calls: string[]) => (async (input: RequestInfo | URL) => {
  const url = String(input);
  calls.push(url);
  if (url.includes('/v3/place/text')) {
    return new Response(JSON.stringify({
      status: '1',
      infocode: '10000',
      pois: [
        {
          id: 'B0FFA', name: '湖畔书店', type: '购物服务', cityname: '杭州市',
          adname: '西湖区', location: `${POI_A.lng.toFixed(6)},${POI_A.lat.toFixed(6)}`, distance: '1200',
        },
        {
          id: 'B0FFB', name: '河坊街茶馆', type: '餐饮服务', cityname: '杭州市',
          adname: '上城区', location: `${POI_B.lng.toFixed(6)},${POI_B.lat.toFixed(6)}`, distance: '2100',
        },
      ],
    }), { headers: { 'Content-Type': 'application/json' } });
  }
  if (url.includes('/v3/direction/walking')) {
    const q = new URL(url).searchParams;
    const [ox, oy] = String(q.get('origin')).split(',').map(Number);
    const [dx, dy] = String(q.get('destination')).split(',').map(Number);
    const mid = `${((ox + dx) / 2 + 0.001).toFixed(6)},${((oy + dy) / 2 + 0.001).toFixed(6)}`;
    return new Response(JSON.stringify({
      status: '1',
      infocode: '10000',
      route: {
        paths: [{
          distance: '1500',
          duration: '1200',
          steps: [{
            instruction: '沿道路步行',
            polyline: `${ox},${oy};${mid};${dx},${dy}`,
            distance: '1500',
            duration: '1200',
          }],
        }],
      },
    }), { headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error(`unexpected amap url ${url}`);
}) as unknown as typeof globalThis.fetch;

/** 记录调用的假账本端口（生产实现是 llmLedger.ts 的 autonomy 适配器）。 */
const ledger = (override?: Partial<TravelLlmLedgerPort>) => {
  const reserved: string[] = [];
  const settled: Array<{ reservationId: string; actualTokens: number }> = [];
  const port: TravelLlmLedgerPort = {
    read: async () => ({ usedTokens: 0, limitTokens: 200_000, paused: false }),
    reserve: async ({ idempotencyKey }) => {
      reserved.push(idempotencyKey);
      return { ok: true, reservationId: idempotencyKey };
    },
    settle: async ({ reservationId, actualTokens }) => {
      settled.push({ reservationId, actualTokens });
    },
    release: async () => {},
    ...override,
  };
  return { port, reserved, settled };
};

type Script = unknown | ((input: unknown) => unknown);

/** 脚本化模型端口：按顺序吐预设值（值可以是函数，用来引用真实候选 id）。 */
const scriptPort = (chooseOut: Script[], segmentOut: Script[], intentOut: Script[] = []) => {
  const asked: string[] = [];
  const next = (list: Script[]): unknown => {
    const item = list.shift();
    return typeof item === 'function' ? (item as (input: unknown) => unknown)(null) : item;
  };
  const port: TravelDecisionPort = {
    async choose({ candidates }) {
      asked.push('choose');
      const item = chooseOut.shift();
      return typeof item === 'function'
        ? (item as (input: unknown) => unknown)(candidates)
        : item ?? { kind: 'wait' };
    },
    async nextSegment(context) {
      asked.push('segment');
      const item = segmentOut.shift();
      return typeof item === 'function'
        ? (item as (input: unknown) => unknown)(context)
        : item ?? { kind: 'wait' };
    },
    async proposeIntent() {
      asked.push('intent');
      const item = intentOut.shift();
      return item ?? { want: 'none' };
    },
    lastUsageTokens: () => undefined,
  };
  return { port, asked };
};

const firstCandidate = ((candidates: unknown) => ({
  kind: 'choose',
  candidateId: (candidates as Array<{ id: string }>)[0].id,
})) as unknown as Script;

const seedWish = async (category = 'wander') => {
  await upsertTravelSettings(db, { userId: USER, nowMs: T0, baseVersion: null, enabled: true });
  await setTravelCharEnabled(db, { userId: USER, charId: CHAR, enabled: true, nowMs: T0 });
  await putTravelAnchor(db, {
    userId: USER, charId: CHAR, label: '翠苑一区', city: '杭州市', district: '西湖区',
    lat: ANCHOR.lat, lng: ANCHOR.lng, coordSys: 'gcj02', precision: 'area',
    confirmedAt: T0, updatedAt: T0,
  } as never);
  await insertTravelWish(db, {
    id: WISH, userId: USER, charId: CHAR,
    wishText: '在附近随便走走', category,
    selectedCandidateId: null, state: 'open',
    expiresAt: T0 + 12 * 60 * MIN, createdAt: T0, updatedAt: T0,
  });
};

const seedAuthOnly = async () => {
  await upsertTravelSettings(db, { userId: USER, nowMs: T0, baseVersion: null, enabled: true });
  await setTravelCharEnabled(db, { userId: USER, charId: CHAR, enabled: true, nowMs: T0 });
  await putTravelAnchor(db, {
    userId: USER, charId: CHAR, label: '翠苑一区', city: '杭州市', district: '西湖区',
    lat: ANCHOR.lat, lng: ANCHOR.lng, coordSys: 'gcj02', precision: 'area',
    confirmedAt: T0, updatedAt: T0,
  } as never);
};

const wiring = (args: {
  now: number;
  calls: string[];
  port: TravelDecisionPort | null;
  ledgerPort: TravelLlmLedgerPort | null;
}): TravelTickWiring => {
  const deps = {
    fetch: amapFetch(args.calls),
    reserveMapCall: async () => ({ allowed: true as const }),
    now: () => args.now,
  };
  return {
    now: () => args.now,
    fetch: amapFetch(args.calls),
    providers: [createAmapProvider({ resolveKey: () => 'test-web-key' } as never, deps as never)],
    region: 'CN',
    readAnchor: async () => ({
      label: '翠苑一区', city: '杭州市', district: '西湖区',
      lat: ANCHOR.lat, lng: ANCHOR.lng, coordSys: 'gcj02' as const, precision: 'area' as const,
      confirmedAt: T0, source: 'user' as const,
    }),
    decisionPort: args.port,
    llmPort: args.ledgerPort,
    licensedGeometry: true,
    dwellMinutes: 30,
  };
};

const tick = (args: {
  now: number;
  calls: string[];
  port: TravelDecisionPort | null;
  ledgerPort: TravelLlmLedgerPort | null;
}): Promise<TravelTickOutcome> =>
  runTravelTickForSubject(db, { userId: USER, charId: CHAR }, wiring(args));

/** 一路推到「刚停留结束」：出门 → 到家 → 待够 30 分钟。 */
const walkToDwellEnd = async (port: TravelDecisionPort, ledgerPort: TravelLlmLedgerPort) => {
  const calls: string[] = [];
  await tick({ now: T0, calls, port, ledgerPort });            // open → candidates_ready
  await tick({ now: T0 + 5 * MIN, calls, port, ledgerPort });  // 选点 + 排路线 → planned
  await tick({ now: T0 + 6 * MIN, calls, port, ledgerPort });  // planned → en_route
  await tick({ now: T0 + 26 * MIN, calls, port, ledgerPort }); // en_route → dwelling

  const trip = await getActiveTravelTrip(db, { userId: USER, charId: CHAR });
  expect(trip?.status).toBe('dwelling');
  calls.length = 0;
  return { calls, dwellEndsAt: trip!.dwellUntil! };
};

beforeEach(async () => {
  sql = openTestSqlite();
  resetTravelSchemaCacheForTesting();
  db = createSqliteD1(sql) as unknown as TravelDb;
  await ensureTravelSchema(db);
  if (!sql.prepare("SELECT name FROM sqlite_master WHERE name = 'travel_budget_state'").get()) {
    sql.exec(TRAVEL_SCHEMA_SQL);
  }
  await ensureTravelBudgetRow(db, { userId: USER, mapCallsLimit: 20, nowMs: T0 });
});

describe('闲逛分段：走到一站之后由角色自己决定', () => {
  it('两段闲逛 → 停留 → 选返程 → 沿真实路线回到确认锚点（不是原地标 returned）', async () => {
    await seedWish();
    const led = ledger();
    const model = scriptPort(
      [firstCandidate],
      [
        (ctx: unknown) => {
          const c = ctx as { hereLabel: string | null; candidates: Array<{ id: string; label: string }> };
          const other = c.candidates.find((x) => x.label !== c.hereLabel) ?? c.candidates[0];
          return { kind: 'next', candidateId: other.id, reason: '再逛逛' };
        },
        { kind: 'return', reason: '该回家了' },
      ],
    );

    const { calls, dwellEndsAt } = await walkToDwellEnd(model.port, led.port);
    const first = await getActiveTravelTrip(db, { userId: USER, charId: CHAR });
    expect(first?.planVersion).toBe(1);
    const firstStop = first!.dest!.label;

    // 第一段结束：角色选「换一站」
    const seg1 = await tick({ now: dwellEndsAt + MIN, calls, port: model.port, ledgerPort: led.port });
    expect(seg1.segment).toBe('next');
    const second = await getActiveTravelTrip(db, { userId: USER, charId: CHAR });
    expect(second?.planVersion).toBe(2);
    expect(second?.status).toBe('planned');
    expect(second?.route?.points.length).toBeGreaterThanOrEqual(3);
    // 换站的路线起点是**上一站**，不是住处；终点是新候选（真实 POI）
    expect(second?.origin.label).toBe(firstStop);
    expect(second?.dest?.label).not.toBe(firstStop); // 换了一站，不是原地重排
    expect(calls.filter((u) => u.includes('/v3/place/text'))).toHaveLength(1);
    expect(calls.filter((u) => u.includes('/v3/direction/walking'))).toHaveLength(1);

    // 第二段走完 → 再停留结束：角色选回家
    const arrive2 = second!.arriveAt!;
    const dwell2 = second!.dwellUntil!;
    await tick({ now: second!.departAt! + MIN, calls, port: model.port, ledgerPort: led.port }); // planned → en_route
    await tick({ now: arrive2 + MIN, calls, port: model.port, ledgerPort: led.port });          // en_route → dwelling
    const atStop2 = await getActiveTravelTrip(db, { userId: USER, charId: CHAR });
    expect(atStop2?.status).toBe('dwelling');

    const seg2 = await tick({ now: dwell2 + MIN, calls, port: model.port, ledgerPort: led.port });
    expect(seg2.segment).toBe('return');
    const goingHome = await getActiveTravelTrip(db, { userId: USER, charId: CHAR });
    expect(goingHome?.status).toBe('returning');
    expect(goingHome?.origin.label).toBe(second!.dest!.label);
    expect(goingHome?.dest?.label).toBe('翠苑一区');
    // 返程路线终点 = 确认锚点（沿道路折线的最后一个点）
    const last = goingHome!.route!.points.at(-1)!;
    expect(last.lat).toBeCloseTo(ANCHOR.lat, 5);
    expect(last.lng).toBeCloseTo(ANCHOR.lng, 5);

    // 到点才 returned（走回去的，不是瞬间翻状态）
    await tick({ now: goingHome!.returnAt! + MIN, calls, port: model.port, ledgerPort: led.port });
    const done = await getTravelTrip(db, { userId: USER, tripId: goingHome!.id });
    expect(done?.status).toBe('returned');
    expect(await getActiveTravelTrip(db, { userId: USER, charId: CHAR })).toBeNull();
  });

  it('角色选「再待一会儿」→ 延长停留，不排路线、不换站', async () => {
    await seedWish();
    const led = ledger();
    const model = scriptPort([firstCandidate], [{ kind: 'stay', minutes: 40, reason: '还没看完' }]);
    const { calls, dwellEndsAt } = await walkToDwellEnd(model.port, led.port);

    const seg = await tick({ now: dwellEndsAt + MIN, calls, port: model.port, ledgerPort: led.port });
    expect(seg.segment).toBe('stay');
    const after = await getActiveTravelTrip(db, { userId: USER, charId: CHAR });
    expect(after?.status).toBe('dwelling');
    expect(after?.planVersion).toBe(1);
    expect(after?.dwellUntil).toBeGreaterThan(dwellEndsAt);
    expect(after?.dwellUntil).toBe(dwellEndsAt + MIN + 40 * MIN);
    // 停留本身不排路线（唯一的真实地图请求是「附近还有哪儿能去」的候选查询）
    expect(calls.filter((u) => u.includes('/v3/direction/walking'))).toHaveLength(0);
    expect(calls.filter((u) => u.includes('/v3/place/text'))).toHaveLength(1);
  });

  it('角色选「就在这儿结束」→ 终态 stopped，不是 returned', async () => {
    await seedWish();
    const led = ledger();
    const model = scriptPort([firstCandidate], [{ kind: 'stop', reason: '不想再走了' }]);
    const { calls, dwellEndsAt } = await walkToDwellEnd(model.port, led.port);
    const trip = await getActiveTravelTrip(db, { userId: USER, charId: CHAR });
    const here = trip!.dest!.label;

    const seg = await tick({ now: dwellEndsAt + MIN, calls, port: model.port, ledgerPort: led.port });
    expect(seg.segment).toBe('stop');
    const stopped = await getTravelTrip(db, { userId: USER, tripId: trip!.id });
    expect(stopped?.status).toBe('stopped');
    expect(stopped?.dest?.label).toBe(here); // 停在哪就是哪，没被改写回家
    expect(calls.filter((u) => u.includes('/v3/direction/walking'))).toHaveLength(0);
    const events = await listTripEvents(db, { userId: USER, tripId: trip!.id });
    const stopEvent = events.find((e) => e.kind === 'segment_stop');
    expect(stopEvent?.payload).toMatchObject({ endedAway: true, atLabel: here });
    expect(await getActiveTravelTrip(db, { userId: USER, charId: CHAR })).toBeNull();
  });

  it('没有模型端口 → 安全暂停：留在原地、愿望保留、零模型零地图', async () => {
    await seedWish();
    const led = ledger();
    const model = scriptPort([firstCandidate], []);
    const { calls, dwellEndsAt } = await walkToDwellEnd(model.port, led.port);
    const before = await getActiveTravelTrip(db, { userId: USER, charId: CHAR });

    const seg = await tick({ now: dwellEndsAt + MIN, calls, port: null, ledgerPort: led.port });
    expect(seg.skipped).toContain('llm_unavailable');
    expect(seg.segment).toBeNull();
    const after = await getActiveTravelTrip(db, { userId: USER, charId: CHAR });
    expect(after?.status).toBe('dwelling');
    expect(after?.dwellUntil).toBe(before!.dwellUntil);
    expect(calls).toHaveLength(0);
  });

  it('LLM 额度拒绝 → budget_blocked：不调模型、不搜点、行程不动', async () => {
    await seedWish();
    let reserves = 0;
    const led = ledger({
      reserve: async ({ idempotencyKey }) => {
        reserves += 1;
        // 第一次是「选哪站」的决策（照常）；分段那次才额度不足。
        return reserves === 1
          ? { ok: true, reservationId: idempotencyKey }
          : { ok: false, code: 'BUDGET_BLOCKED' };
      },
    });
    const model = scriptPort([firstCandidate], []);
    const { calls, dwellEndsAt } = await walkToDwellEnd(model.port, led.port);
    const askedBefore = model.asked.length;

    const seg = await tick({ now: dwellEndsAt + MIN, calls, port: model.port, ledgerPort: led.port });
    expect(seg.skipped).toContain('budget_blocked');
    expect(model.asked.length).toBe(askedBefore); // 分段一次模型都没打
    expect(calls).toHaveLength(0); // 也没搜点
    expect((await getActiveTravelTrip(db, { userId: USER, charId: CHAR }))?.status).toBe('dwelling');
  });

  it('并发重放同一段 → 最多一次模型、一次地图（另一个 tick 直接 CAS 冲突）', async () => {
    await seedWish();
    const led = ledger();
    const model = scriptPort([firstCandidate], [{ kind: 'stay', minutes: 20 }]);
    const { calls, dwellEndsAt } = await walkToDwellEnd(model.port, led.port);
    const askedBefore = model.asked.length;

    const args = { now: dwellEndsAt + MIN, calls, port: model.port, ledgerPort: led.port };
    const [a, b] = await Promise.all([tick(args), tick(args)]);
    const segments = [a, b].filter((o) => o.segment === 'stay').length;
    expect(segments).toBe(1);
    expect(model.asked.length - askedBefore).toBe(1);
    // 同一段最多搜一次点（抢输的那个 tick 什么都不做）
    expect(calls.filter((u) => u.includes('/v3/place/text'))).toHaveLength(1);
  });

  it('结算优先用供应商真实 usage，而不是预估值', async () => {
    await seedWish();
    const led = ledger();
    const outputs = [{ kind: 'stay', minutes: 20 }];
    const port: TravelDecisionPort = {
      async choose({ candidates }) {
        return { kind: 'choose', candidateId: candidates[0].id };
      },
      async nextSegment() {
        return outputs.shift() ?? { kind: 'stay' };
      },
      lastUsageTokens: () => 777,
    };
    const { calls, dwellEndsAt } = await walkToDwellEnd(port, led.port);
    await tick({ now: dwellEndsAt + MIN, calls, port, ledgerPort: led.port });
    const segmentSettle = led.settled.at(-1);
    expect(segmentSettle?.actualTokens).toBe(777);
  });

  it('没有推送订阅也能自己产生愿望：3 小时窗口内只问一次，说不想就不写', async () => {
    await seedAuthOnly();
    const led = ledger();
    const model = scriptPort([], [], [{ want: 'wander' }]);

    // 库里连 push_subscriptions 这张表都没有：这条路径不查订阅（旧链路才会 409）。
    expect(sql.prepare("SELECT name FROM sqlite_master WHERE name = 'push_subscriptions'").get()).toBeUndefined();

    const first = await tick({ now: T0, calls: [], port: model.port, ledgerPort: led.port });
    expect(model.asked).toEqual(['intent']);
    const wish = (await listTravelWishes(db, { userId: USER, charId: CHAR, nowMs: T0, states: ['open'] }))[0];
    expect(wish?.category).toBe('wander');
    expect(first.searched).toBe(false); // 这一跳只问意愿，不搜点

    // 同一窗口第二跳：认领失败 → 不再问一次意愿，也不会多出一条愿望
    await tick({ now: T0 + 5 * MIN, calls: [], port: model.port, ledgerPort: led.port });
    expect(model.asked).toEqual(['intent']);
    const openAfter = await listTravelWishes(db, { userId: USER, charId: CHAR, nowMs: T0 + 5 * MIN });
    expect(openAfter).toHaveLength(1);
  });

  it('角色想待着（want=none）→ 不写愿望、不伪造「想出门」', async () => {
    await seedAuthOnly();
    const led = ledger();
    const model = scriptPort([], [], [{ want: 'none' }]);
    const out = await tick({ now: T0, calls: [], port: model.port, ledgerPort: led.port });
    expect(model.asked).toEqual(['intent']);
    expect(out.skipped).toContain('no_wish');
    expect(await listTravelWishes(db, { userId: USER, charId: CHAR, nowMs: T0 })).toHaveLength(0);
  });

  it('非闲逛的愿望到点照旧自动回家（不花模型，也不伪造心理）', async () => {
    await seedWish('看书');
    const led = ledger();
    const model = scriptPort([firstCandidate], []);
    const { calls, dwellEndsAt } = await walkToDwellEnd(model.port, led.port);
    const askedBefore = model.asked.length;

    const seg = await tick({ now: dwellEndsAt + MIN, calls, port: model.port, ledgerPort: led.port });
    expect(seg.segment).toBeNull();
    expect(seg.advanced).toContain('returning');
    expect(model.asked.length).toBe(askedBefore);
    expect(calls).toHaveLength(0);
  });
});
