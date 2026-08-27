-- Soundboard clips uploaded by users (encrypted client-side)
CREATE TABLE IF NOT EXISTS soundboard_clips (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    encrypted_audio BLOB NOT NULL,
    audio_nonce BLOB NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sb_clips_user ON soundboard_clips(user_id);
CREATE INDEX IF NOT EXISTS idx_sb_clips_server ON soundboard_clips(server_id);

-- Per-user soundboard muting: one user can mute another user's soundboard playback
CREATE TABLE IF NOT EXISTS soundboard_mutes (
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    muted_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (server_id, user_id, muted_by)
);
