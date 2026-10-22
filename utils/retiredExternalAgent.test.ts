import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DB } from './db';
import {
    RETIRED_EXTERNAL_AGENT_KEY_PREFIX,
    retireExternalAgentStorage,
} from './retiredExternalAgent';

/**
 * 外部 agent 桥（终端 App / opencode 遥控）整块退役后的启动期清理。
 *
 * 代码删干净了，但浏览器里可能还留着旧连接记录（`aetheros.opencode.connection`
 * 里是明文 Basic 密码），旧备份包里也可能带着 `opencodeLocal`。这里锁死三件事：
 *   1. 只删该前缀的键，别的设置一个都不动（绝不 clear()）；
 *   2. 幂等、localStorage 不可用也不阻断启动；
 *   3. 旧备份里的退役字段被静默忽略，不回写、不报错。
 */

const ls = (): Storage => globalThis.localStorage as unknown as Storage;

describe('retiredExternalAgent · 启动期一次性清理', () => {
    beforeEach(() => { ls().clear(); });
    afterEach(() => { ls().clear(); });

    it('删掉旧终端连接键（含 Basic 密码）并返回清掉的键数', () => {
        ls().setItem(RETIRED_EXTERNAL_AGENT_KEY_PREFIX + 'connection', JSON.stringify({
            host: 'http://127.0.0.1:4096',
            username: 'opencode',
            password: 'pw-should-not-survive',
        }));

        expect(retireExternalAgentStorage(ls())).toBe(1);
        expect(ls().getItem(RETIRED_EXTERNAL_AGENT_KEY_PREFIX + 'connection')).toBeNull();
        expect(ls().length).toBe(0);
    });

    it('同前缀的历史残留一并清掉（不止那一个键）', () => {
        ls().setItem('aetheros.opencode.connection', '{}');
        ls().setItem('aetheros.opencode.connection.lastProject', 'p1');

        expect(retireExternalAgentStorage(ls())).toBe(2);
        expect(ls().length).toBe(0);
    });

    it('只清退役前缀：用户其它设置与同词不同前缀的键都保留', () => {
        ls().setItem('aetheros.opencode.connection', '{}');
        // 没有点的同词键不属于退役前缀（防误伤）
        ls().setItem('aetheros.opencodeXyz', 'keep-open');
        // 用户其它真实设置
        ls().setItem('aetheros.google.refresh', 'keep-google');
        ls().setItem('aetheros.theme', '{"launcherDockOrder":["terminal"]}');
        ls().setItem('unrelated', 'keep-misc');

        expect(retireExternalAgentStorage(ls())).toBe(1);
        expect(ls().getItem('aetheros.opencodeXyz')).toBe('keep-open');
        expect(ls().getItem('aetheros.google.refresh')).toBe('keep-google');
        expect(ls().getItem('aetheros.theme')).toBe('{"launcherDockOrder":["terminal"]}');
        expect(ls().getItem('unrelated')).toBe('keep-misc');
    });

    it('幂等：清过一次后再启动无事可做', () => {
        ls().setItem('aetheros.opencode.connection', '{}');
        expect(retireExternalAgentStorage(ls())).toBe(1);
        expect(retireExternalAgentStorage(ls())).toBe(0);
    });

    it('无残留时不写日志、返回 0', () => {
        ls().setItem('aetheros.theme', '{}');
        expect(retireExternalAgentStorage(ls())).toBe(0);
        expect(ls().getItem('aetheros.theme')).toBe('{}');
    });

    it('localStorage 不可用/抛错（隐私模式、沙箱 iframe）时静默返回，不阻断启动', () => {
        const denied = {
            length: 1,
            key(): string { throw new Error('SecurityError: storage denied'); },
            getItem(): null { return null; },
            setItem(): void { throw new Error('SecurityError'); },
            removeItem(): void { throw new Error('SecurityError'); },
            clear(): void { throw new Error('SecurityError'); },
        } as unknown as Storage;

        expect(() => retireExternalAgentStorage(denied)).not.toThrow();
        expect(retireExternalAgentStorage(denied)).toBe(0);
        expect(() => retireExternalAgentStorage(null)).not.toThrow();
        expect(retireExternalAgentStorage(null)).toBe(0);
    });
});

describe('retiredExternalAgent · 备份兼容', () => {
    beforeEach(() => { ls().clear(); });
    afterEach(() => { ls().clear(); });

    it('导出不再带 opencodeLocal 字段', async () => {
        const exported = await DB.exportFullData();
        expect('opencodeLocal' in (exported as Record<string, unknown>)).toBe(false);
    });

    it('旧备份包里的 opencodeLocal 被静默忽略：导入不报错、不写回 localStorage', async () => {
        const exported = await DB.exportFullData();
        const legacyPacket = {
            ...exported,
            // 退役前的字段：旧包仍可能带地址 + 空密码（backupSecrets 只清值）
            opencodeLocal: { host: 'http://192.168.1.5:4096', username: 'opencode', password: '' },
        };

        await expect(DB.importFullData(legacyPacket as any)).resolves.not.toThrow();
        expect(ls().getItem(RETIRED_EXTERNAL_AGENT_KEY_PREFIX + 'connection')).toBeNull();
    });
});

describe('退役残留 · 不再留下坏自启注册', () => {
    const scriptsDir = path.join(__dirname, '..', 'scripts');

    it('opencode 自启脚本已删除（它会注册指向已删 opencode-proxy.mjs 的登录任务）', () => {
        expect(fs.existsSync(path.join(scriptsDir, 'opencode-autostart-win.ps1'))).toBe(false);
        expect(fs.existsSync(path.join(scriptsDir, 'opencode-proxy.mjs'))).toBe(false);
    });

    it('scripts/ 下没有任何可执行文件再引用已删的 opencode-proxy', () => {
        const offenders = fs.readdirSync(scriptsDir)
            .filter((name) => /\.(mjs|cjs|js|ps1|sh|cmd|bat)$/i.test(name))
            .filter((name) => fs.readFileSync(path.join(scriptsDir, name), 'utf8').includes('opencode-proxy'));
        expect(offenders).toEqual([]);
    });

    it('保留 opencode.ai 作为聊天供应商（退役的只是外部 agent 桥）', () => {
        const identity = fs.readFileSync(path.join(__dirname, '..', 'utils', 'llmIdentity.ts'), 'utf8');
        expect(identity).toContain('x-opencode-session');
    });
});
