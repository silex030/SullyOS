#!/usr/bin/env node
/**
 * 出行首次连接 · 本机管理员批准脚本（只在服务器本机运行，不挂公网 HTTP）
 *
 * 用法：
 *   node scripts/travel-pair-admin.mjs list
 *   node scripts/travel-pair-admin.mjs approve <requestId> <userId>
 *
 * 安全：
 * - 只输出 requestId 短前缀、状态、时间；不输出短码/哈希/owner 密钥。
 * - userId 由管理员从可信来源确定（用户设置页展示的账号 ID），不接受申请体自带。
 * - 批准只把 pending → approved 并绑定 userId；真正签发 owner 密钥发生在用户浏览器的
 *   一次性 claim，服务端只存哈希。
 */
import { DatabaseSync } from 'node:sqlite';

const DB = process.env.AMSG_DB_PATH || '/opt/sullyos/data/amsg.sqlite';
const DDL = `CREATE TABLE IF NOT EXISTS travel_pair_requests (
  request_id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  client_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  user_id TEXT,
  ip_hash TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  approved_at INTEGER,
  claimed_at INTEGER
)`;

const isValidUserId = (value) => typeof value === 'string'
  && value.trim().length > 0
  && value.trim().length <= 128
  && !/[\s\u0000-\u001f\u007f]/.test(value);

const [cmd, requestId, userId] = process.argv.slice(2);
const db = new DatabaseSync(DB);
db.exec(DDL);

if (cmd === 'list') {
  const now = Date.now();
  const rows = db.prepare(
    'SELECT request_id, status, user_id, created_at, expires_at FROM travel_pair_requests ORDER BY created_at DESC LIMIT 20',
  ).all();
  console.log(JSON.stringify(rows.map((r) => ({
    requestId: String(r.request_id).slice(0, 10) + '…',
    status: r.status === 'pending' && Number(r.expires_at) < now ? 'expired' : r.status,
    userId: r.user_id ? String(r.user_id) : null,
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
  }))));
} else if (cmd === 'approve') {
  if (!requestId || !isValidUserId(userId)) {
    console.error('usage: approve <requestId> <userId>');
    process.exit(2);
  }
  const now = Date.now();
  const result = db.prepare(
    "UPDATE travel_pair_requests SET status = 'approved', user_id = ?, approved_at = ? " +
      "WHERE request_id = ? AND status = 'pending' AND expires_at >= ?",
  ).run(userId.trim(), now, requestId, now);
  const changes = Number(result.changes ?? 0);
  console.log(JSON.stringify({ ok: changes === 1, approved: changes === 1, boundUserId: userId.trim() }));
  if (changes !== 1) process.exit(1);
} else if (cmd === 'purge') {
  const now = Date.now();
  const result = db.prepare('DELETE FROM travel_pair_requests WHERE expires_at < ? AND status != ?').run(now, 'claimed');
  console.log(JSON.stringify({ ok: true, purged: Number(result.changes ?? 0) }));
} else {
  console.error('usage: list | approve <requestId> <userId> | purge');
  process.exit(2);
}
db.close();
