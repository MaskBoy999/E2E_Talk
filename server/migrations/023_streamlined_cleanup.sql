-- Migration 023: Streamlined Cleanup
-- Drops legacy tables that are no longer referenced by the codebase.
-- These were part of the old multi-device X3DH architecture.
-- Now using simplified envelope encryption (ECDH + HKDF) for all key exchange.

-- 1. Add escrow columns to users table (migrate from user_key_escrow)
ALTER TABLE users ADD COLUMN encrypted_private_key BLOB;
ALTER TABLE users ADD COLUMN escrow_salt BLOB;
ALTER TABLE users ADD COLUMN escrow_nonce BLOB;

-- 2. Migrate existing escrow data from user_key_escrow to users table
UPDATE users SET
    encrypted_private_key = (SELECT encrypted_private_key FROM user_key_escrow WHERE user_id = users.id),
    escrow_salt = (SELECT salt FROM user_key_escrow WHERE user_id = users.id),
    escrow_nonce = (SELECT nonce FROM user_key_escrow WHERE user_id = users.id)
WHERE EXISTS (SELECT 1 FROM user_key_escrow WHERE user_id = users.id);

-- 3. Drop legacy tables
DROP TABLE IF EXISTS user_devices;
DROP TABLE IF EXISTS prekey_bundles;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS user_device_escrow;
DROP TABLE IF EXISTS user_key_escrow;
