/**
 * room3d · mutex
 * 跨文档互斥端口（redesign-v1 新写协议）。
 *
 * - 生产：同源 Web Locks（navigator.locks.request, exclusive），锁覆盖
 *   fresh-read → validate → compare → mutate → save → 成功确认整个区间。
 * - 无安全能力（浏览器缺 Web Locks 且调用方显式传 null，或默认解析为 null）
 *   时所有写入口 fail closed：拒绝写入，不报假成功。
 * - 测试：注入同一个 SharedMemoryMutex 实例模拟跨 tab 共享锁；
 *   每个 store 独立实例不算共享（遮蔽问题），测试必须显式共享。
 * - 不新增主 DB store，不碰 v81。
 */

export interface CrossDocMutex {
  readonly kind: string;
  withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T>;
}

/** 进程内共享链式锁：测试注入用。必须把同一实例传给所有参与者才算共享。 */
export class SharedMemoryMutex implements CrossDocMutex {
  readonly kind = 'shared-memory (test/shared-tab only)';
  private tails = new Map<string, Promise<void>>();

  async withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const cur = new Promise<void>((res) => {
      release = res;
    });
    this.tails.set(key, prev.then(() => cur));
    await prev;
    try {
      return await fn();
    } finally {
      release();
      // 收尾：若没有后来者排队，清理 key，避免 Map 无限增长。
      const tail = this.tails.get(key);
      if (tail) {
        void tail.then(() => {
          if (this.tails.get(key) === tail) this.tails.delete(key);
        });
      } else {
        this.tails.delete(key);
      }
    }
  }
}

/** Web Locks 实现：仅在 navigator.locks 可用时构造。 */
export class WebLocksMutex implements CrossDocMutex {
  readonly kind = 'web-locks (exclusive, cross-document)';
  async withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const nav = (globalThis as unknown as { navigator?: unknown }).navigator as
      | { locks?: { request: (name: string, cb: () => Promise<T> | T) => Promise<T> } }
      | undefined;
    if (!nav?.locks?.request) throw new Error('no-web-locks');
    return nav.locks.request(key, fn);
  }
}

let webSingleton: WebLocksMutex | null = null;
let procSingleton: SharedMemoryMutex | null = null;

/** 是否有浏览器跨文档锁能力。 */
export function hasWebLocks(): boolean {
  const nav = (globalThis as unknown as { navigator?: unknown }).navigator as
    | { locks?: { request?: unknown } }
    | undefined;
  return typeof nav?.locks?.request === 'function';
}

/**
 * 默认互斥解析：
 * - 浏览器有 Web Locks → 单例 WebLocksMutex（生产路径）；
 * - Node/测试（无 window）→ 进程内单例（仅单测/单进程用，跨进程不安全，
 *   跨 tab 测试必须显式注入共享实例）；
 * - 浏览器无 Web Locks → null（调用方必须 fail closed）。
 */
export function getDefaultMutex(): CrossDocMutex | null {
  if (hasWebLocks()) {
    if (!webSingleton) webSingleton = new WebLocksMutex();
    return webSingleton;
  }
  const isBrowser =
    typeof (globalThis as unknown as { window?: unknown }).window !== 'undefined' ||
    typeof (globalThis as unknown as { document?: unknown }).document !== 'undefined';
  if (!isBrowser) {
    if (!procSingleton) procSingleton = new SharedMemoryMutex();
    return procSingleton;
  }
  return null;
}

/** 稳定资源键：与存储 key 一一对应，锁与槽同粒度。 */
export function room3dLockKey(charId: string): string {
  return `sully-home3d-${charId}`;
}

export function halloweenLockKey(charId: string): string {
  return `sully-seasonal-halloween-2026-${charId}`;
}
