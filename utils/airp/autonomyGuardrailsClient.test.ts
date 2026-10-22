import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AirpSettings } from './settings';
import { AUTONOMY_GUARDRAIL_DEFAULTS, AUTONOMY_GUARDRAIL_STATE_KEY, AUTONOMY_GUARDRAIL_STATE_NAMESPACE } from './autonomyGuardrails';
import {
  AUTONOMY_GUARDRAILS_DRAFT_KEY,
  bindGuardrailCloudSync,
  clearCharGuardrails,
  getGlobalGuardrailsSnapshot,
  getGuardrailsSyncState,
  hoursToMinutes,
  minutesToHours,
  parseGuardrailInput,
  readCharGuardrailsUi,
  readGlobalGuardrails,
  refreshGlobalGuardrailsFromRemote,
  saveGlobalGuardrails,
  withCharGuardrails,
} from './autonomyGuardrailsClient';

const airpWith = (extra: Partial<AirpSettings> = {}): AirpSettings => ({
  enabled: true,
  autonomyLevel: 2,
  capabilities: [],
  mcpAllow: [],
  writable: false,
  ...extra,
  version: 1,
});

const charWith = (airp?: AirpSettings) => ({ id: 'c1', airp } as any);

afterEach(() => {
  bindGuardrailCloudSync(null);
  localStorage.removeItem(AUTONOMY_GUARDRAILS_DRAFT_KEY);
  vi.restoreAllMocks();
});

describe('parseGuardrailInput', () => {
  it('0 合法（暂停 / 不限），负数 / 小数 / 超界 / 空串各自明确', () => {
    expect(parseGuardrailInput('0', 0, 12)).toEqual({ kind: 'set', value: 0 });
    expect(parseGuardrailInput('12', 0, 12)).toEqual({ kind: 'set', value: 12 });
    expect(parseGuardrailInput('13', 0, 12)).toEqual({ kind: 'invalid', reason: 'range' });
    expect(parseGuardrailInput('-1', 0, 12)).toEqual({ kind: 'invalid', reason: 'range' });
    expect(parseGuardrailInput('1.5', 0, 12)).toEqual({ kind: 'invalid', reason: 'integer' });
    expect(parseGuardrailInput('abc', 0, 12)).toEqual({ kind: 'invalid', reason: 'nan' });
    expect(parseGuardrailInput('  ', 0, 12)).toEqual({ kind: 'empty' });
  });
});

describe('小时 / 分钟换算', () => {
  it('面板小时 → 契约分钟，天花板 24h；分钟 → 小时保留一位', () => {
    expect(hoursToMinutes(2)).toBe(120);
    expect(hoursToMinutes(1.5)).toBe(90);
    expect(hoursToMinutes(0)).toBe(0);
    expect(hoursToMinutes(99)).toBe(24 * 60);
    expect(minutesToHours(120)).toBe(2);
    expect(minutesToHours(90)).toBe(1.5);
    expect(minutesToHours(0)).toBe(0);
  });
});

describe('readCharGuardrailsUi', () => {
  it('没有 airp / 没有 guardrails → 契约默认（2 次 / 2h / 1600）且 hasOwn=false', () => {
    expect(readCharGuardrailsUi(charWith(undefined))).toEqual({
      hasOwn: false,
      perCharPerDay: 2,
      sameKindMinGapHours: 2,
      reserveTokensPerRun: AUTONOMY_GUARDRAIL_DEFAULTS.reserveTokensPerRun,
    });
  });

  it('旧配置只有 overrides.maxRoundsPerDay 时，面板仍显示契约默认（旧字段不影响护栏显示）', () => {
    const char = charWith(airpWith({
      autonomy: { enabled: true, templateId: 'custom', overrides: { maxRoundsPerDay: 5 }, version: 1 },
    }));
    const out = readCharGuardrailsUi(char);
    expect(out.hasOwn).toBe(false);
    expect(out.perCharPerDay).toBe(2);
  });

  it('自己的 guardrails：0 次/天原样读回（不会被归一化洗成默认）', () => {
    const char = charWith(airpWith({
      autonomy: {
        enabled: false,
        templateId: 'custom',
        overrides: {},
        guardrails: { version: 1, perCharPerDay: 0, sameKindMinGapMinutes: 90, reserveTokensPerRun: 2000, globalPerDay: 6, paused: false },
        version: 1,
      } as any,
    }));
    expect(readCharGuardrailsUi(char)).toEqual({
      hasOwn: true,
      perCharPerDay: 0,
      sameKindMinGapHours: 1.5,
      reserveTokensPerRun: 2000,
    });
  });
});

describe('withCharGuardrails', () => {
  it('写契约形状，并镜像旧调度器认的 overrides.maxRoundsPerDay', () => {
    const next = withCharGuardrails(airpWith(), { perCharPerDay: 3, sameKindMinGapMinutes: 90, reserveTokensPerRun: 2000 });
    const autonomy = (next as any).autonomy;
    expect(autonomy.guardrails).toEqual({
      version: 1,
      perCharPerDay: 3,
      sameKindMinGapMinutes: 90,
      reserveTokensPerRun: 2000,
      globalPerDay: AUTONOMY_GUARDRAIL_DEFAULTS.globalPerDay,
      paused: false,
    });
    expect(autonomy.overrides.maxRoundsPerDay).toBe(3);
  });

  it('保留面板不管的字段（directorModel / mcpAllow / writable / autonomyLevel / capabilityMode）', () => {
    const next = withCharGuardrails(airpWith({
      directorModel: 'm1',
      mcpAllow: ['srv'],
      writable: true,
      autonomyLevel: 3,
      capabilityMode: 'allowlist',
      capabilities: ['cap.a'],
    }), { perCharPerDay: 2 });
    expect(next.directorModel).toBe('m1');
    expect(next.mcpAllow).toEqual(['srv']);
    expect(next.writable).toBe(true);
    expect(next.autonomyLevel).toBe(3);
    expect(next.capabilityMode).toBe('allowlist');
    expect(next.capabilities).toEqual(['cap.a']);
  });

  it('0 次/天 = 暂停：关掉 autonomy.enabled 并删掉旧计数镜像', () => {
    const base = airpWith({
      autonomy: { enabled: true, templateId: 'custom', overrides: { maxRoundsPerDay: 5 }, version: 1 },
    });
    const next = withCharGuardrails(base, { perCharPerDay: 0 });
    const autonomy = (next as any).autonomy;
    expect((autonomy as any).enabled).toBe(false);
    expect(autonomy.guardrails.perCharPerDay).toBe(0);
    expect(autonomy.overrides.maxRoundsPerDay).toBeUndefined();
  });

  it('先设 0 再改其它字段，0 保持不被洗掉', () => {
    const first = withCharGuardrails(airpWith(), { perCharPerDay: 0 });
    const second = withCharGuardrails(first, { sameKindMinGapMinutes: 300 });
    const autonomy = (second as any).autonomy;
    expect(autonomy.guardrails.perCharPerDay).toBe(0);
    expect(autonomy.guardrails.sameKindMinGapMinutes).toBe(300);
  });

  it('越界值夹到天花板，不产生 NaN / 小数', () => {
    const next = withCharGuardrails(airpWith(), { perCharPerDay: 999, sameKindMinGapMinutes: 99999, reserveTokensPerRun: 99999 });
    const g = readCharGuardrailsUi(charWith(next));
    expect(g.perCharPerDay).toBe(12);
    expect(g.sameKindMinGapHours).toBe(24);
    expect(g.reserveTokensPerRun).toBe(8000);
  });

  it('未传的字段沿用上一次的值', () => {
    const first = withCharGuardrails(airpWith(), { perCharPerDay: 4, sameKindMinGapMinutes: 180, reserveTokensPerRun: 3000 });
    const second = withCharGuardrails(first, { perCharPerDay: 5 });
    expect(readCharGuardrailsUi(charWith(second))).toMatchObject({
      perCharPerDay: 5,
      sameKindMinGapHours: 3,
      reserveTokensPerRun: 3000,
    });
  });
});

describe('clearCharGuardrails', () => {
  it('删 guardrails 与旧计数镜像，其它字段不动 → 回到跟随契约默认', () => {
    const filled = withCharGuardrails(airpWith({ mcpAllow: ['x'] }), { perCharPerDay: 3 });
    const cleared = clearCharGuardrails(filled);
    expect((cleared as any).autonomy.guardrails).toBeUndefined();
    expect((cleared as any).autonomy.overrides.maxRoundsPerDay).toBeUndefined();
    expect(cleared.mcpAllow).toEqual(['x']);
    expect(readCharGuardrailsUi(charWith(cleared)).hasOwn).toBe(false);
  });
});

describe('全局共享行：本地草稿 + 鉴权端口', () => {
  it('没有草稿 → 展示兜底是契约默认，但快照明确「未确认」', () => {
    expect(readGlobalGuardrails()).toEqual(AUTONOMY_GUARDRAIL_DEFAULTS);
    expect(getGlobalGuardrailsSnapshot()).toMatchObject({ value: null, canSave: false, authority: 'unknown' });
  });

  it('未绑定端口：不允许落权威值（不再用 local-only 假装保存成功）', async () => {
    const result = await saveGlobalGuardrails({ globalPerDay: 4, paused: true });
    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
    expect(readGlobalGuardrails()).toEqual(AUTONOMY_GUARDRAIL_DEFAULTS);
  });

  it('端口成功后 pending 清掉，刷新仍从草稿恢复', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    bindGuardrailCloudSync({ save, load: vi.fn().mockResolvedValue(null) });
    await refreshGlobalGuardrailsFromRemote();
    const result = await saveGlobalGuardrails({ globalPerDay: 3 });
    expect(save).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('synced');
    expect(getGuardrailsSyncState()).toMatchObject({ status: 'synced', pendingSync: false });
    expect(readGlobalGuardrails().globalPerDay).toBe(3);
    // 新建行：entry 是后台可直接吃的那条
    expect(result.entry?.key).toBe(AUTONOMY_GUARDRAIL_STATE_KEY);
    expect(result.entry?.namespace).toBe(AUTONOMY_GUARDRAIL_STATE_NAMESPACE);
  });

  it('端口失败：保留草稿 + lastError，状态 error；非法值不会原样上后台', async () => {
    const save = vi.fn().mockRejectedValue(new Error('401 未授权'));
    bindGuardrailCloudSync({ save, load: vi.fn().mockResolvedValue(null) });
    await refreshGlobalGuardrailsFromRemote();
    const result = await saveGlobalGuardrails({ globalPerDay: 999, paused: false });
    expect(result.ok).toBe(false);
    expect(getGuardrailsSyncState()).toMatchObject({ status: 'error', pendingSync: true, lastError: '401 未授权' });
    // 999 超天花板 → 夹到 24 再上云
    expect(JSON.parse(save.mock.calls[0][0].value).globalPerDay).toBe(24);
  });

  it('回读：本地有待同步草稿时不覆盖；没有草稿时采用后台值', async () => {
    const load = vi.fn().mockResolvedValue(JSON.stringify({ globalPerDay: 5, paused: true }));
    bindGuardrailCloudSync({ save: vi.fn().mockRejectedValue(new Error('offline')), load });
    await refreshGlobalGuardrailsFromRemote();

    await saveGlobalGuardrails({ globalPerDay: 2 });
    expect(getGuardrailsSyncState().pendingSync).toBe(true);
    expect(await refreshGlobalGuardrailsFromRemote()).toMatchObject({ status: 'skipped', reason: 'pending' });
    expect(readGlobalGuardrails().globalPerDay).toBe(2);

    // 后台可达、上传成功清掉 pending 后再回读 → 采用后台值
    bindGuardrailCloudSync({ save: vi.fn().mockResolvedValue(undefined), load });
    const retry = await saveGlobalGuardrails({ globalPerDay: 2 });
    expect(retry.ok).toBe(true);
    expect(getGuardrailsSyncState().pendingSync).toBe(false);
    expect((await refreshGlobalGuardrailsFromRemote()).status).toBe('ok');
    expect(readGlobalGuardrails()).toMatchObject({ globalPerDay: 5, paused: true });
  });

  it('回读拿到的坏数据 → 不采用、不落默认，状态 error', async () => {
    bindGuardrailCloudSync({ save: vi.fn(), load: vi.fn().mockResolvedValue('{oops') });
    expect((await refreshGlobalGuardrailsFromRemote()).status).toBe('invalid');
    expect(getGlobalGuardrailsSnapshot().value).toBeNull();
    expect(getGuardrailsSyncState().status).toBe('error');
  });
});
