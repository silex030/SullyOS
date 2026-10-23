/**
 * 出行 · 用**用户自己的**模型凭据跑决策端口（复用既有 `llm_credentials` 链路）
 *
 * 之前这里是 worker 级 `TRAVEL_LLM_*` / `LLM_*`：那套 env 在线上已经实测失效
 * （`Invalid credential`），却因为「字段非空」被当成可用，结果每一跳决策都失败、
 * 还要白扣预算。现在按**既有 invoke 路径**取 per-user 凭据：
 *
 * - 名字与自主生活同一口径：`char:<charId>/chat`（`llm_credentials.cred_id`）；
 * - 解密用上游同一份 `resolveLlmCredential`（`getLlmCredentials` + `decryptFromStorage`
 *   + `deriveUserEncryptionKey(userId, masterKey)`），不另写一套加密/表结构；
 * - 解不开 / 没这行 → 返回 `null`（决策端口缺席 → tick 落 `wait`），**不**回落到
 *   worker 级 env 冒充「有凭据」；
 * - 取到的明文只用于本次请求头，不带到任何返回值/日志/推送对象里。
 */

import { decryptFromStorage, deriveUserEncryptionKey } from '@rei-standard/amsg-server/cloudflare';

/** 与 `autonomyChatCredId` 同一口径（自主生活与出行共用一个角色凭据行）。 */
export const travelCredIdFor = (charId: string): string => `char:${charId}/chat`;

export interface ResolvedTravelCredential {
  apiUrl: string;
  apiKey: string;
  primaryModel: string;
}

interface CredentialRow {
  cred_id?: unknown;
  encrypted_value?: unknown;
}

/** 只要求 `getLlmCredentials` 的最小适配面（和上游 DbAdapter 的那一段同形）。 */
export interface TravelCredentialDb {
  getLlmCredentials?: (userId: string, credIds: string[]) => Promise<CredentialRow[]>;
  prepare?(sql: string): {
    bind(...values: unknown[]): { all(): Promise<{ results?: CredentialRow[] }> };
  };
}

/**
 * 按 credRef 解一份明文凭据。任何异常（缺行、换过 masterKey、密文坏、表不存在）
 * 一律 `null` —— 不猜、不用空 Key 发请求。
 */
export async function resolveTravelCredential(args: {
  db: TravelCredentialDb;
  userId: string;
  userKey: string;
  credId: string;
}): Promise<ResolvedTravelCredential | null> {
  const { db, userId, userKey, credId } = args;
  if (!credId) return null;
  let rows: CredentialRow[] = [];
  try {
    if (typeof db.getLlmCredentials === 'function') {
      rows = await db.getLlmCredentials(userId, [credId]);
    } else if (typeof db.prepare === 'function') {
      const result = await db
        .prepare('SELECT cred_id, encrypted_value FROM llm_credentials WHERE user_id = ? AND cred_id = ?')
        .bind(userId, credId)
        .all();
      rows = result?.results ?? [];
    } else {
      return null;
    }
  } catch {
    return null;
  }
  const row = rows.find((candidate) => candidate?.cred_id === credId);
  if (!row || typeof row.encrypted_value !== 'string' || !row.encrypted_value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await decryptFromStorage(row.encrypted_value, userKey));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  const apiUrl = typeof value.apiUrl === 'string' ? value.apiUrl.trim() : '';
  const apiKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : '';
  const primaryModel = typeof value.primaryModel === 'string' ? value.primaryModel.trim() : '';
  if (!apiUrl || !apiKey || !primaryModel) return null;
  return { apiUrl, apiKey, primaryModel };
}

/**
 * 出行决策端口的凭据来源：**只用 per-user 那一行**。
 *
 * `masterKey` 缺失（worker 没配 `AMSG_MASTER_KEY`）同样算没有凭据 —— 解不开就是没有，
 * 不用 worker env 顶替。返回值里没有任何缓存/日志落点。
 */
export async function resolveTravelModelCredentialsForUser(args: {
  db: TravelCredentialDb;
  userId: string;
  charId: string;
  masterKey: string | null | undefined;
}): Promise<{ baseUrl: string; apiKey: string; model: string } | null> {
  const masterKey = typeof args.masterKey === 'string' ? args.masterKey : '';
  if (!masterKey) return null;
  let userKey: string;
  try {
    userKey = await deriveUserEncryptionKey(args.userId, masterKey);
  } catch {
    return null;
  }
  const credential = await resolveTravelCredential({
    db: args.db,
    userId: args.userId,
    userKey,
    credId: travelCredIdFor(args.charId),
  });
  if (!credential) return null;
  return {
    baseUrl: credential.apiUrl,
    apiKey: credential.apiKey,
    model: credential.primaryModel,
  };
}
