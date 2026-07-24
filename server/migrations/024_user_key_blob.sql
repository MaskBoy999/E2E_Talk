CREATE TABLE IF NOT EXISTS user_key_blobs (
    user_id TEXT NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    encrypted_blob TEXT NOT NULL,
    salt TEXT NOT NULL,
    nonce TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
);
