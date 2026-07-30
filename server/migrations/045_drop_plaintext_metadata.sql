-- Migration 045: Drop plaintext metadata columns that have encrypted counterparts
-- sticker_name in user_stickers now has encrypted_sticker_name + sticker_name_nonce (migration 041)
-- file_name in notification_sounds now has encrypted_file_name + file_name_nonce (migration 039)
-- The plaintext columns are no longer written by the client and can be dropped.

ALTER TABLE user_stickers DROP COLUMN sticker_name;
ALTER TABLE notification_sounds DROP COLUMN file_name;
