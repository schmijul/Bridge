ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS thread_root_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS mention_user_ids TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS messages_thread_root_idx
  ON messages (thread_root_message_id);
