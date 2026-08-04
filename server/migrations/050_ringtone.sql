-- Ringtone Sync
-- Stores encrypted ringtone data so it syncs across devices.
-- The sound file is encrypted client-side with the user's identity public key.
CREATE TABLE IF NOT EXISTS ringtones (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    encrypted_sound BLOB NOT NULL,
    nonce BLOB NOT NULL,
    sender_public_key BLOB NOT NULL,
    encrypted_file_name BLOB,
    file_name_nonce BLOB,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
