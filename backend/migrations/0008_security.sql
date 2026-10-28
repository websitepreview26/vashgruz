ALTER TABLE orders ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN delivery_next_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customer_contacts ADD COLUMN source TEXT NOT NULL DEFAULT 'legacy';
CREATE TABLE request_limits (
  key TEXT PRIMARY KEY,
  window INTEGER NOT NULL,
  hits INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX request_limits_expiry ON request_limits(expires_at);
CREATE TABLE delivery_outbox (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  kind TEXT NOT NULL CHECK(kind IN ('edit','sendMessage')),
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX delivery_outbox_due ON delivery_outbox(state,available_at);
CREATE INDEX delivery_outbox_order ON delivery_outbox(order_id,state);
CREATE INDEX orders_user_page ON orders(user_id,created_at DESC,id DESC);

CREATE TABLE delivery_resolutions (
 id TEXT PRIMARY KEY,
 order_id TEXT NOT NULL REFERENCES orders(id),
 task_id TEXT,
 outcome TEXT NOT NULL,
 note TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
