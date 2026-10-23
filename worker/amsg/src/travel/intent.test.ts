/**
 * 出行 · 后台自主产生愿望 + per-user 凭据（B7/B8）端到端回归
 *
 * 回答两件事，全部用**真实 SQLite** + 注入的网络桩：
 * 1. 已授权角色**没有愿望**时也能被后台枚举；角色在自己的自主回合里说「想出去」→ 落一条
 *    真实 wish → tick 搜点 → 角色选点 → 真实步行路线 → 出发/到达；没说不去/未授权/零额度
 *    时一次模型与地图都不调。
 * 2. 决策用的模型凭据来自**该用户自己的** `llm_credentials` 行（合成 AES 钥加密的信封，
 *    不读 .env），解不开就是没有 —— 不回落到 worker 级失效 env。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { decryptFromStorage, deriveUserEncryptionKey, encryptForStorage } from '@rei-standard/amsg-server/cloudflare';

import { TRAVEL_SCHEMA_SQL } from '../../../../contracts/travel';
import { createSqliteD1, openTestSqlite, type TestSqlite } from '../test/d1-sqlite';
import { ensureTravelBudgetRow } from './budget';
import {
  parseTravelIntent,
  recordTravelIntent,
  listAuthorizedTravelSubjects,
  resolveIntentProbeWindowMs,
  TRAVEL_INTENT_PROBE_WINDOW_MS,
  TRAVEL_INTENT_PROBE_WINDOW_MAX_MS,
} from './intent';
import { resolveTravelModelCredentialsForUser, travelCredIdFor } from './credentials';
import type { TravelMapProvider } from './provider';
import { runTravelTickForSubject, runTravelTick } from './tick';
import {
  ensureTravelSchema,
  getActiveTravelTrip,
  insertTravelWish,
  listTravelWishes,
  putTravelAnchor,
  resetTravelSchemaCacheForTesting,
  setTravelCharEnabled,
  upsertTravelSettings,
  type TravelDb,
} from './store';

const NOW = Date.parse('2026-10-23T04:00:00.000Z');
const USER = '22222222-2222-4222-8222-222222222222';
const CHAR = 'char-w';

let sql: TestSqlite;
let db: TravelDb;

const providerCalls = { search: 0, route: 0 };

const stubProvider = (): TravelMapProvider => ({
  id: 'amap',
  coordSys: 'gcj02',
  regions: ['CN'],
  supports: (region) => region === 'CN',
  async searchCandidates() {
    providerCalls.search += 1;
    return [{
      id: 'B0FFTEST',
      label: '社区图书馆',
      category: '文化',
      city: '杭州市',
      location: { lat: 30.28, lng: 120.16, coordSys: 'gcj02' },
      distanceM: 640,
      provider: 'amap',
    }] as never;
  },
  async route() {
    providerCalls.route += 1;
    return {
      points: [
        { lat: 30.27, lng: 120.15 },
        { lat: 30.275, lng: 120.155 },
        { lat: 30.28, lng: 120.16 },
      ],
      distanceM: 720,
      durationS: 540,
      coordSys: 'gcj02',
    } as never;
  },
  async geocodeAnchor() {
    throw new Error('not used');
  },
});

const seedAuthorized = async (mapCallsLimit = 5): Promise<void> => {
  await ensureTravelSchema(db);
  await upsertTravelSettings(db, {
    userId: USER, enabled: true, baseVersion: null, nowMs: NOW,
  } as never);
  await setTravelCharEnabled(db, { userId: USER, charId: CHAR, enabled: true, nowMs: NOW });
  await ensureTravelBudgetRow(db, { userId: USER, mapCallsLimit, nowMs: NOW });
  await putTravelAnchor(db, {
    userId: USER,
    charId: CHAR,
    label: '文三路一带',
    city: '杭州市',
    district: '西湖区',
    lat: 30.27,
    lng: 120.15,
    coordSys: 'gcj02',
    precision: 'area',
    confirmedAt: NOW,
    updatedAt: NOW,
  } as never);
};

const wiring = (portCalls: { model: number; choice?: string }) => ({
  now: () => NOW,
  providers: [stubProvider()],
  region: 'CN' as const,
  readAnchor: async () => ({
    label: '文三路一带', city: '杭州市', district: '西湖区',
    lat: 30.27, lng: 120.15, coordSys: 'gcj02' as const,
    precision: 'area' as const, confirmedAt: NOW, source: 'user' as const,
  }),
  decisionPort: {
    async choose({ candidates }: { candidates: readonly { id: string }[] }) {
      portCalls.model += 1;
      return { kind: 'choose', candidateId: candidates[0]?.id, reason: '想去看看书' };
    },
  },
});

beforeEach(() => {
  resetTravelSchemaCacheForTesting();
  sql = openTestSqlite();
  sql.exec(TRAVEL_SCHEMA_SQL);
  db = createSqliteD1(sql) as unknown as TravelDb;
  providerCalls.search = 0;
  providerCalls.route = 0;
});

describe('自主回合里的出行意图（parser）', () => {
  it('缺省 / none 都是「不出门」，不是失败', () => {
    expect(parseTravelIntent(undefined)).toEqual({ kind: 'none' });
    expect(parseTravelIntent({ want: 'none' })).toEqual({ kind: 'none' });
  });

  it('go 需要一句可用的愿望；带坐标或空文本一律判不合法', () => {
    expect(parseTravelIntent({ want: 'go', wish: '想去书店翻翻新到的杂志', category: '书店' }))
      .toEqual({ kind: 'go', wishText: '想去书店翻翻新到的杂志', category: '书店' });
    expect(parseTravelIntent({ want: 'go', wish: '' })).toBeNull();
    expect(parseTravelIntent({ want: 'go', wish: '去 30.123456,120.123456 那边' })).toBeNull();
  });

  it('wander 不要求目的地，但保留角色原话', () => {
    expect(parseTravelIntent({ want: 'wander' })).toEqual({
      kind: 'wander', wishText: '在附近随便走走', category: 'wander',
    });
    expect(parseTravelIntent({ want: 'wander', wish: '沿河边走走' })).toEqual({
      kind: 'wander', wishText: '沿河边走走', category: 'wander',
    });
  });

  it('形状不认识 → null（调用方只丢这一段，不判整轮失败）', () => {
    expect(parseTravelIntent('go')).toBeNull();
    expect(parseTravelIntent({ want: 'teleport' })).toBeNull();
  });
});

describe('探针窗口（3h 不是硬编码：运维可配 + 复用用户自己的间隔）', () => {
  it('运维配了分钟数就用它（优先于用户间隔）', () => {
    expect(resolveIntentProbeWindowMs({ configuredMinutes: 90, guardrailGapMinutes: 120 }))
      .toBe(90 * 60_000);
  });

  it('没配就沿用 autonomy 护栏里的同类动作最小间隔', () => {
    expect(resolveIntentProbeWindowMs({ guardrailGapMinutes: 45 })).toBe(45 * 60_000);
    expect(resolveIntentProbeWindowMs({ configuredMinutes: Number(''), guardrailGapMinutes: 45 }))
      .toBe(45 * 60_000);
  });

  it('两者都没有才回落 3h；间隔 0（= 不设间隔）不会退化成每跳都问', () => {
    expect(resolveIntentProbeWindowMs({})).toBe(TRAVEL_INTENT_PROBE_WINDOW_MS);
    expect(resolveIntentProbeWindowMs({ guardrailGapMinutes: 0 })).toBe(TRAVEL_INTENT_PROBE_WINDOW_MS);
    expect(resolveIntentProbeWindowMs({ guardrailGapMinutes: 0.4 })).toBe(60_000);
  });

  it('上限 24h：配成巨大值等于关掉探针，不给隐形关闭留口子', () => {
    expect(resolveIntentProbeWindowMs({ configuredMinutes: 60 * 24 * 30 }))
      .toBe(TRAVEL_INTENT_PROBE_WINDOW_MAX_MS);
  });
});

describe('愿望落库前的授权/预算闸', () => {
  it('未授权不写；地图额度 0 也不写（写了也跑不动）', async () => {
    const intent = parseTravelIntent({ want: 'go', wish: '想去书店' });
    const disabled = await recordTravelIntent(db, { userId: USER, charId: CHAR, intent, nowMs: NOW });
    expect(disabled).toMatchObject({ written: false, reason: 'disabled' });

    await seedAuthorized(0);
    const zero = await recordTravelIntent(db, { userId: USER, charId: CHAR, intent, nowMs: NOW });
    expect(zero).toMatchObject({ written: false, reason: 'budget_zero' });
    expect(await listTravelWishes(db, {
      userId: USER, charId: CHAR, nowMs: NOW, states: ['open'],
    })).toHaveLength(0);
  });

  it('授权齐备就写一条 open 愿望；同一时间窗内不叠加第二条', async () => {
    await seedAuthorized(5);
    const intent = parseTravelIntent({ want: 'go', wish: '想去书店' });
    const first = await recordTravelIntent(db, { userId: USER, charId: CHAR, intent, nowMs: NOW });
    expect(first.written).toBe(true);
    const second = await recordTravelIntent(db, { userId: USER, charId: CHAR, intent, nowMs: NOW + 60_000 });
    expect(second).toMatchObject({ written: false, reason: 'duplicate' });
    const rows = await listTravelWishes(db, {
      userId: USER, charId: CHAR, nowMs: NOW, states: ['open'],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ wishText: '想去书店', state: 'open' });
  });

  it('作者（角色）说不去 → 一条愿望都不写', async () => {
    await seedAuthorized(5);
    const result = await recordTravelIntent(db, {
      userId: USER, charId: CHAR, intent: parseTravelIntent({ want: 'none' }), nowMs: NOW,
    });
    expect(result).toMatchObject({ written: false, reason: 'none' });
  });
});

describe('从零愿望到出发（真实 SQLite + 网络桩）', () => {
  it('已授权角色即使没有愿望也会被后台枚举，且不花模型/地图', async () => {
    await seedAuthorized(5);
    const subjects = await listAuthorizedTravelSubjects(db);
    expect(subjects).toEqual([{ userId: USER, charId: CHAR }]);

    const portCalls = { model: 0 };
    const report = await runTravelTick({ DB: db } as never, {
      now: () => NOW,
      listSubjects: async () => subjects,
      wiringForSubject: () => wiring(portCalls),
    });
    expect(report.subjects).toBe(1);
    expect(report.outcomes[0].skipped).toContain('no_wish');
    expect(portCalls.model).toBe(0);
    expect(providerCalls.search).toBe(0);
    expect(providerCalls.route).toBe(0);
  });

  it('意图 → 搜点 → 角色选点 → 真实步行段 → 出发/到达', async () => {
    await seedAuthorized(5);
    const intent = parseTravelIntent({ want: 'go', wish: '想去书店' });
    expect((await recordTravelIntent(db, { userId: USER, charId: CHAR, intent, nowMs: NOW })).written).toBe(true);

    const portCalls = { model: 0 };
    // 1) 搜候选
    const searched = await runTravelTickForSubject(db, { userId: USER, charId: CHAR }, wiring(portCalls));
    expect(searched.searched).toBe(true);
    expect(providerCalls.search).toBe(1);
    // 2) 角色自己选点（模型端口只被调用一次）
    const decided = await runTravelTickForSubject(db, { userId: USER, charId: CHAR }, wiring(portCalls));
    expect(decided.decided).toBe(true);
    expect(portCalls.model).toBe(1);
    // 3) 排路线：选点与排路线都在「角色做了决定」那一跳完成（一次真实 provider.route）
    expect(decided.planned).toBe(true);
    expect(providerCalls.route).toBe(1);
    const trip = await getActiveTravelTrip(db, { userId: USER, charId: CHAR });
    expect(trip?.status).toBe('planned');
    expect(trip?.dest?.label).toBe('社区图书馆');

    // 4) 到点出发 → 到达（相位推进，不再花模型/地图）
    const departed = await runTravelTickForSubject(
      db, { userId: USER, charId: CHAR }, { ...wiring(portCalls), now: () => NOW + 1_000 },
    );
    expect(departed.advanced).toContain('en_route');
    const walking = await getActiveTravelTrip(db, { userId: USER, charId: CHAR });
    expect(walking?.status).toBe('en_route');
    // 到点在路上的那一段：不重新花模型钱（换下一段/返程要等角色自己再说）。
    expect(portCalls.model).toBe(1);
  });

  it('角色禁行或额度 0 时，tick 不调用模型（也不搜点）', async () => {
    await seedAuthorized(5);
    await recordTravelIntent(db, {
      userId: USER, charId: CHAR, intent: parseTravelIntent({ want: 'go', wish: '想去书店' }), nowMs: NOW,
    });
    await setTravelCharEnabled(db, { userId: USER, charId: CHAR, enabled: false, nowMs: NOW });
    const portCalls = { model: 0 };
    const off = await runTravelTickForSubject(db, { userId: USER, charId: CHAR }, wiring(portCalls));
    expect(off.skipped).toContain('char_disabled');
    expect(portCalls.model).toBe(0);
    expect(providerCalls.search).toBe(0);

    // 禁用行删掉换成「额度 0」：仍然一次模型都不调。
    sql.exec(`DELETE FROM travel_char_settings WHERE user_id = '${USER}'`);
    await setTravelCharEnabled(db, { userId: USER, charId: CHAR, enabled: true, nowMs: NOW });
    sql.exec(`UPDATE travel_budget_state SET map_calls_limit = 0, paused = 0 WHERE user_id = '${USER}'`);
    const zero = await runTravelTickForSubject(db, { userId: USER, charId: CHAR }, wiring(portCalls));
    expect(zero.skipped).toContain('budget_blocked');
    expect(portCalls.model).toBe(0);
  });

  it('已有愿望但未授权角色不写愿望（wish 表不受影响）', async () => {
    await ensureTravelSchema(db);
    const ok = await insertTravelWish(db, {
      id: 'tw:manual:1', userId: USER, charId: CHAR, wishText: '想去公园',
      category: null, selectedCandidateId: null, state: 'open',
      expiresAt: null, createdAt: NOW, updatedAt: NOW,
    });
    expect(ok).toBe(true);
    const result = await recordTravelIntent(db, {
      userId: USER, charId: CHAR,
      intent: parseTravelIntent({ want: 'go', wish: '想去书店' }), nowMs: NOW,
    });
    expect(result.reason).toBe('disabled');
  });
});

describe('per-user 模型凭据（合成 AES 钥，不读 .env）', () => {
  const MASTER = 'test-master-key-for-travel-credentials';
  const encode = (value: unknown): string => JSON.stringify(value);

  const putCredential = async (credId: string, value: unknown, master = MASTER): Promise<void> => {
    const userKey = await deriveUserEncryptionKey(USER, master);
    const encrypted = await encryptForStorage(encode(value), userKey);
    await db.prepare(
      'INSERT INTO llm_credentials (user_id, cred_id, encrypted_value) VALUES (?, ?, ?)'
      + ' ON CONFLICT(user_id, cred_id) DO UPDATE SET encrypted_value = excluded.encrypted_value',
    ).bind(USER, credId, encrypted).run();
  };

  beforeEach(() => {
    sql.exec('CREATE TABLE IF NOT EXISTS llm_credentials (user_id TEXT NOT NULL, cred_id TEXT NOT NULL, encrypted_value TEXT NOT NULL, PRIMARY KEY (user_id, cred_id))');
  });

  it('按 char:<id>/chat 解出该用户自己的凭据', async () => {
    await putCredential(travelCredIdFor(CHAR), {
      apiUrl: 'https://llm.example/v1', apiKey: 'sk-synthetic-not-real', primaryModel: 'model-x',
    });
    const creds = await resolveTravelModelCredentialsForUser({
      db: db as never, userId: USER, charId: CHAR, masterKey: MASTER,
    });
    expect(creds).toEqual({ baseUrl: 'https://llm.example/v1', apiKey: 'sk-synthetic-not-real', model: 'model-x' });
  });

  it('换过 masterKey / 没这行 / 缺字段 → null（不回落到 worker env）', async () => {
    await putCredential(travelCredIdFor(CHAR), {
      apiUrl: 'https://llm.example/v1', apiKey: 'sk-x', primaryModel: 'm',
    }, 'another-master-key-000000000000000');
    expect(await resolveTravelModelCredentialsForUser({
      db: db as never, userId: USER, charId: CHAR, masterKey: MASTER,
    })).toBeNull();

    expect(await resolveTravelModelCredentialsForUser({
      db: db as never, userId: USER, charId: 'other-char', masterKey: MASTER,
    })).toBeNull();

    expect(await resolveTravelModelCredentialsForUser({
      db: db as never, userId: USER, charId: CHAR, masterKey: '',
    })).toBeNull();
  });

  it('解出来的明文能按同一路径再解开（证明信封格式与上游一致）', async () => {
    await putCredential(travelCredIdFor(CHAR), {
      apiUrl: 'https://llm.example/v1', apiKey: 'sk-y', primaryModel: 'm2',
    });
    const row = sql.prepare('SELECT encrypted_value FROM llm_credentials WHERE cred_id = ?')
      .get(travelCredIdFor(CHAR)) as { encrypted_value: string };
    const userKey = await deriveUserEncryptionKey(USER, MASTER);
    expect(JSON.parse(await decryptFromStorage(row.encrypted_value, userKey))).toMatchObject({
      apiKey: 'sk-y', primaryModel: 'm2',
    });
  });
});
