-- 链接分享最小关联表（t_2c2dba79，契约 5.1/5.2/5.5）
-- 归属：本文件是**待集成**的 schema 草案；实际建表/绑定 SOCIAL_CONTENT_DB 由集成人接线，
-- 不允许 worker 自己用进程 Map 冒充持久化（契约 5.3）。
--
-- 设计要点：
--  * shareRef 是随机稳定引用，主键；不含会话/角色信息，不能从 ref 推断归属；
--  * 可信 scope 由服务端鉴权上下文写入，绝不信 body/query 的 ownerId/characterId；
--  * (scope, message_id, occurrence_key) 唯一：同消息同链接只一张卡，重放不重复建卡；
--  * content_id 可空：解析前必须为空，解析成功后才填 platform:encoded(sourceId):encoded(externalId)；
--  * revision 单调；旧持有者写不进更大 revision（应用层 CAS：UPDATE ... WHERE revision = ?）；
--  * lease_until 支持多进程租约与超时恢复，避免永久 resolving；
--  * 原 URL 只存受控值，签名参数（如 xsec_token）不得落进本表。

CREATE TABLE IF NOT EXISTS social_share_attachments (
  share_ref        TEXT PRIMARY KEY,
  scope            TEXT NOT NULL,
  message_id       TEXT NOT NULL,
  conversation_id  TEXT NOT NULL,
  character_id     TEXT,
  occurrence_key   TEXT NOT NULL,
  occurrence_spans TEXT NOT NULL,          -- JSON [{start,end}]
  original_url     TEXT NOT NULL,          -- 去掉跟踪参数的最小形式
  platform         TEXT,
  source_id        TEXT,
  resolved_url     TEXT,
  canonical_url    TEXT,
  open_url         TEXT,
  content_id       TEXT,
  part_key         TEXT,
  state            TEXT NOT NULL CHECK (state IN ('queued','resolving','ready','partial','failed','cancelled')),
  revision         INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  attempt          INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  lease_until      INTEGER,                -- UTC ms；过期后可被其他进程接管
  error_code       TEXT,
  error_json       TEXT,
  preview_json     TEXT,
  projection_json  TEXT,                   -- 冻结 contextProjection
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_share_msg_occurrence
  ON social_share_attachments (scope, message_id, occurrence_key);

CREATE INDEX IF NOT EXISTS ix_share_message
  ON social_share_attachments (scope, conversation_id, message_id);

CREATE INDEX IF NOT EXISTS ix_share_state_lease
  ON social_share_attachments (state, lease_until);

-- 内容正文/评论/字幕沿用共享 social_content_items 等表；这里不重复建内容表，
-- 也不双存图片字节（契约 3.3 / 5.1）。
