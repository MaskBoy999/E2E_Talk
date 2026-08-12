-- Two-factor authentication (TOTP) — secret encrypted at rest with the server's
-- JWT-derived key, plus 8 one-time recovery codes (SHA-256 hashed with a
-- per-user salt). CASCADE so deleting a user removes everything.
CREATE TABLE IF NOT EXISTS totp_secrets (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret_encrypted TEXT NOT NULL,  -- base64 ChaCha20-Poly1305 ciphertext
    nonce TEXT NOT NULL,             -- base64 12-byte nonce
    salt TEXT NOT NULL,              -- per-user hex salt for recovery-code hashing
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recovery_codes (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,          -- hex sha256(salt || code_upper)
    used INTEGER NOT NULL DEFAULT 0,
    used_at TEXT,
    PRIMARY KEY (user_id, code_hash)
);
CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON recovery_codes(user_id);
