import { describe, expect, it, vi } from 'vitest';
import { createGuardrailCloudPort } from './autonomyGuardrailTransport';
import {
  AUTONOMY_GUARDRAIL_DEFAULTS,
  buildAutonomyGuardrailStateEntry,
  type AirpAutonomyGuardrails,
} from './autonomyGuardrails';
import { GuardrailSyncError } from './autonomyGuardrailsClient';

const entryFor = (patch: Partial<AirpAutonomyGuardrails> = {}, at = 123) =>
  buildAutonomyGuardrailStateEntry({ ...AUTONOMY_GUARDRAIL_DEFAULTS, ...patch }, at);

describe('保存后回读确认', () => {
  it('保存后从鉴权云端读回同一条目才确认成功', async () => {
    const entry = entryFor({ globalPerDay: 4 });
    const client = {
      writeClientStateValue: vi.fn(async () => {}),
      readClientStateValue: vi.fn(async () => entry.value),
    };
    await createGuardrailCloudPort(client).save(entry);
    expect(client.writeClientStateValue).toHaveBeenCalledWith(entry.namespace, entry.key, entry.value);
    expect(client.readClientStateValue).toHaveBeenCalledWith(entry.namespace, entry.key);
  });

  it('后端返回旧值时不显示已同步', async () => {
    const entry = entryFor({ globalPerDay: 4 });
    const client = {
      writeClientStateValue: vi.fn(async () => {}),
      readClientStateValue: vi.fn(async () => null),
    };
    await expect(createGuardrailCloudPort(client).save(entry)).rejects.toThrow('未确认');
  });
});

describe('乐观并发：写前核对基线', () => {
  it('期望「不存在」但云端已有行 → 冲突，不写', async () => {
    const entry = entryFor({ paused: true });
    const client = {
      writeClientStateValue: vi.fn(async () => {}),
      readClientStateValue: vi.fn(async () => entry.value),
    };
    const error = await createGuardrailCloudPort(client)
      .save(entry, { kind: 'absent' })
      .catch((e: unknown) => e as GuardrailSyncError);
    expect(error).toBeInstanceOf(GuardrailSyncError);
    expect((error as GuardrailSyncError).code).toBe('conflict');
    expect(client.writeClientStateValue).not.toHaveBeenCalled();
  });

  it('基线与云端现值不一致（另一台设备改了）→ 冲突，并把现值带回给调用方', async () => {
    const base = entryFor({ globalPerDay: 4 });
    const remote = entryFor({ globalPerDay: 4, paused: true });
    const entry = entryFor({ globalPerDay: 6 });
    const client = {
      writeClientStateValue: vi.fn(async () => {}),
      readClientStateValue: vi.fn(async () => remote.value),
    };
    const error = await createGuardrailCloudPort(client)
      .save(entry, { kind: 'value', value: JSON.parse(base.value) })
      .catch((e: unknown) => e as GuardrailSyncError);
    expect((error as GuardrailSyncError).code).toBe('conflict');
    expect((error as GuardrailSyncError).remoteValue).toBe(remote.value);
    expect(client.writeClientStateValue).not.toHaveBeenCalled();
  });

  it('基线一致 → 正常写入', async () => {
    const base = entryFor({ globalPerDay: 4 });
    const entry = entryFor({ globalPerDay: 5 });
    const client = {
      writeClientStateValue: vi.fn(async () => {}),
      readClientStateValue: vi.fn()
        .mockResolvedValueOnce(base.value)   // 写前核对
        .mockResolvedValueOnce(entry.value), // 写后读回
    };
    await createGuardrailCloudPort(client).save(entry, { kind: 'value', value: JSON.parse(base.value) });
    expect(client.writeClientStateValue).toHaveBeenCalledTimes(1);
  });

  it('云端那份读不出来（坏 JSON）时按冲突处理，不做盲写', async () => {
    const entry = entryFor();
    const client = {
      writeClientStateValue: vi.fn(async () => {}),
      readClientStateValue: vi.fn(async () => '{oops'),
    };
    const error = await createGuardrailCloudPort(client)
      .save(entry, { kind: 'value', value: JSON.parse(entry.value) })
      .catch((e: unknown) => e as GuardrailSyncError);
    expect((error as GuardrailSyncError).code).toBe('conflict');
    expect(client.writeClientStateValue).not.toHaveBeenCalled();
  });
});

describe('专用原子写入（POST /autonomy-guardrails/patch）', () => {
  it('有专用路由时优先走它：把 patch + 基线 + 解暂停意图一起交出去，不自己读改写', async () => {
    const entry = entryFor({ globalPerDay: 4 });
    const patchMock = vi.fn(async (_body: { patch: Record<string, unknown> }) => ({
      status: 200,
      body: { success: true, data: { value: JSON.parse(entry.value) } },
    }));
    const client = {
      writeClientStateValue: vi.fn(async () => {}),
      readClientStateValue: vi.fn(async () => null),
      patchGlobalGuardrails: patchMock,
    };
    await createGuardrailCloudPort(client).save(entry, { kind: 'absent' }, { allowUnpause: true });

    expect(client.readClientStateValue).not.toHaveBeenCalled();
    expect(client.writeClientStateValue).not.toHaveBeenCalled();
    expect(client.patchGlobalGuardrails).toHaveBeenCalledWith(expect.objectContaining({
      allowUnpause: true,
      expected: { kind: 'absent' },
    }));
    const sent = patchMock.mock.calls[0][0];
    expect(sent.patch.globalPerDay).toBe(4);
  });

  it('服务端 409 → conflict（带回云端现值），调用方据此放弃本次写入', async () => {
    const entry = entryFor({ globalPerDay: 4, paused: true });
    const client = {
      writeClientStateValue: vi.fn(async () => {}),
      readClientStateValue: vi.fn(async () => null),
      patchGlobalGuardrails: vi.fn(async () => ({
        status: 409,
        body: {
          success: false,
          error: { code: 'GUARDRAIL_CONFLICT', message: 'no' },
          data: { value: { ...AUTONOMY_GUARDRAIL_DEFAULTS, paused: true } },
        },
      })),
    };
    const error = await createGuardrailCloudPort(client)
      .save(entry, { kind: 'value', value: JSON.parse(entry.value) })
      .catch((e: unknown) => e as GuardrailSyncError);
    expect((error as GuardrailSyncError).code).toBe('conflict');
    expect((error as GuardrailSyncError).remoteValue).toContain('paused');
  });

  it('服务端 503（读不出来）→ 不当作成功，也不声称已同步', async () => {
    const entry = entryFor({ globalPerDay: 4 });
    const client = {
      writeClientStateValue: vi.fn(async () => {}),
      readClientStateValue: vi.fn(async () => null),
      patchGlobalGuardrails: vi.fn(async () => ({
        status: 503,
        body: { success: false, error: { code: 'GUARDRAIL_UNREADABLE', message: 'no' } },
      })),
    };
    await expect(createGuardrailCloudPort(client).save(entry)).rejects.toThrow(GuardrailSyncError);
  });

  it('服务端把解暂停按回去（unpauseIgnored）→ 回执如实带回，客户端不显示已解暂停', async () => {
    const entry = entryFor({ globalPerDay: 4, paused: false });
    const client = {
      writeClientStateValue: vi.fn(async () => {}),
      readClientStateValue: vi.fn(async () => null),
      patchGlobalGuardrails: vi.fn(async () => ({
        status: 200,
        body: {
          success: true,
          data: { value: { ...JSON.parse(entry.value), paused: true }, unpauseIgnored: true },
        },
      })),
    };
    const ack = await createGuardrailCloudPort(client).save(entry, undefined, { allowUnpause: false });
    expect(ack?.unpauseIgnored).toBe(true);
    expect(ack?.value?.paused).toBe(true);
  });
});
