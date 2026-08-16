-- Migration 064: Disappearing messages (server-enforced TTL + shredding).
--
-- `expires_at` (fixed-width RFC3339, NULL = never expires) is plaintext
-- metadata the server MUST know to enforce the countdown — the same class as
-- timestamps/channel ids. The CONTENT stays fully E2E-encrypted; the server
-- only learns how long a message lives, never what it says. A periodic
-- sweeper DELETES the row (cascading to search tokens, reactions, poll votes,
-- read acks, and pins via their message_id FKs) and shreds any attached file
-- record + chunks, so after expiry neither the ciphertext nor the file exists
-- on the host. The TTL itself rides as a plaintext `ttl_seconds` field on the
-- message_send / dm_send frames.
--
-- Restart-safe: IF NOT EXISTS.
ALTER TABLE messages ADD COLUMN expires_at TEXT;
ALTER TABLE dm_messages ADD COLUMN expires_at TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_expires_at ON messages(expires_at);
CREATE INDEX IF NOT EXISTS idx_dm_messages_expires_at ON dm_messages(expires_at);
