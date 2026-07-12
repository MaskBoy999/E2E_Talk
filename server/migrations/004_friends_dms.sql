-- Phase 4: Friend codes + friend requests + Direct Messages
--
-- NOTE: The `friend_code` column on `users` is added imperatively by the app
-- (db.rs run_migrations) with a column-exists guard, because ALTER TABLE ADD
-- COLUMN is not idempotent and run_migrations executes on every startup.
-- Everything below uses CREATE TABLE / INDEX IF NOT EXISTS so it is safe to
-- re-run. The whole batch is executed with errors ignored (matching 002/003).

-- DM channels: a private 1:1 conversation between two users.
CREATE TABLE IF NOT EXISTS dm_channels (
    id TEXT PRIMARY KEY,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- DM members: the two participants of a DM channel.
CREATE TABLE IF NOT EXISTS dm_members (
    dm_channel_id TEXT NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (dm_channel_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_dm_members_user_id ON dm_members(user_id);
CREATE INDEX IF NOT EXISTS idx_dm_members_channel_id ON dm_members(dm_channel_id);

-- DM messages: stored as ciphertext + nonce, server never sees plaintext.
CREATE TABLE IF NOT EXISTS dm_messages (
    id TEXT PRIMARY KEY,
    dm_channel_id TEXT NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    encrypted_content BLOB NOT NULL,
    nonce BLOB NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_dm_messages_channel_id ON dm_messages(dm_channel_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_dm_messages_sender_id ON dm_messages(sender_id);

-- DM keys: the symmetric DM key, envelope-encrypted for each member with their
-- identity public key. Same envelope pattern as the server_keys table.
CREATE TABLE IF NOT EXISTS dm_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dm_channel_id TEXT NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    encrypted_key BLOB NOT NULL,
    sender_public_key BLOB NOT NULL,
    nonce BLOB NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(dm_channel_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_dm_keys_channel_id ON dm_keys(dm_channel_id);
CREATE INDEX IF NOT EXISTS idx_dm_keys_user_id ON dm_keys(user_id);

-- Friend requests: from_user requests to_user. Status starts 'pending'.
CREATE TABLE IF NOT EXISTS friend_requests (
    id TEXT PRIMARY KEY,
    from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'declined')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    responded_at DATETIME,
    UNIQUE(from_user_id, to_user_id)
);

CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests(to_user_id, status);
CREATE INDEX IF NOT EXISTS idx_friend_requests_from ON friend_requests(from_user_id, status);

-- Friendships: bidirectional link. DMs require a matching friendship row.
-- Canonical ordering (a < b) prevents duplicate (a,b)/(b,a) rows.
CREATE TABLE IF NOT EXISTS friendships (
    user_id_a TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_id_b TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id_a, user_id_b),
    CHECK(user_id_a < user_id_b)
);
