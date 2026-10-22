/**
 * 全局自主生活护栏 · 服务端守卫（发布阻断项 6）。
 *
 * 问题（TOCTOU）：全局护栏那一行 `amsg:global/autonomy_guardrails` 是普通的
 * client_state 条目，`PUT /client-state` 按 **updatedAt last-write-wins** 覆盖。
 * 客户端那套「读基线 → 写 → 读回」只能事后发现不一致，窗口内两个设备同时保存时，
 * 后写的那种**整对象覆盖**会把远端刚按下的 `paused: true` 改成 `false` ——
 * 用户以为暂停了，后台下一跳照跑。
 *
 * 这里给服务端补两件真正的保证：
 *   1. `patchGlobalGuardrails`：**原子条件写**（CAS）。写前条件 UPDATE 带上「原值必须
 *      等于我读到的那个字符串」，0 行 = 别人先改了 → 409 conflict，本轮不写。
 *      另外「当前是暂停」时，除非调用方明确 `allowUnpause`（用户点了总开关），
 *      `paused:false` 一律保不住 —— 旧客户端整对象覆写也解不了暂停。
 *   2. `screenClientStateWrite`：泛写入口的**最后一道闸**。老客户端（或任何绕过专用路由
 *      的写入）带着 `paused:false` 打过来、而云端当前是暂停 → 直接拒写（409），
 *      行保持 paused:true。读不出当前值（缺钥/密文坏）同样拒写：证明不了「没暂停」。
 *
 * 这两条都是真的 SQL 条件写，不是「读一遍再写」——后者在并发下仍然会覆盖。
 */

import {
  decryptFromStorage,
  deriveUserEncryptionKey,
  encryptForStorage,
} from '@rei-standard/amsg-server/cloudflare';
import {
  AUTONOMY_GUARDRAIL_DEFAULTS,
  AUTONOMY_GUARDRAIL_STATE_KEY,
  AUTONOMY_GUARDRAIL_STATE_NAMESPACE,
  guardrailValuesEqual,
  normalizeAutonomyGuardrails,
  readAutonomyGuardrailStateValue,
  type AirpAutonomyGuardrails,
} from '../../../utils/airp/autonomyGuardrails';
import { unpackStateValue } from '../../../utils/amsgFirePack';
import type { AutonomyDb } from './autonomyStore';

const changesOf = (result: unknown): number => {
  const changes = (result as { changes?: unknown })?.changes;
  return typeof changes === 'number' && Number.isFinite(changes) ? changes : 0;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 云端那一行的当前状态：**缺行**与**读坏**必须分开（读坏不许当默认值）。 */
export type GuardrailRowState =
  | { kind: 'absent'; raw: null }
  | { kind: 'ok'; raw: string; value: AirpAutonomyGuardrails }
  | { kind: 'unreadable'; raw: string | null; error: string };

export async function readGuardrailRow(args: {
  db: AutonomyDb;
  masterKey: string;
  userId: string;
}): Promise<GuardrailRowState> {
  if (!args.masterKey) return { kind: 'unreadable', raw: null, error: 'missing-master-key' };
  try {
    const row = await args.db
      .prepare('SELECT value FROM client_state WHERE user_id = ? AND namespace = ? AND key = ?')
      .bind(args.userId, AUTONOMY_GUARDRAIL_STATE_NAMESPACE, AUTONOMY_GUARDRAIL_STATE_KEY)
      .first();
    if (row == null) return { kind: 'absent', raw: null };
    const raw = (row as { value?: unknown }).value;
    if (typeof raw !== 'string' || !raw) return { kind: 'unreadable', raw: null, error: 'empty-value' };
    const userKey = await deriveUserEncryptionKey(args.userId, args.masterKey);
    const plain = await unpackStateValue(await decryptFromStorage(raw, userKey));
    const parsed = readAutonomyGuardrailStateValue(plain);
    if (parsed.kind !== 'ok') return { kind: 'unreadable', raw, error: `bad-shape:${parsed.kind}` };
    return { kind: 'ok', raw, value: parsed.value };
  } catch (error) {
    return {
      kind: 'unreadable',
      raw: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 写前基线：`absent` = 期望云端没有这一行；`value` = 期望云端恰好是这一份。 */
export type GuardrailExpected =
  | { kind: 'absent' }
  | { kind: 'value'; value: AirpAutonomyGuardrails };

/**
 * 客户端传上来的期望基线 → 结构化。`null` = 客户端没给基线（只靠暂停粘性 + CAS）；
 * `'invalid'` = 给了但形状不对 —— 调用方应当直接 400，不能把坏基线当成「没给」。
 */
export function normalizeGuardrailExpected(raw: unknown): GuardrailExpected | null | 'invalid' {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) return 'invalid';
  if (raw.kind === 'absent') return { kind: 'absent' };
  if (raw.kind === 'value') {
    const value = readAutonomyGuardrailStateValue(
      typeof raw.value === 'string' ? raw.value : JSON.stringify(raw.value ?? null),
    );
    if (value.kind !== 'ok') return 'invalid';
    return { kind: 'value', value: value.value };
  }
  return 'invalid';
}

export interface GuardrailPatchArgs {
  db: AutonomyDb;
  masterKey: string;
  userId: string;
  /** 只合并用户改过的字段（不接受整对象语义）。 */
  patch: unknown;
  expected?: GuardrailExpected | null;
  /** 用户**明确**要求解除暂停（只能来自总开关那一次点击）。 */
  allowUnpause?: boolean;
  nowMs: number;
}

export interface GuardrailPatchResult {
  ok: boolean;
  status: 'ok' | 'conflict' | 'unreadable' | 'invalid';
  /** 写入成功后的值；冲突时是云端当前值（读得出来才有）。 */
  value: AirpAutonomyGuardrails | null;
  /** 基线是暂停、调用方没有明确解暂停意图 → paused 被保住。 */
  unpauseIgnored?: boolean;
  error?: string;
}

/** 只接受契约里的键：模型/旧客户端塞进来的预算、权限、工具名一律丢掉。 */
const CONTRACT_KEYS = ['perCharPerDay', 'sameKindMinGapMinutes', 'globalPerDay', 'reserveTokensPerRun', 'paused'] as const;

const pickPatch = (raw: unknown): Record<string, unknown> | null => {
  if (!isRecord(raw)) return null;
  const out: Record<string, unknown> = {};
  for (const key of CONTRACT_KEYS) {
    if (raw[key] !== undefined) out[key] = raw[key];
  }
  return Object.keys(out).length > 0 ? out : null;
};

/**
 * 原子 CAS 写入：条件里带上「我读到的原值」，0 行 = 期间被别人改过 → 冲突。
 * 缺行时用 INSERT ... ON CONFLICT DO NOTHING（同样 0 行 = 别人刚建了）。
 */
const casWrite = async (args: {
  db: AutonomyDb;
  userId: string;
  nextAtRest: string;
  previousRaw: string | null;
  nowMs: number;
}): Promise<number> => {
  if (args.previousRaw == null) {
    const inserted = await args.db
      .prepare(
        `INSERT INTO client_state (user_id, namespace, key, value, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, namespace, key) DO NOTHING`,
      )
      .bind(
        args.userId,
        AUTONOMY_GUARDRAIL_STATE_NAMESPACE,
        AUTONOMY_GUARDRAIL_STATE_KEY,
        args.nextAtRest,
        args.nowMs,
      )
      .run();
    return changesOf(inserted);
  }
  const updated = await args.db
    .prepare(
      `UPDATE client_state SET value = ?, updated_at = ?
        WHERE user_id = ? AND namespace = ? AND key = ? AND value = ?`,
    )
    .bind(
      args.nextAtRest,
      args.nowMs,
      args.userId,
      AUTONOMY_GUARDRAIL_STATE_NAMESPACE,
      AUTONOMY_GUARDRAIL_STATE_KEY,
      args.previousRaw,
    )
    .run();
  return changesOf(updated);
};

/**
 * 合并 + 写入（原子）。返回的是**真实落库结果**，不是「我打算写什么」。
 *
 * 语义：
 * - 当前行读坏 / 换钥 → `unreadable`，一个字都不写（证明不了用户没暂停）；
 * - 期望基线与云端不一致 → `conflict`，一个字都不写（带回云端当前值）；
 * - 当前是暂停、patch 想 `paused:false`、没有 `allowUnpause` → 保住暂停并标 `unpauseIgnored`
 *   （不是失败：其余字段照样写进去）；
 * - 写的时候条件 UPDATE 0 行 → `conflict`（并发覆盖的最后一道保险）。
 */
export async function patchGlobalGuardrails(args: GuardrailPatchArgs): Promise<GuardrailPatchResult> {
  const patch = pickPatch(args.patch);
  if (!patch) return { ok: false, status: 'invalid', value: null, error: 'empty-patch' };

  const row = await readGuardrailRow({ db: args.db, masterKey: args.masterKey, userId: args.userId });
  if (row.kind === 'unreadable') {
    return { ok: false, status: 'unreadable', value: null, error: row.error };
  }

  if (args.expected) {
    if (args.expected.kind === 'absent') {
      if (row.kind !== 'absent') {
        return {
          ok: false, status: 'conflict',
          value: row.kind === 'ok' ? row.value : null,
          error: 'expected-absent',
        };
      }
    } else if (row.kind !== 'ok' || !guardrailValuesEqual(row.value, args.expected.value)) {
      return {
        ok: false, status: 'conflict',
        value: row.kind === 'ok' ? row.value : null,
        error: 'expected-value-mismatch',
      };
    }
  }

  const base = row.kind === 'ok' ? row.value : { ...AUTONOMY_GUARDRAIL_DEFAULTS };
  const merged = normalizeAutonomyGuardrails({ ...base, ...patch });
  let unpauseIgnored = false;
  if (merged.paused === false && base.paused === true && args.allowUnpause !== true) {
    merged.paused = true;
    unpauseIgnored = true;
  }

  const nextValue = JSON.stringify(merged);
  let nextAtRest: string;
  try {
    const userKey = await deriveUserEncryptionKey(args.userId, args.masterKey);
    nextAtRest = await encryptForStorage(nextValue, userKey);
  } catch (error) {
    return {
      ok: false, status: 'unreadable', value: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const changes = await casWrite({
    db: args.db,
    userId: args.userId,
    nextAtRest,
    previousRaw: row.kind === 'ok' ? row.raw : null,
    nowMs: args.nowMs,
  });
  if (changes !== 1) {
    const fresh = await readGuardrailRow({ db: args.db, masterKey: args.masterKey, userId: args.userId });
    return {
      ok: false, status: 'conflict',
      value: fresh.kind === 'ok' ? fresh.value : null,
      error: 'cas-lost',
    };
  }

  return { ok: true, status: 'ok', value: merged, ...(unpauseIgnored ? { unpauseIgnored: true } : {}) };
}

// ─── 泛写入口的最后一道闸（旧客户端 / 绕过专用路由的写入） ──────────────────

export interface ClientStateWriteEntry {
  namespace?: unknown;
  key?: unknown;
  value?: unknown;
}

export type ClientStateWriteScreen =
  | { blocked: false }
  | { blocked: true; reason: 'unpause-blocked' | 'unreadable-guardrail'; message: string };

/**
 * 拦「普通保存把远端暂停改回未暂停」。
 *
 * 只对**全局护栏那一行**生效；其它条目（fire_pack / tool_config / 角色状态…）原样放行。
 * 放行的条件：
 * - 这次写入不带全局护栏行；或
 * - 云端当前没有这一行 / 当前不是暂停；或
 * - 写入本身也是暂停（不会解暂停）；或
 * - 调用方带明确的解暂停意图（专用路由/总开关），由上层传入 `allowUnpause`。
 *
 * 云端读坏（缺钥/密文坏）一律拒写：证明不了「没暂停」时，宁可这次保存失败，
 * 也不能让一行坏数据被「默认未暂停」盖过去。
 */
export async function screenClientStateWrite(args: {
  db: AutonomyDb;
  masterKey: string;
  userId: string;
  entries: readonly ClientStateWriteEntry[];
  allowUnpause: boolean;
}): Promise<ClientStateWriteScreen> {
  const guardrailEntry = args.entries.find(
    (entry) => entry?.namespace === AUTONOMY_GUARDRAIL_STATE_NAMESPACE
      && entry?.key === AUTONOMY_GUARDRAIL_STATE_KEY,
  );
  if (!guardrailEntry) return { blocked: false };
  if (args.allowUnpause) return { blocked: false };

  const incoming = readAutonomyGuardrailStateValue(guardrailEntry.value);
  // 不是「明确要求未暂停」的写入，不构成解暂停风险（暂停→暂停、坏值→坏值都不拦）。
  if (incoming.kind !== 'ok' || incoming.value.paused !== false) return { blocked: false };

  const row = await readGuardrailRow({ db: args.db, masterKey: args.masterKey, userId: args.userId });
  if (row.kind === 'unreadable') {
    return {
      blocked: true,
      reason: 'unreadable-guardrail',
      message: '云端护栏配置现在读不出来，不能确认是否暂停；这次保存已拒绝（没有写入）。',
    };
  }
  if (row.kind === 'ok' && row.value.paused === true) {
    return {
      blocked: true,
      reason: 'unpause-blocked',
      message: '云端当前的自主生活是暂停状态；要恢复请在本机设置页明确打开总开关（普通保存不能解除暂停）。',
    };
  }
  return { blocked: false };
}
