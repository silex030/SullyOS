/**
 * worker 侧测试工具（t_2c2dba79）：假 DNS + 假 Transport，全程不碰网络。
 * 文件名不含 .test，不会被 vitest 当测试收集。
 */

import type { SafeFetchDeps, TransportRequest, TransportResponse } from './safeFetch';

export interface RouteReply {
  status?: number;
  body: string;
  headers?: Record<string, string>;
}

export type Route = RouteReply | ((req: TransportRequest) => RouteReply);

export interface FakeDepsOptions {
  /** 默认解析结果（全部公网）。 */
  addresses?: string[];
  /** 按 host 定制解析结果，用来模拟 DNS 重绑定/私网域。 */
  resolver?: (host: string) => string[];
}

export function fakeDeps(routes: Record<string, Route>, opts: FakeDepsOptions = {}) {
  const calls: TransportRequest[] = [];
  const deps: SafeFetchDeps = {
    resolve: async (host: string) => (opts.resolver ? opts.resolver(host) : opts.addresses ?? ['93.184.216.34']),
    transport: async (req: TransportRequest): Promise<TransportResponse> => {
      calls.push(req);
      const u = new URL(req.url);
      const key = `${u.hostname}${u.pathname}${u.search}`;
      const keyNoQuery = `${u.hostname}${u.pathname}`;
      const route = routes[key] ?? routes[keyNoQuery];
      if (!route) throw new Error(`unexpected upstream request: ${key}`);
      const reply = typeof route === 'function' ? route(req) : route;
      return {
        status: reply.status ?? 200,
        headers: reply.headers ?? { 'content-type': 'application/json' },
        readBody: async (limitBytes: number) => {
          const text = reply.body;
          const truncated = text.length > limitBytes;
          return {
            text: truncated ? text.slice(0, limitBytes) : text,
            bytes: Math.min(text.length, limitBytes),
            truncated,
          };
        },
      };
    },
  };
  return { deps, calls };
}

/** 永远不返回、只响应 abort 的 transport：验证超时分支。 */
export function hangingTransport(never: Promise<never>): SafeFetchDeps['transport'] {
  return (req) =>
    new Promise((_resolve, reject) => {
      req.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
      void never;
    });
}
