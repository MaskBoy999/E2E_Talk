-- Migration 060: E2E blind-index message search.
--
-- Clients store an HMAC-SHA256 token per searchable keyword, keyed by a key the
-- server never sees (derived from the server/DM encryption key), so the server
-- can match keyword queries without ever seeing plaintext and cannot run a
-- dictionary attack (it lacks the HMAC key). Tokens are insert-only metadata;
-- message content stays fully encrypted.
--
-- Restart-safe: IF NOT EXISTS, run per-execute_batch.
CREATE TABLE IF NOT EXISTS message_search_tokens (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    PRIMARY KEY (message_id, token)
);
CREATE INDEX IF NOT EXISTS idx_message_search_tokens_token ON message_search_tokens(token);

CREATE TABLE IF NOT EXISTS dm_message_search_tokens (
    message_id TEXT NOT NULL REFERENCES dm_messages(id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    PRIMARY KEY (message_id, token)
);
CREATE INDEX IF NOT EXISTS idx_dm_message_search_tokens_token ON dm_message_search_tokens(token);
