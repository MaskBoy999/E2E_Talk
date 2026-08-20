-- F3: Threaded replies — thread_parent_id on messages
-- NULL = top-level message; non-NULL = reply inside a thread
ALTER TABLE messages ADD COLUMN thread_parent_id TEXT REFERENCES messages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_messages_thread_parent ON messages(thread_parent_id);

-- F4: Channel categories — server owners group channels into collapsible sections
CREATE TABLE IF NOT EXISTS channel_categories (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    encrypted_name BLOB,
    name_nonce BLOB,
    position INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_channel_categories_server ON channel_categories(server_id);

-- Add category FK to channels (nullable = uncategorized → default group)
ALTER TABLE channels ADD COLUMN category_id TEXT REFERENCES channel_categories(id) ON DELETE SET NULL;
