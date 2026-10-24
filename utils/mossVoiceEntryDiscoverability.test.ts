// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-10-24 用户反馈回归：「我没看到本机语音音色，也没看到可选的具体音色」。
 *
 * 现场结论：v3.22 的渲染没坏，坏在**入口**——两块 UI 都被 `genieVoiceEnabled === true`
 * 门控，而这个开关只存在于「设置 → 其他 API」这张**默认折叠**的卡片里；卡片里又写着
 * 语音只支持 MiniMax/鱼声/ElevenLabs，底部醒目的「当前语音引擎（三选一）」也没有本地语音，
 * 于是用户按指引找不到入口。另一条：目录探活失败被合并成「还没有可选音色」，不可区分。
 *
 * 这组用例锁死修复后的可发现性契约与探活错误分类（不再只锁 chunk 字符串）。
 */
describe('Settings · 本机语音入口可发现性', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/Settings.tsx'), 'utf8');

    it('折叠标题上带语音引擎徽标，折叠时也能看出用的是本地还是云端', () => {
        expect(source).toContain('语音：本地语音');
        expect(source).toContain('语音：云端');
        // 必须挂在「其他 API」这张 SettingsSection 上，而不是随便一个 span
        const idx = source.indexOf('title="其他 API"');
        expect(idx).toBeGreaterThan(-1);
        expect(source.slice(idx, idx + 700)).toContain('badge=');
    });

    it('开区文案点名本地语音，不再只说三家云端', () => {
        const idx = source.indexOf('语音生成支持');
        expect(idx).toBeGreaterThan(-1);
        const block = source.slice(idx, idx + 500);
        expect(block).toContain('本地语音');
        expect(block).toContain('MOSS-TTS-Nano');
    });

    it('底部引擎选择明确是「云端」，并指回本机语音入口', () => {
        expect(source).toContain('云端语音引擎（三选一）');
        expect(source).not.toContain('当前语音引擎（三选一）');
        const idx = source.indexOf('云端语音引擎（三选一）');
        expect(source.slice(idx, idx + 800)).toContain('本地语音（MOSS-TTS-Nano）');
    });

    it('把探活的 reachable / 失败原因传进选择器（空态才能分区）', () => {
        expect(source).toContain('reachable={localMossReachable}');
        expect(source).toContain('probeError={localMossError}');
        expect(source).toContain('setLocalMossReachable(probe.reachable)');
    });
});

describe('Character · 角色入口在云端 provider 下给出明确指引', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/Character.tsx'), 'utf8');

    it('非本地语音时提示去哪里开启，而不是什么都不显示', () => {
        expect(source).toContain('{!isMossProvider && (');
        const idx = source.indexOf('{!isMossProvider && (');
        const block = source.slice(idx, idx + 500);
        expect(block).toContain('设置');
        expect(block).toContain('本地语音（MOSS-TTS-Nano）');
    });

    it('选择器拿到探活状态与原因', () => {
        expect(source).toContain('reachable={mossCatalog.reachable}');
        expect(source).toContain('probeError={mossCatalog.error}');
    });
});

describe('probeMossVoiceStatus · 失败要给出可区分的原因', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        localStorage.clear();
    });

    async function probeWith(fetchImpl: typeof fetch, cfg: Record<string, string>) {
        localStorage.setItem('os_api_config', JSON.stringify(cfg));
        vi.stubGlobal('fetch', fetchImpl);
        const mod = await import('./genieTts');
        return mod.probeMossVoiceStatus();
    }

    it('403 时说「主代理拒绝了访问」，不回显地址或令牌', async () => {
        const probe = await probeWith(
            (async () => new Response('{"error":"unauthorized"}', { status: 403 })) as unknown as typeof fetch,
            { agentUrl: 'https://example.invalid/agent', agentToken: 'secret-token-value' },
        );
        expect(probe.reachable).toBe(false);
        expect(probe.error).toContain('主代理拒绝了访问');
        expect(JSON.stringify(probe)).not.toContain('secret-token-value');
        expect(JSON.stringify(probe)).not.toContain('example.invalid');
    });

    it('没填地址时走同源反代；同源返回的是静态网页就明说，不假装「没有音色」', async () => {
        const urls: string[] = [];
        const probe = await probeWith(
            (async (url: string) => {
                urls.push(String(url));
                // 静态站对未知路径的兜底：200 + text/html，不是健康数据
                return new Response('<!doctype html><title>x</title>', {
                    status: 200,
                    headers: { 'content-type': 'text/html; charset=utf-8' },
                });
            }) as unknown as typeof fetch,
            { agentUrl: '', agentToken: '' },
        );
        // 不再逼用户先去填地址：直接试同源（前端就托管在反代这台机器上）
        expect(urls[0]).toBe('/agent/v1/tts/health');
        expect(probe.reachable).toBe(false);
        expect(probe.error).toContain('网页');
    });

    it('网络层失败时说「连不上主代理」', async () => {
        const probe = await probeWith(
            (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch,
            { agentUrl: 'https://example.invalid/agent', agentToken: 't' },
        );
        expect(probe.reachable).toBe(false);
        expect(probe.error).toContain('连不上主代理');
    });
});
