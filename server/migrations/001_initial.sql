-- Users & Authentication
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Signal Protocol PreKeys
CREATE TABLE IF NOT EXISTS prekey_bundles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id),
    identity_key_public BLOB NOT NULL,
    signed_prekey_public BLOB NOT NULL,
    signed_prekey_signature BLOB NOT NULL,
    one_time_prekey_public BLOB,
    one_time_prekey_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id)
);

-- Sessions (encrypted ratchet state)
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    our_user_id TEXT NOT NULL REFERENCES users(id),
    their_user_id TEXT NOT NULL REFERENCES users(id),
    session_data BLOB NOT NULL,
    ratchet_counter INTEGER DEFAULT 0,
    UNIQUE(our_user_id, their_user_id)
);

-- Servers
CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Channels within servers
CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id),
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('text', 'voice')),
    position INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Server members
CREATE TABLE IF NOT EXISTS server_members (
    user_id TEXT NOT NULL REFERENCES users(id),
    server_id TEXT NOT NULL REFERENCES servers(id),
    role TEXT DEFAULT 'member',
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, server_id)
);

-- Messages (Phase 2: encrypted - server stores only ciphertext + sender)
-- Drop old messages table if it exists (Phase 1 had plaintext content column)
DROP TABLE IF EXISTS messages;

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id),
    sender_id TEXT NOT NULL REFERENCES users(id),
    encrypted_content BLOB NOT NULL,
    nonce BLOB NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);
