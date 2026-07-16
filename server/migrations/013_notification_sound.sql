-- Notification Sound Sync
-- Stores encrypted notification sound data so it syncs across devices.
-- The sound file is encrypted client-side with the user's identity public key.
CREATE TABLE IF NOT EXISTS notification_sounds (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    encrypted_sound BLOB NOT NULL,
    nonce BLOB NOT NULL,
    sender_public_key BLOB NOT NULL,
    file_name TEXT NOT NULL DEFAULT 'notification.mp3',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
