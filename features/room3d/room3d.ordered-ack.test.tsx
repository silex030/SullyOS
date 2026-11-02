// @vitest-environment jsdom
/**
 * room3d · ordered-ack-closeout (本轮单调持久化确认栅栏)
 * - review267 精确复现：锁内已写完仅延迟投递，较新保存后旧 ack 返回，
 *   再加第 9 件/移动后保存不断言 notice 而断言 items 数量与坐标、无自造 conflict。
 * - 旧 saved / 旧 conflict 参数化覆盖。
 * - 保存完成前本地编辑：旧 ack 不覆盖新布局，但下一次保存用正确基线成功
 *  （防“一刀丢掉全部旧 ack”断链）。
 * - 代次边界最小检查：跨槽旧 ack 不得污染新槽 rev。
 */
import { describe, expect, it, vi, beforeAll } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { CrossDocMutex } from './mutex';
import { SharedMemoryMutex } from './mutex';
import { createRoom3DStore, type StorageLike } from './storage';
import { room3DStorageKey } from './types';
import { resolveChibiMarker } from './chibiAdapter';

vi.mock('three', () => {
  class Obj {
    children: unknown[] = [];
    position = { x: 0, y: 0, z: 0, set(x: number, y: number, z: number): void { this.x = x; this.y = y; this.z = z; } };
    rotation = { y: 0 };
    scale = { setScalar(): void {} };
    userData: Record<string, unknown> = {};
    add(...os: unknown[]): void { this.children.push(...os); }
    remove(o: unknown): void { this.children = this.children.filter((c) => c !== o); }
    traverse(fn: (o: unknown) => void): void { fn(this); for (const c of this.children) (c as Obj).traverse(fn); }
  }
  class Disposable { dispose(): void {} }
  class Mesh extends Obj {
    material: unknown; geometry: unknown;
    constructor(geometry: unknown, material: unknown) { super(); this.geometry = geometry; this.material = material; }
  }
  class Material extends Disposable {
    emissive = { getHex(): number { return 0; }, set(): void {} };
    emissiveIntensity = 0;
  }
  class Light extends Obj {}
  class Camera extends Obj { aspect = 1; updateProjectionMatrix(): void {} lookAt(): void {} }
  return {
    WebGLRenderer: class extends Disposable { constructor(_opts: unknown) { super(); } setPixelRatio(): void {} setSize(): void {} render(): void {} forceContextLoss(): void {} },
    Scene: class extends Obj { background: unknown = null; },
    Color: class { value: unknown; constructor(value: unknown) { this.value = value; } },
    PerspectiveCamera: Camera,
    HemisphereLight: class extends Light { constructor(..._args: unknown[]) { super(); } },
    DirectionalLight: class extends Light { constructor(..._args: unknown[]) { super(); } },
    PlaneGeometry: Disposable, BoxGeometry: Disposable, CylinderGeometry: Disposable,
    SphereGeometry: Disposable, ConeGeometry: Disposable,
    Mesh, MeshStandardMaterial: Material,
    GridHelper: class extends Obj { geometry = new Disposable(); material = new Disposable(); constructor(..._args: unknown[]) { super(); } },
    Group: Obj,
    PointLight: class extends Light { constructor(..._args: unknown[]) { super(); } },
    Raycaster: class { ray = { intersectObjects: (): unknown[] => [], intersectPlane: (): null => null }; setFromCamera(): void {} },
    Vector2: class { x = 0; y = 0; },
    Vector3: class { x = 0; y = 0; z = 0; constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } set(x: number, y: number, z: number): void { this.x = x; this.y = y; this.z = z; } },
    Plane: class { constructor(..._args: unknown[]) {} },
    TextureLoader: class { load(): void {} },
    Sprite: Obj, SpriteMaterial: Disposable, SRGBColorSpace: 'srgb',
  };
});

(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const { Room3DHome } = await import('./Room3DHome');

function memStorage(): StorageLike {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
  };
}

/** 延迟投递锁：fn 立即执行（盘已写），结果延迟投递。 */
class DelayedMutex implements CrossDocMutex {
  readonly kind = 'delay-delivery-test';
  delayNext = false;
  private opener: (() => void) | null = null;
  async withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    void key;
    const res = await fn();
    if (this.delayNext) {
      this.delayNext = false;
      await new Promise<void>((r) => {
        this.opener = r;
      });
    }
    return res;
  }
  open(): void {
    const o = this.opener;
    this.opener = null;
    o?.();
  }
}

/** 入口门闩锁（保留作文档：旧保存卡在锁外时制造 conflict 结果的门闩模式）。
 * 本轮 conflict 参数化改用“胜出 tab 先写 + 延迟投递旧保存”的真实时序，
 * 不再需要门闩；此类保留仅供后续用例复用。 */
class GateMutex implements CrossDocMutex {
  readonly kind = 'gate-test';
  private tail: Promise<void> = Promise.resolve();
  gateNext = false;
  private opener: (() => void) | null = null;
  async withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    void key;
    const prev = this.tail;
    let release!: () => void;
    const cur = new Promise<void>((res) => {
      release = res;
    });
    this.tail = prev.then(() => cur);
    await prev;
    if (this.gateNext) {
      this.gateNext = false;
      await new Promise<void>((res) => {
        this.opener = res;
      });
    }
    try {
      return await fn();
    } finally {
      release();
    }
  }
  open(): void {
    const o = this.opener;
    this.opener = null;
    o?.();
  }
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

const chibi = resolveChibiMarker(null);

beforeAll(() => {
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'getContext', {
    value: () => ({}),
    configurable: true,
  });
  Object.defineProperty(window, 'matchMedia', {
    value: () => ({ matches: false, addEventListener: (): void => {}, removeEventListener: (): void => {} }),
    configurable: true,
  });
  (globalThis as unknown as Record<string, unknown>)['ResizeObserver'] = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

function renderRoom(
  el: HTMLElement,
  root: Root,
  props: { charId: string; storage: StorageLike; mutex: CrossDocMutex; onSaved?: (state: unknown) => void },
): void {
  act(() => {
    root.render(
      <Room3DHome
        charId={props.charId}
        storage={props.storage}
        chibi={chibi}
        mutex={props.mutex}
        autoSelectFirst
        onSaved={props.onSaved}
        fallback2D={<div>2D</div>}
      />,
    );
  });
}

async function waitReady(el: HTMLElement): Promise<void> {
  await waitFor(
    () =>
      Array.from(el.querySelectorAll('button')).some((b) => (b.textContent ?? '').includes('保存布置')) &&
      (el.textContent ?? '').includes('视角'),
    'save button + orbit label (ready)',
  );
}

async function clickSave(el: HTMLElement): Promise<void> {
  const btn = Array.from(el.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes('保存布置'),
  );
  if (!btn) throw new Error('save button missing');
  act(() => {
    (btn as HTMLButtonElement).click();
  });
  await flush();
}

function clickFirstAdd(el: HTMLElement): void {
  const btn = Array.from(el.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').startsWith('+ '),
  );
  if (!btn) throw new Error('add button missing');
  act(() => {
    (btn as HTMLButtonElement).click();
  });
}

function clickMoveRight(el: HTMLElement): void {
  const btn = Array.from(el.querySelectorAll('button')).find(
    (b) => b.getAttribute('aria-label') === '右移',
  );
  if (!btn) throw new Error('move-right button missing (no selection?)');
  act(() => {
    (btn as HTMLButtonElement).click();
  });
}

function diskItems(storage: StorageLike, charId: string): { items: Array<{ id: string; kind: string; pose: { x: number; z: number } }>; raw: string } {
  const raw = storage.getItem(room3DStorageKey(charId));
  if (!raw) throw new Error('disk empty');
  const parsed = JSON.parse(raw) as { items: Array<{ id: string; kind: string; pose: { x: number; z: number } }> };
  return { items: parsed.items, raw };
}

/**
 * review267 精确复现（saved 旧 ack 版）：
 * 基线(7) → S_old 延迟投递(盘已写) → 加1件发起冲突保存(载入胜出) →
 * 再加1件 S_new 成功(8) → 投递旧 S_old → 加第9件+右移后 S_final 必须成功(9)且坐标保留。
 */
async function runReview267WithOldKind(oldKind: 'saved' | 'conflict'): Promise<void> {
  const storage = memStorage();
  const saved: unknown[] = [];
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root: Root = createRoot(el);

  if (oldKind === 'saved') {
    const mutex = new DelayedMutex();
    renderRoom(el, root, { charId: 'A', storage, mutex, onSaved: (s) => void saved.push(s) });
    await waitReady(el);

    // 基线：默认 7 件落盘。
    await clickSave(el);
    expect(el.textContent).toContain('已保存，重新打开可恢复');
    expect(diskItems(storage, 'A').items).toHaveLength(7);
    const rev0 = storage.getItem(room3DStorageKey('A'))!;

    // S_old：盘写完但延迟投递。
    mutex.delayNext = true;
    await clickSave(el);
    await waitFor(() => storage.getItem(room3DStorageKey('A')) !== rev0, 'old save persisted');
    const revOld = storage.getItem(room3DStorageKey('A'))!;

    // 加 1 件并发起新保存：rev 仍是旧指针，必然 conflict 并载入胜出盘态。
    clickFirstAdd(el);
    await flush();
    await clickSave(el);
    await flush();
    expect(el.textContent).toContain('另一处有更新');
    expect(diskItems(storage, 'A').items).toHaveLength(7);

    // 重新加到 8 件并成功保存 S_new。
    clickFirstAdd(el);
    await flush();
    saved.length = 0;
    await clickSave(el);
    expect(el.textContent).toContain('已保存，重新打开可恢复');
    const afterNew = diskItems(storage, 'A');
    expect(afterNew.items).toHaveLength(8);
    const revNew = afterNew.raw;
    expect(revNew).not.toBe(revOld);

    // 投递旧 S_old：不得回退 rev，不得污染 UI，不得自造 conflict。
    mutex.open();
    await flush();
    await flush();
    expect(storage.getItem(room3DStorageKey('A'))).toBe(revNew);
    expect(diskItems(storage, 'A').items).toHaveLength(8);

    // 加第 9 件 + 右移第一件，S_final 必须成功且坐标保留。
    const before = diskItems(storage, 'A');
    const firstId = before.items[0].id;
    const firstX = before.items[0].pose.x;
    clickFirstAdd(el);
    await flush();
    clickMoveRight(el);
    await flush();
    saved.length = 0;
    await clickSave(el);
    await flush();
    expect(el.textContent).toContain('已保存，重新打开可恢复');
    expect(el.textContent).not.toContain('另一处有更新');
    // onSaved 至少被最终保存触发一次（旧 ack 不得触发）。
    expect(saved.length).toBeGreaterThanOrEqual(1);
    const fin = diskItems(storage, 'A');
    expect(fin.items).toHaveLength(9);
    const moved = fin.items.find((i) => i.id === firstId)!;
    expect(moved).toBeDefined();
    expect(moved.pose.x).toBeGreaterThan(firstX);

    act(() => root.unmount());
    el.remove();
    return;
  }

  // oldKind === 'conflict'：旧保存因基线过期返回 conflict，其 storedRev
  // 必然 older；较新保存已接纳更新 rev 后，旧 conflict 不得回退指针。
  // 流程与 saved 版对称：胜出 tab 先写 R1 → S_old(期望 R0)延迟投递必 conflict(R1) →
  // 中转 conflict 载入 R1 → 重加 S_new 成功 R2(8) → 投递旧 conflict(R1) → 加第9件 S_final 必须成功。
  const mutex = new DelayedMutex();
  renderRoom(el, root, { charId: 'A', storage, mutex, onSaved: (s) => void saved.push(s) });
  await waitReady(el);

  await clickSave(el);
  expect(diskItems(storage, 'A').items).toHaveLength(7);
  const revBase = storage.getItem(room3DStorageKey('A'))!;

  // 另一 tab 先胜出 R1（8 件）：直接走带锁保存，模拟跨 tab。
  {
    const shared = new SharedMemoryMutex();
    const store = createRoom3DStore(storage, { mutex: shared });
    const meta = store.loadMeta('A');
    const winnerItems = [...(meta.state?.items ?? [])];
    const extra = {
      ...((winnerItems[0] as unknown as Record<string, unknown>) ?? {}),
      id: `winner-${Date.now()}`,
    };
    const winner = await store.save('A', [...winnerItems, extra] as never, { expectedRev: meta.rev });
    expect(winner.status).toBe('saved');
  }
  const revWinner = storage.getItem(room3DStorageKey('A'))!;
  expect(revWinner).not.toBe(revBase);
  expect(diskItems(storage, 'A').items).toHaveLength(8);

  // S_old：UI 仍持有旧指针 R0，快照 7 件，延迟投递 → 必 conflict(storedRev R1)。
  mutex.delayNext = true;
  await clickSave(el);
  await flush();
  // 中转：UI 用过期指针再保存一次会先 conflict 并载入 R1（8 件胜出）。
  // 注意此时 S_old 仍未投递；这次中转保存不用延迟锁（mutex.delayNext 已被 S_old 消费）。
  await clickSave(el);
  await flush();
  expect(el.textContent).toContain('另一处有更新');
  expect(diskItems(storage, 'A').items).toHaveLength(8);

  // 重加到 9 件？不——先回到 8 件基线再按 saved 版走 S_new(8)→旧投递→第9件。
  // 此时 UI 已是胜出 8 件（conflict 载入），直接保存即 S_new 成功（rev R1→R2）。
  saved.length = 0;
  await clickSave(el);
  expect(el.textContent).toContain('已保存，重新打开可恢复');
  const afterNew = diskItems(storage, 'A');
  expect(afterNew.items).toHaveLength(8);
  const revNew = afterNew.raw;

  // 投递旧 conflict(storedRev R1)：不得把 rev 从 R2 回退到 R1。
  mutex.open();
  await flush();
  await flush();
  expect(storage.getItem(room3DStorageKey('A'))).toBe(revNew);
  expect(diskItems(storage, 'A').items).toHaveLength(8);

  // 加第 9 件 + 右移，S_final 必须成功。
  const beforeC = diskItems(storage, 'A');
  const firstIdC = beforeC.items[0].id;
  const firstXC = beforeC.items[0].pose.x;
  clickFirstAdd(el);
  await flush();
  clickMoveRight(el);
  await flush();
  saved.length = 0;
  await clickSave(el);
  await flush();
  expect(el.textContent).toContain('已保存，重新打开可恢复');
  expect(el.textContent).not.toContain('另一处有更新');
  expect(saved.length).toBeGreaterThanOrEqual(1);
  const finC = diskItems(storage, 'A');
  expect(finC.items).toHaveLength(9);
  const movedC = finC.items.find((i) => i.id === firstIdC)!;
  expect(movedC).toBeDefined();
  expect(movedC.pose.x).toBeGreaterThan(firstXC);

  act(() => root.unmount());
  el.remove();
}

describe('room3d ordered-ack-closeout', () => {
  it.each([['saved'], ['conflict']] as Array<['saved' | 'conflict']>)(
    'review267: old %s ack cannot regress newer rev; final save keeps 9 items + moved coords',
    async (oldKind) => {
      await runReview267WithOldKind(oldKind);
    },
  );

  it('edit-before-ack: stale save keeps new layout, next save uses synced baseline and succeeds', async () => {
    const storage = memStorage();
    const saved: unknown[] = [];
    const mutex = new DelayedMutex();
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root: Root = createRoot(el);
    renderRoom(el, root, { charId: 'A', storage, mutex, onSaved: (s) => void saved.push(s) });
    await waitReady(el);

    await clickSave(el);
    const rev0 = storage.getItem(room3DStorageKey('A'))!;
    saved.length = 0; // 基线回调清零，旧 ack 自身必须零回调。

    // 旧保存延迟投递，期间本地加一件（edit++ 使旧租约失效）。
    mutex.delayNext = true;
    await clickSave(el);
    await waitFor(() => storage.getItem(room3DStorageKey('A')) !== rev0, 'old save persisted');
    const revOld = storage.getItem(room3DStorageKey('A'))!;

    clickFirstAdd(el);
    await flush();

    // 投递旧 ack：不得覆盖新布局（UI 仍 8 件概念），不得新增 onSaved 回调。
    // 注意基线保存的旧 notice 文本仍在，不能用 not.toContain('已保存') 断言；
    // 关键是旧 ack 自身零回调、盘仍旧快照。
    mutex.open();
    await flush();
    await flush();
    expect(saved).toHaveLength(0);
    // 盘仍是旧快照（7 件），UI 不动；但 rev 指针必须已同步到 revOld 以便下次保存不断链。
    expect(storage.getItem(room3DStorageKey('A'))).toBe(revOld);

    // 下一次保存必须用正确基线成功，落盘 8 件。
    saved.length = 0;
    await clickSave(el);
    expect(el.textContent).toContain('已保存，重新打开可恢复');
    expect(saved).toHaveLength(1);
    expect(diskItems(storage, 'A').items).toHaveLength(8);

    act(() => root.unmount());
    el.remove();
  });

  it('generation fence: stale ack after charId switch cannot touch new slot rev', async () => {
    const storage = memStorage();
    const mutex = new DelayedMutex();
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root: Root = createRoot(el);
    renderRoom(el, root, { charId: 'A', storage, mutex });
    await waitReady(el);
    await clickSave(el);
    expect(diskItems(storage, 'A').items).toHaveLength(7);

    // A 的旧保存延迟投递。
    mutex.delayNext = true;
    await clickSave(el);
    await waitFor(() => storage.getItem(room3DStorageKey('A')) !== null, 'A old persisted');

    // 切到 B（同实例新代次）：B 空槽基线保存成功。
    act(() => {
      root.render(
        <Room3DHome charId="B" storage={storage} chibi={chibi} mutex={mutex} autoSelectFirst fallback2D={<div>2D</div>} />,
      );
    });
    await flush();
    await waitReady(el);
    await clickSave(el);
    const revB = storage.getItem(room3DStorageKey('B'))!;
    expect(diskItems(storage, 'B').items).toHaveLength(7);

    // 投递 A 的旧 ack：B 盘与 B rev 一律不动。
    mutex.open();
    await flush();
    await flush();
    expect(storage.getItem(room3DStorageKey('B'))).toBe(revB);
    expect(diskItems(storage, 'B').items).toHaveLength(7);

    act(() => root.unmount());
    el.remove();
  });
});
