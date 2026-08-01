-- Migration 048: Drop confirmed-dead legacy columns
-- The app is unreleased (development only) — no backward-compat needed.
-- Every column below is never meaningfully populated (0 non-empty values in
-- the live DB) and has no active read path:
--   messages/dm_messages.message_nonce          → client always sends null (encryptDm has no messageNonce)
--   messages/dm_messages.encrypted_profile_key / profile_key_nonce / encrypted_banner_key / banner_key_nonce
--       → legacy migration-020 "REST retrieval" columns; profile data now rides in
--         encrypted_profile_snapshot + profile_snapshot_nonce
--   messages/dm_messages.encrypted_file_key / file_key_nonce
--       → file keys now travel inside the E2E-encrypted message payload
--   users.encrypted_profile_key / profile_eph_pub / profile_nonce   → pre-022 BLOBs, zero refs
--   users.encrypted_private_key / escrow_salt / escrow_nonce        → escrow now lives in user_key_escrow
--   users.profile_picture_file_key / profile_banner_file_key        → plaintext keys, replaced by encrypted_pic_key (043)
--   servers.invite_code        → only invite_code_hash is used (042's batch aborted before this drop)
--   server_keys.eph_pub        → zero refs (user_media.eph_pub is a different table)
--   server_keys.device_id / dm_keys.device_id → multi-device moved to user_devices; always written as ''

ALTER TABLE messages DROP COLUMN message_nonce;
ALTER TABLE messages DROP COLUMN encrypted_profile_key;
ALTER TABLE messages DROP COLUMN profile_key_nonce;
ALTER TABLE messages DROP COLUMN encrypted_banner_key;
ALTER TABLE messages DROP COLUMN banner_key_nonce;
ALTER TABLE messages DROP COLUMN encrypted_file_key;
ALTER TABLE messages DROP COLUMN file_key_nonce;

ALTER TABLE dm_messages DROP COLUMN message_nonce;
ALTER TABLE dm_messages DROP COLUMN encrypted_profile_key;
ALTER TABLE dm_messages DROP COLUMN profile_key_nonce;
ALTER TABLE dm_messages DROP COLUMN encrypted_banner_key;
ALTER TABLE dm_messages DROP COLUMN banner_key_nonce;
ALTER TABLE dm_messages DROP COLUMN encrypted_file_key;
ALTER TABLE dm_messages DROP COLUMN file_key_nonce;

ALTER TABLE users DROP COLUMN encrypted_profile_key;
ALTER TABLE users DROP COLUMN profile_eph_pub;
ALTER TABLE users DROP COLUMN profile_nonce;
ALTER TABLE users DROP COLUMN encrypted_private_key;
ALTER TABLE users DROP COLUMN escrow_salt;
ALTER TABLE users DROP COLUMN escrow_nonce;
ALTER TABLE users DROP COLUMN profile_picture_file_key;
ALTER TABLE users DROP COLUMN profile_banner_file_key;

ALTER TABLE servers DROP COLUMN invite_code;

ALTER TABLE server_keys DROP COLUMN eph_pub;
ALTER TABLE server_keys DROP COLUMN device_id;

ALTER TABLE dm_keys DROP COLUMN device_id;
