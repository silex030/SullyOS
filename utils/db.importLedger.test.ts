/**
 * 备份导入后清空记忆协商账本（发布阻断项 2）。
 *
 * 账本在 localStorage（`mp_negotiation_v1_<charId>`），**不进备份包**，导入也不会清它。
 * 换了一份数据之后，旧候选还留着旧库里的消息 id，会绑到新数据的消息上（id 撞车）。
 *
 * 这条路径有**两个入口**，都必须清：
 *   1. OSContext 的 importSystem 成功收尾（用户点「恢复」走的那条）；
 *   2. utils/db.ts 的 importFullData（独立导入路径，别的调用方/测试直接用这条）。
 *
 * 这里钉住的是「真的清了」与「幂等 / 清了不会让导入失败」，不是只看源码里有没有那行字。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DB } from './db';
import { ledgerStorageKey, saveNegotiationLedger, emptyNegotiationLedger } from './memoryPalace/negotiationLedger';

const CHAR_ID = 'char-import-ledger';
const KEY = ledgerStorageKey(CHAR_ID);

const seedLedger = () => {
    const ledger = emptyNegotiationLedger(CHAR_ID, 1_700_000_000_000);
    ledger.candidates = [{
        id: 'cand-1',
        charId: CHAR_ID,
        claim: '用户喜欢在雨天读书',
        subject: { kind: 'user' },
        topicId: 'topic-1',
        evidence: 'char_guess',
        durability: 'unknown',
        sourceMessageIds: [41],
        state: 'pending',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        attempts: [],
    } as any];
    saveNegotiationLedger(ledger);
    localStorage.setItem(KEY, JSON.stringify(ledger));
    return ledger;
};

describe('备份导入 · 清空旧记忆协商账本', () => {
    beforeEach(() => {
        localStorage.removeItem(KEY);
    });

    it('importFullData 成功后账本被清掉（旧消息 id 不再残留）', async () => {
        seedLedger();
        expect(localStorage.getItem(KEY)).not.toBeNull();

        await DB.importFullData({ characters: [], messages: [] } as any, {});

        expect(localStorage.getItem(KEY)).toBeNull();
    });

    it('幂等：账本本来就空时导入照样成功', async () => {
        await expect(DB.importFullData({ characters: [], messages: [] } as any, {})).resolves.toBeUndefined();
        await expect(DB.importFullData({ characters: [], messages: [] } as any, {})).resolves.toBeUndefined();
    });
});

describe('备份导入 · 两个入口都接线（源码级回归）', () => {
    const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');

    it('OSContext importSystem 成功收尾会清账本，且失败不当成清掉了', () => {
        const src = read('../context/OSContext.tsx');
        const clearAt = src.indexOf('clearAllNegotiationLedgers');
        expect(clearAt).toBeGreaterThan(-1);
        // 在「恢复成功」提示之前、导入进度收尾之后
        const commitAt = src.indexOf('clearImportInProgress();');
        const toastAt = src.indexOf('恢复成功，系统即将重启');
        expect(commitAt).toBeGreaterThan(-1);
        expect(clearAt).toBeGreaterThan(commitAt);
        expect(clearAt).toBeLessThan(toastAt);
        // 失败时单独说一句，不是静默当作清干净了
        expect(src).toContain('旧候选可能误绑到新消息');
        expect(src).toContain('ledgerCleared = false');
    });

    it('db.importFullData 自己也会清（独立导入路径不依赖 OSContext）', () => {
        const src = read('./db.ts');
        const fnAt = src.indexOf('importFullData: async (');
        expect(fnAt).toBeGreaterThan(-1);
        const tail = src.slice(fnAt, fnAt + 60_000);
        expect(tail).toContain('clearAllNegotiationLedgers');
    });
});
