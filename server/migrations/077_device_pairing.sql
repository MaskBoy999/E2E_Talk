-- QR-code second-device pairing tickets
CREATE TABLE IF NOT EXISTS device_pairing_tickets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key BLOB NOT NULL,
    encrypted_key_blob BLOB NOT NULL,
    key_blob_nonce BLOB NOT NULL,
    expires_at DATETIME NOT NULL,
    claimed_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pairing_user ON device_pairing_tickets(user_id);
