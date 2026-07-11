-- E2E Encryption v2: Per-user identity keys + per-server envelope-encrypted keys

-- Add identity public key to users
ALTER TABLE users ADD COLUMN identity_public_key BLOB;

-- Per-server keys: each member gets the server key encrypted with their public key
CREATE TABLE IF NOT EXISTS server_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    encrypted_key BLOB NOT NULL,
    sender_public_key BLOB NOT NULL,
    nonce BLOB NOT NULL,
    version INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(server_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_server_keys_server_id ON server_keys(server_id);
CREATE INDEX IF NOT EXISTS idx_server_keys_user_id ON server_keys(user_id);
