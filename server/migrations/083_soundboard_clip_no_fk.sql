-- Clips are per-account (F12): the clip belongs to the user, not a server.
-- 'server_id' keeps its column for backward compat but is no longer a foreign
-- key and may be any sentinel (e.g. '_global') since clips work in DMs too.
-- Recreate without the FK constraint (SQLite can't drop constraints in place).
CREATE TABLE IF NOT EXISTS soundboard_clips_v2 (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_id TEXT NOT NULL DEFAULT '_global',
    name TEXT NOT NULL,
    encrypted_audio BLOB NOT NULL,
    audio_nonce BLOB NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    encrypted_key TEXT DEFAULT '',
    key_nonce TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO soundboard_clips_v2 (id, user_id, server_id, name, encrypted_audio, audio_nonce, duration_ms, encrypted_key, key_nonce, created_at)
    SELECT id, user_id, server_id, name, encrypted_audio, audio_nonce, duration_ms, COALESCE(encrypted_key, ''), COALESCE(key_nonce, ''), created_at FROM soundboard_clips;
DROP TABLE soundboard_clips;
ALTER TABLE soundboard_clips_v2 RENAME TO soundboard_clips;
CREATE INDEX IF NOT EXISTS idx_sb_clips_user ON soundboard_clips(user_id);
CREATE INDEX IF NOT EXISTS idx_sb_clips_server ON soundboard_clips(server_id);
