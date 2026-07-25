-- Migration 028: Add sender_id_hash to messages and dm_messages
-- Stores SHA-256(sender_id + ":" + channel_id) for each message so
-- the client has a deterministic, opaque sender identifier without
-- exposing the raw user UUID in API responses.
ALTER TABLE messages ADD COLUMN sender_id_hash TEXT;
ALTER TABLE dm_messages ADD COLUMN sender_id_hash TEXT;
