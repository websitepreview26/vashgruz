ALTER TABLE orders ADD COLUMN customer_visibility TEXT NOT NULL DEFAULT 'active';
UPDATE orders SET customer_visibility='archived' WHERE business_status IN ('cancelled','completed','confirmed');
CREATE INDEX orders_customer_visibility ON orders(user_id,customer_visibility,created_at);
