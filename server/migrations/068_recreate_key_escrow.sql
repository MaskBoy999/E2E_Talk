-- Migration 068: Recreate user_key_escrow
-- The table was dropped by migration 023 (which moved data to users columns),
-- then migration 048 dropped those users columns, but the codebase still
-- references user_key_escrow in save_escrowed_key, change_password_credentials,
-- delete_user, and the admin endpoint. Recreate it so the code works again.
CREATE TABLE IF NOT EXISTS user_key_escrow (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    encrypted_private_key BLOB NOT NULL,
    salt BLOB NOT NULL,
    nonce BLOB NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
