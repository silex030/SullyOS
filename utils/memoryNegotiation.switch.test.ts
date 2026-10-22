import { describe, it, expect, beforeEach } from 'vitest';
import {
    MEMORY_NEGOTIATION_STORAGE_KEY,
    MEMORY_NEGOTIATION_DEV_OVERRIDE_KEY,
    MEMORY_NEGOTIATION_CONFIG_STORAGE_KEY,
    getMemoryNegotiationGate,
    isMemoryNegotiationEnabled,
    resolveMemoryNegotiationEnabled,
} from './memoryNegotiation';

/**
 * 开关读取段：正式开关是记忆宫殿的全局 config
 * （os_memory_palace_config.featureFlags.epistemicState），和后台数据闭环读同一个值。
 * 约定：旧备份缺字段 → 关；调试 localkey 仍兼容，但「明确关闭」优先。
 */

const writeConfig = (featureFlags?: Record<string, unknown>) => {
    localStorage.setItem(
        MEMORY_NEGOTIATION_CONFIG_STORAGE_KEY,
        JSON.stringify({ embedding: {}, lightLLM: {}, rerank: {}, ...(featureFlags ? { featureFlags } : {}) }),
    );
};

beforeEach(() => {
    localStorage.removeItem(MEMORY_NEGOTIATION_STORAGE_KEY);
    localStorage.removeItem(MEMORY_NEGOTIATION_DEV_OVERRIDE_KEY);
    localStorage.removeItem(MEMORY_NEGOTIATION_CONFIG_STORAGE_KEY);
});

describe('记忆协商开关 —— 读正式 config', () => {
    it('旧备份没有 config / 没有 epistemicState → 默认关闭', () => {
        expect(isMemoryNegotiationEnabled()).toBe(false);
        writeConfig({ recallRouter: true });
        expect(isMemoryNegotiationEnabled()).toBe(false);
        expect(getMemoryNegotiationGate().source).toBe('default_off');
    });

    it('config 明确打开 → 开；明确关闭 → 关', () => {
        writeConfig({ epistemicState: true });
        expect(isMemoryNegotiationEnabled()).toBe(true);
        expect(getMemoryNegotiationGate()).toEqual({ enabled: true, source: 'config' });

        writeConfig({ epistemicState: false });
        expect(isMemoryNegotiationEnabled()).toBe(false);
        expect(getMemoryNegotiationGate()).toEqual({ enabled: false, source: 'config' });
    });

    it('config JSON 损坏 / 值不是布尔 → 按关闭处理，不抛异常', () => {
        localStorage.setItem(MEMORY_NEGOTIATION_CONFIG_STORAGE_KEY, '{not json');
        expect(isMemoryNegotiationEnabled()).toBe(false);
        expect(getMemoryNegotiationGate()).toEqual({ enabled: false, source: 'config_unreadable' });
        writeConfig({ epistemicState: 'yes' });
        expect(isMemoryNegotiationEnabled()).toBe(false);
        expect(getMemoryNegotiationGate()).toEqual({ enabled: false, source: 'config_unreadable' });
    });

    it('config 读坏时不再回落到旧 localkey —— 读不出来 ≠ 缺字段，宁可关着', () => {
        localStorage.setItem(MEMORY_NEGOTIATION_CONFIG_STORAGE_KEY, '{not json');
        localStorage.setItem(MEMORY_NEGOTIATION_STORAGE_KEY, 'on');
        expect(isMemoryNegotiationEnabled()).toBe(false);
        expect(getMemoryNegotiationGate().source).toBe('config_unreadable');
    });

    it('旧调试 localkey 只在正式 config 确实缺这个字段时才生效', () => {
        localStorage.setItem(MEMORY_NEGOTIATION_STORAGE_KEY, 'on');
        // 记忆宫殿配置存在、但 featureFlags 里没有 epistemicState（旧备份 / 老版本）
        writeConfig({ recallRouter: true });
        expect(isMemoryNegotiationEnabled()).toBe(true);
        expect(getMemoryNegotiationGate().source).toBe('legacy_key');

        // 正式字段一出现（明确关闭）就压过旧 key
        writeConfig({ recallRouter: true, epistemicState: false });
        expect(isMemoryNegotiationEnabled()).toBe(false);
        expect(getMemoryNegotiationGate()).toEqual({ enabled: false, source: 'config' });
    });

    it('旧调试 localkey 在没有正式 config 记录时仍然兼容（升级前的调试值）', () => {
        localStorage.setItem(MEMORY_NEGOTIATION_STORAGE_KEY, '1');
        expect(isMemoryNegotiationEnabled()).toBe(true);
        expect(getMemoryNegotiationGate().source).toBe('legacy_key');
    });

    it('正式 config 的「明确关闭」优先于旧调试 key 的 on', () => {
        writeConfig({ epistemicState: false });
        localStorage.setItem(MEMORY_NEGOTIATION_STORAGE_KEY, 'on');
        expect(isMemoryNegotiationEnabled()).toBe(false);
    });

    it('调试覆盖显式 on/off 优先：off 能压住 config 打开，on 能临时打开', () => {
        writeConfig({ epistemicState: true });
        localStorage.setItem(MEMORY_NEGOTIATION_DEV_OVERRIDE_KEY, 'off');
        expect(isMemoryNegotiationEnabled()).toBe(false);
        expect(getMemoryNegotiationGate()).toEqual({ enabled: false, source: 'dev_override' });

        writeConfig({ epistemicState: false });
        localStorage.setItem(MEMORY_NEGOTIATION_DEV_OVERRIDE_KEY, 'on');
        expect(isMemoryNegotiationEnabled()).toBe(true);
        expect(getMemoryNegotiationGate()).toEqual({ enabled: true, source: 'dev_override' });
    });

    it('无关的调试值（如空串 / 乱写）不改变正式开关', () => {
        writeConfig({ epistemicState: true });
        localStorage.setItem(MEMORY_NEGOTIATION_DEV_OVERRIDE_KEY, 'maybe');
        expect(isMemoryNegotiationEnabled()).toBe(true);
        expect(getMemoryNegotiationGate().source).toBe('config');
    });

    it('组装提示词时的开关：正式 config 明确关闭压过调用方传来的 explicit=true 与旧 key', () => {
        writeConfig({ epistemicState: false });
        localStorage.setItem(MEMORY_NEGOTIATION_STORAGE_KEY, 'on');
        expect(resolveMemoryNegotiationEnabled(true)).toBe(false);
        expect(resolveMemoryNegotiationEnabled(undefined)).toBe(false);
    });

    it('组装提示词时的开关：config 缺字段时 explicit=false 就是关，explicit=true 才临时开', () => {
        localStorage.setItem(MEMORY_NEGOTIATION_STORAGE_KEY, 'on');
        expect(resolveMemoryNegotiationEnabled(false)).toBe(false);
        expect(resolveMemoryNegotiationEnabled(true)).toBe(true);
        expect(resolveMemoryNegotiationEnabled(undefined)).toBe(true);
    });

    it('config 读坏时 resolve 也按关，不接受 explicit=true', () => {
        localStorage.setItem(MEMORY_NEGOTIATION_CONFIG_STORAGE_KEY, '{not json');
        expect(resolveMemoryNegotiationEnabled(true)).toBe(false);
    });
});
