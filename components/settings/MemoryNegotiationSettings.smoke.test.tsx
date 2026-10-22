// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import {
    MEMORY_NEGOTIATION_DEV_OVERRIDE_KEY,
    MEMORY_NEGOTIATION_STORAGE_KEY,
} from '../../utils/memoryNegotiation';

// React 18.3 把 act 挪到了 react 包；@types/react 还没跟上，这里按可选能力取一次。
const act = (React as unknown as { act: (cb: () => void) => void }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 设置页「记忆协商」卡片的最小渲染契约：
 * 开关落在记忆宫殿全局 config 的 featureFlags.epistemicState，说明写清
 * 自然确认 / 不强制问卷 / 短期不升级，默认关闭。
 */

const h = vi.hoisted(() => ({
    config: {
        embedding: { baseUrl: '', apiKey: '', model: '', dimensions: 1024 },
        lightLLM: { baseUrl: '', apiKey: '', model: '' },
        rerank: { enabled: false, baseUrl: '', apiKey: '', model: '', topN: 5 },
        featureFlags: {
            recallRouter: false,
            interactionAdaptation: false,
            deepEngagement: false,
            epistemicState: false,
        },
    },
    update: vi.fn(),
}));

vi.mock('../../context/OSContext', () => ({
    useOS: () => ({ memoryPalaceConfig: h.config, updateMemoryPalaceConfig: h.update }),
}));

import MemoryNegotiationSettings from './MemoryNegotiationSettings';

beforeEach(() => {
    localStorage.removeItem(MEMORY_NEGOTIATION_STORAGE_KEY);
    localStorage.removeItem(MEMORY_NEGOTIATION_DEV_OVERRIDE_KEY);
    h.update.mockClear();
    h.config.featureFlags.epistemicState = false;
});

describe('MemoryNegotiationSettings 渲染', () => {
    it('默认关闭，并说清自然确认 / 不强制问卷 / 短期不升级', () => {
        const html = renderToStaticMarkup(React.createElement(MemoryNegotiationSettings));
        expect(html).toContain('记忆协商');
        expect(html).toContain('自然确认');
        expect(html).toContain('不是问卷');
        expect(html).toContain('短期');
        expect(html).toContain('不升级');
        expect(html).toContain('默认关闭');
        expect(html).toContain('aria-checked="false"');
        expect(html).toContain('已关闭');
        // 说明里不能出现「填问卷 / 必须回答」这类强制口径
        expect(html).not.toContain('必须回答');
        // 不能把「问了」写成「已确认」：文案必须点明只有明确回答才算
        expect(html).toContain('问过 ≠ 已确认');
        expect(html).toContain('只有你明确回答');
        expect(html).not.toContain('已自动确认');
    });

    it('config 打开时开关显示已开启', () => {
        h.config.featureFlags.epistemicState = true;
        const html = renderToStaticMarkup(React.createElement(MemoryNegotiationSettings));
        expect(html).toContain('aria-checked="true"');
        expect(html).toContain('已开启');
        expect(html).toContain('epistemicState');
    });

    it('点击开关 → 写回 memoryPalaceConfig.featureFlags.epistemicState', () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        act(() => {
            root.render(React.createElement(MemoryNegotiationSettings));
        });
        const toggle = container.querySelector('[role="switch"]') as HTMLButtonElement;
        expect(toggle).toBeTruthy();
        act(() => {
            toggle.click();
        });
        expect(h.update).toHaveBeenCalledTimes(1);
        expect(h.update).toHaveBeenCalledWith({
            featureFlags: expect.objectContaining({ epistemicState: true }),
        });
        act(() => {
            root.unmount();
        });
        container.remove();
    });

    it('和此处冲突的旧调试值会被清掉，避免两层开关打架', () => {
        localStorage.setItem(MEMORY_NEGOTIATION_STORAGE_KEY, 'off');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        act(() => {
            root.render(React.createElement(MemoryNegotiationSettings));
        });
        act(() => {
            (container.querySelector('[role="switch"]') as HTMLButtonElement).click();
        });
        expect(localStorage.getItem(MEMORY_NEGOTIATION_STORAGE_KEY)).toBeNull();
        act(() => {
            root.unmount();
        });
        container.remove();
    });

    it('本机调试值压过开关时如实说明，而不是假装开关说了算', () => {
        h.config.featureFlags.epistemicState = true;
        localStorage.setItem(MEMORY_NEGOTIATION_DEV_OVERRIDE_KEY, 'off');
        const html = renderToStaticMarkup(React.createElement(MemoryNegotiationSettings));
        expect(html).toContain('本机调试值');
        expect(html).toContain('已关闭');
        expect(html).toContain('清除');
    });
});
