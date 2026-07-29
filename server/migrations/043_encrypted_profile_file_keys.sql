-- Migration 043: Encrypt profile_picture_file_key and profile_banner_file_key
-- The client encrypts the file key with their identity key (AES-GCM) before uploading.
-- The server only stores the encrypted version, never the plaintext.
-- Sharing is handled via the existing conversation_profile + encrypted_profile_snapshot mechanism.

ALTER TABLE users ADD COLUMN encrypted_pic_key BLOB;
ALTER TABLE users ADD COLUMN pic_key_nonce BLOB;
ALTER TABLE users ADD COLUMN encrypted_banner_key BLOB;
ALTER TABLE users ADD COLUMN banner_key_nonce BLOB;

-- Drop the old plaintext columns (no backward compatibility needed)
ALTER TABLE users DROP COLUMN profile_picture_file_key;
ALTER TABLE users DROP COLUMN profile_banner_file_key;
