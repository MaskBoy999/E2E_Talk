-- Migration 044: Drop message_signature column (never populated, always NULL)
-- The message_signature column was added for a planned message signing feature
-- but the client never populates it. The field has been removed from API responses
-- and WebSocket messages. Safe to drop.

ALTER TABLE messages DROP COLUMN message_signature;
ALTER TABLE dm_messages DROP COLUMN message_signature;
