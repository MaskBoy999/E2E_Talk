-- Voice channels & calls: persistent owner sanctions + session log tables

-- Owner sanctions that persist across rejoin / page refresh.
-- force_muted: server drops this user's outgoing audio frames.
-- force_deafened: server drops their outgoing audio+video AND drops incoming
-- audio/video to them (they can neither speak nor hear until the owner lifts it).
CREATE TABLE IF NOT EXISTS voice_sanctions (
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    force_muted INTEGER NOT NULL DEFAULT 0,
    force_deafened INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (server_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_voice_sanctions_server ON voice_sanctions(server_id);

-- Session log tables (consumed by the admin panel). Created if absent.
CREATE TABLE IF NOT EXISTS voice_sessions (
    id TEXT PRIMARY KEY,
    channel_id TEXT,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ended_at DATETIME
);

CREATE TABLE IF NOT EXISTS voice_participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voice_session_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    left_at DATETIME,
    is_muted INTEGER DEFAULT 0,
    is_deafened INTEGER DEFAULT 0,
    is_camera_on INTEGER DEFAULT 0,
    is_screen_sharing INTEGER DEFAULT 0
);
