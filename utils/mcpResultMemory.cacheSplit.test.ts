import { describe, it, expect, beforeEach } from 'vitest';
import {
    recordMcpResult,
    bumpMcpTurn,
    getMcpResultMemoryBlock,
    getMcpResultMemoryParts,
    getMcpResultList,
    clearMcpResults,
} from './mcpResultMemory';

// C7：MCP 调用记忆拆成两段——近期窗口每轮都变（→ 易变尾段），
// 长期手册变化极慢（→ 留在稳定前缀）。信息一条都不能少，旧接口照旧可用。

const CHAR = 'char-mcp-split';
const KEEP = 3;

const server = { id: 'srv-1', name: '笔记台' };

const pushResult = (toolName: string, turnId: number, data: any, persistMode?: 'auto' | 'always' | 'never') => {
    recordMcpResult({
        charId: CHAR,
        server: { ...server, ...(persistMode ? { persistMode } : {}) },
        toolName,
        args: { q: toolName },
        result: { success: true, data },
        turnId,
        keepTurns: KEEP,
    });
};

beforeEach(() => {
    clearMcpResults(CHAR, 'all');
});

describe('getMcpResultMemoryParts —— 近期进动态、手册留稳定', () => {
    it('只有近期结果时：dynamic 有内容，stable 为空', () => {
        const turn = bumpMcpTurn(CHAR);
        pushResult('搜索', turn, '三条搜索结果');
        const parts = getMcpResultMemoryParts(CHAR, KEEP);
        expect(parts.dynamic).toContain('三条搜索结果');
        expect(parts.dynamic).toContain('最近几轮');
        expect(parts.stable).toBe('');
    });

    it('只有长期手册（超出手册关键词判定之外，用 persistMode=always）时：stable 有原文', () => {
        const turn = bumpMcpTurn(CHAR);
        pushResult('查询', turn, '手册原文内容 ABC', 'always');
        const parts = getMcpResultMemoryParts(CHAR, KEEP);
        expect(parts.stable).toContain('手册原文内容 ABC');
        expect(parts.stable).toContain('长期工具手册');
        expect(parts.dynamic).toBe('');
    });

    it('两段同时存在时各归各位，且合起来与旧整块信息一致', () => {
        const turn = bumpMcpTurn(CHAR);
        pushResult('查询', turn, '手册原文内容 ABC', 'always');
        pushResult('搜索', turn, '三条搜索结果');

        const parts = getMcpResultMemoryParts(CHAR, KEEP);
        expect(parts.stable).toContain('手册原文内容 ABC');
        expect(parts.stable).not.toContain('三条搜索结果');
        expect(parts.dynamic).toContain('三条搜索结果');
        expect(parts.dynamic).not.toContain('手册原文内容 ABC');

        // 旧接口保留：两段都还在，只是拼在一起
        const legacy = getMcpResultMemoryBlock(CHAR, KEEP);
        expect(legacy).toContain('三条搜索结果');
        expect(legacy).toContain('手册原文内容 ABC');
        expect(legacy.startsWith('\n---\n')).toBe(true);
        expect(legacy.trimEnd().endsWith('---')).toBe(true);
    });

    it('keepTurns=0：只剩手册类，dynamic 为空', () => {
        const turn = bumpMcpTurn(CHAR);
        pushResult('搜索', turn, '三条搜索结果');
        pushResult('查询', turn, '手册原文内容 ABC', 'always');
        const parts = getMcpResultMemoryParts(CHAR, 0);
        expect(parts.dynamic).toBe('');
        expect(parts.stable).toContain('手册原文内容 ABC');
    });

    it('窗口滑过后近期条目不再注入，手册仍在（与旧行为一致）', () => {
        const t1 = bumpMcpTurn(CHAR);
        pushResult('搜索', t1, '老结果');
        pushResult('查询', t1, '手册原文内容 ABC', 'always');
        for (let i = 0; i < KEEP + 2; i += 1) bumpMcpTurn(CHAR);
        const parts = getMcpResultMemoryParts(CHAR, KEEP);
        expect(parts.dynamic).toBe('');
        expect(parts.stable).toContain('手册原文内容 ABC');
        // 窗口是读取时过滤的：没到下一次 recordMcpResult 之前，底层条目还在（旧行为不变）
        expect(getMcpResultList(CHAR).some(e => e.resultSummary.includes('老结果'))).toBe(true);
    });

    it('无任何记录时两段都为空', () => {
        const parts = getMcpResultMemoryParts(CHAR, KEEP);
        expect(parts).toEqual({ stable: '', dynamic: '' });
    });
});
