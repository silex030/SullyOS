/**
 * 隔离环境联调页的浏览器入口（**只用于 scripts/autonomy-e2e 的联调**，不进 App 包）。
 *
 * 它 import 的是**真实**的浏览器侧模块：
 *   - utils/autonomyLife/api.ts          → 真实 HTTP 请求（fetch）
 *   - utils/autonomyLife/executor.ts     → 真实 register→claim→permit→本地事务→回执
 *   - utils/autonomyLife/localLedger.ts  → 真实 IndexedDB（AetherOS_Data）
 * 没有 fake-indexeddb、没有假 api：请求真的发到 harness 的 worker 进程（D1 SQLite）。
 */

import { createAutonomyLifeApi } from '../../utils/autonomyLife/api';
import { createAutonomyLifeExecutor } from '../../utils/autonomyLife/executor';
import {
  AUTONOMY_LOCAL_STORES,
  createLocalDbPort,
  openAutonomyLocalDb,
} from '../../utils/autonomyLife/localLedger';

export interface E2EConfig {
  baseUrl: string;
  token: string;
  userId: string;
  installationId: string;
  charId: string;
}

declare global {
  interface Window {
    __AUTONOMY_E2E__?: {
      run: (config: E2EConfig) => Promise<unknown>;
      readLocal: () => Promise<unknown>;
      resetLocal: () => Promise<void>;
    };
  }
}

const DB_NAME = 'AetherOS_Data';

/** 按 App 的 v81 结构建 store（keyPath 与 utils/db.ts 一致；只建自主生活用到的）。 */
function ensureDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of AUTONOMY_LOCAL_STORES) {
        if (db.objectStoreNames.contains(store)) continue;
        if (store === 'autonomy_action_permits' || store === 'autonomy_action_receipts') {
          db.createObjectStore(store, { keyPath: 'actionId' });
        } else {
          db.createObjectStore(store, { keyPath: 'id' });
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function openPort() {
  await ensureDb();
  const opened = await openAutonomyLocalDb();
  if (!opened.ok) throw new Error(`local_db_unavailable:${opened.reason}`);
  return createLocalDbPort((await ensureDb()) as IDBDatabase);
}

async function readAll(port: Awaited<ReturnType<typeof openPort>>, store: string): Promise<unknown[]> {
  return port.runTransaction([store], 'readonly', async (tx) => tx.getAll(store));
}

async function resetLocal(): Promise<void> {
  const db = await ensureDb();
  const stores = [...AUTONOMY_LOCAL_STORES];
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    for (const store of stores) tx.objectStore(store).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function run(config: E2EConfig) {
  const api = createAutonomyLifeApi({
    resolveEndpoint: () => ({
      baseUrl: config.baseUrl,
      headers: { 'X-Client-Token': config.token, 'X-User-Id': config.userId },
    }),
    // 显式直连：联调环境没有 App 的统一外部请求代理。
    transport: (url, init) => fetch(url, {
      method: init.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      // api.ts 已经序列化过 body；这里只负责转发，别二次 stringify。
      body: typeof init.body === 'string' ? init.body : init.body ? JSON.stringify(init.body) : undefined,
    }),
  });

  const executor = createAutonomyLifeExecutor({
    api,
    installationId: config.installationId,
    charIds: () => [config.charId],
    boundaryFor: async (charId) => {
      const res = await api.readBoundaries(charId);
      if (!res.ok) return null;
      return res.data.effective;
    },
    // 真实 IndexedDB；不用 fake-indexeddb。
    openPort: async () => {
      try {
        return await openPort();
      } catch {
        return null;
      }
    },
    pending: { read: () => [], write: () => undefined },
    now: () => Date.now(),
  });

  const rounds: unknown[] = [];
  for (let index = 0; index < 3; index += 1) {
    const outcomes = await executor.runOnce();
    rounds.push(outcomes);
    if (outcomes.every((item) => !item.claimed)) break;
  }

  const port = await openPort();
  const receipts = await readAll(port, 'autonomy_action_receipts');
  const diaries = await readAll(port, 'diaries');
  const localLife = await readAll(port, 'autonomy_local_life');
  const permits = await readAll(port, 'autonomy_action_permits');

  return {
    rounds,
    receipts,
    diaries,
    localLife,
    permits,
    userAgent: navigator.userAgent,
    hasRealIndexedDB: typeof indexedDB !== 'undefined' && !(indexedDB as unknown as { _fake?: boolean })._fake,
  };
}

window.__AUTONOMY_E2E__ = { run, readLocal: async () => {
  const port = await openPort();
  return {
    receipts: await readAll(port, 'autonomy_action_receipts'),
    diaries: await readAll(port, 'diaries'),
    localLife: await readAll(port, 'autonomy_local_life'),
    permits: await readAll(port, 'autonomy_action_permits'),
  };
}, resetLocal };
