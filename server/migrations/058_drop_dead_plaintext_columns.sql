-- Migration 058 (B1): Drop the final 3 dead plaintext legacy columns.
-- Each ALTER is a separate statement on purpose — the app runs migrations
-- with execute_batch, which aborts the whole batch on the first error (e.g.
-- when a column was already dropped by 042/043/048 on a fresh database).
-- Verified 0 non-null rows in the live DB; nothing reads or writes them:
--   servers.invite_code                → invite_code_hash + invite_code_salt used
--   users.profile_picture_file_key     → encrypted_pic_key / pic_key_nonce used
--   users.profile_banner_file_key      → encrypted_banner_key / banner_key_nonce used
ALTER TABLE servers DROP COLUMN invite_code;
ALTER TABLE users DROP COLUMN profile_picture_file_key;
ALTER TABLE users DROP COLUMN profile_banner_file_key;
