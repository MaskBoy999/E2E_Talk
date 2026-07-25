-- Migration 027: Shared profile data keys
-- Stores profile_data_key pre-encrypted with a DM channel or server key
-- so the recipient can fetch and decrypt it without waiting for a WS profile_key_sync.
--
-- Target types:
--   'dm_channel' — the key is encrypted with the DM channel's ratchet key
--   'server'     — the key is encrypted with the server's metadata key
--
-- The UNIQUE constraint ensures one entry per (owner, target_type, target_id).
-- The sender (owner) uploads this after establishing a DM or joining a server.
-- Any member of the DM/server can fetch it and decrypt using their copy of the
-- same shared key.

CREATE TABLE IF NOT EXISTS shared_profile_data_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL CHECK(target_type IN ('dm_channel', 'server')),
    target_id TEXT NOT NULL,
    encrypted_key TEXT NOT NULL,
    nonce TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(owner_user_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_shared_profile_data_keys_lookup
    ON shared_profile_data_keys(target_type, target_id);
