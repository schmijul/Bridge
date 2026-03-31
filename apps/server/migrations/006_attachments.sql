ALTER TABLE audit_log
  DROP CONSTRAINT IF EXISTS audit_log_target_type_check;

ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_target_type_check
  CHECK (target_type IN ('channel', 'user', 'message', 'workspace', 'attachment'));

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  uploader_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  thread_root_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  storage_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS attachments_message_idx
  ON attachments (message_id, created_at DESC);

CREATE INDEX IF NOT EXISTS attachments_channel_idx
  ON attachments (channel_id, created_at DESC);
