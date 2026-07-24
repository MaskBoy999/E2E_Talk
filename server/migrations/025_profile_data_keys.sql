CREATE TABLE IF NOT EXISTS profile_data_keys (
    user_id TEXT NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    encrypted_key TEXT NOT NULL,
    nonce TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);
