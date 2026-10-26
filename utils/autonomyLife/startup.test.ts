/**
 * 旧自主配置退役（真退役）：旧键删除、角色字段清理、边界迁移一次、之后幂等。
 */
import { describe, expect, it } from 'vitest';

import type { AutonomyLifeApi, LifeBoundaryPayload } from './api';
import { normalizeBoundary } from './boundary';
import { LEGACY_AUTONOMY_CONFIG_KEY, LEGACY_AUTONOMY_MIGRATION_MARKER, retireLegacyAutonomyConfig } from './startup';
import { RETIRED_LEGACY_TIMERS } from './migration';

const NOW = Date.UTC(2026, 9, 24, 4, 0, 0);

function fakeStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => { map.delete(key); },
    setItem: (key: string, value: string) => { map.set(key, value); },
  } as Storage;
}

function accountPayload(revision: number, enabled = false): LifeBoundaryPayload {
  const account = normalizeBoundary(
    { enabled, globalPaused: false, timezone: 'Asia/Shanghai', allowedKinds: [], externalGrants: [], limits: {} },
    { scope: 'account', nowMs: NOW, revision },
  );
  return {
    account,
    characterOverrides: null,
    effective: { ...account, scope: 'account', charEnabled: enabled, allowFictionalNpc: false, limits: {} } as never,
    revision,
    defaults: {} as never,
    maximums: {} as never,
  };
}

function fakeApi(options: { revision?: number; writeOk?: boolean; failRead?: boolean } = {}) {
  const writes: Array<Record<string, unknown>> = [];
  let revision = options.revision ?? 0;
  const api = {
    readBoundaries: async () => {
      if (options.failRead) return { ok: false as const, code: 'NETWORK' as const, status: 0 };
      return { ok: true as const, data: accountPayload(revision) };
    },
    writeBoundaries: async (req: { changes: Record<string, unknown> }) => {
      writes.push(req.changes);
      if (options.writeOk === false) return { ok: false as const, code: 'SERVICE_UNAVAILABLE' as const, status: 503 };
      revision += 1;
      return { ok: true as const, data: accountPayload(revision, req.changes.enabled === true) };
    },
  } as unknown as AutonomyLifeApi;
  return { api, writes, currentRevision: () => revision };
}

const legacyCharacter = () => ({
  id: 'char-old',
  name: '小夏',
  phoneState: {
    records: [] as unknown[],
    autoRefresh: true,
    autoRefreshIntervalMin: 15,
    lastAutoRefreshAt: NOW - 60_000,
    sendToChat: true,
  },
});

describe('退役旧链路（开机一次）', () => {
  it('删旧定时器键、清角色自动刷新字段、把旧上限搬成边界（不扩权）', async () => {
    const storage = fakeStorage({
      [RETIRED_LEGACY_TIMERS[0]]: '1',
      [RETIRED_LEGACY_TIMERS[1]]: '15',
      [LEGACY_AUTONOMY_CONFIG_KEY]: JSON.stringify({
        enabled: false,
        perCharPerDay: 3,
        globalPerDay: 6,
        quietHours: { start: '23:30', end: '07:30' },
      }),
    });
    const { api, writes } = fakeApi({ revision: 0 });
    const saved: unknown[] = [];

    const result = await retireLegacyAutonomyConfig({
      api,
      characters: [legacyCharacter()],
      saveCharacter: async (character) => { saved.push(character); },
      storage,
      now: () => NOW,
      timezone: 'Asia/Shanghai',
    });

    expect(result.migrated).toBe(true);
    expect(result.retiredTimerKeys).toEqual([RETIRED_LEGACY_TIMERS[0], RETIRED_LEGACY_TIMERS[1]]);
    expect(storage.getItem(RETIRED_LEGACY_TIMERS[0])).toBeNull();
    expect(result.strippedCharacters).toEqual(['char-old']);

    const cleaned = saved[0] as { phoneState: Record<string, unknown> };
    expect(cleaned.phoneState.autoRefresh).toBeUndefined();
    expect(cleaned.phoneState.autoRefreshIntervalMin).toBeUndefined();
    expect(cleaned.phoneState.lastAutoRefreshAt).toBeUndefined();
    expect(cleaned.phoneState.sendToChat).toBe(true);

    // 旧配置是关着的 → 迁移不授予任何 kind；上限/免打扰照搬。
    expect(writes.length).toBe(1);
    expect(writes[0]).toMatchObject({
      enabled: false,
      allowedKinds: [],
      limits: { charModelCallsPerDay: 3, accountModelCallsPerDay: 6 },
    });
    expect(storage.getItem(LEGACY_AUTONOMY_MIGRATION_MARKER)).toBe(String(NOW));
  });

  it('第二次启动：不再写边界（幂等），但仍清理残留字段', async () => {
    const storage = fakeStorage({ [LEGACY_AUTONOMY_MIGRATION_MARKER]: String(NOW - 1000) });
    const { api, writes } = fakeApi({ revision: 2 });
    const result = await retireLegacyAutonomyConfig({
      api,
      characters: [legacyCharacter()],
      saveCharacter: async () => {},
      legacy: { enabled: true, perCharPerDay: 9 },
      storage,
      now: () => NOW,
      timezone: 'Asia/Shanghai',
    });
    expect(result.migrated).toBe(false);
    expect(result.skippedReason).toBe('already_migrated');
    expect(writes.length).toBe(0);
    expect(result.strippedCharacters).toEqual(['char-old']);
  });

  it('用户已经配过账号边界（revision > 0）→ 不覆盖，只记 marker', async () => {
    const storage = fakeStorage();
    const { api, writes } = fakeApi({ revision: 4 });
    const result = await retireLegacyAutonomyConfig({
      api,
      characters: [],
      saveCharacter: async () => {},
      legacy: { enabled: true, perCharPerDay: 9 },
      storage,
      now: () => NOW,
      timezone: 'Asia/Shanghai',
    });
    expect(result.migrated).toBe(false);
    expect(result.skippedReason).toBe('account_already_configured');
    expect(writes.length).toBe(0);
    expect(storage.getItem(LEGACY_AUTONOMY_MIGRATION_MARKER)).toBe(String(NOW));
  });

  it('后台不可用 → 不标记完成，下次启动重试', async () => {
    const storage = fakeStorage();
    const { api } = fakeApi({ failRead: true });
    const result = await retireLegacyAutonomyConfig({
      api,
      characters: [],
      saveCharacter: async () => {},
      legacy: { enabled: true },
      storage,
      now: () => NOW,
      timezone: 'Asia/Shanghai',
    });
    expect(result.migrated).toBe(false);
    expect(result.skippedReason).toBe('boundary_unavailable');
    expect(storage.getItem(LEGACY_AUTONOMY_MIGRATION_MARKER)).toBeNull();
  });
});
