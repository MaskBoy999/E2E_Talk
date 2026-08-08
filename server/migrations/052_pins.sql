-- Phase 52: Per-channel message pinning.
--
-- Pinned message IDs are stored server-side so any member can see the pin list.
-- The MESSAGE CONTENT is untouched: it stays encrypted in messages/dm_messages
-- and the server only records WHICH message IDs are pinned (metadata, like
-- message IDs already are). Clients decrypt the pinned content locally when
-- rendering the pins panel — the server never sees pin content plaintext.

CREATE TABLE IF NOT EXISTS message_pins (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    pinned_by TEXT NOT NULL,
    pinned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (channel_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_message_pins_channel ON message_pins(channel_id, pinned_at);

CREATE TABLE IF NOT EXISTS dm_message_pins (
    dm_channel_id TEXT NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL REFERENCES dm_messages(id) ON DELETE CASCADE,
    pinned_by TEXT NOT NULL,
    pinned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (dm_channel_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_dm_message_pins_channel ON dm_message_pins(dm_channel_id, pinned_at);
