-- Phase 12: Per-user sticker/GIF storage (no longer server-bound)
CREATE TABLE IF NOT EXISTS user_stickers (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    sticker_name TEXT NOT NULL,
    file_key TEXT NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'image/png',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_user_stickers_user ON user_stickers(user_id);
