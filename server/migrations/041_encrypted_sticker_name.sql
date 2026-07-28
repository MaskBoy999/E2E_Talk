-- Migration 041: Encrypt sticker_name in user_stickers
-- The sticker_name is encrypted with the user's identity key (AES-GCM)
-- so the server cannot read sticker/emoji names.

ALTER TABLE user_stickers ADD COLUMN encrypted_sticker_name BLOB;
ALTER TABLE user_stickers ADD COLUMN sticker_name_nonce BLOB;
