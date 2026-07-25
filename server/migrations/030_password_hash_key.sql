-- Migration 030: Client-side password hashing with hash_key escrow
-- 
-- The client now generates a random hash_key, encrypts it with the password,
-- hashes the password with the hash_key (HMAC-SHA256), and sends the hash
-- to the server. The server stores the hash and the encrypted hash_key.
-- 
-- This means the server never sees the raw password.
-- The password_hash column now stores the client-computed hash (was server Argon2 hash).
-- New columns store the hash_key encrypted with the password (via Argon2id + AEAD).

ALTER TABLE users ADD COLUMN encrypted_hash_key TEXT;
ALTER TABLE users ADD COLUMN hash_key_salt TEXT;
ALTER TABLE users ADD COLUMN hash_key_nonce TEXT;
