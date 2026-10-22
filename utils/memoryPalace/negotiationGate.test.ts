/**
 * 记忆协商开关「一把尺」回归（发布阻断项 1）。
 *
 * 后台（`memoryPalace/negotiation.ts`）以前自己实现了一套开关顺序：
 * dev > 旧 localkey > featureFlags.epistemicState，跟前台/设置页相反。
 * 结果：设置页关掉 + 残留旧 key → 前台关、后台仍开，而设置页文案说的是同一个字段。
 *
 * 这里钉住三件事：
 *   1. 后台与前台读同一个 gate（正式 config 的 false 高于旧 localkey）；
 *   2. config 读坏按关，且**不**回落旧 key；
 *   3. `resolveMemoryNegotiationEnabled(explicit)` 的 explicit 不能把正式 config 的
 *      false / 读坏拉起来（安全开关语义），同时不引入循环 import。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    describeNegotiationGate as describeBackstageGate,
    isMemoryNegotiationEnabled as isBackstageEnabled,
} from './negotiation';
import {
    getMemoryNegotiationGate,
    resolveMemoryNegotiationEnabled,
} from '../memoryNegotiation';

const CONFIG_KEY = 'os_memory_palace_config';
const LEGACY_KEY = 'sullyos.memoryNegotiation.v1';
const DEV_KEY = 'mp_negotiation_dev';

const reset = () => {
    localStorage.removeItem(CONFIG_KEY);
    localStorage.removeItem(LEGACY_KEY);
    localStorage.removeItem(DEV_KEY);
};

describe('记忆协商开关 · 前后台同一把尺', () => {
    beforeEach(reset);

    it('正式 config 明确关闭压过旧 localkey（后台也跟着关）', () => {
        localStorage.setItem(LEGACY_KEY, 'true');
        localStorage.setItem(CONFIG_KEY, JSON.stringify({ featureFlags: { epistemicState: false } }));

        expect(getMemoryNegotiationGate()).toEqual({ enabled: false, source: 'config' });
        expect(isBackstageEnabled()).toBe(false);
        expect(describeBackstageGate()).toEqual({ enabled: false, source: 'feature_flag' });
    });

    it('正式 config 缺字段时才兼容旧 localkey', () => {
        localStorage.setItem(LEGACY_KEY, 'true');

        expect(getMemoryNegotiationGate()).toEqual({ enabled: true, source: 'legacy_key' });
        expect(isBackstageEnabled()).toBe(true);
        expect(describeBackstageGate()).toEqual({ enabled: true, source: 'feature_flag' });
    });

    it('config 读坏按关，且不回落旧 key', () => {
        localStorage.setItem(LEGACY_KEY, 'true');
        localStorage.setItem(CONFIG_KEY, '{ not json');

        expect(getMemoryNegotiationGate()).toEqual({ enabled: false, source: 'config_unreadable' });
        expect(isBackstageEnabled()).toBe(false);
        // 读坏不许说成「开关开着」
        expect(describeBackstageGate()).toEqual({ enabled: false, source: 'default_off' });
    });

    it('字段存在但不是布尔也算读坏（不当成缺字段）', () => {
        localStorage.setItem(LEGACY_KEY, 'true');
        localStorage.setItem(CONFIG_KEY, JSON.stringify({ featureFlags: { epistemicState: 'yes' } }));

        expect(getMemoryNegotiationGate().source).toBe('config_unreadable');
        expect(isBackstageEnabled()).toBe(false);
    });

    it('本机调试值仍然压过正式 config（dev override 语义保留）', () => {
        localStorage.setItem(CONFIG_KEY, JSON.stringify({ featureFlags: { epistemicState: true } }));
        localStorage.setItem(DEV_KEY, 'off');
        expect(isBackstageEnabled()).toBe(false);
        expect(describeBackstageGate()).toEqual({ enabled: false, source: 'dev_override' });

        localStorage.setItem(DEV_KEY, 'on');
        expect(isBackstageEnabled()).toBe(true);
        expect(describeBackstageGate()).toEqual({ enabled: true, source: 'dev_override' });
    });

    it('默认关闭（升级后行为不突变）', () => {
        expect(isBackstageEnabled()).toBe(false);
        expect(describeBackstageGate()).toEqual({ enabled: false, source: 'default_off' });
    });
});

describe('记忆协商开关 · explicit 参数的安全语义', () => {
    beforeEach(reset);

    it('正式 config 明确关闭时 explicit=true 也拉不起来', () => {
        localStorage.setItem(CONFIG_KEY, JSON.stringify({ featureFlags: { epistemicState: false } }));
        expect(resolveMemoryNegotiationEnabled(true)).toBe(false);
    });

    it('config 读坏时 explicit=true 同样被拒', () => {
        localStorage.setItem(CONFIG_KEY, '{ broken');
        expect(resolveMemoryNegotiationEnabled(true)).toBe(false);
    });

    it('config 开着时 explicit=false 仍是真的关', () => {
        localStorage.setItem(CONFIG_KEY, JSON.stringify({ featureFlags: { epistemicState: true } }));
        expect(resolveMemoryNegotiationEnabled(false)).toBe(false);
    });

    it('没有 explicit 时按 gate；缺字段且无 explicit 仍按默认关', () => {
        expect(resolveMemoryNegotiationEnabled()).toBe(false);
        localStorage.setItem(CONFIG_KEY, JSON.stringify({ featureFlags: { epistemicState: true } }));
        expect(resolveMemoryNegotiationEnabled()).toBe(true);
    });
});

describe('记忆协商开关 · 不引入循环 import', () => {
    const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');

    it('前台叶子不 import memoryPalace（依赖只会单向）', () => {
        const front = read('../memoryNegotiation.ts');
        // 注释里提到模块名没关系，真正要紧的是没有任何 import（尤其不许 import memoryPalace/**）。
        const importLines = front.split('\n').filter((line) => /^import\s/.test(line));
        expect(importLines).toHaveLength(0);
        expect(importLines.join('\n')).not.toContain('memoryPalace');
    });

    it('后台只从前台叶子拿 gate，不再自己读 featureFlags 快照', () => {
        const backstage = read('./negotiation.ts');
        expect(backstage).toContain("from '../../utils/memoryNegotiation'");
        expect(backstage).not.toContain('readRecallRuntimeSnapshot');
        expect(backstage).not.toContain('sullyos.memoryNegotiation.v1');
    });
});
