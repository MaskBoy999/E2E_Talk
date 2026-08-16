-- Migration 063: E2E-encrypted per-message delivery/read receipts.
--
-- Each ack row records that one RECIPIENT's client received ('delivered') or
-- opened/read ('read') one message:
--   * acker_id — the recipient who acked (same metadata class as reactor ids).
--   * status — 'delivered' | 'read' (plaintext metadata the server must know
--     to record the receipt; the SENDER's client renders it).
--   * ack_token — HMAC-SHA256 blind proof keyed by the conversation key
--     ('ack-v1:' + message_id). The host never holds the key, so it can never
--     forge a receipt for content it can't decrypt; only a real member's
--     client can produce a valid token. The server stores it and, in the same
--     style as reactions/polls, returns status rows to the author.
-- UNIQUE(message_id, acker_id) means one ack row per recipient; re-acking
-- upgrades delivered -> read (never downgrades).
--
-- Restart-safe: IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS message_acks (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    acker_id TEXT NOT NULL REFERENCES users(id),
    status TEXT NOT NULL,
    ack_token TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(message_id, acker_id)
);
CREATE INDEX IF NOT EXISTS idx_message_acks_message ON message_acks(message_id);

CREATE TABLE IF NOT EXISTS dm_message_acks (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES dm_messages(id) ON DELETE CASCADE,
    acker_id TEXT NOT NULL REFERENCES users(id),
    status TEXT NOT NULL,
    ack_token TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(message_id, acker_id)
);
CREATE INDEX IF NOT EXISTS idx_dm_message_acks_message ON dm_message_acks(message_id);
