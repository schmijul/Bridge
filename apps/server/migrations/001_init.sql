CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  workspace_name TEXT NOT NULL,
  message_retention_days INTEGER NOT NULL CHECK (message_retention_days >= 7),
  allow_guest_access BOOLEAN NOT NULL DEFAULT FALSE,
  enforce_mfa_for_admins BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'member', 'guest')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_private BOOLEAN NOT NULL DEFAULT FALSE,
  description TEXT NOT NULL,
  archived_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS channels_unique_active_name
  ON channels (workspace_id, name)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  content TEXT NOT NULL CHECK (char_length(content) > 0),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS messages_channel_created_idx
  ON messages (channel_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  target_type TEXT NOT NULL CHECK (target_type IN ('channel', 'user', 'message', 'workspace')),
  target_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_log_created_idx
  ON audit_log (created_at DESC);

CREATE TABLE IF NOT EXISTS read_state (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, channel_id)
);

CREATE TABLE IF NOT EXISTS presence_state (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('online', 'away', 'offline')),
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS event_sequence (
  id SMALLINT PRIMARY KEY,
  current_value BIGINT NOT NULL
);

INSERT INTO event_sequence (id, current_value)
VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
