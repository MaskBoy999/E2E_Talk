-- Phase 8: Per-message key derivation
-- Adds message_nonce to messages/dm_messages for unique per-message key derivation.
-- Nullable: existing messages without it fall back to the old derivation path.
-- Note: Each ALTER TABLE is run separately in db.rs to avoid batch abort issues.

ALTER TABLE messages ADD COLUMN message_nonce TEXT;
ALTER TABLE dm_messages ADD COLUMN message_nonce TEXT;
