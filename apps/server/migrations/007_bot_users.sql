ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS bot_api_tokens (
  id TEXT PRIMARY KEY,
  bot_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS bot_api_tokens_user_idx
  ON bot_api_tokens (bot_user_id);

CREATE INDEX IF NOT EXISTS bot_api_tokens_revoked_idx
  ON bot_api_tokens (revoked_at);
