-- Migration 062: E2E-encrypted polls.
--
-- The poll QUESTION + OPTIONS ride inside the message's encrypted content
-- (payload { type: 'poll', question, options: [{id, text}], multiple }) — the
-- server never sees them. Each VOTE row stores ONLY:
--   * option_token — HMAC-SHA256 blind index of the option id, keyed by the
--     conversation key (never seen by the server). Clients recompute the token
--     for each option id they already know from the decrypted poll message, so
--     the server can tally votes without ever reading WHICH option was chosen.
--   * voter_id — the reactor, exposed the same way message sender ids are
--     (HMAC'd wire id + raw id for the client's "my vote" highlight).
-- Counts are computed client-side after matching tokens; the server never sees
-- the question, the option text, or the vote target.
--
-- UNIQUE(message_id, voter_id, option_token) gives toggle semantics: sending
-- the same token again removes the vote. Single-choice polls are enforced
-- client-side by removing the voter's other option tokens in the same request.
--
-- Restart-safe: IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS message_poll_votes (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    voter_id TEXT NOT NULL REFERENCES users(id),
    option_token TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(message_id, voter_id, option_token)
);
CREATE INDEX IF NOT EXISTS idx_message_poll_votes_message ON message_poll_votes(message_id);

CREATE TABLE IF NOT EXISTS dm_message_poll_votes (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES dm_messages(id) ON DELETE CASCADE,
    voter_id TEXT NOT NULL REFERENCES users(id),
    option_token TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(message_id, voter_id, option_token)
);
CREATE INDEX IF NOT EXISTS idx_dm_message_poll_votes_message ON dm_message_poll_votes(message_id);
