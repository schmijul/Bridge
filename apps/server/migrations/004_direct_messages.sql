ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'channel'
  CHECK (kind IN ('channel', 'dm', 'group_dm'));

ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS dm_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS channels_unique_dm_key
  ON channels (workspace_id, dm_key)
  WHERE dm_key IS NOT NULL AND archived_at IS NULL;
