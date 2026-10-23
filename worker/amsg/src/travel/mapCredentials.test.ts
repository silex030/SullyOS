import { beforeEach, describe, expect, it } from 'vitest';

import { createSqliteD1, openTestSqlite, type TestSqlite } from '../test/d1-sqlite';
import { ensureTravelSchema, resetTravelSchemaCacheForTesting, type TravelDb } from './store';
import {
  getTravelMapCredentialStatus,
  resolveTravelMapCredentialValues,
  saveTravelMapCredentials,
} from './mapCredentials';

const NOW = Date.parse('2026-10-23T04:00:00.000Z');
const MASTER = 'test-master-key-0123456789abcdef-32';
const OTHER_MASTER = 'other-master-key-0123456789abcdef';
const USER = 'u1';

const WEB_MARKER = 'web-service-key-MARKER-0001';
const JS_MARKER = 'js-api-key-MARKER-0002';
const CODE_MARKER = 'security-js-code-MARKER-0003';
const MAPBOX_MARKER = 'pk.mapbox-MARKER-0004-abcdefghijklmn';

let sql: TestSqlite;
let db: TravelDb;

beforeEach(async () => {
  resetTravelSchemaCacheForTesting();
  sql = openTestSqlite();
  db = createSqliteD1(sql) as unknown as TravelDb;
  await ensureTravelSchema(db);
});

const save = (patch: Record<string, string>, extra: { userId?: string; masterKey?: string; clear?: never[] } = {}) =>
  saveTravelMapCredentials({
    db: db as never,
    userId: extra.userId ?? USER,
    masterKey: extra.masterKey ?? MASTER,
    patch,
    nowMs: NOW,
  });

describe('travel map credentials · 加密保存与最小回显', () => {
  it('保存后落库是密文：明文标记一个都不在 encrypted_value 里', async () => {
    const result = await save({
      amapWebKey: WEB_MARKER,
      amapJsKey: JS_MARKER,
      amapJsCode: CODE_MARKER,
      mapboxToken: MAPBOX_MARKER,
      mapboxStyleUrl: 'mapbox://styles/example/clxyz',
    });
    expect(result.ok).toBe(true);

    const row = sql
      .prepare('SELECT encrypted_value FROM travel_map_credentials WHERE user_id = ?')
      .get(USER) as { encrypted_value: string };
    expect(row.encrypted_value.length).toBeGreaterThan(40);
    for (const marker of [WEB_MARKER, JS_MARKER, CODE_MARKER, MAPBOX_MARKER]) {
      expect(row.encrypted_value.includes(marker)).toBe(false);
    }
  });

  it('状态只回存在性与公开展示 Key：Web 服务 Key / jscode 永不出现在 JSON 里', async () => {
    await save({
      amapWebKey: WEB_MARKER,
      amapJsKey: JS_MARKER,
      amapJsCode: CODE_MARKER,
      mapboxToken: MAPBOX_MARKER,
    });
    const status = await getTravelMapCredentialStatus({ db: db as never, userId: USER, masterKey: MASTER });
    expect(status.configured).toBe(true);
    expect(status.has).toEqual({
      amapWebKey: true,
      amapJsKey: true,
      amapJsCode: true,
      mapboxToken: true,
    });
    // 浏览器必需的展示 Key 可以回（官方 JS API 明文 key / Mapbox pk. 公钥）。
    expect(status.amapJsKey).toBe(JS_MARKER);
    expect(status.mapboxToken).toBe(MAPBOX_MARKER);
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(WEB_MARKER);
    expect(serialized).not.toContain(CODE_MARKER);
    expect(Object.keys(status.has)).not.toContain('amapWebKeyValue');
  });

  it('空字段 = 保持不变；清除必须显式，且只清指定的那一个', async () => {
    await save({ amapWebKey: WEB_MARKER, amapJsKey: JS_MARKER, amapJsCode: CODE_MARKER });
    // 空字符串不覆盖
    const kept = await save({ amapWebKey: '', amapJsKey: '   ' });
    expect(kept.ok).toBe(true);
    expect((await resolveTravelMapCredentialValues({ db: db as never, userId: USER, masterKey: MASTER }))).toEqual({
      amapWebKey: WEB_MARKER,
      amapJsKey: JS_MARKER,
      amapJsCode: CODE_MARKER,
      mapboxToken: '',
      mapboxStyleUrl: '',
    });

    const cleared = await saveTravelMapCredentials({
      db: db as never,
      userId: USER,
      masterKey: MASTER,
      patch: {},
      clear: ['amapJsCode'],
      nowMs: NOW + 1000,
    });
    expect(cleared.ok).toBe(true);
    const after = await resolveTravelMapCredentialValues({ db: db as never, userId: USER, masterKey: MASTER });
    expect(after?.amapJsCode).toBe('');
    expect(after?.amapWebKey).toBe(WEB_MARKER);
    expect(after?.amapJsKey).toBe(JS_MARKER);
  });

  it('跨用户隔离：另一个主体读不到也不受影响', async () => {
    await save({ amapWebKey: WEB_MARKER }, { userId: USER });
    const other = await getTravelMapCredentialStatus({ db: db as never, userId: 'u2', masterKey: MASTER });
    expect(other.configured).toBe(false);
    expect(other.has.amapWebKey).toBe(false);
  });

  it('换过主密钥 → unreadable（不假称未配置），并拒绝覆盖', async () => {
    await save({ amapWebKey: WEB_MARKER });
    const broken = await getTravelMapCredentialStatus({
      db: db as never,
      userId: USER,
      masterKey: OTHER_MASTER,
    });
    expect(broken.configured).toBe(false);
    expect(broken.unreadable).toBe(true);

    const overwrite = await save({ amapWebKey: 'attacker-key-should-not-land' }, { masterKey: OTHER_MASTER });
    expect(overwrite.ok).toBe(false);
    expect(overwrite.ok ? null : overwrite.code).toBe('UNREADABLE');
    const row = sql
      .prepare('SELECT encrypted_value FROM travel_map_credentials WHERE user_id = ?')
      .get(USER) as { encrypted_value: string };
    expect(row.encrypted_value.length).toBeGreaterThan(0);
  });

  it('并发写：版本不一致时 409，旧密文不被覆盖', async () => {
    await save({ amapWebKey: WEB_MARKER });
    const before = (sql.prepare('SELECT encrypted_value FROM travel_map_credentials WHERE user_id = ?').get(USER) as {
      encrypted_value: string;
    }).encrypted_value;

    // 模拟另一台设备刚写过：UPDATE 前把 version 推高。
    const racing = createSqliteD1(sql, {
      beforeStatement: (statement) => {
        if (statement.startsWith('UPDATE travel_map_credentials')) {
          sql.prepare('UPDATE travel_map_credentials SET version = version + 1 WHERE user_id = ?').run(USER);
        }
      },
    }) as unknown as TravelDb;
    const lost = await saveTravelMapCredentials({
      db: racing as never,
      userId: USER,
      masterKey: MASTER,
      patch: { amapWebKey: 'second-writer' },
      nowMs: NOW + 5,
    });
    expect(lost.ok).toBe(false);
    expect(lost.ok ? null : lost.code).toBe('VERSION_CONFLICT');
    const after = (sql.prepare('SELECT encrypted_value FROM travel_map_credentials WHERE user_id = ?').get(USER) as {
      encrypted_value: string;
    }).encrypted_value;
    // 旧写入被另一台设备改过版本，但内容仍是第一份密文（没有第二个写者插进来）。
    expect(after).toBe(before);
  });

  it('没有主密钥就不保存（fail-closed）', async () => {
    const result = await save({ amapWebKey: WEB_MARKER }, { masterKey: '' });
    expect(result.ok).toBe(false);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM travel_map_credentials').get() as { n: number }).toEqual({ n: 0 });
  });
});
