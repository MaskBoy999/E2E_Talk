-- F3-15: Encrypted File Vault
-- Each user has a personal encrypted vault with a shared max size.
-- Files in the vault are encrypted client-side with the user's identity key.
-- The server only stores opaque blobs.

CREATE TABLE IF NOT EXISTS user_vault_files (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- The encrypted file data blob (compressed + encrypted client-side)
    encrypted_data BLOB NOT NULL,
    -- Original filename (encrypted)
    encrypted_filename TEXT,
    filename_nonce TEXT,
    -- MIME type (encrypted)
    encrypted_mime_type TEXT,
    mime_type_nonce TEXT,
    -- File size BEFORE compression (for display)
    original_size INTEGER NOT NULL DEFAULT 0,
    -- Size AFTER compression + encryption (actual storage used)
    stored_size INTEGER NOT NULL DEFAULT 0,
    -- Encrypted file key (for decryption on other devices)
    encrypted_file_key TEXT,
    file_key_nonce TEXT,
    -- SHA-256 hash for deduplication
    content_hash TEXT,
    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_vault_user ON user_vault_files(user_id);

-- Store vault size quota in admin_config (shared max vault size in MB)
-- Key: 'vault_max_size_mb', default: 1024 (1 GB)
