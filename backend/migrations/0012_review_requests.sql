CREATE TABLE review_prompts (
  message_id INTEGER PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  actor_id TEXT NOT NULL
);

ALTER TABLE delivery_outbox ADD COLUMN sent_at INTEGER;

-- Update the card after both immediate sends and scheduled delivery attempts.
CREATE TRIGGER refresh_review_card AFTER UPDATE OF state ON delivery_outbox
WHEN NEW.id = 'review:' || NEW.order_id || ':sendMessage'
  AND OLD.state != NEW.state
  AND NEW.state IN ('sent', 'uncertain', 'failed')
BEGIN
  UPDATE delivery_outbox SET sent_at = unixepoch() * 1000
    WHERE id = NEW.id AND NEW.state = 'sent';
  INSERT INTO delivery_outbox (id, order_id, kind, payload, available_at, created_at)
    VALUES ('review-card:' || lower(hex(randomblob(16))), NEW.order_id, 'edit', '{}',
            unixepoch() * 1000, unixepoch() * 1000);
END;
