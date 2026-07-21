-- Migration 022: Streamlined E2E Architecture
-- Adds encrypted server/channel names, voice sessions, user_media.
-- Drops orphaned tables no longer referenced by the codebase.
-- Legacy columns (name, display_name, etc.) are preserved for now
-- since the Rust handlers still reference them.

-- ============================================================
-- 1. ADD NEW COLUMNS
-- ============================================================

-- servers: encrypted server name (keep legacy "name" column for now)
ALTER TABLE servers ADD COLUMN encrypted_name BLOB;
ALTER TABLE servers ADD COLUMN name_nonce BLOB;

-- channels: encrypted channel name (keep legacy "name" column for now)
ALTER TABLE channels ADD COLUMN encrypted_name BLOB;
ALTER TABLE channels ADD COLUMN name_nonce BLOB;

-- messages: key_version for rotation tracking
ALTER TABLE messages ADD COLUMN key_version INTEGER DEFAULT 1;
ALTER TABLE dm_messages ADD COLUMN key_version INTEGER DEFAULT 1;

-- messages: encrypted_profile_snapshot (replaces separate profile_key fields)
ALTER TABLE messages ADD COLUMN encrypted_profile_snapshot BLOB;
ALTER TABLE messages ADD COLUMN profile_snapshot_nonce BLOB;
ALTER TABLE dm_messages ADD COLUMN encrypted_profile_snapshot BLOB;
ALTER TABLE dm_messages ADD COLUMN profile_snapshot_nonce BLOB;

-- messages: encrypted_file_key for wrapping file keys into conversation
ALTER TABLE messages ADD COLUMN encrypted_file_key BLOB;
ALTER TABLE messages ADD COLUMN file_key_nonce BLOB;
ALTER TABLE dm_messages ADD COLUMN encrypted_file_key BLOB;
ALTER TABLE dm_messages ADD COLUMN file_key_nonce BLOB;

-- ============================================================
-- 2. ADD PROFILE COLUMNS TO users (encrypted profile fields)
-- ============================================================

ALTER TABLE users ADD COLUMN encrypted_profile_key BLOB;
ALTER TABLE users ADD COLUMN profile_eph_pub BLOB;
ALTER TABLE users ADD COLUMN profile_nonce BLOB;

-- ============================================================
-- 3. ADD eph_pub TO server_keys (for envelope encryption)
-- ============================================================

ALTER TABLE server_keys ADD COLUMN eph_pub BLOB;

-- ============================================================
-- 4. DROP OBSOLETE TABLES (no longer referenced in code)
-- ============================================================

DROP TABLE IF EXISTS dm_keys;
DROP TABLE IF EXISTS notification_sounds;
DROP TABLE IF EXISTS server_stickers;
DROP TABLE IF EXISTS user_stickers;

-- ============================================================
-- 5. CREATE VOICE SESSION TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS voice_sessions (
    id TEXT PRIMARY KEY,
    channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ended_at DATETIME
);

CREATE TABLE IF NOT EXISTS voice_participants (
    voice_session_id TEXT NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    left_at DATETIME,
    is_muted BOOLEAN NOT NULL DEFAULT 0,
    is_deafened BOOLEAN NOT NULL DEFAULT 0,
    is_camera_on BOOLEAN NOT NULL DEFAULT 0,
    is_screen_sharing BOOLEAN NOT NULL DEFAULT 0,
    PRIMARY KEY (voice_session_id, user_id)
);

-- ============================================================
-- 6. CREATE user_media TABLE (replaces user_stickers + server_stickers)
-- ============================================================

CREATE TABLE IF NOT EXISTS user_media (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    encrypted_file_key BLOB,
    eph_pub BLOB,
    nonce BLOB,
    media_type TEXT NOT NULL CHECK(media_type IN ('sticker', 'gif', 'emoji')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_user_media_user_id ON user_media(user_id);
CREATE INDEX IF NOT EXISTS idx_user_media_type ON user_media(user_id, media_type);
