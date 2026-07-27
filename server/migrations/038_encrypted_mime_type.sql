-- Add encrypted_mime_type and mime_nonce columns to files table
ALTER TABLE files ADD COLUMN encrypted_mime_type BLOB;
ALTER TABLE files ADD COLUMN mime_nonce BLOB;

-- Add encrypted_mime_type and mime_nonce columns to user_stickers table
ALTER TABLE user_stickers ADD COLUMN encrypted_mime_type BLOB;
ALTER TABLE user_stickers ADD COLUMN mime_nonce BLOB;
