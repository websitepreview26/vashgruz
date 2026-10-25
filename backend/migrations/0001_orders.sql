CREATE TABLE IF NOT EXISTS orders (
  request_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  id TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL,
  payload TEXT NOT NULL,
  photo_count INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'received',
  message_id INTEGER,
  photo_file_ids TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, request_id)
);
CREATE INDEX IF NOT EXISTS orders_user_time ON orders(user_id, created_at);
