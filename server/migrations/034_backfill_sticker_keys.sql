-- Backfill legacy sticker rows where encrypted_file_key is NULL.
-- These rows were inserted before migration 018 added the
-- encrypted_file_key column, so they only have the plaintext file_key.
-- We set encrypted_file_key to an empty blob and file_key_nonce to NULL
-- so the server never returns plaintext file keys via the API.
-- The client falls back to fetching old stickers' file_key from the
-- file record when encrypted_file_key is empty, preserving backward
-- compatibility without leaking plaintext keys through the API.
UPDATE user_stickers SET encrypted_file_key = X'', file_key_nonce = NULL WHERE encrypted_file_key IS NULL;
UPDATE server_stickers SET encrypted_file_key = X'', file_key_nonce = NULL WHERE encrypted_file_key IS NULL;
