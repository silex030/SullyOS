/**
 * 「你自己排着的事」提示段回归（发布阻断项 4）。
 *
 * 背景：取消工具要求 planId，而 id 只在 propose 回执里出现过一次。没有这一段，
 * 角色下一轮永远拿不到编号 —— 「角色能撤自己的安排」只是代码里有，对话里没有。
 */
import { describe, expect, it } from 'vitest';
import {
    PENDING_PLANS_PROMPT_MAX,
    buildPendingPlansBlock,
    isPlanCancelableInPrompt,
} from './pendingPlansPrompt';
import type { AutonomyWorkflowPlanRecord } from '../../types';

const NOW = Date.parse('2026-10-22T12:00:00.000Z');

const plan = (over: Partial<AutonomyWorkflowPlanRecord> = {}): AutonomyWorkflowPlanRecord => ({
    id: 'plan-abc',
    charId: 'c1',
    kind: 'diary',
    status: 'proposed',
    title: '写下今天的雨',
    purpose: '想记住窗外的声音',
    basis: 'virtual',
    source: 'chat_reply',
    sourceRef: 'chat:c1:m41',
    scheduledAt: NOW + 30 * 60_000,
    expiresAt: NOW + 24 * 3_600_000,
    createdAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
    ...over,
});

describe('你自己排着的事 · 渲染', () => {
    it('带服务端 id、标题与「可以撤」，且明确说别自己编编号', () => {
        const block = buildPendingPlansBlock({ plans: [plan()], nowMs: NOW });
        expect(block).toContain('编号 plan-abc');
        expect(block).toContain('写下今天的雨');
        expect(block).toContain('可以撤');
        expect(block).toContain('别自己编');
        expect(block).toContain('30 分钟后');
    });

    it('running 如实标「撤不了」，不假装能撤', () => {
        const block = buildPendingPlansBlock({
            plans: [plan({ id: 'plan-run', status: 'running', title: '正在写的日记' })],
            nowMs: NOW,
        });
        expect(block).toContain('正在做，撤不了');
        expect(block).not.toContain('可以撤');
        expect(isPlanCancelableInPrompt(plan({ status: 'running' }))).toBe(false);
    });

    it('取消成功 / 已完成 / 失败的记录不再出现在「还排着」里', () => {
        const block = buildPendingPlansBlock({
            plans: [
                plan({ id: 'p-cancelled', status: 'cancelled' }),
                plan({ id: 'p-completed', status: 'completed' }),
                plan({ id: 'p-failed', status: 'failed' }),
                plan({ id: 'p-unknown', status: 'unknown' }),
            ],
            nowMs: NOW,
        });
        expect(block).toBe('');
    });

    it('服务端回过「撤不了」的本地标记后，不再列成可撤项', () => {
        const block = buildPendingPlansBlock({
            plans: [plan({ id: 'p-stale', lastError: 'cannot-cancel' })],
            nowMs: NOW,
        });
        expect(block).toBe('');
    });

    it('已过期的安排不列（下一跳就会被服务端标失败）', () => {
        const block = buildPendingPlansBlock({
            plans: [plan({ id: 'p-expired', expiresAt: NOW - 1 })],
            nowMs: NOW,
        });
        expect(block).toBe('');
    });

    it('最多列 5 条，按排期先后', () => {
        const many = Array.from({ length: 8 }, (_, i) => plan({
            id: `p-${i}`,
            scheduledAt: NOW + (i + 1) * 60_000,
        }));
        const block = buildPendingPlansBlock({ plans: many, nowMs: NOW });
        expect(block.match(/编号 p-/g)).toHaveLength(PENDING_PLANS_PROMPT_MAX);
        expect(block.indexOf('p-0')).toBeLessThan(block.indexOf('p-4'));
        expect(block).not.toContain('p-5');
    });

    it('没有记录 → 空串（不占位、不留「暂无」）', () => {
        expect(buildPendingPlansBlock({ plans: [], nowMs: NOW })).toBe('');
        expect(buildPendingPlansBlock({ plans: null as any, nowMs: NOW })).toBe('');
    });
});
