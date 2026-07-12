-- Multi-device key support: store multiple public keys per user
-- and allow multiple encrypted server_keys per (server_id, user_id)

CREATE TABLE IF NOT EXISTS user_public_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key BLOB NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_user_public_keys_user_id ON user_public_keys(user_id);

-- Recreate server_keys without UNIQUE(server_id, user_id) to allow multiple encrypted keys per user
CREATE TABLE IF NOT EXISTS server_keys_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    encrypted_key BLOB NOT NULL,
    sender_public_key BLOB NOT NULL,
    nonce BLOB NOT NULL,
    version INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO server_keys_new (server_id, user_id, encrypted_key, sender_public_key, nonce, version, created_at)
    SELECT server_id, user_id, encrypted_key, sender_public_key, nonce, version, created_at FROM server_keys;
DROP TABLE server_keys;
ALTER TABLE server_keys_new RENAME TO server_keys;
CREATE INDEX IF NOT EXISTS idx_server_keys_server_id ON server_keys(server_id);
CREATE INDEX IF NOT EXISTS idx_server_keys_user_id ON server_keys(user_id);

-- Recreate dm_keys without UNIQUE to allow multiple encrypted keys per user per DM channel
CREATE TABLE IF NOT EXISTS dm_keys_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dm_channel_id TEXT NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    encrypted_key BLOB NOT NULL,
    sender_public_key BLOB NOT NULL,
    nonce BLOB NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO dm_keys_new (dm_channel_id, user_id, encrypted_key, sender_public_key, nonce, created_at)
    SELECT dm_channel_id, user_id, encrypted_key, sender_public_key, nonce, created_at FROM dm_keys;
DROP TABLE dm_keys;
ALTER TABLE dm_keys_new RENAME TO dm_keys;
CREATE INDEX IF NOT EXISTS idx_dm_keys_channel_user ON dm_keys(dm_channel_id, user_id);
