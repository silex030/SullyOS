/**
 * 全局护栏客户端的 fail-closed 契约（发布前护栏阻断项）。
 *
 * 要证明的四条：
 *   1. 读不到云端真实值（网络 / master key / 坏 JSON）→ 不得展示「可保存的 paused:false」；
 *   2. 明确缺行（新用户）才允许落默认；读错保持上次确认值；
 *   3. 保存是「在已确认基线上打补丁」，未确认基线整对象覆写一律拒绝；
 *   4. 旧客户端只改次数不能无意解暂停；多设备暂停冲突不能把暂停覆盖掉。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTONOMY_GUARDRAIL_DEFAULTS,
  type AirpAutonomyGuardrails,
} from './autonomyGuardrails';
import {
  AUTONOMY_GUARDRAILS_DRAFT_KEY,
  GuardrailSyncError,
  bindGuardrailCloudSync,
  getGlobalGuardrailsSnapshot,
  getGuardrailsSyncState,
  readGlobalGuardrails,
  refreshGlobalGuardrailsFromRemote,
  resetGlobalGuardrailsState,
  saveGlobalGuardrails,
} from './autonomyGuardrailsClient';

const confirmedPaused: AirpAutonomyGuardrails = { ...AUTONOMY_GUARDRAIL_DEFAULTS, paused: true, globalPerDay: 2 };
const confirmedActive: AirpAutonomyGuardrails = { ...AUTONOMY_GUARDRAIL_DEFAULTS, paused: false, globalPerDay: 4 };

beforeEach(() => {
  resetGlobalGuardrailsState();
  localStorage.removeItem(AUTONOMY_GUARDRAILS_DRAFT_KEY);
});

afterEach(() => {
  bindGuardrailCloudSync(null);
  resetGlobalGuardrailsState();
  localStorage.removeItem(AUTONOMY_GUARDRAILS_DRAFT_KEY);
  vi.restoreAllMocks();
});

describe('读不到云端真实值：什么都不许当成「未暂停」', () => {
  it('新设备还没同步过 → 快照值是 null，可保存=false，状态 unknown', () => {
    const snap = getGlobalGuardrailsSnapshot();
    expect(snap.value).toBeNull();
    expect(snap.lastConfirmed).toBeNull();
    expect(snap.authority).toBe('unknown');
    expect(snap.canSave).toBe(false);
    expect(snap.syncState.status).toBe('unknown');
    // 展示兜底可以有，但不在快照的权威值里
    expect(readGlobalGuardrails().paused).toBe(false);
  });

  it('丢网（load 抛错）→ 状态 error、值仍未知、不允许保存、不写盘', async () => {
    const save = vi.fn();
    bindGuardrailCloudSync({ save, load: vi.fn().mockRejectedValue(new Error('offline')) });

    const read = await refreshGlobalGuardrailsFromRemote();
    expect(read).toMatchObject({ status: 'error' });
    const snap = getGlobalGuardrailsSnapshot();
    expect(snap.value).toBeNull();
    expect(snap.canSave).toBe(false);
    expect(snap.syncState.status).toBe('error');
    expect(snap.syncState.lastError).toContain('offline');

    const res = await saveGlobalGuardrails({ paused: false, globalPerDay: 6 });
    expect(res.ok).toBe(false);
    expect(res.blocked).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it('master key 错（解密失败）→ 同样是「未确认」，不能自动解暂停', async () => {
    bindGuardrailCloudSync({
      save: vi.fn(),
      load: vi.fn().mockRejectedValue(new Error('解密失败：master key 不匹配')),
    });
    await refreshGlobalGuardrailsFromRemote();
    const snap = getGlobalGuardrailsSnapshot();
    expect(snap.value).toBeNull();
    expect(snap.canSave).toBe(false);
    expect(snap.syncState.status).toBe('error');
    expect(snap.syncState.lastError).toContain('master key');
    expect(await saveGlobalGuardrails({ paused: false })).toMatchObject({ ok: false, blocked: true });
  });

  it('云端那一行是坏 JSON → 不是「缺行」，不落默认、不允许保存', async () => {
    bindGuardrailCloudSync({ save: vi.fn(), load: vi.fn().mockResolvedValue('{oops') });
    const read = await refreshGlobalGuardrailsFromRemote();
    expect(read.status).toBe('invalid');
    const snap = getGlobalGuardrailsSnapshot();
    expect(snap.value).toBeNull();
    expect(snap.authority).toBe('unknown');
    expect(snap.canSave).toBe(false);
    expect(snap.syncState.status).toBe('error');
  });

  it('已确认过暂停后再次读失败 → 保持上次确认值（paused 仍为 true），不退回默认', async () => {
    bindGuardrailCloudSync({
      save: vi.fn().mockResolvedValue(undefined),
      load: vi.fn().mockResolvedValue(JSON.stringify(confirmedPaused)),
    });
    expect((await refreshGlobalGuardrailsFromRemote()).status).toBe('ok');
    expect(getGlobalGuardrailsSnapshot().value?.paused).toBe(true);

    bindGuardrailCloudSync({
      save: vi.fn(),
      load: vi.fn().mockRejectedValue(new Error('network down')),
    });
    expect((await refreshGlobalGuardrailsFromRemote()).status).toBe('error');
    const snap = getGlobalGuardrailsSnapshot();
    expect(snap.value?.paused).toBe(true);
    expect(snap.lastConfirmed?.paused).toBe(true);
    expect(snap.canSave).toBe(true); // 有上次确认的基线，可以基于它保存
    expect(snap.syncState.status).toBe('error');
  });
});

describe('明确缺行（新用户）才允许默认值', () => {
  it('load 返回 null → remote-absent，默认值可保存（新用户首次创建）', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    bindGuardrailCloudSync({ save, load: vi.fn().mockResolvedValue(null) });

    expect((await refreshGlobalGuardrailsFromRemote()).status).toBe('absent');
    const snap = getGlobalGuardrailsSnapshot();
    expect(snap.authority).toBe('remote-absent');
    expect(snap.canSave).toBe(true);
    expect(snap.value).toEqual(AUTONOMY_GUARDRAIL_DEFAULTS);

    const res = await saveGlobalGuardrails({ paused: false, globalPerDay: 6 });
    expect(res.ok).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    // 新建行用的是「期望不存在」而不是整对象覆盖
    expect(save.mock.calls[0][1]).toEqual({ kind: 'absent' });
  });

  it('端口没绑（本机草稿）时不再假装保存成功，也不允许落权威值', async () => {
    const res = await saveGlobalGuardrails({ globalPerDay: 3 });
    expect(res.ok).toBe(false);
    expect(res.blocked).toBe(true);
    expect(res.status).toBe('unknown');
    expect(getGlobalGuardrailsSnapshot().canSave).toBe(false);
  });
});

describe('保存 = 在已确认基线上打补丁', () => {
  it('只改次数：写出的对象保留云端 paused:true（不会解暂停）', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    bindGuardrailCloudSync({ save, load: vi.fn().mockResolvedValue(JSON.stringify(confirmedPaused)) });
    await refreshGlobalGuardrailsFromRemote();

    const res = await saveGlobalGuardrails({ globalPerDay: 3 });
    expect(res.ok).toBe(true);
    const entry = save.mock.calls[0][0];
    expect(JSON.parse(entry.value)).toMatchObject({ globalPerDay: 3, paused: true });
    expect(getGlobalGuardrailsSnapshot().value?.paused).toBe(true);
    // 基线是上次确认值（乐观并发），不是默认值
    expect(save.mock.calls[0][1]).toEqual({ kind: 'value', value: confirmedPaused });
  });

  it('旧客户端整对象覆写（带 paused:false）但没有明确解暂停 → 暂停被保住', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    bindGuardrailCloudSync({ save, load: vi.fn().mockResolvedValue(JSON.stringify(confirmedPaused)) });
    await refreshGlobalGuardrailsFromRemote();

    // 老版本调用形状：把整份（读失败时为默认值的）对象传进来
    const res = await saveGlobalGuardrails({ ...AUTONOMY_GUARDRAIL_DEFAULTS, paused: false, globalPerDay: 4 });
    expect(res.ok).toBe(true);
    expect(res.unpauseIgnored).toBe(true);
    const written = JSON.parse(save.mock.calls[0][0].value);
    expect(written.paused).toBe(true);
    expect(written.globalPerDay).toBe(4);
  });

  it('用户明确打开总开关（allowUnpause）→ 才真的解暂停', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    bindGuardrailCloudSync({ save, load: vi.fn().mockResolvedValue(JSON.stringify(confirmedPaused)) });
    await refreshGlobalGuardrailsFromRemote();

    const res = await saveGlobalGuardrails({ paused: false }, { allowUnpause: true });
    expect(res.ok).toBe(true);
    expect(res.unpauseIgnored).toBeUndefined();
    expect(JSON.parse(save.mock.calls[0][0].value).paused).toBe(false);
  });

  it('全局次数填 0 → 写 paused:true + globalPerDay:0（不是默认 6）', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    bindGuardrailCloudSync({ save, load: vi.fn().mockResolvedValue(JSON.stringify(confirmedActive)) });
    await refreshGlobalGuardrailsFromRemote();

    const res = await saveGlobalGuardrails({ globalPerDay: 0 });
    expect(res.ok).toBe(true);
    const written = JSON.parse(save.mock.calls[0][0].value);
    expect(written.globalPerDay).toBe(0);
    expect(written.paused).toBe(true);
  });

  it('成功后基线上移：第二次保存以刚写回的值做乐观基线', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const load = vi.fn().mockResolvedValue(JSON.stringify(confirmedActive));
    bindGuardrailCloudSync({ save, load });
    await refreshGlobalGuardrailsFromRemote();

    await saveGlobalGuardrails({ globalPerDay: 3 });
    expect(save.mock.calls[0][1]).toEqual({ kind: 'value', value: confirmedActive });

    save.mockClear();
    await saveGlobalGuardrails({ globalPerDay: 5 });
    expect(save.mock.calls[0][1]).toEqual({ kind: 'value', value: { ...confirmedActive, globalPerDay: 3 } });
  });
});

describe('多设备暂停冲突', () => {
  it('另一台设备先暂停：本机基于旧值保存 → 冲突，云端暂停不被覆盖，本机改用云端值', async () => {
    const load = vi.fn()
      // 第一次：本机看到的是「未暂停」
      .mockResolvedValueOnce(JSON.stringify(confirmedActive))
      // 冲突时回读：另一台设备已经暂停了
      .mockResolvedValue(JSON.stringify(confirmedPaused));
    const save = vi.fn().mockRejectedValue(
      new GuardrailSyncError('conflict', '云端配置已被另一台设备修改。', JSON.stringify(confirmedPaused)),
    );
    bindGuardrailCloudSync({ save, load });
    await refreshGlobalGuardrailsFromRemote();

    const res = await saveGlobalGuardrails({ paused: false, globalPerDay: 6 }, { allowUnpause: true });
    expect(res.ok).toBe(false);
    expect(res.conflict).toBe(true);
    expect(res.status).toBe('conflict');

    const snap = getGlobalGuardrailsSnapshot();
    expect(snap.value?.paused).toBe(true);
    expect(snap.lastConfirmed?.paused).toBe(true);
    expect(snap.syncState.status).toBe('conflict');
    // 冲突后没有把草稿继续挂着等自动重写（否则重试会再次覆盖云端暂停）
    expect(snap.pendingSync).toBe(false);
  });

  it('冲突但拿不到云端可读值时 → 保持上次确认值（不是默认值），状态 conflict', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(confirmedActive))
      .mockResolvedValueOnce('{oops');
    const save = vi.fn().mockRejectedValue(new GuardrailSyncError('conflict', '冲突'));
    bindGuardrailCloudSync({ save, load });
    await refreshGlobalGuardrailsFromRemote();

    const res = await saveGlobalGuardrails({ globalPerDay: 1 });
    expect(res.conflict).toBe(true);
    const snap = getGlobalGuardrailsSnapshot();
    // 读不到真实值时不能用默认值冒充；保持上次确认的 paused 状态
    expect(snap.value?.paused).toBe(confirmedActive.paused);
    expect(snap.pendingSync).toBe(false);
    expect(snap.syncState.status).toBe('conflict');
  });

  it('写后回读不一致（后台没确认）→ 保持草稿 + error，不标记已同步', async () => {
    const save = vi.fn().mockRejectedValue(new GuardrailSyncError('unconfirmed', '后台未确认此次护栏配置，请重试同步。'));
    bindGuardrailCloudSync({ save, load: vi.fn().mockResolvedValue(JSON.stringify(confirmedActive)) });
    await refreshGlobalGuardrailsFromRemote();

    const res = await saveGlobalGuardrails({ globalPerDay: 2 });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('error');
    const state = getGuardrailsSyncState();
    expect(state.status).toBe('error');
    expect(state.pendingSync).toBe(true);
    expect(getGlobalGuardrailsSnapshot().lastConfirmed?.globalPerDay).toBe(confirmedActive.globalPerDay);
  });
});

describe('旧缓存形状（升级前写的草稿）', () => {
  it('旧记录里的 value 不会升级成「已确认的云端值」', () => {
    localStorage.setItem(AUTONOMY_GUARDRAILS_DRAFT_KEY, JSON.stringify({
      v: 1,
      value: { ...AUTONOMY_GUARDRAIL_DEFAULTS, paused: false, globalPerDay: 6 },
      pendingSync: true,
      savedAt: 1,
    }));
    const snap = getGlobalGuardrailsSnapshot();
    expect(snap.authority).toBe('unknown');
    expect(snap.canSave).toBe(false);
  });
});
