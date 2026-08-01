-- Migration 046: Drop plaintext mime_type from user_stickers
-- The client now encrypts the sticker/emoji/gif mime type with the sticker's own
-- shareable file key and stores it in encrypted_mime_type + mime_nonce (migration
-- 038 columns). The plaintext column is no longer written and can be dropped so a
-- DB dump reveals nothing about the sticker/emoji/gif type.

ALTER TABLE user_stickers DROP COLUMN mime_type;
