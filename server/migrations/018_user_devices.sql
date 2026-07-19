-- Migration 018: Multi-device improvements
-- 1. Replace user_public_keys with user_devices (per-device identity + prekeys)
-- 2. Add device_id to server_keys and dm_keys
-- 3. Add encrypted file_key columns to sticker tables

-- Create user_devices table (replaces user_public_keys)
CREATE TABLE IF NOT EXISTS user_devices (
    device_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_name TEXT DEFAULT '',
    identity_key BLOB NOT NULL,
    signed_prekey BLOB,
    signed_prekey_signature BLOB,
    one_time_prekey BLOB,
    one_time_prekey_id INTEGER,
    last_active_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (device_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_user_devices_user_id ON user_devices(user_id);

-- Add device_id to server_keys if not exists
ALTER TABLE server_keys ADD COLUMN device_id TEXT DEFAULT '';

-- Add device_id to dm_keys if not exists  
ALTER TABLE dm_keys ADD COLUMN device_id TEXT DEFAULT '';

-- Add encrypted file_key columns to server_stickers if not exists
ALTER TABLE server_stickers ADD COLUMN encrypted_file_key BLOB;
ALTER TABLE server_stickers ADD COLUMN file_key_nonce BLOB;

-- Add encrypted file_key columns to user_stickers if not exists
ALTER TABLE user_stickers ADD COLUMN encrypted_file_key BLOB;
ALTER TABLE user_stickers ADD COLUMN file_key_nonce BLOB;

-- Per-device key escrow table
CREATE TABLE IF NOT EXISTS user_device_escrow (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    encrypted_private_key BLOB NOT NULL,
    salt BLOB NOT NULL,
    nonce BLOB NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, device_id)
);

-- Copy existing data from user_public_keys to user_devices before dropping
INSERT OR IGNORE INTO user_devices (device_id, user_id, device_name, identity_key, last_active_at, created_at)
SELECT id, user_id, 'primary', public_key, created_at, created_at
FROM user_public_keys;

-- Drop the old user_public_keys table (replaced by user_devices)
DROP TABLE IF EXISTS user_public_keys;
