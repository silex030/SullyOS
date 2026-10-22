/**
 * 测试用最小 D1 适配器（真 SQL，不是假库）。
 *
 * 为什么需要：护栏的保证是「**条件 UPDATE** 0 行 = 冲突」。只记录 SQL 文本的假库只能
 * 证明「我写了 WHERE」，证明不了「并发下真的没覆盖」。这里用 node:sqlite（Node ≥22
 * 自带）跑真语句，`changes` 就是真值。仅在测试里用，不进任何生产路径。
 */

import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

// vitest(vite) 会把静态 `node:sqlite` 解析成裸 `sqlite` 然后找不到；运行时 require
// 走 Node 自己的解析，测试里够用，也不必为此改全局 vitest 配置。
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
};

export type TestSqlite = DatabaseSyncType;

export interface D1DoubleHooks {
  /** 每条语句执行**之前**的钩子：用来在特定语句执行前插入「另一台设备」的写入。 */
  beforeStatement?: (sql: string) => void;
}

const normalizeParams = (args: unknown[]): unknown[] =>
  args.map((value) => {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value as any;
  });

export function createSqliteD1(sql: TestSqlite, hooks: D1DoubleHooks = {}) {
  return {
    prepare(sqlText: string) {
      let params: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          params = normalizeParams(args);
          return stmt;
        },
        async first() {
          hooks.beforeStatement?.(sqlText);
          return sql.prepare(sqlText).get(...(params as never[])) ?? null;
        },
        async all() {
          hooks.beforeStatement?.(sqlText);
          return { results: sql.prepare(sqlText).all(...(params as never[])) };
        },
        async run() {
          hooks.beforeStatement?.(sqlText);
          const result = sql.prepare(sqlText).run(...(params as never[]));
          return {
            changes: Number(result.changes ?? 0),
            lastInsertRowid: Number(result.lastInsertRowid ?? 0),
          };
        },
      };
      return stmt;
    },
  };
}

export function openTestSqlite(): TestSqlite {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE client_state (
      user_id TEXT NOT NULL,
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, namespace, key)
    );
  `);
  return db;
}
