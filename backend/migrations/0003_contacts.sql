CREATE TABLE customer_contacts (
  user_id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  first_name TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
INSERT INTO customer_contacts(user_id,phone,first_name,updated_at)
SELECT user_id,phone,first_name,updated_at FROM (
  SELECT user_id,json_extract(payload,'$.phone') AS phone,
    coalesce(json_extract(payload,'$.name'),'') AS first_name,updated_at,
    row_number() OVER (PARTITION BY user_id ORDER BY created_at DESC,id DESC) AS rank
  FROM orders WHERE state='sent' AND length(json_extract(payload,'$.phone'))>0
) WHERE rank=1;
