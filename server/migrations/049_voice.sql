-- Migration 049: Voice calls & voice channels
-- Voice sessions (active call sessions)
CREATE TABLE IF NOT EXISTS voice_sessions (
    id TEXT PRIMARY KEY,
    channel_id TEXT,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ended_at DATETIME
);

-- Active voice participants
CREATE TABLE IF NOT EXISTS voice_participants (
    voice_session_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    left_at DATETIME,
    is_muted INTEGER DEFAULT 0,
    is_deafened INTEGER DEFAULT 0,
    is_camera_on INTEGER DEFAULT 0,
    is_screen_sharing INTEGER DEFAULT 0
);

-- Voice sanctions (server owner controls: force mute / force deafen)
CREATE TABLE IF NOT EXISTS voice_sanctions (
    server_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    force_muted INTEGER DEFAULT 0,
    force_deafened INTEGER DEFAULT 0,
    PRIMARY KEY (server_id, user_id)
);
