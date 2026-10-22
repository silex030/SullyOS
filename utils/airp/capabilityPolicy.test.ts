/**
 * B4 权限契约回归：能力授权要能显式表达 all / allowlist / none。
 *
 * 老数据（只有 capabilities 数组、没有 mode）的语义必须原样保留：
 *   空数组 = all（历史上就是"不勾选即全开"），非空 = allowlist。
 * 新数据一旦写了 none，就再也不能因为"数组是空的"被读回 all。
 */
import { describe, expect, it } from 'vitest';
import type { CharacterProfile } from '../../types';
import { AIRP_CAPABILITIES } from './capabilityCatalog';
import { resolveCapabilities } from './snapshot';
import {
    capabilityPolicyPatch,
    mergeAirpSettings,
    resolveAirpCapabilityPolicy,
    type AirpCapabilityPolicy,
} from './settings';

const makeChar = (airp: unknown): CharacterProfile =>
    ({ id: 'cap-policy-char', airp } as unknown as CharacterProfile);

const LOW_WRITE_IDS = AIRP_CAPABILITIES.filter((cap) => cap.risk === 'low_write').map((cap) => cap.id);
const READ_IDS = AIRP_CAPABILITIES.filter((cap) => cap.risk !== 'low_write').map((cap) => cap.id);

describe('resolveAirpCapabilityPolicy · 旧配置迁移', () => {
    it('缺省 / 空数组一律读回 all（历史上"不勾选 = 全部可用"不能变）', () => {
        expect(resolveAirpCapabilityPolicy(undefined)).toEqual({ mode: 'all', allow: [] });
        expect(resolveAirpCapabilityPolicy(null)).toEqual({ mode: 'all', allow: [] });
        expect(resolveAirpCapabilityPolicy({})).toEqual({ mode: 'all', allow: [] });
        expect(resolveAirpCapabilityPolicy({ capabilities: [] })).toEqual({ mode: 'all', allow: [] });
    });

    it('非空数组读回 allowlist，内容原样保留', () => {
        expect(resolveAirpCapabilityPolicy({ capabilities: ['web_search', 'read_note'] }))
            .toEqual({ mode: 'allowlist', allow: ['web_search', 'read_note'] });
    });

    it('脏输入（非对象 / 非数组）按旧语义回落 all，不抛错', () => {
        for (const raw of ['junk', 42, true, [], { capabilities: 'oops' }, { capabilities: null }]) {
            expect(resolveAirpCapabilityPolicy(raw)).toEqual({ mode: 'all', allow: [] });
        }
    });

    it('去重、丢掉非字符串条目，顺序保持首次出现', () => {
        expect(resolveAirpCapabilityPolicy({ capabilities: ['b', 5, 'a', 'b', null] }).allow)
            .toEqual(['b', 'a']);
    });

    it('未知 mode 视为没有 mode，走旧语义', () => {
        expect(resolveAirpCapabilityPolicy({ capabilityMode: 'partial', capabilities: [] }))
            .toEqual({ mode: 'all', allow: [] });
        expect(resolveAirpCapabilityPolicy({ capabilityMode: 'partial', capabilities: ['web_search'] }))
            .toEqual({ mode: 'allowlist', allow: ['web_search'] });
    });
});

describe('resolveAirpCapabilityPolicy · 显式 none 不许变回 all', () => {
    it('显式 none + 空数组 = none', () => {
        expect(resolveAirpCapabilityPolicy({ capabilityMode: 'none', capabilities: [] }))
            .toEqual({ mode: 'none', allow: [] });
    });

    it('显式 none + 残留 id：仍然是 none，残留项不得复活', () => {
        expect(resolveAirpCapabilityPolicy({ capabilityMode: 'none', capabilities: ['web_search'] }))
            .toEqual({ mode: 'none', allow: [] });
    });

    it('显式 allowlist + 空数组 = none（空白名单不等于全开）', () => {
        expect(resolveAirpCapabilityPolicy({ capabilityMode: 'allowlist', capabilities: [] }))
            .toEqual({ mode: 'none', allow: [] });
    });

    it('显式 all + 残留 id：按 all 处理并清掉白名单', () => {
        expect(resolveAirpCapabilityPolicy({ capabilityMode: 'all', capabilities: ['web_search'] }))
            .toEqual({ mode: 'all', allow: [] });
    });

    it('写回补丁把 mode 与数组一起写，二者永远同源', () => {
        const policy: AirpCapabilityPolicy = { mode: 'allowlist', allow: ['read_note'] };
        expect(capabilityPolicyPatch(policy)).toEqual({ capabilityMode: 'allowlist', capabilities: ['read_note'] });
        expect(capabilityPolicyPatch({ mode: 'none', allow: [] })).toEqual({ capabilityMode: 'none', capabilities: [] });
        expect(capabilityPolicyPatch({ mode: 'all', allow: [] })).toEqual({ capabilityMode: 'all', capabilities: [] });
    });
});

describe('mergeAirpSettings · 备份往返不丢 none', () => {
    it('旧数据（无 mode）保持旧形状：不多出 capabilityMode 字段', () => {
        const merged = mergeAirpSettings({ capabilities: [], writable: true });
        expect('capabilityMode' in merged).toBe(false);
        expect(merged.capabilities).toEqual([]);
    });

    it('显式 none 往返后仍是 none，不会因为数组为空被读成 all', () => {
        const merged = mergeAirpSettings({ capabilityMode: 'none', capabilities: [], writable: true });
        expect(merged.capabilityMode).toBe('none');
        expect(merged.capabilities).toEqual([]);
        expect(resolveAirpCapabilityPolicy(merged)).toEqual({ mode: 'none', allow: [] });
    });

    it('显式 allowlist 往返后仍是 allowlist', () => {
        const merged = mergeAirpSettings({ capabilityMode: 'allowlist', capabilities: ['read_note'] });
        expect(merged.capabilityMode).toBe('allowlist');
        expect(resolveAirpCapabilityPolicy(merged)).toEqual({ mode: 'allowlist', allow: ['read_note'] });
    });

    it('脏 mode + 残留 id 往返后按旧语义（allowlist）', () => {
        const merged = mergeAirpSettings({ capabilityMode: 'nope', capabilities: ['read_note'] });
        expect(merged.capabilityMode).toBeUndefined();
        expect(merged.capabilities).toEqual(['read_note']);
    });
});

describe('resolveCapabilities（运行时快照闸门）与前端同一契约', () => {
    it('旧空数组（无 mode）+ writable=false = 全部只读能力，写入项剔除', () => {
        const caps = resolveCapabilities(makeChar({ capabilities: [], writable: false }));
        expect(caps.map((cap) => cap.id)).toEqual(READ_IDS);
    });

    it('显式 none 即便 writable=true 也一个都不给', () => {
        const caps = resolveCapabilities(makeChar({ capabilityMode: 'none', capabilities: [], writable: true }));
        expect(caps).toEqual([]);
    });

    it('显式 allowlist 只保留白名单内，仍受 writable 闸门约束', () => {
        const allow = ['web_search', 'diary_write'];
        const caps = resolveCapabilities(makeChar({ capabilityMode: 'allowlist', capabilities: allow, writable: false }));
        expect(caps.map((cap) => cap.id)).toEqual(['web_search']);
    });

    it('allowlist 里混入目录外的 id 直接忽略', () => {
        const caps = resolveCapabilities(makeChar({ capabilityMode: 'allowlist', capabilities: ['ghost', 'read_note'], writable: true }));
        expect(caps.map((cap) => cap.id)).toEqual(['read_note']);
    });

    it('显式 all 与旧空数组结果一致（迁移前后行为不变）', () => {
        const legacy = resolveCapabilities(makeChar({ capabilities: [], writable: false }));
        const explicit = resolveCapabilities(makeChar({ capabilityMode: 'all', capabilities: [], writable: false }));
        expect(explicit.map((cap) => cap.id)).toEqual(legacy.map((cap) => cap.id));
        expect(LOW_WRITE_IDS.every((id) => !explicit.some((cap) => cap.id === id))).toBe(true);
    });
});
