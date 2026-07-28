-- Migration 042: Drop legacy plaintext columns
-- The app is in development — old test users don't need backward compatibility.
-- These columns stored plaintext data that is now encrypted or hashed:
--   user_stickers.file_key       → use encrypted_file_key instead
--   users.friend_code            → use encrypted_friend_code + hash instead
--   servers.invite_code          → use invite_code_hash instead

ALTER TABLE user_stickers DROP COLUMN file_key;
ALTER TABLE users DROP COLUMN friend_code;
ALTER TABLE servers DROP COLUMN invite_code;
