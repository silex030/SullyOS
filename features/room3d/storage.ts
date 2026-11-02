/**
 * room3d · storage
 * 生产可用的 assets 持久化 adapter：localStorage 实现 + 并发保存顺序。
 * - 以 StorageLike 端口注入（浏览器 localStorage / 单测 Map / 后续备份沙盒）。
 * - 读取分四态：missing（空槽）/ ok / corrupt（坏 JSON·未知版本·串槽）/
 *   read-error（读抛异常）。load() 保持“失败回 null”，loadMeta() 暴露明细。
 * - 保存并发协议（opaque rev = 存档原始字节）：
 *   - expectedRev === null → 仅空槽可写（两个首次打开空槽的实例只有一个能赢）；
 *   - expectedRev 为字符串 → 当前原始字节必须逐字节相等，否则 conflict；
 *   - 不传 expectedRev → 盲写（兼容旧调用；组件生产路径永远传 rev）。
 *   - 时间戳单调：now <= 已存 updatedAt 时自动抬到 stored+1，
 *     同毫秒/时钟回退不会产生旧版本覆盖问题（版本判定只看 rev）。
 * - 损坏/不可读保护：当前原始字节损坏或不可读时，普通 save 拒绝覆盖
 *   （corrupt-blocked / rejected），只留显式用户恢复动作 clearCorrupt()。
 * - 不新增主 DB store，不碰 v81 IndexedDB。
 */
import {
  type Room3DBackupEnvelope,
  type Room3DFurnitureItem,
  type Room3DStateV1,
  room3DStorageKey,
} from './types';
import { validateRoomState } from './validate';
import {
  type CrossDocMutex,
  getDefaultMutex,
  room3dLockKey,
} from './mutex';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type Room3DLoadStatus = 'missing' | 'ok' | 'corrupt' | 'read-error';

export interface Room3DLoadMeta {
  status: Room3DLoadStatus;
  /** ok 时为合法存档，否则为 null。 */
  state: Room3DStateV1 | null;
  /** 存储中的原始字节（missing/read-error 时为 null；即 opaque rev）。 */
  raw: string | null;
  /** ok/冲突比较用的 rev：即 raw 本身；无字节时为 null。 */
  rev: string | null;
}

export type Room3DSaveResult =
  | { status: 'saved'; state: Room3DStateV1; rev: string }
  | { status: 'conflict'; stored: Room3DStateV1 | null; storedRev: string | null }
  | { status: 'rejected'; errors: string[] }
  | { status: 'corrupt-blocked'; raw: string | null };

export interface Room3DSaveOptions {
  /**
   * 并发期望（opaque）：loadMeta()/上次 saved 的 rev。
   * - null = 仅空槽可写；字符串 = 当前字节必须完全一致；不传 = 盲写。
   */
  expectedRev?: string | null;
  /** 可注入时钟（单测/调试用；生产不传）。 */
  now?: number;
}

export interface Room3DImportOptions {
  expectedRev?: string | null;
}

export interface Room3DStoreOptions {
  /**
   * 跨文档互斥能力：
   * - 传入共享 mutex 实例 → 用它（测试必须把同一实例传给所有参与者）；
   * - 传入 null → 无安全能力，写入口一律 fail closed；
   * - 不传 → getDefaultMutex()（浏览器 Web Locks / Node 进程内单例 /
   *   无锁浏览器 null）。
   */
  mutex?: CrossDocMutex | null;
}

export interface Room3DStore {
  load(charId: string): Room3DStateV1 | null;
  loadMeta(charId: string): Room3DLoadMeta;
  save(
    charId: string,
    items: Room3DFurnitureItem[],
    opts?: Room3DSaveOptions,
  ): Promise<Room3DSaveResult>;
  /**
   * 显式用户恢复：锁内重验，仅当当前原始字节仍等于 expectedRaw（或槽已空）
   * 时清除。返回 true = 已清除（调用方可接着用 expectedRev:null 做一次干净保存）。
   * 注：第1轮新架构复审后，同步裸 clear 已移除；这是唯一的删除路径，
   * 无互斥能力时返回 false（0 写入）。
   */
  clearCorrupt(charId: string, expectedRaw: string | null): Promise<boolean>;
  /** 导出本模块备份信封（供后续整包备份拼装）。 */
  exportModule(charId: string): string | null;
  /** 导入备份信封；非法/串槽一律 rejected 且不动现有存档。排序规则见实现。 */
  importModule(json: string, charId: string, opts?: Room3DImportOptions): Promise<Room3DSaveResult>;
}

const missingMeta = (): Room3DLoadMeta => ({ status: 'missing', state: null, raw: null, rev: null });

const NO_MUTEX_MSG = '无跨文档互斥能力，拒绝写入以保护旧数据（no-cross-tab-mutex）';

export function createRoom3DStore(storage: StorageLike, storeOpts: Room3DStoreOptions = {}): Room3DStore {
  const explicitMutex = storeOpts.mutex;
  const resolveMutex = (): CrossDocMutex | null =>
    explicitMutex !== undefined ? explicitMutex : getDefaultMutex();
  const readRaw = (charId: string): { raw: string | null; readError: boolean } => {
    try {
      return { raw: storage.getItem(room3DStorageKey(charId)), readError: false };
    } catch {
      return { raw: null, readError: true };
    }
  };

  const loadMeta = (charId: string): Room3DLoadMeta => {
    const { raw, readError } = readRaw(charId);
    if (readError) return { status: 'read-error', state: null, raw: null, rev: null };
    if (raw == null) return missingMeta();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: 'corrupt', state: null, raw, rev: raw };
    }
    const r = validateRoomState(parsed, charId);
    if (!r.ok || !r.state) return { status: 'corrupt', state: null, raw, rev: raw };
    return { status: 'ok', state: r.state, raw, rev: raw };
  };

  const load = (charId: string): Room3DStateV1 | null => loadMeta(charId).state;

  const writeState = (charId: string, state: Room3DStateV1): Room3DSaveResult => {
    const rev = JSON.stringify(state);
    try {
      storage.setItem(room3DStorageKey(charId), rev);
    } catch {
      return { status: 'rejected', errors: ['底层存储写入失败'] };
    }
    // 写后读回确认（成功确认区间的一部分，仍在锁内）。
    const check = readRaw(charId);
    if (check.readError || check.raw !== rev) {
      return { status: 'rejected', errors: ['写后确认失败，存档状态未知'] };
    }
    return { status: 'saved', state, rev };
  };

  const saveLocked = (
    charId: string,
    items: Room3DFurnitureItem[],
    opts: Room3DSaveOptions = {},
  ): Room3DSaveResult => {
    const meta = loadMeta(charId);
    if (meta.status === 'read-error') {
      return { status: 'rejected', errors: ['存储不可读，拒绝覆盖以防丢失数据'] };
    }
    if (meta.status === 'corrupt') {
      // 损坏旧态：普通保存绝不覆盖，只留显式恢复路径。
      return { status: 'corrupt-blocked', raw: meta.raw };
    }
    if (opts.expectedRev !== undefined) {
      const want = opts.expectedRev;
      if (want === null) {
        if (meta.raw !== null) {
          return { status: 'conflict', stored: meta.state, storedRev: meta.rev };
        }
      } else if (meta.raw !== want) {
        return { status: 'conflict', stored: meta.state, storedRev: meta.rev };
      }
    }
    const now = opts.now ?? Date.now();
    const base = meta.status === 'ok' && meta.state ? meta.state.updatedAt : Number.NEGATIVE_INFINITY;
    const updatedAt = now > base ? now : base + 1;
    const r = validateRoomState(
      { version: 1, charId, items, updatedAt },
      charId,
    );
    if (!r.ok || !r.state) return { status: 'rejected', errors: r.errors };
    return writeState(charId, r.state);
  };

  const save = async (
    charId: string,
    items: Room3DFurnitureItem[],
    opts: Room3DSaveOptions = {},
  ): Promise<Room3DSaveResult> => {
    const mutex = resolveMutex();
    if (!mutex) return { status: 'rejected', errors: [NO_MUTEX_MSG] };
    return mutex.withLock(room3dLockKey(charId), () => saveLocked(charId, items, opts));
  };

  return {
    load,
    loadMeta,
    save,
    async clearCorrupt(charId: string, expectedRaw: string | null): Promise<boolean> {
      const mutex = resolveMutex();
      if (!mutex) return false;
      return mutex.withLock(room3dLockKey(charId), () => {
        const { raw, readError } = readRaw(charId);
        if (readError) return false;
        if (raw === null) return true; // 槽已空：视为已清除
        if (expectedRaw !== null && raw !== expectedRaw) return false; // 已被别人动过
        let valid = false;
        try {
          valid = validateRoomState(JSON.parse(raw), charId).ok;
        } catch {
          valid = false;
        }
        if (valid) return false; // 存档是好的：拒绝“恢复式”清除
        try {
          storage.removeItem(room3DStorageKey(charId));
        } catch {
          return false;
        }
        // 写后确认（与 save 同协议）：同一锁内读回同一 key，
        // 确认为 missing/null 才成功。残留字节/读异常一律失败，
        // 不重建默认值、不提示已清除。
        const confirm = readRaw(charId);
        if (confirm.readError) return false;
        if (confirm.raw !== null) return false;
        return true;
      });
    },
    exportModule(charId: string) {
      const state = load(charId);
      if (!state) return null;
      const envelope: Room3DBackupEnvelope = {
        module: 'room3d',
        version: 1,
        charId,
        state,
      };
      return JSON.stringify(envelope);
    },
    async importModule(json: string, charId: string, opts: Room3DImportOptions = {}): Promise<Room3DSaveResult> {
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        return { status: 'rejected', errors: ['导入内容不是合法 JSON'] };
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        (parsed as Record<string, unknown>)['module'] !== 'room3d' ||
        (parsed as Record<string, unknown>)['version'] !== 1
      ) {
        return { status: 'rejected', errors: ['导入信封 module/version 非法'] };
      }
      const inner = (parsed as Record<string, unknown>)['state'];
      const r = validateRoomState(inner, charId);
      if (!r.ok || !r.state) return { status: 'rejected', errors: r.errors };
      const incoming = r.state;
      const mutex = resolveMutex();
      if (!mutex) return { status: 'rejected', errors: [NO_MUTEX_MSG] };
      return mutex.withLock(room3dLockKey(charId), (): Room3DSaveResult => {
        const meta = loadMeta(charId);
        if (meta.status === 'read-error') {
          return { status: 'rejected', errors: ['存储不可读，拒绝导入覆盖'] };
        }
        if (opts.expectedRev !== undefined) {
          const want = opts.expectedRev;
          if (want === null) {
            if (meta.status === 'ok') {
              return { status: 'conflict', stored: meta.state, storedRev: meta.rev };
            }
          } else if (meta.raw !== want) {
            return { status: 'conflict', stored: meta.state, storedRev: meta.rev };
          }
        }
        // 版本排序：旧备份不得覆盖已胜出的新版本（corrupt 槽允许显式导入恢复）。
        if (meta.status === 'ok' && meta.state && incoming.updatedAt <= meta.state.updatedAt) {
          return { status: 'conflict', stored: meta.state, storedRev: meta.rev };
        }
        return writeState(charId, incoming);
      });
    },
  };
}
