/**
 * 全局护栏「远端暂停不被普通保存覆盖」的真 SQL 回归（发布阻断项 6）。
 *
 * 背景：全局护栏那一行原本是普通 client_state 条目，`PUT /client-state` 按 updatedAt
 * last-write-wins 覆盖。客户端那套「读基线 → 写 → 读回」只能**事后**发现不一致：
 * 两台设备同时保存时，后写的整对象覆盖会把远端刚按下的 `paused: true` 改成 `false`。
 *
 * 这里用 node:sqlite 跑真语句（不是记录 SQL 文本的假库）证明两件事：
 *   1. 专用路由的写入是**条件 UPDATE（CAS）**：基线不是云端现值就 409，一个字节都不写；
 *   2. 泛写入口（老客户端那条路）会被闸拦下，云端行仍然 paused:true —— 对照组证明
 *      没有闸时同一份 payload 真的会把它翻掉（否则这条测试证明不了任何东西）。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import type { TestSqlite } from './test/d1-sqlite';
import { encryptForStorage, deriveUserEncryptionKey } from '@rei-standard/amsg-server/cloudflare';
import {
  AUTONOMY_GUARDRAIL_STATE_KEY,
  AUTONOMY_GUARDRAIL_STATE_NAMESPACE,
  type AirpAutonomyGuardrails,
} from '../../../utils/airp/autonomyGuardrails';
import { decryptFromStorage } from '@rei-standard/amsg-server/cloudflare';
import { patchGlobalGuardrails, readGuardrailRow, screenClientStateWrite } from './guardrailPatch';
import { createSqliteD1, openTestSqlite } from './test/d1-sqlite';

const USER_ID = '00000000-0000-4000-8000-0000000000aa';
const MASTER = 'a'.repeat(64);
const NOW = Date.parse('2026-10-22T12:00:00.000Z');

const PAUSED: AirpAutonomyGuardrails = {
  version: 1,
  perCharPerDay: 2,
  sameKindMinGapMinutes: 120,
  globalPerDay: 6,
  reserveTokensPerRun: 1600,
  paused: true,
};
const ACTIVE: AirpAutonomyGuardrails = { ...PAUSED, paused: false };

let sql: TestSqlite;
let db: ReturnType<typeof createSqliteD1>;

const keyFor = () => deriveUserEncryptionKey(USER_ID, MASTER);

const putRaw = async (value: AirpAutonomyGuardrails, updatedAt = NOW - 1000) => {
  const atRest = await encryptForStorage(JSON.stringify(value), await keyFor());
  sql.prepare(
    `INSERT INTO client_state (user_id, namespace, key, value, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, namespace, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(USER_ID, AUTONOMY_GUARDRAIL_STATE_NAMESPACE, AUTONOMY_GUARDRAIL_STATE_KEY, atRest, updatedAt);
};

const readPlain = async (): Promise<AirpAutonomyGuardrails | null> => {
  const row = sql.prepare('SELECT value FROM client_state WHERE user_id = ? AND namespace = ? AND key = ?')
    .get(USER_ID, AUTONOMY_GUARDRAIL_STATE_NAMESPACE, AUTONOMY_GUARDRAIL_STATE_KEY) as { value?: string } | undefined;
  if (!row?.value) return null;
  const plain = await decryptFromStorage(row.value, await keyFor());
  return JSON.parse(plain) as AirpAutonomyGuardrails;
};

/** 上游那条 LWW 写：不看当前值，直接覆盖（对照组用）。 */
const lwwOverwrite = async (value: AirpAutonomyGuardrails, updatedAt: number) => {
  const atRest = await encryptForStorage(JSON.stringify(value), await keyFor());
  sql.prepare(
    `INSERT INTO client_state (user_id, namespace, key, value, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, namespace, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(USER_ID, AUTONOMY_GUARDRAIL_STATE_NAMESPACE, AUTONOMY_GUARDRAIL_STATE_KEY, atRest, updatedAt);
};

describe('全局护栏 · 远端暂停不被覆盖（真 SQL）', () => {
  beforeEach(() => {
    sql = openTestSqlite();
    db = createSqliteD1(sql);
  });

  it('CAS 丢失（基线不是云端现值）→ conflict，云端行还是 paused:true', async () => {
    await putRaw(PAUSED);
    // 另一台设备此刻看到的是「未暂停」的旧基线（它本地缓存的 confirmed 值）
    const result = await patchGlobalGuardrails({
      db: db as any,
      masterKey: MASTER,
      userId: USER_ID,
      patch: { paused: false, globalPerDay: 2 },
      expected: { kind: 'value', value: ACTIVE },
      allowUnpause: false,
      nowMs: NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('conflict');
    expect((await readPlain())?.paused).toBe(true);
    expect((await readPlain())?.globalPerDay).toBe(6);
  });

  it('真并发：读完之后、写之前被另一台设备改了 → 条件 UPDATE 0 行 → conflict，不覆盖', async () => {
    await putRaw(PAUSED);
    let flipped = false;
    // 在 UPDATE 语句执行前插入「另一台设备」的写入：这才是 TOCTOU 的真实形态。
    const racy = createSqliteD1(sql, {
      beforeStatement: (statement) => {
        if (!flipped && statement.trim().toUpperCase().startsWith('UPDATE CLIENT_STATE')) {
          flipped = true;
          const atRest = sql.prepare('SELECT value FROM client_state WHERE user_id = ?').get(USER_ID) as any;
          // 另一台设备把 globalPerDay 改成 3（值变了，就不再是我读到的那个字符串）
          void atRest;
          sql.prepare('UPDATE client_state SET value = ?, updated_at = ? WHERE user_id = ?')
            .run('other-device-value-marker', NOW + 1, USER_ID);
        }
      },
    });

    const result = await patchGlobalGuardrails({
      db: racy as any,
      masterKey: MASTER,
      userId: USER_ID,
      patch: { paused: false, globalPerDay: 2 },
      expected: { kind: 'value', value: PAUSED },
      allowUnpause: true, // 就算明确解暂停，CAS 丢了也不能覆盖别人刚写的东西
      nowMs: NOW,
    });

    expect(flipped).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('conflict');
    // 被别人改过的行保持别人写的内容（我们一个字节都没写进去）
    const raw = sql.prepare('SELECT value FROM client_state WHERE user_id = ?').get(USER_ID) as { value: string };
    expect(raw.value).toBe('other-device-value-marker');
  });

  it('没有明确解暂停意图时，paused:false 保不住（但其它字段照写）', async () => {
    await putRaw(PAUSED);
    const result = await patchGlobalGuardrails({
      db: db as any,
      masterKey: MASTER,
      userId: USER_ID,
      patch: { paused: false, globalPerDay: 2 },
      expected: { kind: 'value', value: PAUSED },
      allowUnpause: false,
      nowMs: NOW,
    });

    expect(result.ok).toBe(true);
    expect(result.unpauseIgnored).toBe(true);
    const stored = await readPlain();
    expect(stored?.paused).toBe(true);
    expect(stored?.globalPerDay).toBe(2);
  });

  it('用户明确点开总开关（allowUnpause）才真的解暂停', async () => {
    await putRaw(PAUSED);
    const result = await patchGlobalGuardrails({
      db: db as any,
      masterKey: MASTER,
      userId: USER_ID,
      patch: { paused: false },
      expected: { kind: 'value', value: PAUSED },
      allowUnpause: true,
      nowMs: NOW,
    });

    expect(result.ok).toBe(true);
    expect(result.unpauseIgnored).toBeFalsy();
    expect((await readPlain())?.paused).toBe(false);
  });

  it('云端行读坏 → unreadable，拒绝写入（不拿默认值盖掉未知状态）', async () => {
    sql.prepare(
      'INSERT INTO client_state (user_id, namespace, key, value, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(USER_ID, AUTONOMY_GUARDRAIL_STATE_NAMESPACE, AUTONOMY_GUARDRAIL_STATE_KEY, 'not-decryptable', NOW);

    const result = await patchGlobalGuardrails({
      db: db as any,
      masterKey: MASTER,
      userId: USER_ID,
      patch: { paused: false },
      allowUnpause: true,
      nowMs: NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('unreadable');
    const row = sql.prepare('SELECT value FROM client_state WHERE user_id = ?').get(USER_ID) as { value: string };
    expect(row.value).toBe('not-decryptable');
  });

  it('缺行时插入成功；重复插入被 ON CONFLICT DO NOTHING 挡下 → conflict', async () => {
    const first = await patchGlobalGuardrails({
      db: db as any, masterKey: MASTER, userId: USER_ID,
      patch: { paused: true }, expected: { kind: 'absent' }, nowMs: NOW,
    });
    expect(first.ok).toBe(true);
    expect((await readPlain())?.paused).toBe(true);

    const second = await patchGlobalGuardrails({
      db: db as any, masterKey: MASTER, userId: USER_ID,
      patch: { paused: false }, expected: { kind: 'absent' }, nowMs: NOW + 1,
    });
    expect(second.ok).toBe(false);
    expect(second.status).toBe('conflict');
    expect((await readPlain())?.paused).toBe(true);
  });

  it('只合并契约里的字段：夹带预算/权限/工具名一律丢掉', async () => {
    await putRaw(PAUSED);
    const result = await patchGlobalGuardrails({
      db: db as any, masterKey: MASTER, userId: USER_ID,
      patch: { globalPerDay: 1, budget: 999999, permission: 'all', tool: 'shell' },
      expected: { kind: 'value', value: PAUSED }, nowMs: NOW,
    });
    expect(result.ok).toBe(true);
    const stored = (await readPlain()) as unknown as Record<string, unknown>;
    expect(stored.globalPerDay).toBe(1);
    expect(stored.budget).toBeUndefined();
    expect(stored.permission).toBeUndefined();
    expect(stored.tool).toBeUndefined();
  });
});

describe('泛写入口闸 · 普通保存不许解暂停（真 SQL）', () => {
  beforeEach(() => {
    sql = openTestSqlite();
    db = createSqliteD1(sql);
  });

  const entry = (value: AirpAutonomyGuardrails) => ([{
    namespace: AUTONOMY_GUARDRAIL_STATE_NAMESPACE,
    key: AUTONOMY_GUARDRAIL_STATE_KEY,
    value: JSON.stringify(value),
  }]);

  it('对照组：没有闸时同样的 payload（LWW）真的会把远端暂停翻掉', async () => {
    await putRaw(PAUSED);
    await lwwOverwrite(ACTIVE, NOW + 5000);
    expect((await readPlain())?.paused).toBe(false); // 这就是要防的事
  });

  it('云端暂停 + 老客户端整对象写未暂停 → 拦下，行仍是 paused:true', async () => {
    await putRaw(PAUSED);
    const screen = await screenClientStateWrite({
      db: db as any, masterKey: MASTER, userId: USER_ID,
      entries: entry(ACTIVE), allowUnpause: false,
    });
    expect(screen.blocked).toBe(true);
    expect((await readPlain())?.paused).toBe(true);
  });

  it('带明确解暂停意图（总开关那一次点击）→ 放行', async () => {
    await putRaw(PAUSED);
    const screen = await screenClientStateWrite({
      db: db as any, masterKey: MASTER, userId: USER_ID,
      entries: entry(ACTIVE), allowUnpause: true,
    });
    expect(screen.blocked).toBe(false);
  });

  it('写的是暂停 / 不是全局护栏那一行 → 都不拦（不影响 fire_pack 等同步）', async () => {
    await putRaw(PAUSED);
    const asPaused = await screenClientStateWrite({
      db: db as any, masterKey: MASTER, userId: USER_ID,
      entries: entry(PAUSED), allowUnpause: false,
    });
    expect(asPaused.blocked).toBe(false);

    const otherEntry = await screenClientStateWrite({
      db: db as any, masterKey: MASTER, userId: USER_ID,
      entries: [{ namespace: 'amsg:char:c1', key: 'fire_pack', value: JSON.stringify(ACTIVE) }],
      allowUnpause: false,
    });
    expect(otherEntry.blocked).toBe(false);
  });

  it('云端行读坏 → 拒写（证明不了「没暂停」时宁可失败）', async () => {
    sql.prepare(
      'INSERT INTO client_state (user_id, namespace, key, value, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(USER_ID, AUTONOMY_GUARDRAIL_STATE_NAMESPACE, AUTONOMY_GUARDRAIL_STATE_KEY, 'broken-cipher', NOW);
    const screen = await screenClientStateWrite({
      db: db as any, masterKey: MASTER, userId: USER_ID,
      entries: entry(ACTIVE), allowUnpause: false,
    });
    expect(screen.blocked).toBe(true);
    const row = sql.prepare('SELECT value FROM client_state WHERE user_id = ?').get(USER_ID) as { value: string };
    expect(row.value).toBe('broken-cipher');
  });

  it('缺钥 → 也按读不出来处理（拒写，不放行）', async () => {
    await putRaw(PAUSED);
    const screen = await screenClientStateWrite({
      db: db as any, masterKey: '', userId: USER_ID,
      entries: entry(ACTIVE), allowUnpause: false,
    });
    expect(screen.blocked).toBe(true);
  });
});
