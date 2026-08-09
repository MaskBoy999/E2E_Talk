-- Migration 053: Auth sessions (Settings → Security → Devices)
-- One row per signed-in device. The JWT carries a `sid` claim that maps to
-- this table's `id`, so a session can be revoked server-side (force-kick) and
-- every token minted for it becomes invalid at the next validation.
CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    device_id TEXT NOT NULL DEFAULT '',
    device_name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_active_at TEXT,
    expires_at TEXT,
    revoked INTEGER NOT NULL DEFAULT 0,
    revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_device ON auth_sessions(user_id, device_id);
