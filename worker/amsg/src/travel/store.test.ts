/**
 * B1 存储层的**真表**回归（node:sqlite + 契约 DDL，不是记录 SQL 文本的假库）。
 *
 * 为什么必须真库：这一层要证明的四件事，假库一件都证明不了 ——
 *   1. `travel_trips (user_id, char_id, dedupe_key)` 唯一索引真的挡住了跨租户 dedupe 碰撞；
 *   2. 幂等插入（`INSERT OR IGNORE`）真能「第二次不改行、回同一行」；
 *   3. CAS 是**条件 UPDATE**：并发方在读到写之间插进来，我们必须拿 0 行、对方的值必须留下；
 *   4. 保留期删除按 `changes` 回报真删了几行，且不会越界删到别的租户/在途行程。
 *
 * 测试用 `worker/amsg/src/test/d1-sqlite.ts`（只读复用）把 D1 形状接到真 sqlite 上。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { TRAVEL_SCHEMA_SQL, type TravelPlaceRef } from '../../../../contracts/travel';
import { createSqliteD1, openTestSqlite, type TestSqlite } from '../test/d1-sqlite';
import {
  appendTravelTripEvent,
  casUpdateTravelTrip,
  ensureTravelSchema,
  getTravelCandidate,
  getActiveTravelTrip,
  getTravelSettings,
  getTravelShareState,
  getTravelTrip,
  getTravelWish,
  insertTravelWish,
  listTravelCandidates,
  listTravelWishes,
  listTripEvents,
  pruneTravelRetention,
  resetTravelSchemaCacheForTesting,
  saveTravelCandidates,
  setTravelShareState,
  setTravelWishState,
  upsertTravelSettings,
  upsertTravelTrip,
  type TravelCandidateRecord,
  type TravelTripRecord,
} from './store';

const NOW = Date.parse('2026-10-23T04:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const place = (label: string, lat: number, lng: number): TravelPlaceRef => ({
  label,
  city: '杭州市',
  district: '西湖区',
  lat,
  lng,
  coordSys: 'gcj02',
  kind: 'public',
});

const tripRow = (overrides: Partial<TravelTripRecord> = {}): TravelTripRecord => ({
  id: 'trip-1',
  userId: 'u1',
  charId: 'c1',
  status: 'planned',
  phase: 'planned',
  planVersion: 1,
  revision: 1,
  coordSys: 'gcj02',
  provider: 'amap',
  origin: place('阳光花园', 30.25, 120.15),
  dest: place('西湖文化广场', 30.28, 120.16),
  route: { points: [{ lat: 30.25, lng: 120.15 }, { lat: 30.28, lng: 120.16 }], distanceM: 4200 },
  routeFetchedAt: NOW - 60_000,
  departAt: NOW,
  arriveAt: NOW + 3_600_000,
  dwellUntil: NOW + 7_200_000,
  returnAt: NOW + 10_800_000,
  retentionExpiresAt: NOW + 30 * DAY,
  dedupeKey: 'wish-1:gen:1:trip-1',
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const candidateRow = (overrides: Partial<TravelCandidateRecord> = {}): TravelCandidateRecord => ({
  id: 'cand-1',
  userId: 'u1',
  wishId: 'wish-1',
  provider: 'amap',
  placeId: 'B0FFH1',
  label: '西湖文化广场',
  category: '风景名胜',
  city: '杭州市',
  district: '拱墅区',
  lat: 30.28,
  lng: 120.16,
  coordSys: 'gcj02',
  distanceM: 4200,
  expiresAt: NOW + DAY,
  createdAt: NOW,
  ...overrides,
});

let sql: TestSqlite;
let db: ReturnType<typeof createSqliteD1>;

const count = (table: string, where = '', ...params: unknown[]): number => {
  const row = sql.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get(...(params as never[]));
  return Number((row as { n: number }).n);
};

const indexNames = (table: string): string[] =>
  (sql.prepare(`PRAGMA index_list('${table}')`).all() as Array<{ name: string; unique: number }>).map(
    (row) => `${row.name}:${row.unique}`,
  );

beforeEach(async () => {
  resetTravelSchemaCacheForTesting();
  sql = openTestSqlite();
  db = createSqliteD1(sql);
  await ensureTravelSchema(db);
});

describe('ensureTravelSchema（契约原文 DDL）', () => {
  it('契约表全部建出来（含锚点/角色开关/位置历史），且唯一索引真的含 user_id', () => {
    const tables = (
      sql
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'travel_%' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(tables).toEqual([
      'travel_anchors',
      'travel_budget_state',
      'travel_candidates',
      'travel_char_settings',
      'travel_map_credentials',
      'travel_settings',
      'travel_share_state',
      'travel_trip_events',
      'travel_trip_positions',
      'travel_trips',
      'travel_wishes',
    ]);

    // 不建缓存表（高德协议 3.5/7.3/4.12.3）：契约里就没有，schema 也不许有。
    expect(tables).not.toContain('travel_place_cache');
    expect(tables).not.toContain('travel_route_cache');

    expect(indexNames('travel_trips')).toEqual(
      expect.arrayContaining(['travel_trips_dedupe:1']),
    );
    expect(indexNames('travel_trip_events')).toEqual(
      expect.arrayContaining(['travel_events_seq:1']),
    );

    // 唯一索引的列必须是 (user_id, char_id, dedupe_key) —— 少了 user_id 就是跨租户串号。
    const cols = (
      sql.prepare("PRAGMA index_info('travel_trips_dedupe')").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(cols).toEqual(['user_id', 'char_id', 'dedupe_key']);

    // 幂等建表：同一份 SQL 再跑一次不报错、不丢数据。
    sql.exec(TRAVEL_SCHEMA_SQL);
    expect(count('travel_settings')).toBe(0);
  });
});

describe('travel_settings（账号级策略 + 版本 CAS）', () => {
  it('首次落默认时区/保留期；再改必须带对版本，落后版本被拒且原值不动', async () => {
    const created = await upsertTravelSettings(db, { userId: 'u1', nowMs: NOW, baseVersion: null });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.settings.budgetTz).toBe('Asia/Shanghai');
    expect(created.settings.tripRetentionDays).toBe(30);
    expect(created.settings.eventRetentionDays).toBe(7);
    expect(created.settings.version).toBe(1);

    const updated = await upsertTravelSettings(db, {
      userId: 'u1',
      nowMs: NOW + 1000,
      baseVersion: 1,
      budgetTz: 'America/New_York',
      tripRetentionDays: 0,
      eventRetentionDays: 0,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    // 0 是「只留当前行程 / 不保留事件」，不是「用默认值」。
    expect(updated.settings).toMatchObject({
      budgetTz: 'America/New_York',
      tripRetentionDays: 0,
      eventRetentionDays: 0,
      version: 2,
    });

    // 另一台设备还拿着 version=1：必须拒，且库里仍是 version=2 的值。
    const stale = await upsertTravelSettings(db, {
      userId: 'u1',
      nowMs: NOW + 2000,
      baseVersion: 1,
      budgetTz: 'Europe/London',
    });
    expect(stale).toEqual({ ok: false, code: 'VERSION_CONFLICT' });
    expect((await getTravelSettings(db, 'u1'))!.budgetTz).toBe('America/New_York');
  });

  it('租户隔离：u2 读不到 u1 的策略，各自独立建行', async () => {
    await upsertTravelSettings(db, { userId: 'u1', nowMs: NOW, baseVersion: null, budgetTz: 'Asia/Tokyo' });
    expect(await getTravelSettings(db, 'u2')).toBeNull();
    await upsertTravelSettings(db, { userId: 'u2', nowMs: NOW, baseVersion: null });
    expect((await getTravelSettings(db, 'u1'))!.budgetTz).toBe('Asia/Tokyo');
    expect((await getTravelSettings(db, 'u2'))!.budgetTz).toBe('Asia/Shanghai');
  });
});

describe('travel_wishes（愿望）', () => {
  const wish = (overrides: Record<string, unknown> = {}) => ({
    id: 'wish-1',
    userId: 'u1',
    charId: 'c1',
    wishText: '想去看看西湖边的旧书店',
    category: '书店',
    state: 'open' as const,
    expiresAt: NOW + DAY,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });

  it('同 id 重复插入不新增行（幂等），id 归属别的租户时拒绝覆盖', async () => {
    expect(await insertTravelWish(db, wish())).toBe(true);
    expect(await insertTravelWish(db, wish({ wishText: '改个说法' }))).toBe(false);
    expect(count('travel_wishes')).toBe(1);
    // 原行一个字都没被覆盖。
    expect((await getTravelWish(db, { userId: 'u1', wishId: 'wish-1' }))!.wishText).toBe(
      '想去看看西湖边的旧书店',
    );

    // u2 拿同一个 id：不许插、更不许看到 u1 的行。
    expect(await insertTravelWish(db, wish({ userId: 'u2' }))).toBe(false);
    expect(await getTravelWish(db, { userId: 'u2', wishId: 'wish-1' })).toBeNull();
    expect(count('travel_wishes')).toBe(1);
  });

  it('按租户+角色列未过期愿望；状态改写是条件 UPDATE（别人的行改不动）', async () => {
    await insertTravelWish(db, wish());
    await insertTravelWish(db, wish({ id: 'wish-2', expiresAt: NOW - 1 }));
    await insertTravelWish(db, wish({ id: 'wish-3', charId: 'c2' }));
    await insertTravelWish(db, wish({ id: 'wish-4', userId: 'u2' }));

    const listed = await listTravelWishes(db, { userId: 'u1', charId: 'c1', nowMs: NOW });
    expect(listed.map((row) => row.id)).toEqual(['wish-1']);

    expect(
      await setTravelWishState(db, {
        userId: 'u3',
        wishId: 'wish-1',
        state: 'chosen',
        nowMs: NOW + 5,
      }),
    ).toBe(false);
    expect((await getTravelWish(db, { userId: 'u1', wishId: 'wish-1' }))!.state).toBe('open');

    expect(
      await setTravelWishState(db, { userId: 'u1', wishId: 'wish-1', state: 'chosen', nowMs: NOW + 5 }),
    ).toBe(true);
    expect((await getTravelWish(db, { userId: 'u1', wishId: 'wish-1' }))!.state).toBe('chosen');
  });
});

describe('travel_candidates（有界候选，坐标只留在服务端）', () => {
  it('同批重复保存不新增；过期候选不列、查不到（上游给 UNKNOWN_CANDIDATE）', async () => {
    expect(
      await saveTravelCandidates(db, {
        userId: 'u1',
        wishId: 'wish-1',
        nowMs: NOW,
        candidates: [candidateRow(), candidateRow({ id: 'cand-2', label: '晓风书屋' })],
      }),
    ).toEqual({ inserted: 2, skipped: 0 });

    // 同 id 再次保存：幂等，不覆盖已有行。
    expect(
      await saveTravelCandidates(db, {
        userId: 'u1',
        wishId: 'wish-1',
        nowMs: NOW,
        candidates: [candidateRow({ label: '被改名了' })],
      }),
    ).toEqual({ inserted: 0, skipped: 1 });
    expect(count('travel_candidates')).toBe(2);

    const listed = await listTravelCandidates(db, { userId: 'u1', wishId: 'wish-1', nowMs: NOW });
    expect(listed.map((row) => row.label)).toEqual(['西湖文化广场', '晓风书屋']);

    expect(
      await getTravelCandidate(db, { userId: 'u1', wishId: 'wish-1', candidateId: 'cand-1', nowMs: NOW }),
    ).not.toBeNull();
    expect(
      await getTravelCandidate(db, {
        userId: 'u1',
        wishId: 'wish-1',
        candidateId: 'cand-1',
        nowMs: NOW + DAY,
      }),
    ).toBeNull();
  });

  it('租户隔离：u2 既列不到 u1 的候选，也拿同一个 id 查不到', async () => {
    await saveTravelCandidates(db, {
      userId: 'u1',
      wishId: 'wish-1',
      nowMs: NOW,
      candidates: [candidateRow()],
    });
    expect(await listTravelCandidates(db, { userId: 'u2', wishId: 'wish-1', nowMs: NOW })).toEqual([]);
    expect(
      await getTravelCandidate(db, { userId: 'u2', wishId: 'wish-1', candidateId: 'cand-1', nowMs: NOW }),
    ).toBeNull();
  });
});

describe('travel_trips（幂等插入 + 真 CAS）', () => {
  it('同 (user,char,dedupe) 第二次插入不新增行，返回同一行；跨租户同 dedupe 各插各的', async () => {
    const first = await upsertTravelTrip(db, tripRow());
    expect(first.inserted).toBe(true);
    expect(first.trip.id).toBe('trip-1');

    const again = await upsertTravelTrip(db, tripRow({ id: 'trip-other', updatedAt: NOW + 1 }));
    expect(again.inserted).toBe(false);
    expect(again.trip.id).toBe('trip-1');
    expect(count('travel_trips')).toBe(1);

    // 同一个 char_id + dedupe_key，换一个租户：唯一索引含 user_id，必须能各插一条。
    const other = await upsertTravelTrip(db, tripRow({ id: 'trip-u2', userId: 'u2' }));
    expect(other.inserted).toBe(true);
    expect(count('travel_trips')).toBe(2);
    expect(await getTravelTrip(db, { userId: 'u2', tripId: 'trip-1' })).toBeNull();
  });

  it('CAS 用条件 UPDATE：并发方先改了 revision，我们拿 0 行、对方的值留下', async () => {
    await upsertTravelTrip(db, tripRow());
    let injected = false;
    // 在**我们那条 UPDATE 执行前**插入另一台设备的写入（同 revision 起点）。
    const racing = createSqliteD1(sql, {
      beforeStatement: (text) => {
        if (!injected && /^\s*UPDATE\s+travel_trips\b/i.test(text)) {
          injected = true;
          sql
            .prepare("UPDATE travel_trips SET status = 'aborted', phase = 'aborted', revision = revision + 1 WHERE id = 'trip-1'")
            .run();
        }
      },
    });

    const result = await casUpdateTravelTrip(racing, {
      userId: 'u1',
      tripId: 'trip-1',
      baseRevision: 1,
      nowMs: NOW + 1000,
      patch: { status: 'en_route' },
    });
    expect(result).toEqual({ ok: false, code: 'VERSION_CONFLICT' });

    // 对方的写入没被我们覆盖：状态是 aborted，revision=2（不是 2 次自增后的 3）。
    const row = await getTravelTrip(db, { userId: 'u1', tripId: 'trip-1' });
    expect(row!.status).toBe('aborted');
    expect(row!.revision).toBe(2);
  });

  it('CAS 成功时只动自己的租户：别人的行返回冲突且原样保留', async () => {
    await upsertTravelTrip(db, tripRow());
    await upsertTravelTrip(db, tripRow({ id: 'trip-u2', userId: 'u2' }));

    expect(
      await casUpdateTravelTrip(db, {
        userId: 'u2',
        tripId: 'trip-1',
        baseRevision: 1,
        nowMs: NOW + 500,
        patch: { status: 'aborted' },
      }),
    ).toEqual({ ok: false, code: 'VERSION_CONFLICT' });
    expect((await getTravelTrip(db, { userId: 'u1', tripId: 'trip-1' }))!.status).toBe('planned');

    const ok = await casUpdateTravelTrip(db, {
      userId: 'u1',
      tripId: 'trip-1',
      baseRevision: 1,
      nowMs: NOW + 500,
      patch: { status: 'en_route', route: null, routeFetchedAt: null },
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.trip).toMatchObject({ status: 'en_route', phase: 'en_route', revision: 2 });
    // 路线清了就是清了，别留着旧几何（未获几何许可时不许写 route_json）。
    expect(ok.trip.route).toBeNull();
    expect(ok.trip.origin.label).toBe('阳光花园');
  });
});

describe('travel_trip_events（seq 唯一 + 租户隔离）', () => {
  it('同一行程 seq 递增；跨租户各算各的 seq；内容按写入顺序可读回', async () => {
    await upsertTravelTrip(db, tripRow());
    const a = await appendTravelTripEvent(db, {
      userId: 'u1',
      tripId: 'trip-1',
      kind: 'departed',
      at: NOW,
      source: 'tick',
      nowMs: NOW,
      expiresAt: NOW + 7 * DAY,
    });
    const b = await appendTravelTripEvent(db, {
      userId: 'u1',
      tripId: 'trip-1',
      kind: 'arrived',
      at: NOW + 3600_000,
      source: 'tick',
      nowMs: NOW + 3600_000,
      expiresAt: NOW + 7 * DAY,
    });
    expect([a.seq, b.seq]).toEqual([1, 2]);

    const otherTenant = await appendTravelTripEvent(db, {
      userId: 'u2',
      tripId: 'trip-1',
      kind: 'departed',
      at: NOW,
      source: 'tick',
      nowMs: NOW,
      expiresAt: NOW + 7 * DAY,
    });
    expect(otherTenant.seq).toBe(1);

    const events = await listTripEvents(db, { userId: 'u1', tripId: 'trip-1' });
    expect(events.map((row) => row.kind)).toEqual(['departed', 'arrived']);
    expect(events[1].seq).toBe(2);
  });
});

describe('travel_share_state（共享位，版本 CAS + 租户）', () => {
  it('缺行=未共享；开/关各自带版本；落后版本被拒；别人读不到', async () => {
    expect(await getTravelShareState(db, { userId: 'u1', charId: 'c1' })).toBeNull();

    const on = await setTravelShareState(db, {
      userId: 'u1',
      charId: 'c1',
      shareEnabled: true,
      baseVersion: null,
      nowMs: NOW,
    });
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    expect(on.state).toMatchObject({ shareEnabled: true, version: 1 });

    const stale = await setTravelShareState(db, {
      userId: 'u1',
      charId: 'c1',
      shareEnabled: false,
      baseVersion: 5,
      nowMs: NOW + 10,
    });
    expect(stale).toEqual({ ok: false, code: 'VERSION_CONFLICT' });
    expect((await getTravelShareState(db, { userId: 'u1', charId: 'c1' }))!.shareEnabled).toBe(true);

    const off = await setTravelShareState(db, {
      userId: 'u1',
      charId: 'c1',
      shareEnabled: false,
      baseVersion: 1,
      nowMs: NOW + 20,
    });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.state).toMatchObject({ shareEnabled: false, version: 2 });

    expect(await getTravelShareState(db, { userId: 'u2', charId: 'c1' })).toBeNull();
  });
});

describe('pruneTravelRetention（真实 changes，按租户/时间边界）', () => {
  it('只删过期的行程/事件/候选/已结束愿望，在途与别的租户原样留下', async () => {
    const past = NOW - 1000;
    await upsertTravelTrip(db, tripRow({ id: 'trip-old', dedupeKey: 'd-old', retentionExpiresAt: past }));
    await upsertTravelTrip(db, tripRow({ id: 'trip-live', dedupeKey: 'd-live', retentionExpiresAt: NOW + DAY }));
    // 未设保留期的在途行程永远不删。
    await upsertTravelTrip(db, tripRow({ id: 'trip-open', dedupeKey: 'd-open', retentionExpiresAt: null }));
    await upsertTravelTrip(
      db,
      tripRow({ id: 'trip-u2-old', userId: 'u2', dedupeKey: 'd-u2', retentionExpiresAt: past }),
    );

    await appendTravelTripEvent(db, {
      userId: 'u1', tripId: 'trip-old', kind: 'aborted', at: past, source: 'tick',
      nowMs: past, expiresAt: past,
    });
    await appendTravelTripEvent(db, {
      userId: 'u1', tripId: 'trip-live', kind: 'departed', at: NOW, source: 'tick',
      nowMs: NOW, expiresAt: NOW + 7 * DAY,
    });

    await saveTravelCandidates(db, {
      userId: 'u1', wishId: 'wish-1', nowMs: NOW,
      candidates: [candidateRow({ expiresAt: past }), candidateRow({ id: 'cand-live', expiresAt: NOW + DAY })],
    });

    await insertTravelWish(db, {
      id: 'wish-old', userId: 'u1', charId: 'c1', wishText: '旧愿望', state: 'dropped',
      expiresAt: past, createdAt: past, updatedAt: past,
    });
    await insertTravelWish(db, {
      id: 'wish-live', userId: 'u1', charId: 'c1', wishText: '新愿望', state: 'open',
      expiresAt: NOW + DAY, createdAt: NOW, updatedAt: NOW,
    });

    const swept = await pruneTravelRetention(db, { userId: 'u1', nowMs: NOW });
    expect(swept).toEqual({ trips: 1, events: 1, candidates: 1, wishes: 1 });

    expect(count('travel_trips')).toBe(3);
    expect(count("travel_trips WHERE id = 'trip-u2-old'")).toBe(1);
    expect(count("travel_trips WHERE id IN ('trip-live','trip-open')")).toBe(2);
    expect(count('travel_trip_events')).toBe(1);
    expect(count('travel_candidates')).toBe(1);
    expect(count("travel_wishes WHERE id = 'wish-live'")).toBe(1);

    // 再扫一次：没有可删的了，changes 必须归零（不是永远回 1 的假计数）。
    expect(await pruneTravelRetention(db, { userId: 'u1', nowMs: NOW })).toEqual({
      trips: 0, events: 0, candidates: 0, wishes: 0,
    });

    // 不带 userId 的全局清扫（cron 用）才动别的租户。
    expect((await pruneTravelRetention(db, { nowMs: NOW })).trips).toBe(1);
    expect(count("travel_trips WHERE id = 'trip-u2-old'")).toBe(0);
  });

  it('completed 愿望也按保留期清掉（新增终态不会在库里越积越多）', async () => {
    const past = NOW - 1000;
    await insertTravelWish(db, {
      id: 'wish-done', userId: 'u1', charId: 'c1', wishText: '走完了', state: 'completed',
      expiresAt: past, createdAt: past, updatedAt: past,
    });
    await insertTravelWish(db, {
      id: 'wish-open', userId: 'u1', charId: 'c1', wishText: '还在进行', state: 'open',
      expiresAt: NOW + DAY, createdAt: NOW, updatedAt: NOW,
    });

    const swept = await pruneTravelRetention(db, { userId: 'u1', nowMs: NOW });
    expect(swept.wishes).toBe(1);
    expect(count("travel_wishes WHERE id = 'wish-done'")).toBe(0);
    expect(count("travel_wishes WHERE id = 'wish-open'")).toBe(1);
  });
});

describe('getActiveTravelTrip（终态清单与契约同源）', () => {
  it('stopped / returned 都算终态，不会被当成在途行程继续规划', async () => {
    await upsertTravelTrip(db, tripRow({ id: 'trip-stopped', status: 'stopped', phase: 'stopped', dedupeKey: 'd-stop' }));
    expect(await getActiveTravelTrip(db, { userId: 'u1', charId: 'c1' })).toBeNull();

    await upsertTravelTrip(db, tripRow({ id: 'trip-returned', status: 'returned', phase: 'returned', dedupeKey: 'd-ret' }));
    expect(await getActiveTravelTrip(db, { userId: 'u1', charId: 'c1' })).toBeNull();

    // 非终态照常返回最新一代。
    await upsertTravelTrip(db, tripRow({ id: 'trip-live', status: 'dwelling', phase: 'dwelling', dedupeKey: 'd-live' }));
    const active = await getActiveTravelTrip(db, { userId: 'u1', charId: 'c1' });
    expect(active?.id).toBe('trip-live');
  });
});
