-- Per-user soundboard disable: server owner can disable one user's soundboard for everyone
CREATE TABLE IF NOT EXISTS soundboard_user_disabled (
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    disabled_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (server_id, user_id, disabled_by)
);
