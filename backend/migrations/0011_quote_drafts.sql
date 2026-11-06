CREATE TABLE quote_drafts (
  message_id INTEGER PRIMARY KEY,
  prompt_id INTEGER NOT NULL REFERENCES quote_prompts(message_id),
  actor_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  note TEXT NOT NULL,
  discarded INTEGER NOT NULL DEFAULT 0
);
