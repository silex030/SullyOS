/**
 * 测试用 D1 兼容垫片（仅测试；生产用 vps-backend/src/shim/d1.js 的 better-sqlite3 适配器）。
 *
 * 为什么用 node:sqlite 而不是假的进程 Map：本卡要求“真实 SQLite 唯一约束/版本冲突/租约恢复”
 * 有证据，Map 实现测不出 UNIQUE 与 CAS 行为。
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

// vite 的内置模块表里没有 node:sqlite（Node 22.5+ 才有的实验 API），静态 import 会被
// 它当成待解析依赖而失败。用 createRequire 在运行期拿真模块，避开打包器静态分析。
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: new (path: string) => any };

export interface TestD1 {
  prepare(sql: string): {
    bind(...args: unknown[]): any;
    run(): Promise<{ meta: { changes: number } }>;
    first<T = Record<string, unknown>>(): Promise<T | null>;
    all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  };
  exec(sql: string): Promise<{ success: true }>;
  /** 直接看某张表的行数（断言“没有重复建卡”）。 */
  count(table: string, where?: string, args?: unknown[]): number;
  close(): void;
}

export function schemaSql(): string {
  return readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
}

export function openTestD1(seedSql = schemaSql()): TestD1 {
  const db = new DatabaseSync(':memory:');
  db.exec(seedSql);

  const normalize = (args: unknown[]) => args.map((a) => (a === undefined ? null : a));

  return {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async run() {
          const info = db.prepare(sql).run(...(normalize(bound) as never[]));
          return { meta: { changes: Number(info.changes) } };
        },
        async first<T = Record<string, unknown>>() {
          const row = db.prepare(sql).get(...(normalize(bound) as never[]));
          return (row ?? null) as T | null;
        },
        async all<T = Record<string, unknown>>() {
          return { results: db.prepare(sql).all(...(normalize(bound) as never[])) as T[] };
        },
      };
      return stmt;
    },
    async exec(sql: string) {
      db.exec(sql);
      return { success: true as const };
    },
    count(table: string, where = '', args: unknown[] = []) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get(...(normalize(args) as never[])) as
        | { n: number | bigint }
        | undefined;
      return Number(row?.n ?? 0);
    },
    close() {
      db.close();
    },
  };
}
