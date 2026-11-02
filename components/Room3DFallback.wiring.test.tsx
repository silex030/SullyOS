// @vitest-environment jsdom
/**
 * Room3DHome 接线冒烟（降级路径）：生产永远不传 forceFallback，
 * 这里只验证接线 props 编译通过 + WebGL 不可用时 fallback2D 插槽如实渲染、
 * 且绝不递归嵌套整个 RoomApp。
 */
import { describe, expect, it } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Room3DHome } from '../features/room3d/Room3DHome';
import { resolveChibiMarker } from '../features/room3d/chibiAdapter';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class MemStore {
    private m = new Map<string, string>();
    getItem(k: string): string | null {
        return this.m.has(k) ? this.m.get(k)! : null;
    }
    setItem(k: string, v: string): void {
        this.m.set(k, String(v));
    }
    removeItem(k: string): void {
        this.m.delete(k);
    }
}

describe('Room3DHome 接线 fallback', () => {
    it('WebGL 不可用时渲染传入的 fallback2D（返回 2D 小窝按钮），不自嵌套 RoomApp', () => {
        const storage = new MemStore();
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        act(() => {
            root.render(
                <Room3DHome
                    charId="charT"
                    storage={storage}
                    chibi={resolveChibiMarker({})}
                    forceFallback
                    fallback2D={<button type="button">返回 2D 小窝</button>}
                />,
            );
        });
        expect(container.textContent).toContain('3D 家园暂不可用');
        expect(container.textContent).toContain('返回 2D 小窝');
        // 降级面板里只有调用方给的轻按钮，没有整个 2D 房间视图
        expect(container.querySelectorAll('canvas').length).toBe(0);
        act(() => {
            root.unmount();
        });
        container.remove();
    });

    it('chibi 只读映射：无 Q 版字段时明确 fallback2d，不伪称 avatar 齐全', () => {
        expect(resolveChibiMarker({})).toMatchObject({ kind: 'fallback2d' });
        expect(resolveChibiMarker(null)).toMatchObject({ kind: 'fallback2d' });
    });
});
