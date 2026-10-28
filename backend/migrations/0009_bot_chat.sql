CREATE TABLE bot_private_chats (
 user_id TEXT PRIMARY KEY,
 welcome_message_id INTEGER,
 welcome_state TEXT NOT NULL DEFAULT 'new',
 welcome_revision INTEGER NOT NULL DEFAULT 0,
 pinned INTEGER NOT NULL DEFAULT 0,
 synced_at INTEGER NOT NULL DEFAULT 0,
 updated_at INTEGER NOT NULL,
 lease_until INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT NOT NULL DEFAULT ''
);
CREATE TABLE private_message_cleanup (
 user_id TEXT NOT NULL REFERENCES bot_private_chats(user_id),
 message_id INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending',
 attempts INTEGER NOT NULL DEFAULT 0,
 available_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL,
 lease_until INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(user_id,message_id)
);
CREATE INDEX private_cleanup_due ON private_message_cleanup(state,available_at);
