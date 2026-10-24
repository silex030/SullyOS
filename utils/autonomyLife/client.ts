/**
 * 前端传输封装（契约 §7）：页面只调这里的方法，不手拼 URL、不自造错误码。
 *
 * transport 由部署侧注入（生产用 activeMsgClient 的实现，测试用假实现），因此本文件
 * 不依赖任何具体网络库，也能在 vitest 里直接跑。
 */

import {
  AUTONOMY_LIFE_API_BASE,
  AUTONOMY_LIFE_SCHEMA_VERSION,
  type ActivityKind,
  type ActivityRecord,
  type ApiErrorBody,
  type BoundaryScope,
  type BoundaryV1,
  type Capability,
  type CharacterLifeState,
  type EffectiveBoundaryV1,
  type LifeEvent,
} from '../../contracts/autonomyLife';

export interface TransportRequest {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  query?: Record<string, string | number | null | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface TransportResponse {
  status: number;
  body: unknown;
}

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export class AutonomyLifeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorBody['error']['code'] | 'UNKNOWN',
    message: string,
    readonly retryable = false,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AutonomyLifeApiError';
  }
}

const buildPath = (segments: string[]): string => `${AUTONOMY_LIFE_API_BASE}/${segments.filter(Boolean).join('/')}`;

const buildQuery = (query: TransportRequest['query']): string => {
  if (!query) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
};

let idempotencyCounter = 0;

function newIdempotencyKey(prefix: string): string {
  idempotencyCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idempotencyCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface AutonomyLifeClientOptions {
  transport: Transport;
  /** 安装 id（执行设备绑定）；注册/领取/许可/回执都要带。 */
  installationId: string;
}

export function createAutonomyLifeClient(opts: AutonomyLifeClientOptions) {
  const call = async <T>(request: TransportRequest): Promise<T> => {
    const response = await opts.transport({
      ...request,
      path: `${request.path}${buildQuery(request.query)}`,
    });
    const body = response.body as Record<string, any> | null;
    if (response.status >= 400 || (body && 'error' in body)) {
      const error = (body?.error ?? {}) as ApiErrorBody['error'];
      throw new AutonomyLifeApiError(
        response.status,
        (error.code as AutonomyLifeApiError['code']) ?? 'UNKNOWN',
        error.message ?? 'autonomy_life_request_failed',
        error.retryable === true,
        error.details,
      );
    }
    if (body && body.schemaVersion !== undefined && body.schemaVersion !== AUTONOMY_LIFE_SCHEMA_VERSION) {
      throw new AutonomyLifeApiError(response.status, 'AUTONOMY_UPGRADE_REQUIRED', 'schema_version_mismatch');
    }
    return body as T;
  };

  return {
    async getState(charId: string): Promise<{ state: CharacterLifeState; capabilities: Capability[] }> {
      return call({ method: 'GET', path: buildPath(['characters', charId, 'state']) });
    },

    async getBoundaries(charId?: string): Promise<{
      account: BoundaryV1;
      characterOverrides: BoundaryV1 | null;
      effective: EffectiveBoundaryV1;
      revision: number;
      defaults: Record<string, number>;
      maximums: Record<string, number>;
    }> {
      return call({ method: 'GET', path: buildPath(['boundaries']), query: { charId } });
    },

    async patchBoundaries(input: {
      scope: BoundaryScope;
      charId?: string;
      expectedRevision: number;
      changes: Record<string, unknown>;
    }): Promise<{ effective: EffectiveBoundaryV1; revision: number }> {
      return call({
        method: 'PATCH',
        path: buildPath(['boundaries']),
        body: input,
        headers: { 'Idempotency-Key': newIdempotencyKey('bnd') },
      });
    },

    async pause(input: {
      scope: BoundaryScope;
      charId?: string;
      paused: boolean;
      expectedRevision?: number;
    }): Promise<{ acknowledged: boolean; quiesced: boolean; paused: boolean; revision: number }> {
      return call({
        method: 'POST',
        path: buildPath(['pause']),
        body: input,
        headers: { 'Idempotency-Key': newIdempotencyKey('pause') },
      });
    },

    async activities(input: {
      charId: string;
      status?: string;
      limit?: number;
      cursor?: string | null;
    }): Promise<{ items: ActivityRecord[]; nextCursor: string | null }> {
      return call({ method: 'GET', path: buildPath(['activities']), query: { ...input } });
    },

    async cancel(actionId: string, expectedRevision: number): Promise<{ action: unknown }> {
      return call({
        method: 'POST',
        path: buildPath(['actions', actionId, 'cancel']),
        body: { expectedRevision },
        headers: { 'Idempotency-Key': newIdempotencyKey('cancel') },
      });
    },

    async registerDevice(capabilitiesVersion = 'v1'): Promise<{ bindingState: string }> {
      return call({
        method: 'POST',
        path: buildPath(['devices', 'register']),
        body: { installationId: opts.installationId, capabilitiesVersion },
        headers: { 'Idempotency-Key': newIdempotencyKey('dev') },
      });
    },

    async claim(charId: string): Promise<{ action: unknown; leaseEpoch: number; leaseExpiresAt: number | null }> {
      return call({
        method: 'POST',
        path: buildPath(['execution', 'claim']),
        body: { installationId: opts.installationId, charId, limit: 1 },
      });
    },

    async commitPermit(input: {
      actionId: string;
      leaseEpoch: number;
      argsHash: string;
      policyVersion: string;
    }): Promise<{ permit: { expiresAt: number; nonce: string } }> {
      return call({
        method: 'POST',
        path: buildPath(['actions', input.actionId, 'commit-permit']),
        body: { ...input, installationId: opts.installationId },
      });
    },

    async receipt(input: {
      actionId: string;
      leaseEpoch: number;
      argsHash: string;
      status: 'succeeded' | 'failed' | 'unknown';
      resultRef?: string | null;
      errorCode?: string;
    }): Promise<{ action: unknown }> {
      return call({
        method: 'POST',
        path: buildPath(['actions', input.actionId, 'receipt']),
        body: { ...input, installationId: opts.installationId },
        headers: { 'Idempotency-Key': `receipt-${input.actionId}` },
      });
    },

    async events(after: number): Promise<{
      items: LifeEvent[];
      nextSequence: number;
      hasMore: boolean;
      resyncRequired: boolean;
    }> {
      return call({ method: 'GET', path: buildPath(['events']), query: { after } });
    },

    /** 供 UI 的能力文案映射：不要把 reasonCodes 直接当句子显示。 */
    describeKind(kind: ActivityKind): string {
      const labels: Record<ActivityKind, string> = {
        'journal.write': '写日记',
        'room.plan': '整理计划',
        'room.note': '房间笔记',
        'phone.record': '查手机',
        'takeout.order': '点外卖（OS 内模拟）',
        'shopping.order': '购物（OS 内模拟）',
        'interaction.message': '主动消息',
        'travel.wish': '出行愿望',
        'external.read': '外部只读浏览',
      };
      return labels[kind] ?? kind;
    },
  };
}

export type AutonomyLifeClient = ReturnType<typeof createAutonomyLifeClient>;
