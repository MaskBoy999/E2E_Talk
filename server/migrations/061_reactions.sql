-- Migration 061: E2E-encrypted message reactions.
--
-- Reactions are content, so they are never stored in plaintext. Each reaction
-- row stores:
--   * encrypted_emoji / emoji_nonce — the emoji payload (unicode emoji or a
--     custom-emoji ref with file_id/file_key) encrypted with the channel/DM
--     key. Only members can decrypt it; the server relays/store ciphertext.
--   * emoji_token — HMAC-SHA256 blind index of the emoji (keyed by the same
--     channel/DM key, never seen by the server), used to dedupe identical
--     emoji from one reactor (UNIQUE constraint) and to toggle reactions off.
-- Counts are computed client-side after decryption; the server never sees them.
--
-- Restart-safe: IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS message_reactions (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    reactor_id TEXT NOT NULL REFERENCES users(id),
    emoji_token TEXT NOT NULL,
    encrypted_emoji TEXT NOT NULL,
    emoji_nonce TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(message_id, reactor_id, emoji_token)
);
CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON message_reactions(message_id);

CREATE TABLE IF NOT EXISTS dm_message_reactions (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES dm_messages(id) ON DELETE CASCADE,
    reactor_id TEXT NOT NULL REFERENCES users(id),
    emoji_token TEXT NOT NULL,
    encrypted_emoji TEXT NOT NULL,
    emoji_nonce TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(message_id, reactor_id, emoji_token)
);
CREATE INDEX IF NOT EXISTS idx_dm_message_reactions_message ON dm_message_reactions(message_id);
