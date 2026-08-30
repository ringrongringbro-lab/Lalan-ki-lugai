-- D1 schema for the Telegram control bot
-- Apply with: wrangler d1 execute BOT_DB --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS sessions (
  user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  state TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, chat_id)
);

-- Replaces the old "pin a message and parse it" trick for watermark/font links
-- name = 'watermark' | 'file' (font) | 'wm_position'
CREATE TABLE IF NOT EXISTS configs (
  chat_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, name)
);

CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  workflow TEXT NOT NULL,      -- 'encode.yml' or 'audio_merge.yml'
  payload TEXT NOT NULL,       -- JSON string of workflow_dispatch inputs
  status TEXT NOT NULL DEFAULT 'queued',  -- queued | dispatched
  created_at INTEGER NOT NULL
);
