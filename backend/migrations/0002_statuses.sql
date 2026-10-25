ALTER TABLE orders ADD COLUMN business_status TEXT NOT NULL DEFAULT 'received';
ALTER TABLE orders ADD COLUMN business_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN status_updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN buttons_version INTEGER NOT NULL DEFAULT 0;
UPDATE orders SET status_updated_at=updated_at WHERE state='sent';
CREATE TABLE order_status_events (
  event_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  status TEXT NOT NULL,
  actor_id TEXT,
  changed_at INTEGER NOT NULL
);
CREATE INDEX status_events_order ON order_status_events(order_id,changed_at);
INSERT INTO order_status_events(event_id,order_id,status,changed_at)
  SELECT 'received:'||id,id,'received',updated_at FROM orders WHERE state='sent';
