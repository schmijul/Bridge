CREATE TABLE IF NOT EXISTS push_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('expo', 'fcm', 'apns')),
  platform TEXT NOT NULL,
  device_token TEXT NOT NULL,
  app_version TEXT,
  device_name TEXT,
  os_version TEXT,
  timezone TEXT,
  locale TEXT,
  metadata JSONB,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, installation_id),
  UNIQUE (provider, device_token)
);

CREATE INDEX IF NOT EXISTS push_devices_user_idx
  ON push_devices (user_id);
