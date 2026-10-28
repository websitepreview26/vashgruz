ALTER TABLE bot_private_chats ADD COLUMN welcome_kind TEXT NOT NULL DEFAULT 'text';
ALTER TABLE bot_private_chats ADD COLUMN welcome_media_url TEXT NOT NULL DEFAULT '';
