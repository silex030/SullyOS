/**
 * 隔离环境联调页的浏览器入口（**只用于 scripts/autonomy-e2e 的联调**，不进 App 包）。
 *
 * 它 import 的是**真实**的浏览器侧模块：
 *   - utils/autonomyLife/api.ts          → 真实 HTTP 请求（fetch）
 *   - utils/autonomyLife/executor.ts     → 真实 register→claim→permit→本地事务→回执
 *   - utils/autonomyLife/localLedger.ts  → 真实 IndexedDB（AetherOS_Data）
 *   - utils/autonomyLife/marketCatalog   → 真实目录选单（价格来自 /shopping/*.json）
 *   - utils/autonomyLife/view.ts         → UI 实际使用的投影/文案层
 * 没有 fake-indexeddb、没有假 api：请求真的发到 harness 的 worker 进程（D1 SQLite）。
 */

import { createAutonomyLifeApi, type AutonomyLifeApi } from '../../utils/autonomyLife/api';
import { createAutonomyLifeExecutor } from '../../utils/autonomyLife/executor';
import {
  AUTONOMY_LOCAL_STORES,
  createLocalDbPort,
  openAutonomyLocalDb,
} from '../../utils/autonomyLife/localLedger';
import {
  buildMarketCatalog,
  buildMarketProposal,
  type MarketCatalog,
} from '../../utils/autonomyLife/marketCatalog';
import { KIND_LABELS, latestActivity, sortActivities } from '../../utils/autonomyLife/view';

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
      // 生产链路场景（不 seed 目标动作）
      seedLocalIdentity: (config: E2EConfig) => Promise<unknown>;
      submitCatalogProposals: (config: E2EConfig) => Promise<unknown>;
      runExecutorOnce: (config: E2EConfig) => Promise<unknown>;
      readUiView: (config: E2EConfig) => Promise<unknown>;
    };
  }
}

const DB_NAME = 'AetherOS_Data';
const EXTRA_STORES: Array<{ name: string; keyPath: string }> = [
  { name: 'characters', keyPath: 'id' },
  { name: 'bank_data', keyPath: 'id' },
];

/** 按 App 的 v81 结构建 store（keyPath 与 utils/db.ts 一致；只建联调用到的）。 */
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
      for (const store of EXTRA_STORES) {
        if (!db.objectStoreNames.contains(store.name)) db.createObjectStore(store.name, { keyPath: store.keyPath });
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
  const stores = [...AUTONOMY_LOCAL_STORES, ...EXTRA_STORES.map((store) => store.name)];
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    for (const store of stores) tx.objectStore(store).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function makeApi(config: E2EConfig): AutonomyLifeApi {
  return createAutonomyLifeApi({
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
}

function makeExecutor(config: E2EConfig, api: AutonomyLifeApi) {
  return createAutonomyLifeExecutor({
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
}

async function run(config: E2EConfig) {
  const api = makeApi(config);
  const executor = makeExecutor(config, api);

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

/**
 * 生产链路前置：写「真实设备上才有的」两样东西 —— 角色档案（收货地址）与角色模拟钱包。
 * 值都是联调夹具，明确标注 NOT_APP_DATA，避免被误当成真实用户数据。
 */
async function seedLocalIdentity(config: E2EConfig) {
  await ensureDb();
  const db = await ensureDb();
  const character = {
    id: config.charId,
    name: '小夏',
    delivery: { addressText: '北京市朝阳区联调小区 3 号楼 502（联调夹具）', cityTag: '北京' },
    __e2eFixture: true,
  };
  const bank = {
    id: 'main_state',
    cards: [{
      id: 'card-e2e-1',
      name: '角色卡',
      tailNo: '0001',
      balance: 88.8,
      owner: 'char',
      ownerId: config.charId,
      isDefault: true,
    }],
    __e2eFixture: true,
  };
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['characters', 'bank_data'], 'readwrite');
    tx.objectStore('characters').put(character);
    tx.objectStore('bank_data').put(bank);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return { character: character.id, cardBalance: bank.cards[0].balance, address: character.delivery.addressText };
}

async function loadCatalog(): Promise<MarketCatalog> {
  const [shops, dishes, mallShops, mallGoods] = await Promise.all([
    fetch('/shopping/shops.json').then((res) => (res.ok ? res.json() : null)),
    fetch('/shopping/dishes.json').then((res) => (res.ok ? res.json() : null)),
    fetch('/shopping/mall-shops.json').then((res) => (res.ok ? res.json() : null)),
    fetch('/shopping/mall-goods.json').then((res) => (res.ok ? res.json() : null)),
  ]);
  const dishesList = Array.isArray(dishes) ? dishes : Object.values(dishes ?? {}).flat();
  return buildMarketCatalog({
    takeout: { shops: shops ?? [], dishes: dishesList },
    mall: { shops: mallShops ?? [], goods: mallGoods ?? [] },
  });
}

/**
 * 设备侧从**真实目录**（/shopping/*.json）+ 角色地址 + 角色卡余额选出 1~2 条候选，
 * 通过真实 api 上报（POST /proposals）。价格全部来自目录。
 */
async function submitCatalogProposals(config: E2EConfig) {
  const api = makeApi(config);
  const catalog = await loadCatalog();
  const port = await openPort();
  const characters = await readAll(port, 'characters') as Array<{ id: string; delivery?: { addressText?: string } }>;
  const bankRows = await readAll(port, 'bank_data') as Array<{ id: string; cards?: Array<{ id: string; balance: number; owner?: string; ownerId?: string; isDefault?: boolean }> }>;
  const character = characters.find((row) => row.id === config.charId);
  const addressText = character?.delivery?.addressText ?? '';
  const bank = bankRows.find((row) => row.id === 'main_state');
  const cards = (bank?.cards ?? []).filter((card) => card.owner === 'char' && card.ownerId === config.charId);
  const card = cards.find((item) => item.isDefault) ?? cards[0];
  const walletBalanceMinor = Math.max(0, Math.round(Number(card?.balance ?? 0) * 100));
  const cardId = String(card?.id ?? '');
  const boundaries = await api.readBoundaries(config.charId);
  const life = await api.readLife(config.charId);
  const limit = boundaries.ok ? boundaries.data.effective.limits : null;
  const spend = life.ok ? life.data.state.budget.find((row) => row.dimension === 'virtual_spend') : undefined;
  const budget = {
    orderMaxMinor: limit?.virtualOrderMaxMinor ?? 0,
    spendRemainingMinor: spend ? Math.max(0, spend.limit - spend.used - spend.reserved) : 0,
    walletBalanceMinor,
  };
  const proposals = [];
  for (const kind of ['takeout.order', 'shopping.order'] as const) {
    if (boundaries.ok && !boundaries.data.effective.allowedKinds.includes(kind)) continue;
    const proposal = buildMarketProposal({
      catalog,
      kind,
      charId: config.charId,
      cardId,
      addressText,
      nowMs: Date.now(),
      timezone: boundaries.ok ? boundaries.data.effective.timezone : 'Asia/Shanghai',
      budget,
      seed: `e2e-seed:${config.userId}`,
    });
    if (proposal) proposals.push(proposal);
  }
  const submitted = proposals.length > 0
    ? await api.submitProposals({ charId: config.charId, proposals })
    : null;
  return { catalogShops: catalog.takeout.shops.length, proposals, submitted, budget, addressText };
}

async function runExecutorOnce(config: E2EConfig) {
  const api = makeApi(config);
  const executor = makeExecutor(config, api);
  const outcomes = await executor.runOnce();
  return outcomes;
}

/** UI 实际消费的数据：GET /activities + /state，经 view.ts 投影成人话与排序。 */
async function readUiView(config: E2EConfig) {
  const api = makeApi(config);
  const [activities, state] = await Promise.all([
    api.readActivities({ charId: config.charId, limit: 20 }),
    api.readLife(config.charId),
  ]);
  if (!activities.ok) return { ok: false, error: activities.code };
  const items = sortActivities(activities.data.items).map((item) => ({
    id: item.id,
    kind: item.kind,
    label: KIND_LABELS[item.kind],
    status: item.status,
    effectVerified: item.effectVerified,
    reasonSummary: item.reasonSummary,
  }));
  const latest = latestActivity(activities.data.items);
  return {
    ok: true,
    items,
    latest: latest ? { id: latest.id, kind: latest.kind, label: KIND_LABELS[latest.kind], status: latest.status } : null,
    state: state.ok ? {
      availability: state.data.state.availability,
      reasonCodes: state.data.state.reasonCodes,
      scheduleConfidence: state.data.state.scheduleConfidence,
      capabilities: state.data.capabilities.map((cap) => ({ kind: cap.kind, available: cap.available, enabled: cap.enabled, unavailableReason: cap.unavailableReason ?? null })),
    } : { error: state.code },
  };
}

window.__AUTONOMY_E2E__ = {
  run,
  readLocal: async () => {
    const port = await openPort();
    return {
      receipts: await readAll(port, 'autonomy_action_receipts'),
      diaries: await readAll(port, 'diaries'),
      localLife: await readAll(port, 'autonomy_local_life'),
      permits: await readAll(port, 'autonomy_action_permits'),
      shoppingOrders: await readAll(port, 'shopping_orders'),
      bankTransactions: await readAll(port, 'bank_transactions'),
      bankData: await readAll(port, 'bank_data'),
    };
  },
  resetLocal,
  seedLocalIdentity,
  submitCatalogProposals,
  runExecutorOnce,
  readUiView,
};
