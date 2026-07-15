-- Phase 10: Edit tracking + server sticker registry

-- Add edited_at timestamp to messages (NULL means not edited)
ALTER TABLE messages ADD COLUMN edited_at DATETIME;
ALTER TABLE dm_messages ADD COLUMN edited_at DATETIME;

-- Server sticker registry: maps files to servers as stickers
CREATE TABLE IF NOT EXISTS server_stickers (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    uploaded_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sticker_name TEXT NOT NULL,
    file_key TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(server_id, file_id)
);

CREATE INDEX IF NOT EXISTS idx_server_stickers_server ON server_stickers(server_id);
