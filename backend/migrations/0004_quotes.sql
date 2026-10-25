ALTER TABLE orders ADD COLUMN quote_amount_minor INTEGER;
ALTER TABLE orders ADD COLUMN quote_note TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN quote_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN customer_note TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN manager_text TEXT NOT NULL DEFAULT '';
CREATE TABLE quote_prompts (
  message_id INTEGER PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  expected_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
UPDATE orders SET buttons_version=0 WHERE state='sent';
