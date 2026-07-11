-- Phase 3: Server bans + admin config

CREATE TABLE IF NOT EXISTS server_bans (
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    banned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (server_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_server_bans_server_id ON server_bans(server_id);
CREATE INDEX IF NOT EXISTS idx_server_bans_user_id ON server_bans(user_id);

-- Admin config: stores the admin password hash (set once, never changed)
CREATE TABLE IF NOT EXISTS admin_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
