/**
 * 首期活动窗口的受控适配器：describeCapabilities → validateIntent → prepare →
 * execute → reconcile → project（契约 §6 末段）。
 *
 * 能力门槛是这个文件的核心：**"纳入首期"≠"已接通"**。
 *   - 内部窗口（日记/房间/查手机/模拟外卖·购物/互动消息）只要本地 store 在、执行设备绑定、
 *     策略通过 → available；
 *   - 外部窗口默认关闭：external.read 需要「服务端适配器已配置 + 连接自检通过 + 用户只读授权」，
 *     travel.wish 需要地图凭据与授权，任一条不满足就 unavailable 并给出**系统原因**；
 *   - 真实支付、真实发帖/评论/私信、任意网页抓取、跨设备同步 → 永远 CAPABILITY_UNAVAILABLE，
 *     UI 不得生成假确认按钮。
 *
 * execute() 只有在拿到本地事务回执后才算 succeeded；等待设备/缺凭据都返回明确的不执行结果，
 * 绝不生成「故事」冒充执行。
 */

import {
  KIND_EXECUTION_MODE,
  KIND_SCOPE,
  type ActivityKind,
  type AutonomyLifeErrorCode,
  type Capability,
  type EffectiveBoundaryV1,
  type ExecuteContext,
  type ExecuteResult,
  type PreparedEffect,
} from '../../contracts/autonomyLife';
import { boundaryGate } from './boundary';
import { toLocalPermit } from './executionPermit';
import {
  placeSimulatedOrder,
  refundSimulatedOrder,
  writeExternalRead,
  writeInteractionMessage,
  writeJournalEntry,
  writePhoneRecord,
  writeRoomNote,
  writeRoomPlan,
  writeTravelWish,
  type LocalDbPort,
  type LocalWriteOutcome,
} from './localLedger';
import {
  checkContentPolicy,
  checkIntentPolicy,
  validateArgsForKind,
  type PolicyBoundaryView,
} from './policy';

export interface CapabilityProbeState {
  localStoresReady: boolean;
  deviceBound: boolean;
  hasModelCredentials: boolean;
  externalRead: { configured: boolean; reachable: boolean; reason?: string };
  map: { configured: boolean; reachable: boolean; reason?: string };
}

export type UnavailableReason =
  | 'local_stores_missing'
  | 'device_unbound'
  | 'missing_credentials'
  | 'map_not_configured'
  | 'external_adapter_not_configured'
  | 'external_adapter_unreachable'
  | 'grant_missing'
  | 'policy_denied'
  | 'not_implemented';

const APP_ID: Record<ActivityKind, string> = {
  'journal.write': 'journal',
  'room.plan': 'room',
  'room.note': 'room',
  'phone.record': 'phone',
  'takeout.order': 'takeout',
  'shopping.order': 'shopping',
  'interaction.message': 'chat',
  'travel.wish': 'travel',
  'external.read': 'xhs',
};

const REQUIRES_GRANT: Record<ActivityKind, boolean> = {
  'journal.write': false,
  'room.plan': false,
  'room.note': false,
  'phone.record': false,
  'takeout.order': false,
  'shopping.order': false,
  'interaction.message': false,
  'travel.wish': true,
  'external.read': true,
};

/** 首期永远不开放的真实副作用（明确列出，避免以后被顺手打开）。 */
export const NEVER_AUTONOMOUS_KINDS = [
  'payment.transfer',
  'payment.purchase',
  'social.publish',
  'social.comment',
  'social.dm',
  'web.fetch.arbitrary',
] as const;

export function capabilityUnavailable(kind: string): { code: 'CAPABILITY_UNAVAILABLE'; kind: string } {
  return { code: 'CAPABILITY_UNAVAILABLE', kind };
}

function grantActive(boundary: EffectiveBoundaryV1, provider: 'xhs' | 'amap', nowMs: number): boolean {
  return boundary.externalGrants.some((grant) => grant.provider === provider && grant.expiresAt > nowMs);
}

/** 能力表：逐 kind 给 available / enabled / 原因（总状态不吞掉其它限制）。 */
export function describeCapabilities(input: {
  boundary: EffectiveBoundaryV1;
  probes: CapabilityProbeState;
  nowMs: number;
}): Capability[] {
  const { boundary, probes, nowMs } = input;
  return (Object.keys(APP_ID) as ActivityKind[]).map((kind) => {
    const requiresGrant = REQUIRES_GRANT[kind];
    const enabled = boundary.allowedKinds.includes(kind);
    let unavailableReason: UnavailableReason | undefined;
    if (!probes.localStoresReady) unavailableReason = 'local_stores_missing';
    else if (!probes.deviceBound) unavailableReason = 'device_unbound';
    else if (!probes.hasModelCredentials) unavailableReason = 'missing_credentials';
    // 外部窗口先报「服务侧配没配/通不通」，再报「用户授没授权」：前者是系统原因，
    // 后者才是用户可操作的原因，顺序反了会把「地图未配置」说成「你没授权」。
    else if (kind === 'external.read') {
      if (!probes.externalRead.configured) unavailableReason = 'external_adapter_not_configured';
      else if (!probes.externalRead.reachable) unavailableReason = 'external_adapter_unreachable';
      else if (!grantActive(boundary, 'xhs', nowMs)) unavailableReason = 'grant_missing';
    } else if (kind === 'travel.wish') {
      if (!probes.map.configured) unavailableReason = 'map_not_configured';
      else if (!probes.map.reachable) unavailableReason = 'external_adapter_unreachable';
      else if (!grantActive(boundary, 'amap', nowMs)) unavailableReason = 'grant_missing';
    }
    const available = !unavailableReason;
    return {
      kind,
      appId: APP_ID[kind],
      available,
      enabled: enabled && available,
      executionMode: KIND_EXECUTION_MODE[kind],
      requiresForeground: KIND_EXECUTION_MODE[kind] === 'local',
      requiresGrant,
      ...(unavailableReason ? { unavailableReason } : {}),
    };
  });
}

export interface AdapterIntentInput {
  kind: ActivityKind;
  charId: string;
  args: Record<string, unknown>;
  boundary: EffectiveBoundaryV1;
  nowMs: number;
  tz: string;
  classify?: (text: string) => { verdict: 'blocked' | 'allowed' } | { error: string };
  requireClassifier?: boolean;
}

export type AdapterValidateResult =
  | { ok: true; prepared: PreparedEffect; args: Record<string, unknown> }
  | { ok: false; code: AutonomyLifeErrorCode; reason: string };

const policyView = (boundary: EffectiveBoundaryV1): PolicyBoundaryView => ({
  forbiddenCategories: boundary.forbiddenCategories,
  avoidTopics: boundary.avoidTopics,
  allowFictionalNpc: boundary.allowFictionalNpc,
  externalGrants: boundary.externalGrants,
});

/**
 * validateIntent + prepare：**执行前**的第二道强校验（第一道在计划登记时）。
 * 只读计算总额/权限/摘要，不写任何东西。
 */
export function validateAndPrepare(input: AdapterIntentInput): AdapterValidateResult {
  const gate = boundaryGate(input.boundary, input.kind);
  if (!gate.ok) return { ok: false, code: gate.code, reason: gate.code };

  const decision = checkIntentPolicy(
    {
      kind: input.kind,
      args: input.args,
      purpose: String(input.args.__purpose ?? ''),
      boundary: policyView(input.boundary),
      classify: input.classify,
      requireClassifier: input.requireClassifier,
    },
    input.nowMs,
  );
  if (!decision.allowed) {
    return {
      ok: false,
      code: decision.reasonCode === 'grant_missing' ? 'GRANT_REQUIRED' : 'POLICY_DENIED',
      reason: decision.reasonCode ?? 'policy_denied',
    };
  }

  const argCheck = validateArgsForKind(input.kind, input.args);
  if (!argCheck.ok) return { ok: false, code: 'VALIDATION_FAILED', reason: argCheck.reasonCode ?? 'bad_args' };

  if (input.kind === 'takeout.order' || input.kind === 'shopping.order') {
    const items = Array.isArray(input.args.items) ? (input.args.items as Array<Record<string, unknown>>) : [];
    let subtotal = 0;
    for (const item of items) {
      const price = item.unitPriceMinor;
      const qty = item.qty;
      if (typeof price !== 'number' || !Number.isInteger(price) || price < 0) {
        return { ok: false, code: 'VALIDATION_FAILED', reason: 'bad_price' };
      }
      if (typeof qty !== 'number' || !Number.isInteger(qty) || qty <= 0) {
        return { ok: false, code: 'VALIDATION_FAILED', reason: 'bad_qty' };
      }
      subtotal += price * qty;
    }
    const fee = typeof input.args.deliveryFeeMinor === 'number' ? input.args.deliveryFeeMinor : 0;
    const total = subtotal + fee;
    if (!Number.isSafeInteger(total) || total <= 0) return { ok: false, code: 'VALIDATION_FAILED', reason: 'bad_total' };
    if (!String(input.args.addressText ?? '').trim()) {
      return { ok: false, code: 'VALIDATION_FAILED', reason: 'empty_address' };
    }
    return {
      ok: true,
      args: input.args,
      prepared: {
        summary: `${input.args.shopName ?? '店铺'} × ${items.reduce((sum, item) => sum + Number(item.qty ?? 0), 0)} 件（含配送费，OS 内模拟）`,
        spendMinor: total,
        resourceHints: { orderTotalMinor: String(total) },
      },
    };
  }

  if (input.kind === 'external.read') {
    // 授权必须**当前有效**：过期/撤销的 grant 不算（不只是「曾经给过」）。
    const grant = input.boundary.externalGrants.find(
      (item) => item.provider === 'xhs' && item.expiresAt > input.nowMs,
    );
    if (!grant) return { ok: false, code: 'GRANT_REQUIRED', reason: 'grant_missing' };
    const query = String(input.args.query ?? '').trim();
    if (!query) return { ok: false, code: 'VALIDATION_FAILED', reason: 'query_required' };
    if (query.length > EXTERNAL_MAX_QUERY_LEN) {
      return { ok: false, code: 'VALIDATION_FAILED', reason: 'query_too_long' };
    }
    // 只发用户允许的字段：查询词里出现聊天全文/地址/联系方式特征就拦。
    if (/(https?:\/\/|@|地址|电话|身份证|密码|token)/i.test(query)) {
      return { ok: false, code: 'POLICY_DENIED', reason: 'pii_in_query' };
    }
    const requestedFields = Array.isArray(input.args.fields)
      ? (input.args.fields as unknown[]).filter((item): item is string => typeof item === 'string')
      : [];
    // 授权里的 allowedFieldKeys 约束的是**外传内容**（本次只外传 query），不是回传字段。
    if (grant.allowedFieldKeys.length > 0 && !grant.allowedFieldKeys.includes('query')) {
      return { ok: false, code: 'GRANT_REQUIRED', reason: 'query_not_allowed_by_grant' };
    }
    // 回传字段 = 用户要求 ∩ 平台白名单（响应投影只发生在服务端，见 worker external.ts）。
    const fields = (requestedFields.length ? requestedFields : [...EXTERNAL_FIELD_ALLOWLIST.xhs.slice(0, 4)])
      .filter((field) => (EXTERNAL_FIELD_ALLOWLIST.xhs as readonly string[]).includes(field));
    if (fields.length === 0) return { ok: false, code: 'VALIDATION_FAILED', reason: 'fields_not_allowed' };
    // 注意：**不改写 args**。许可签的是模型给的参数；grant 绑定/字段投影是执行期的
    // 派生身份信息，写进 args 会让「被批准的参数」与「实际参数」hash 错位。
    return {
      ok: true,
      args: input.args,
      prepared: {
        summary: `只读检索「${query.slice(0, 24)}」`,
        resourceHints: { provider: 'xhs', fields: fields.slice(0, EXTERNAL_MAX_FIELDS).join(','), grantExpiresAt: String(grant.expiresAt) },
      },
    };
  }

  if (input.kind === 'travel.wish') {
    const grant = input.boundary.externalGrants.find(
      (item) => item.provider === 'amap' && item.expiresAt > input.nowMs,
    );
    if (!grant) return { ok: false, code: 'GRANT_REQUIRED', reason: 'grant_missing' };
    const text = String(input.args.wishText ?? '').trim();
    if (!text) return { ok: false, code: 'VALIDATION_FAILED', reason: 'wish_required' };
    if (text.length > 200) return { ok: false, code: 'VALIDATION_FAILED', reason: 'wish_too_long' };
    return {
      ok: true,
      args: input.args,
      prepared: {
        summary: '提一个出行愿望，交给出行状态机推进',
        resourceHints: { provider: 'amap', grantExpiresAt: String(grant.expiresAt) },
      },
    };
  }

  const summaryByKind: Record<string, string> = {
    'journal.write': '写一篇私人日记',
    'room.plan': '整理今日待办',
    'room.note': '留一条房间笔记',
    'phone.record': '记一条角色生活模拟',
    'interaction.message': '主动发一条消息',
  };
  return { ok: true, args: input.args, prepared: { summary: summaryByKind[input.kind] ?? input.kind } };
}

/** 外部只读窗口允许的字段（超出即拒；默认只取前 4 个）。 */
export const EXTERNAL_FIELD_ALLOWLIST = {
  xhs: ['title', 'excerpt', 'author', 'likes', 'url'],
  amap: ['name', 'address', 'distanceM', 'category'],
} as const;
export const EXTERNAL_MAX_ITEMS = 5;
export const EXTERNAL_MAX_FIELDS = 5;
export const EXTERNAL_MAX_QUERY_LEN = 80;

export type ExternalProvider = keyof typeof EXTERNAL_FIELD_ALLOWLIST;

/**
 * 受控外部窗口的端口。**真正的网络访问不在执行器里**：
 *   - 浏览器执行器通过 worker 的 `/external/read` 走服务端白名单 fetch（SSRF 防线在服务端）；
 *   - 本接口只负责「把投影后的结果拿回来」，不接触 URL，也没有任意抓取能力。
 */
export interface ExternalWindowPort {
  read(input: {
    provider: ExternalProvider;
    query: string;
    fields: readonly string[];
    charId: string;
    grantId: string;
    nowMs: number;
  }): Promise<
    | { ok: true; items: Array<Record<string, string | number>>; fetchedAt: number }
    | { ok: false; code: AutonomyLifeErrorCode; reason: string }
  >;
  submitWish(input: {
    charId: string;
    text: string;
    grantId: string;
    nowMs: number;
  }): Promise<{ ok: true; wishId: string } | { ok: false; code: AutonomyLifeErrorCode; reason: string }>;
}

export interface ExecuteDeps {
  port: LocalDbPort;
  /** 策略版本：许可里绑定，执行时不许悄悄换。 */
  policyVersion: string;
  tz: string;
  /** 外部窗口端口；缺省 = 未配置（明确不可执行，不假装做到）。 */
  external?: ExternalWindowPort | null;
}

export type ExecuteOutcome =
  | { status: 'succeeded'; resultRef: string; effectVerified: true }
  | { status: 'failed'; code: AutonomyLifeErrorCode; message: string; effectVerified: false }
  | { status: 'unknown'; code: 'UNKNOWN_EFFECT'; message: string; effectVerified: false };

function fromLocalWrite(outcome: LocalWriteOutcome): ExecuteOutcome {
  if (outcome.status === 'succeeded') {
    return { status: 'succeeded', resultRef: outcome.receipt.resultRef ?? '', effectVerified: true };
  }
  if (outcome.code === 'UNKNOWN_EFFECT') {
    // 事务 abort 但没法确认到底有没有落地：报 unknown，等对账，不盲目重试。
    return { status: 'unknown', code: 'UNKNOWN_EFFECT', message: outcome.message, effectVerified: false };
  }
  return { status: 'failed', code: outcome.code, message: outcome.message, effectVerified: false };
}

/**
 * execute：只接受「已核验执行上下文 + 一次性许可 + 原 actionId」。
 * 所有副作用都在本地事务里；许可在同一个事务里核销，回执写入成功才算 succeeded。
 *
 * 许可门放在这里而不是只放 runLocalAction：这是**最后一个**可达的副作用入口，
 * 任何新调用点（比如未来的 worker 端执行器）都会被同一道门拦。
 */
export async function executeAction(
  ctx: ExecuteContext,
  deps: ExecuteDeps,
): Promise<ExecuteOutcome> {
  if (!ctx.permit) {
    return { status: 'failed', code: 'STATE_CONFLICT', message: 'permit_required', effectVerified: false };
  }
  if (
    ctx.permit.actionId !== ctx.actionId
    || ctx.permit.argsHash !== ctx.argsHash
    || ctx.permit.leaseEpoch !== ctx.leaseEpoch
    || ctx.permit.installationId !== ctx.installationId
    || ctx.permit.policyVersion !== ctx.policyVersion
  ) {
    return { status: 'failed', code: 'STATE_CONFLICT', message: 'permit_mismatch', effectVerified: false };
  }
  const common = {
    actionId: ctx.actionId,
    kind: ctx.kind,
    args: ctx.args,
    nowMs: ctx.nowMs,
    // 事务内核销的凭据：动作可能写入多个 store，许可只跟着这一次执行。
    permit: toLocalPermit(ctx.permit),
  };
  switch (ctx.kind) {
    case 'journal.write': {
      const args = ctx.args as Record<string, never> & {
        charId: string; title: string; body: string; mood?: string; tags?: string[];
        entryType?: 'private' | 'exchange'; date?: string;
      };
      if (!args.charId) return { status: 'failed', code: 'VALIDATION_FAILED', message: 'charId_required', effectVerified: false };
      // 不再在这里补 date：许可/回执签名的是**模型给的参数**，执行期临时补字段会让
      // 「被批准的参数」与「写入的参数」hash 错位。日期由本地写入口按时区派生（只影响
      // 记录内容，不参与签名）。
      const outcome = await writeJournalEntry(deps.port, {
        ...common,
        kind: ctx.kind,
        args,
        tz: deps.tz,
      });
      return fromLocalWrite(outcome);
    }
    case 'room.plan': {
      const args = ctx.args as unknown as { charId: string; items: string[]; mood?: string };
      if (!args.charId) return { status: 'failed', code: 'VALIDATION_FAILED', message: 'charId_required', effectVerified: false };
      return fromLocalWrite(await writeRoomPlan(deps.port, { ...common, kind: ctx.kind, args }, deps.tz));
    }
    case 'room.note': {
      const args = ctx.args as unknown as { charId: string; content: string; noteType?: string };
      if (!args.charId) return { status: 'failed', code: 'VALIDATION_FAILED', message: 'charId_required', effectVerified: false };
      return fromLocalWrite(await writeRoomNote(deps.port, { ...common, kind: ctx.kind, args }));
    }
    case 'phone.record': {
      const args = ctx.args as unknown as {
        charId: string; with: string; summary: string;
        channel?: 'chat' | 'call' | 'sms'; durationMinutes?: number; fictionalNpc?: boolean;
      };
      if (!args.charId) return { status: 'failed', code: 'VALIDATION_FAILED', message: 'charId_required', effectVerified: false };
      return fromLocalWrite(await writePhoneRecord(deps.port, { ...common, kind: ctx.kind, args }));
    }
    case 'interaction.message': {
      const args = ctx.args as unknown as { charId: string; text: string; style?: string; shareable?: boolean };
      if (!args.charId) return { status: 'failed', code: 'VALIDATION_FAILED', message: 'charId_required', effectVerified: false };
      return fromLocalWrite(await writeInteractionMessage(deps.port, { ...common, kind: ctx.kind, args }));
    }
    case 'takeout.order':
    case 'shopping.order': {
      const args = ctx.args as unknown as {
        charId: string; orderId: string; shopId: string; shopName: string; shopCat: string;
        category: string; items: Array<{ dishId: string; name: string; unitPriceMinor: number; qty: number }>;
        addressText: string; deliveryFeeMinor: number; cardId: string;
      };
      if (!args.charId || !args.orderId || !args.cardId) {
        return { status: 'failed', code: 'VALIDATION_FAILED', message: 'missing_order_fields', effectVerified: false };
      }
      return fromLocalWrite(await placeSimulatedOrder(deps.port, { ...common, kind: ctx.kind, args }));
    }
    case 'external.read': {
      if (!deps.external) {
        return { status: 'failed', code: 'CAPABILITY_UNAVAILABLE', message: 'external_window_unconfigured', effectVerified: false };
      }
      const args = ctx.args as unknown as { charId: string; query: string; fields?: string[] };
      if (!args.charId || !args.query) {
        return { status: 'failed', code: 'VALIDATION_FAILED', message: 'external_args_missing', effectVerified: false };
      }
      const provider: ExternalProvider = 'xhs';
      const requested = Array.isArray(args.fields) ? args.fields : [];
      const fields = (requested.length ? requested : [...EXTERNAL_FIELD_ALLOWLIST[provider].slice(0, 4)])
        .filter((field) => (EXTERNAL_FIELD_ALLOWLIST[provider] as readonly string[]).includes(field));
      const read = await deps.external.read({
        provider,
        query: args.query,
        fields,
        charId: args.charId,
        // 授权 id 只作审计提示：真正的授权校验在 validateAndPrepare（现读边界）与服务端。
        grantId: `grant:${provider}:${ctx.nowMs}`,
        nowMs: ctx.nowMs,
      });
      if (!read.ok) {
        return { status: 'failed', code: read.code, message: read.reason, effectVerified: false };
      }
      return fromLocalWrite(await writeExternalRead(deps.port, {
        ...common,
        kind: ctx.kind,
        // 许可签的是模型给的 query/fields；读取结果只是业务记录，不参与签名。
        signedArgs: ctx.args,
        args: {
          charId: args.charId,
          provider,
          query: args.query,
          items: read.items,
          fetchedAt: read.fetchedAt,
          grantId: `grant:${provider}:${ctx.nowMs}`,
        },
      }));
    }
    case 'travel.wish': {
      if (!deps.external) {
        return { status: 'failed', code: 'CAPABILITY_UNAVAILABLE', message: 'external_window_unconfigured', effectVerified: false };
      }
      const args = ctx.args as unknown as { charId: string; wishText?: string };
      const text = String(args.wishText ?? '').trim();
      if (!args.charId || !text) {
        return { status: 'failed', code: 'VALIDATION_FAILED', message: 'wish_args_missing', effectVerified: false };
      }
      const wish = await deps.external.submitWish({
        charId: args.charId,
        text,
        grantId: `grant:amap:${ctx.nowMs}`,
        nowMs: ctx.nowMs,
      });
      if (!wish.ok) {
        return { status: 'failed', code: wish.code, message: wish.reason, effectVerified: false };
      }
      return fromLocalWrite(await writeTravelWish(deps.port, {
        ...common,
        kind: ctx.kind,
        signedArgs: ctx.args,
        args: { charId: args.charId, text, wishId: wish.wishId, grantId: `grant:amap:${ctx.nowMs}` },
      }));
    }
    default:
      return { status: 'failed', code: 'CAPABILITY_UNAVAILABLE', message: 'unknown_kind', effectVerified: false };
  }
}

/** 退款：独立、有审计的补偿动作（不是通用 rollback）。 */
export async function compensateRefund(args: {
  port: LocalDbPort;
  actionId: string;
  charId: string;
  orderId: string;
  reason?: string;
  nowMs: number;
}): Promise<ExecuteOutcome> {
  return fromLocalWrite(
    await refundSimulatedOrder(args.port, {
      actionId: args.actionId,
      kind: 'shopping.order',
      nowMs: args.nowMs,
      // 退款是**用户发起**的补偿动作（取消订单/对账善后），不是自主动作：
      // 它不复用自主动作的许可，但仍然是同事务、可审计、幂等的本地写。
      allowPermitless: true,
      args: { charId: args.charId, orderId: args.orderId, reason: args.reason },
    }),
  );
}

/** 对账：查本地回执，决定 succeeded / confirmed_no_effect / unknown。 */
export async function reconcileAction(args: {
  port: LocalDbPort;
  actionId: string;
  argsHash: string;
}): Promise<{ status: 'succeeded' | 'confirmed_no_effect' | 'unknown'; resultRef?: string }> {
  const receipt = await args.port
    .runTransaction(['autonomy_action_receipts'], 'readonly', async (tx) =>
      tx.get<{ argsHash: string; resultRef: string | null }>('autonomy_action_receipts', args.actionId))
    .catch(() => null);
  if (receipt) {
    if (receipt.argsHash !== args.argsHash) return { status: 'unknown' };
    return { status: 'succeeded', resultRef: receipt.resultRef ?? undefined };
  }
  return { status: 'unknown' };
}

/** 投影：ActivityRecord 的 effectVerified 只认回执 + 业务记录可解析。 */
export function projectEffectVerified(outcome: ExecuteOutcome): boolean {
  return outcome.status === 'succeeded' && outcome.effectVerified;
}

/** 内容侧最后一道检查（写进日记/消息之前）。 */
export function finalContentCheck(text: string, boundary: EffectiveBoundaryV1): { ok: boolean; reason?: string } {
  const decision = checkContentPolicy(text, policyView(boundary));
  return decision.allowed ? { ok: true } : { ok: false, reason: decision.reasonCode };
}

/** 真实交易的统一答复：永远 CAPABILITY_UNAVAILABLE（无假确认按钮）。 */
export function describeNeverAutonomous(): Array<{ kind: string; code: 'CAPABILITY_UNAVAILABLE'; message: string }> {
  return NEVER_AUTONOMOUS_KINDS.map((kind) => ({
    kind,
    code: 'CAPABILITY_UNAVAILABLE' as const,
    message: '本期未开放：真实支付/发布/任意网络抓取不可自动执行',
  }));
}
