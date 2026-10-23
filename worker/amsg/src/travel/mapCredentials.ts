/**
 * 出行 · 地图服务凭据（用户在前端自己填，后台按主体加密保存）
 *
 * 为什么要单独一层：用户已经有高德 Web 服务 Key，不想再手改 `.env` 或构建参数。
 * 但 Key / jscode 属于真实凭据：
 * - **只按已签名会话里的 userId 存取**，请求体里的 userId 一律忽略（路由层保证）；
 * - 整份 JSON 用 `deriveUserEncryptionKey(userId, AMSG_MASTER_KEY)` 派生的每用户密钥
 *   `encryptForStorage` 后落 `travel_map_credentials`，**不新建全局 owner、不新造加密**；
 * - 解不开（换过 masterKey / 密文坏）→ 认为「没有凭据」且**拒绝覆盖**，不静默清空用户配置；
 * - GET 只回**存在性**和浏览器必需的公开展示 Key（官方 JS API Key、Mapbox `pk.` 公钥）；
 *   **Web 服务 Key 与 securityJsCode 永远不回前端**（它们只出现在服务端发往厂商的请求里）；
 * - 保存动作本身**不发任何收费请求**；「测试连接」是用户显式点击后的单次调用，另有冷却。
 */
import { decryptFromStorage, deriveUserEncryptionKey, encryptForStorage } from '@rei-standard/amsg-server/cloudflare';

export interface TravelMapCredentialDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>;
      first(): Promise<Record<string, unknown> | null>;
      all(): Promise<{ results?: Array<Record<string, unknown>> }>;
    };
  };
}

export interface TravelMapCredentialValues {
  /** 高德 **Web 服务** Key（地理编码 / 路径规划 / 静态图）。只在服务端使用。 */
  amapWebKey: string;
  /** 高德 **JS API** Key（底图展示）。浏览器必需，按高德控制台域名白名单约束。 */
  amapJsKey: string;
  /** 高德 **安全密钥 jscode**。只在代理端注入，永不回前端。 */
  amapJsCode: string;
  /** 可选：Mapbox 公钥（`pk.` 开头）。国外展示用。 */
  mapboxToken: string;
  /** Mapbox 样式地址（非敏感，随 token 一起保存）。 */
  mapboxStyleUrl: string;
}

export const TRAVEL_MAP_CREDENTIAL_FIELDS = [
  'amapWebKey',
  'amapJsKey',
  'amapJsCode',
  'mapboxToken',
  'mapboxStyleUrl',
] as const;

export type TravelMapCredentialField = (typeof TRAVEL_MAP_CREDENTIAL_FIELDS)[number];

export type TravelMapCredentialPatch = Partial<Record<TravelMapCredentialField, string>>;

const EMPTY: TravelMapCredentialValues = {
  amapWebKey: '',
  amapJsKey: '',
  amapJsCode: '',
  mapboxToken: '',
  mapboxStyleUrl: '',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 密钥里不接受空白/控制字符：粘贴时常带换行，静默 trim 会让「看起来保存了」但请求 401。 */
const cleanSecret = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length > 512) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
};

const parseStored = (raw: unknown): TravelMapCredentialValues | null => {
  if (!isRecord(raw)) return null;
  const out = { ...EMPTY };
  for (const field of TRAVEL_MAP_CREDENTIAL_FIELDS) {
    const value = raw[field];
    if (typeof value === 'string') out[field] = value;
  }
  return out;
};

const normalizeForStore = (values: TravelMapCredentialValues): TravelMapCredentialValues => ({
  amapWebKey: values.amapWebKey.trim(),
  amapJsKey: values.amapJsKey.trim(),
  amapJsCode: values.amapJsCode.trim(),
  mapboxToken: values.mapboxToken.trim(),
  mapboxStyleUrl: values.mapboxStyleUrl.trim(),
});

export interface TravelMapCredentialRow {
  encrypted_value: string;
  version: number;
  updated_at: number;
}

export type ReadResult =
  | { kind: 'absent' }
  | { kind: 'ok'; values: TravelMapCredentialValues; version: number; updatedAt: number }
  | { kind: 'unreadable'; version: number; updatedAt: number };

/** 读一行并按用户密钥解密。缺 masterKey / 密文坏 → unreadable（不是 absent）。 */
export async function readTravelMapCredentialRow(args: {
  db: TravelMapCredentialDb;
  userId: string;
  masterKey: string | null | undefined;
}): Promise<ReadResult> {
  let row: Record<string, unknown> | null = null;
  try {
    row = await args.db
      .prepare('SELECT encrypted_value, version, updated_at FROM travel_map_credentials WHERE user_id = ?')
      .bind(args.userId)
      .first();
  } catch {
    return { kind: 'absent' };
  }
  if (!row) return { kind: 'absent' };
  const version = Number(row.version ?? 0) || 0;
  const updatedAt = Number(row.updated_at ?? 0) || 0;
  const encrypted = typeof row.encrypted_value === 'string' ? row.encrypted_value : '';
  const masterKey = typeof args.masterKey === 'string' ? args.masterKey.trim() : '';
  if (!encrypted || !masterKey) return { kind: 'unreadable', version, updatedAt };
  try {
    const userKey = await deriveUserEncryptionKey(args.userId, masterKey);
    const plain = await decryptFromStorage(encrypted, userKey);
    const parsed = parseStored(JSON.parse(plain));
    if (!parsed) return { kind: 'unreadable', version, updatedAt };
    return { kind: 'ok', values: normalizeForStore(parsed), version, updatedAt };
  } catch {
    return { kind: 'unreadable', version, updatedAt };
  }
}

export interface TravelMapCredentialStatus {
  /** 服务端确实读到并解密了一份配置。 */
  configured: boolean;
  /** 有行但解不开（masterKey 变更等）；此时保存会被拒绝，不覆盖。 */
  unreadable: boolean;
  has: {
    amapWebKey: boolean;
    amapJsKey: boolean;
    amapJsCode: boolean;
    mapboxToken: boolean;
  };
  /** 浏览器必需的公开展示 Key；没有就是 null。 */
  amapJsKey: string | null;
  /** 只回 Mapbox 公钥（`pk.`）；其它形状一律不回。 */
  mapboxToken: string | null;
  mapboxStyleUrl: string | null;
  updatedAt: number | null;
}

const isPublicMapboxToken = (token: string): boolean => token.startsWith('pk.') && token.length >= 20;

/** 对外状态：**只有存在性与公开展示 Key**，永远不会出现 Web 服务 Key / jscode。 */
export async function getTravelMapCredentialStatus(args: {
  db: TravelMapCredentialDb;
  userId: string;
  masterKey: string | null | undefined;
}): Promise<TravelMapCredentialStatus> {
  const read = await readTravelMapCredentialRow(args);
  if (read.kind === 'absent') {
    return {
      configured: false,
      unreadable: false,
      has: { amapWebKey: false, amapJsKey: false, amapJsCode: false, mapboxToken: false },
      amapJsKey: null,
      mapboxToken: null,
      mapboxStyleUrl: null,
      updatedAt: null,
    };
  }
  if (read.kind === 'unreadable') {
    return {
      configured: false,
      unreadable: true,
      has: { amapWebKey: false, amapJsKey: false, amapJsCode: false, mapboxToken: false },
      amapJsKey: null,
      mapboxToken: null,
      mapboxStyleUrl: null,
      updatedAt: read.updatedAt || null,
    };
  }
  const v = read.values;
  return {
    configured: true,
    unreadable: false,
    has: {
      amapWebKey: !!v.amapWebKey,
      amapJsKey: !!v.amapJsKey,
      amapJsCode: !!v.amapJsCode,
      mapboxToken: !!v.mapboxToken,
    },
    amapJsKey: v.amapJsKey || null,
    mapboxToken: isPublicMapboxToken(v.mapboxToken) ? v.mapboxToken : null,
    mapboxStyleUrl: v.mapboxStyleUrl || null,
    updatedAt: read.updatedAt || null,
  };
}

/** 只给服务端内部（provider / 代理 / 静态图）用的明文读取；不经过任何 HTTP 视图。 */
export async function resolveTravelMapCredentialValues(args: {
  db: TravelMapCredentialDb;
  userId: string;
  masterKey: string | null | undefined;
}): Promise<TravelMapCredentialValues | null> {
  const read = await readTravelMapCredentialRow(args);
  return read.kind === 'ok' ? read.values : null;
}

export type SaveFailureCode = 'UNAUTHORIZED' | 'INVALID_FIELD' | 'UNREADABLE' | 'VERSION_CONFLICT';

export interface SaveTravelMapCredentialsInput {
  db: TravelMapCredentialDb;
  userId: string;
  masterKey: string | null | undefined;
  patch: TravelMapCredentialPatch;
  /** 显式清除（清空需要动作，不靠「留空」猜）。 */
  clear?: readonly TravelMapCredentialField[];
  nowMs: number;
}

/**
 * 保存 / 替换 / 清除。语义：
 * - 只处理 patch 里**出现且非空**的字段，空字符串等于「保持不变」；
 * - `clear` 里的字段显式清空，与 patch 同时出现时以 clear 为准；
 * - 首次创建允许；已有行时按 `version` 做 CAS，0 行 = 409，不覆盖别人的写入；
 * - 解不开的旧行 → 拒绝（`UNREADABLE`），不拿空对象覆盖用户配置。
 */
export async function saveTravelMapCredentials(
  input: SaveTravelMapCredentialsInput,
): Promise<
  | { ok: true; status: TravelMapCredentialStatus }
  | { ok: false; code: SaveFailureCode }
> {
  const masterKey = typeof input.masterKey === 'string' ? input.masterKey.trim() : '';
  if (!masterKey) return { ok: false, code: 'UNAUTHORIZED' };

  const patch: TravelMapCredentialValues = { ...EMPTY };
  for (const field of TRAVEL_MAP_CREDENTIAL_FIELDS) {
    const raw = input.patch[field];
    if (raw === undefined) continue;
    const cleaned = cleanSecret(raw);
    if (cleaned === null) return { ok: false, code: 'INVALID_FIELD' };
    patch[field] = cleaned;
  }
  const clearSet = new Set(input.clear ?? []);

  const existing = await readTravelMapCredentialRow({
    db: input.db,
    userId: input.userId,
    masterKey,
  });
  if (existing.kind === 'unreadable') return { ok: false, code: 'UNREADABLE' };

  const base: TravelMapCredentialValues = existing.kind === 'ok' ? existing.values : { ...EMPTY };
  const next: TravelMapCredentialValues = { ...base };
  for (const field of TRAVEL_MAP_CREDENTIAL_FIELDS) {
    if (clearSet.has(field)) {
      next[field] = '';
    } else if (patch[field]) {
      next[field] = patch[field];
    }
  }

  let encrypted: string;
  try {
    const userKey = await deriveUserEncryptionKey(input.userId, masterKey);
    encrypted = await encryptForStorage(JSON.stringify(normalizeForStore(next)), userKey);
  } catch {
    return { ok: false, code: 'UNAUTHORIZED' };
  }

  try {
    if (existing.kind === 'absent') {
      await input.db
        .prepare(
          'INSERT INTO travel_map_credentials (user_id, encrypted_value, version, updated_at) VALUES (?, ?, 1, ?)',
        )
        .bind(input.userId, encrypted, Math.trunc(input.nowMs))
        .run();
    } else {
      const result = await input.db
        .prepare(
          'UPDATE travel_map_credentials SET encrypted_value = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND version = ?',
        )
        .bind(encrypted, Math.trunc(input.nowMs), input.userId, existing.version)
        .run();
      const changes = Number(
        (result as { meta?: { changes?: unknown }; changes?: unknown } | null)?.meta?.changes
          ?? (result as { changes?: unknown } | null)?.changes
          ?? 0,
      );
      if (changes !== 1) return { ok: false, code: 'VERSION_CONFLICT' };
    }
  } catch {
    return { ok: false, code: 'VERSION_CONFLICT' };
  }

  const status = await getTravelMapCredentialStatus({
    db: input.db,
    userId: input.userId,
    masterKey,
  });
  return { ok: true, status };
}
