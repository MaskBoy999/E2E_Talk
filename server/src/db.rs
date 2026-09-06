use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Sha256, Digest};
use chacha20poly1305::{
    aead::{Aead, AeadCore, KeyInit, OsRng, generic_array::GenericArray, generic_array::typenum::U32},
    XChaCha20Poly1305
};
use x25519_dalek::{EphemeralSecret, PublicKey};
use base64::Engine;
use std::sync::Mutex;
use uuid::Uuid;

/// Map a `messages` row (the 14-column shape used by list_messages and the
/// search functions) to a Message.
fn message_from_row(row: &rusqlite::Row) -> rusqlite::Result<Message> {
    Ok(Message {
        id: row.get(0)?,
        channel_id: row.get(1)?,
        sender_id: row.get(2)?,
        encrypted_content: row.get(3)?,
        nonce: row.get(4)?,
        timestamp: row.get(5)?,
        edited_at: row.get(6)?,
        key_version: row.get(7)?,
        encrypted_profile_snapshot: row.get(8)?,
        profile_snapshot_nonce: row.get(9)?,
        encrypted_sender_username: row.get(10)?,
        sender_username_nonce: row.get(11)?,
        sender_id_hash: row.get(12)?,
        file_id: row.get(13)?,
        thread_parent_id: None,
    })
}

/// Map a `dm_messages` row (the same 14-column shape) to a DmMessage.
fn dm_message_from_row(row: &rusqlite::Row) -> rusqlite::Result<DmMessage> {
    Ok(DmMessage {
        id: row.get(0)?,
        dm_channel_id: row.get(1)?,
        sender_id: row.get(2)?,
        encrypted_content: row.get(3)?,
        nonce: row.get(4)?,
        timestamp: row.get(5)?,
        edited_at: row.get(6)?,
        key_version: row.get(7)?,
        encrypted_profile_snapshot: row.get(8)?,
        profile_snapshot_nonce: row.get(9)?,
        encrypted_sender_username: row.get(10)?,
        sender_username_nonce: row.get(11)?,
        sender_id_hash: row.get(12)?,
        file_id: row.get(13)?,
    })
}

pub fn sha256_hex(data: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data.as_bytes());
    let result = hasher.finalize();
    result.iter().map(|b| format!("{:02x}", b)).collect()
}

#[allow(dead_code)]
pub fn hmac_sha256_hex(key: &[u8], data: &str) -> String {
    const BLOCK_SIZE: usize = 64;
    // Normalize key to 32 bytes: if key is not exactly 32 bytes, hash it.
    // This matches the client behavior in crypto.js where libsodium's one-shot
    // crypto_auth_hmacsha256 requires a 32-byte key.
    let normalized_key = if key.len() != 32 {
        let hash = Sha256::digest(key);
        hash.to_vec()
    } else {
        key.to_vec()
    };
    let mut k = vec![0u8; BLOCK_SIZE];
    k[..normalized_key.len()].copy_from_slice(&normalized_key);
    let mut ipad = vec![0u8; BLOCK_SIZE];
    let mut opad = vec![0u8; BLOCK_SIZE];
    for i in 0..BLOCK_SIZE {
        ipad[i] = k[i] ^ 0x36;
        opad[i] = k[i] ^ 0x5c;
    }
    let inner_hash = {
        let mut hasher = Sha256::new();
        hasher.update(&ipad);
        hasher.update(data.as_bytes());
        hasher.finalize()
    };
    let result = {
        let mut hasher = Sha256::new();
        hasher.update(&opad);
        hasher.update(&inner_hash);
        hasher.finalize()
    };
    result.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Insert-or-update the user's encrypted key blob (identity + message keys).
/// Shared by the key-blob endpoint and the password-change flow so the blob
/// always lands encrypted with the CURRENT password. needs_rebuild=0 clears
/// the stale-rebuild flag whenever the client re-saves the blob.
fn upsert_user_key_blob(conn: &Connection, user_id: &str, encrypted_blob: &str, salt: &str, nonce: &str) -> Result<(), String> {
    // Include needs_rebuild=0 in the insert/update so the flag is cleared
    // when the client re-saves the blob after a rebuild.
    let col_exists: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM pragma_table_info('user_key_blobs') WHERE name = 'needs_rebuild'",
            [],
            |row| row.get::<_, i32>(0),
        )
        .map(|c| c > 0)
        .unwrap_or(false);
    if col_exists {
        conn.execute(
            "INSERT INTO user_key_blobs (user_id, encrypted_blob, salt, nonce, updated_at, needs_rebuild)
             VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP, 0)
             ON CONFLICT(user_id) DO UPDATE SET
                encrypted_blob = excluded.encrypted_blob,
                salt = excluded.salt,
                nonce = excluded.nonce,
                updated_at = CURRENT_TIMESTAMP,
                needs_rebuild = 0",
            params![user_id, encrypted_blob, salt, nonce],
        )
        .map_err(|e| e.to_string())?;
    } else {
        conn.execute(
            "INSERT INTO user_key_blobs (user_id, encrypted_blob, salt, nonce, updated_at)
             VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP)
             ON CONFLICT(user_id) DO UPDATE SET
                encrypted_blob = excluded.encrypted_blob,
                salt = excluded.salt,
                nonce = excluded.nonce,
                updated_at = CURRENT_TIMESTAMP",
            params![user_id, encrypted_blob, salt, nonce],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub struct Database {
    conn: Mutex<Connection>,
    /// Directory holding uploaded file chunks (sibling of the DB file by
    /// default; env UPLOAD_DIR overrides). Stored so cleanup/shredding always
    /// operate on the same directory the upload handlers write to.
    upload_dir: String,
}

#[derive(Debug, Clone)]
pub struct User {
    pub id: String,
    pub username: String,
}

#[derive(Debug, Clone)]
pub struct Server {
    pub id: String,
    pub encrypted_name: Option<Vec<u8>>,
    pub name_nonce: Option<Vec<u8>>,
    pub owner_id: String,
    pub invite_code_hash: String,
    pub joins_disabled: bool,
    pub created_at: String,
    pub server_picture_file_id: Option<String>,
    pub server_picture_file_id_hash: Option<String>,
    pub encrypted_server_picture_key: Option<Vec<u8>>,
    pub server_picture_key_nonce: Option<Vec<u8>>,
    pub group_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Channel {
    pub id: String,
    pub server_id: String,
    pub encrypted_name: Option<Vec<u8>>,
    pub name_nonce: Option<Vec<u8>>,
    pub channel_type: String,
    pub position: i32,
    pub created_at: String,
    // F4: category FK (NULL = uncategorized)
    pub category_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Message {
    pub id: String,
    pub channel_id: String,
    pub sender_id: String,
    pub encrypted_content: Vec<u8>,
    pub nonce: Vec<u8>,
    pub timestamp: String,
    pub edited_at: Option<String>,
    // Streamlined E2E fields (migration 022)
    pub key_version: Option<i32>,
    pub encrypted_profile_snapshot: Option<Vec<u8>>,
    pub profile_snapshot_nonce: Option<Vec<u8>>,
    pub encrypted_sender_username: Option<String>,
    pub sender_username_nonce: Option<String>,
    pub sender_id_hash: Option<String>,
    pub file_id: Option<String>,
    // F3: Threaded replies
    pub thread_parent_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ChannelCategory {
    pub id: String,
    pub server_id: String,
    pub encrypted_name: Option<Vec<u8>>,
    pub name_nonce: Option<Vec<u8>>,
    pub position: i32,
}

#[derive(Debug, Clone)]
pub struct DmMessage {
    pub id: String,
    pub dm_channel_id: String,
    pub sender_id: String,
    pub encrypted_content: Vec<u8>,
    pub nonce: Vec<u8>,
    pub timestamp: String,
    pub edited_at: Option<String>,
    // Streamlined E2E fields (migration 022)
    pub key_version: Option<i32>,
    pub encrypted_profile_snapshot: Option<Vec<u8>>,
    pub profile_snapshot_nonce: Option<Vec<u8>>,
    pub encrypted_sender_username: Option<String>,
    pub sender_username_nonce: Option<String>,
    pub sender_id_hash: Option<String>,
    pub file_id: Option<String>,
}

/// One reaction row (ciphertext + blind emoji token). The emoji payload is
/// encrypted with the channel/DM key; only members can decrypt it. Counts are
/// never stored — every client computes them from the decrypted rows.
#[derive(Debug, Clone)]
pub struct ReactionRow {
    pub reactor_id: String,
    pub emoji_token: String,
    pub encrypted_emoji: String,
    pub emoji_nonce: String,
    pub created_at: String,
}

/// One poll vote row (blind option token + voter). The poll question/options
/// live inside the message's encrypted content; each vote stores ONLY the
/// HMAC-SHA256 blind token of the option id, keyed by the conversation key the
/// server never sees. Counts are computed client-side by matching tokens.
#[derive(Debug, Clone)]
pub struct PollVoteRow {
    pub voter_id: String,
    pub option_token: String,
    pub created_at: String,
}

/// One delivery/read ack row. `status` is 'delivered' or 'read'; `ack_token`
/// is the blind HMAC the recipient's client computed with the conversation key
/// (the host can't forge receipts). The author's client renders the status.
#[derive(Debug, Clone)]
pub struct AckRow {
    pub acker_id: String,
    pub status: String,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct FriendRequestRow {
    pub id: String,
    pub from_user_id: String,
    pub from_username: String,
    pub to_user_id: String,
    pub to_username: String,
    pub status: String,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct FriendRow {
    pub user_id: String,
    pub username: String,
}

#[derive(Debug, Clone)]
pub struct FileRecord {
    pub id: String,
    pub uploader_id: String,
    pub original_size: i64,
    pub mime_type: String,
    pub chunk_count: i32,
    pub upload_complete: bool,
    pub created_at: String,
    pub encrypted_mime_type: Option<Vec<u8>>,
    pub mime_nonce: Option<Vec<u8>>,
}

impl Database {
    /// Checkpoint the WAL to ensure all pending writes are flushed to the main DB file.
    /// Call this BEFORE overwriting the database file (e.g. before import) to prevent
    /// stale WAL data from corrupting the new database.
    pub fn wal_checkpoint(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Reconnect to the database at the given path (used after import)
    pub fn reconnect(&self, path: &str) -> Result<(), String> {
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        *conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA max_length=4294967296;").map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn new(path: &str, upload_dir: &str) -> Result<Self, rusqlite::Error> {
        let conn = Connection::open(path)?;
        // Raise max_length from the 1 GB default so vault blobs up to 4 GiB can
        // be stored in a single row (the vault quota is the real gate).
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA max_length=4294967296;"
        )?;

        let db = Self {
            conn: Mutex::new(conn),
            upload_dir: upload_dir.to_string(),
        };
        db.run_migrations()?;
        // Re-apply max_length after migrations (some PRAGMA settings can be
        // reset by migration batches that use execute_batch).
        {
            let conn = db.conn.lock().unwrap();
            conn.execute_batch("PRAGMA max_length=4294967296;")?;
        }
        Ok(db)
    }

    fn run_migrations(&self) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(include_str!("../migrations/001_initial.sql"))?;

        // Run e2ee migration (ignores errors if already applied)
        let _ = conn.execute_batch(include_str!("../migrations/002_e2ee.sql"));
        let _ = conn.execute_batch(include_str!("../migrations/003_bans.sql"));
        let _ = conn.execute_batch(include_str!("../migrations/004_friends_dms.sql"));

        // Migration 019: message_signature columns (must run after both messages and dm_messages exist)
        // Note: message_signature has been removed in migration 044 - this inline migration
        // only runs on existing databases that already have the column (no-op if column exists)
        let _ = conn.execute_batch("ALTER TABLE messages ADD COLUMN message_signature TEXT");
        let _ = conn.execute_batch("ALTER TABLE dm_messages ADD COLUMN message_signature TEXT");

        // Only run 005 if server_keys still has UNIQUE(server_id, user_id) from 001
        let server_keys_needs_migration: bool = conn
            .query_row(
                "SELECT sql LIKE '%UNIQUE(server_id, user_id)%' FROM sqlite_master WHERE name = 'server_keys' AND type = 'table'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if server_keys_needs_migration {
            let _ = conn.execute_batch(include_str!("../migrations/005_multi_device.sql"));
        }
        // Same check for dm_keys
        let dm_keys_needs_migration: bool = conn
            .query_row(
                "SELECT sql LIKE '%UNIQUE(dm_channel_id, user_id)%' FROM sqlite_master WHERE name = 'dm_keys' AND type = 'table'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if dm_keys_needs_migration {
            // dm_keys migration is in 005, run it separately
            let _ = conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS dm_keys_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    dm_channel_id TEXT NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    encrypted_key BLOB NOT NULL,
                    sender_public_key BLOB NOT NULL,
                    nonce BLOB NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
                INSERT OR IGNORE INTO dm_keys_new (dm_channel_id, user_id, encrypted_key, sender_public_key, nonce, created_at)
                    SELECT dm_channel_id, user_id, encrypted_key, sender_public_key, nonce, created_at FROM dm_keys;
                DROP TABLE dm_keys;
                ALTER TABLE dm_keys_new RENAME TO dm_keys;
                CREATE INDEX IF NOT EXISTS idx_dm_keys_channel_user ON dm_keys(dm_channel_id, user_id);",
            );
        }
        let _ = conn.execute_batch(include_str!("../migrations/006_hashed_codes.sql"));
        let _ = conn.execute_batch(include_str!("../migrations/007_files.sql"));
        // Migration 008: run each ALTER TABLE separately so one failure doesn't block the other
        let _ = conn.execute_batch("ALTER TABLE messages ADD COLUMN message_nonce TEXT");
        let _ = conn.execute_batch("ALTER TABLE dm_messages ADD COLUMN message_nonce TEXT");

        // --- invite_code_hash on servers ---
        // First, make the old invite_code column nullable (SQLite can't DROP COLUMN easily)
        let invite_col_nullable: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('servers') WHERE name = 'invite_code' AND \"notnull\" = 0",
                [],
                |row| row.get(0),
            )?;
        let invite_col_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('servers') WHERE name = 'invite_code'",
                [],
                |row| row.get(0),
            )?;
        if invite_col_exists && !invite_col_nullable {
            // SQLite doesn't support ALTER COLUMN, so we need to recreate the table
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS servers_new (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    owner_id TEXT NOT NULL,
                    invite_code TEXT,
                    invite_code_hash TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
                INSERT INTO servers_new (id, name, owner_id, invite_code, created_at)
                    SELECT id, name, owner_id, invite_code, created_at FROM servers;
                DROP TABLE servers;
                ALTER TABLE servers_new RENAME TO servers;"
            )?;
        }
        let invite_hash_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('servers') WHERE name = 'invite_code_hash'",
                [],
                |row| row.get(0),
            )?;
        if !invite_hash_exists {
            conn.execute("ALTER TABLE servers ADD COLUMN invite_code_hash TEXT", [])?;
        }
        // Backfill any NULL hashes from the old plaintext invite_code column.
        {
            let has_plain: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM pragma_table_info('servers') WHERE name = 'invite_code'",
                    [],
                    |row| row.get(0),
                )?;
            if has_plain {
                let ids: Vec<(String, String)> = {
                    let mut stmt = conn.prepare(
                        "SELECT id, invite_code FROM servers WHERE invite_code_hash IS NULL AND invite_code IS NOT NULL",
                    )?;
                    let rows = stmt.query_map([], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })?;
                    let mut v = Vec::new();
                    for r in rows { v.push(r?); }
                    v
                };
                for (id, code) in ids {
                    let hash = sha256_hex(&code);
                    conn.execute(
                        "UPDATE servers SET invite_code_hash = ?1 WHERE id = ?2",
                        params![hash, id],
                    )?;
                }
            }
        }
        conn.execute_batch(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_invite_code_hash ON servers(invite_code_hash)",
        )?;

        // --- friend_code_hash on users ---
        let friend_hash_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('users') WHERE name = 'friend_code_hash'",
                [],
                |row| row.get(0),
            )?;
        if !friend_hash_exists {
            conn.execute("ALTER TABLE users ADD COLUMN friend_code_hash TEXT", [])?;
        }
        // Backfill friend codes for users missing them.
        {
            let has_friend_code_col: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM pragma_table_info('users') WHERE name = 'friend_code'",
                    [],
                    |row| row.get(0),
                )?;
            let ids_without_hash: Vec<(String, Option<String>)> = {
                let mut stmt = if has_friend_code_col {
                    conn.prepare(
                        "SELECT id, friend_code FROM users WHERE friend_code_hash IS NULL",
                    )?
                } else {
                    conn.prepare(
                        "SELECT id, NULL FROM users WHERE friend_code_hash IS NULL",
                    )?
                };
                let rows = stmt.query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                })?;
                let mut v = Vec::new();
                for r in rows { v.push(r?); }
                v
            };
            for (id, maybe_code) in ids_without_hash {
                let code = match maybe_code {
                    Some(c) => c,
                    None => {
                        let new_code = Self::generate_friend_code();
                        if has_friend_code_col {
                            conn.execute(
                                "UPDATE users SET friend_code = ?1 WHERE id = ?2",
                                params![new_code, id],
                            )?;
                        }
                        new_code
                    }
                };
                let hash = sha256_hex(&code);
                conn.execute(
                    "UPDATE users SET friend_code_hash = ?1 WHERE id = ?2",
                    params![hash, id],
                )?;
            }
        }
        conn.execute_batch(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_friend_code_hash ON users(friend_code_hash)",
        )?;

        // Migration 009: key escrow
        let _ = conn.execute_batch(include_str!("../migrations/009_key_escrow.sql"));

        // Migration 010: edit tracking
        let _ = conn.execute_batch(include_str!("../migrations/010_message_features.sql"));

        // Migration 011: sticker file_key column
        let _ = conn.execute_batch(include_str!("../migrations/011_sticker_file_key.sql"));

        // Migration 012: per-user stickers/GIFs
        let _ = conn.execute_batch(include_str!("../migrations/012_user_stickers.sql"));

        // Migration 013: joins_disabled on servers
        let joins_disabled_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('servers') WHERE name = 'joins_disabled'",
                [],
                |row| row.get(0),
            )?;
        if !joins_disabled_exists {
            conn.execute("ALTER TABLE servers ADD COLUMN joins_disabled INTEGER NOT NULL DEFAULT 0", [])?;
        }

        // Migration 013: notification sound sync
        let _ = conn.execute_batch(include_str!("../migrations/013_notification_sound.sql"));

        // Migration 018: user_devices, device_id on keys, encrypted sticker keys
        let _ = conn.execute_batch(include_str!("../migrations/018_user_devices.sql"));

        // Migration 020: encrypted_profile_key and encrypted_banner_key on messages (for REST API retrieval)
        let _ = conn.execute_batch("ALTER TABLE messages ADD COLUMN encrypted_profile_key TEXT");
        let _ = conn.execute_batch("ALTER TABLE messages ADD COLUMN profile_key_nonce TEXT");
        let _ = conn.execute_batch("ALTER TABLE messages ADD COLUMN encrypted_banner_key TEXT");
        let _ = conn.execute_batch("ALTER TABLE messages ADD COLUMN banner_key_nonce TEXT");
        let _ = conn.execute_batch("ALTER TABLE dm_messages ADD COLUMN encrypted_profile_key TEXT");
        let _ = conn.execute_batch("ALTER TABLE dm_messages ADD COLUMN profile_key_nonce TEXT");
        let _ = conn.execute_batch("ALTER TABLE dm_messages ADD COLUMN encrypted_banner_key TEXT");
        let _ = conn.execute_batch("ALTER TABLE dm_messages ADD COLUMN banner_key_nonce TEXT");

        // Migration 019: friend_requests_disabled
        let fr_disabled_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('users') WHERE name = 'friend_requests_disabled'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);
        if !fr_disabled_exists {
            conn.execute("ALTER TABLE users ADD COLUMN friend_requests_disabled INTEGER NOT NULL DEFAULT 0", [])?;
        }

        // Migration 021: profile background color
        let bg_color_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('users') WHERE name = 'profile_background_color'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);
        if !bg_color_exists {
            conn.execute("ALTER TABLE users ADD COLUMN profile_background_color TEXT DEFAULT '#16213e'", [])?;
        }

        // Migration 014: profile pictures and display names
        let display_name_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('users') WHERE name = 'display_name'",
                [],
                |row| row.get(0),
            )?;
        if !display_name_exists {
            conn.execute("ALTER TABLE users ADD COLUMN display_name TEXT", [])?;
        }
        let profile_pic_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('users') WHERE name = 'profile_picture_file_id'",
                [],
                |row| row.get(0),
            )?;
        if !profile_pic_exists {
            conn.execute("ALTER TABLE users ADD COLUMN profile_picture_file_id TEXT REFERENCES files(id) ON DELETE SET NULL", [])?;
        }
        // Migration 015: username color
        let username_color_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('users') WHERE name = 'username_color'",
                [],
                |row| row.get(0),
            )?;
        if !username_color_exists {
            conn.execute("ALTER TABLE users ADD COLUMN username_color TEXT DEFAULT '#4fc3f7'", [])?;
        }

        // Migration 017: username border color (contrasting glow)
        let border_color_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('users') WHERE name = 'username_border_color'",
                [],
                |row| row.get(0),
            )?;
        if !border_color_exists {
            conn.execute("ALTER TABLE users ADD COLUMN username_border_color TEXT", [])?;
        }

        // Migration 019: store encrypted friend_code for recovery
        let encrypted_fc_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('users') WHERE name = 'encrypted_friend_code'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);
        if !encrypted_fc_exists {
            // Add encrypted friend code storage columns
            conn.execute("ALTER TABLE users ADD COLUMN encrypted_friend_code TEXT", [])?;
            conn.execute("ALTER TABLE users ADD COLUMN friend_code_salt TEXT", [])?;
            conn.execute("ALTER TABLE users ADD COLUMN friend_code_nonce TEXT", [])?;
        }

        // Migration 020: encrypted profile fields (password-based)
        for (col, def) in [
            ("encrypted_profile_data", "TEXT DEFAULT ''"),
            ("encrypted_profile_salt", "TEXT DEFAULT ''"),
            ("encrypted_profile_nonce", "TEXT DEFAULT ''"),
            ("encrypted_profile_data_key", "TEXT DEFAULT ''"),
        ] {
            let col_exists: bool = conn
                .query_row(
                    &format!("SELECT COUNT(*) > 0 FROM pragma_table_info('users') WHERE name = '{}'", col),
                    [],
                    |row| row.get::<_, i32>(0),
                )
                .map(|c| c > 0)?;
            if !col_exists {
                conn.execute(&format!("ALTER TABLE users ADD COLUMN {} {}", col, def), [])?;
            }
        }

        // Migration 018: profile banner, description, nickname
        for (col, def) in [
            ("profile_banner_file_id", "TEXT REFERENCES files(id) ON DELETE SET NULL"),
            ("description", "TEXT DEFAULT ''"),
            ("nickname", "TEXT DEFAULT ''"),
        ] {
            let col_exists: bool = conn
                .query_row(
                    &format!("SELECT COUNT(*) > 0 FROM pragma_table_info('users') WHERE name = '{}'", col),
                    [],
                    |row| row.get::<_, i32>(0),
                )
                .map(|c| c > 0)?;
            if !col_exists {
                conn.execute(&format!("ALTER TABLE users ADD COLUMN {} {}", col, def), [])?;
            }
        }

        // profile_updated_at: timestamp of last profile change (for cache invalidation)
        {
            let col_exists: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM pragma_table_info('users') WHERE name = 'profile_updated_at'",
                    [],
                    |row| row.get::<_, i32>(0),
                )
                .map(|c| c > 0)
                .unwrap_or(false);
            if !col_exists {
                conn.execute("ALTER TABLE users ADD COLUMN profile_updated_at TEXT DEFAULT ''", [])?;
                // Backfill existing users with current timestamp
                conn.execute(
                    "UPDATE users SET profile_updated_at = datetime('now') WHERE profile_updated_at = '' OR profile_updated_at IS NULL",
                    [],
                )?;
            }
        }

        // Migration 022: Streamlined E2E (MUST run LAST — drops obsolete tables/columns,
        // adds encrypted_name, encrypted_profile_snapshot, voice sessions, user_media)
        let _ = conn.execute_batch(include_str!("../migrations/022_streamlined_e2e.sql"));

        // Migration 023: Drop legacy tables (user_devices, prekey_bundles, sessions, user_device_escrow,
        // user_key_escrow) and migrate escrow to users table columns
        let _ = conn.execute_batch(include_str!("../migrations/023_streamlined_cleanup.sql"));

        // Migration 024: user_key_blobs — password-encrypted key bundle for full key recovery
        let _ = conn.execute_batch(include_str!("../migrations/024_user_key_blob.sql"));

        // Migration 025: profile_data_keys — stores each user's profile_data_key
        // encrypted with their identity key, so it can be recovered server-side
        // if the local blob save fails or cookies are cleared.
        let _ = conn.execute_batch(include_str!("../migrations/025_profile_data_keys.sql"));

        // Migration 026: blob_needs_rebuild — flag existing blobs to trigger client-side
        // rebuild with profile_key_cache (Fix 6). The server can't modify encrypted blobs,
        // so we set a flag and let the client rebuild on next login.
        let _ = conn.execute_batch(include_str!("../migrations/026_blob_needs_rebuild.sql"));

        // Migration 027: shared_profile_data_keys — stores profile_data_key pre-encrypted
        // with a DM channel or server key so friends/server-mates can fetch it directly
        // without waiting for a WS profile_key_sync roundtrip.
        let _ = conn.execute_batch(include_str!("../migrations/027_shared_profile_data_keys.sql"));

        // Migration 028: sender_id_hash — stores SHA-256(sender_id + ":" + channel_id)
        // so the client has an opaque, deterministic sender identifier without exposing
        // the raw user UUID in API responses.
        let _ = conn.execute_batch(include_str!("../migrations/028_sender_id_hash.sql"));

        // Migration 030: Client-side password hashing with hash_key escrow
        let _ = conn.execute_batch(include_str!("../migrations/030_password_hash_key.sql"));

        // Migration 031: pending_events — stores key rotation events for offline owners
        let _ = conn.execute_batch(include_str!("../migrations/031_pending_events.sql"));

        // Migration 032: server_picture — encrypted server picture/avatar support
        let _ = conn.execute_batch(include_str!("../migrations/032_server_picture.sql"));

        // Migration 033: pending_notifications — expanded offline notification queue
        let _ = conn.execute_batch(include_str!("../migrations/033_pending_notifications.sql"));

        // Migration 029: Backfill sender_id_hash for existing rows that have NULL
        // Use Rust sha256_hex() instead of SQLite's built-in sha256() (not available in older SQLite)
        {
            let msg_ids: Vec<(String, String, String)> = {
                let mut stmt = conn.prepare(
                    "SELECT id, sender_id, channel_id FROM messages WHERE sender_id_hash IS NULL"
                )?;
                let rows = stmt.query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
                })?;
                let mut v = Vec::new();
                for r in rows { v.push(r?); }
                v
            };
            for (msg_id, sender_id, channel_id) in &msg_ids {
                let hash = sha256_hex(&format!("{}:{}", sender_id, channel_id));
                conn.execute(
                    "UPDATE messages SET sender_id_hash = ?1 WHERE id = ?2",
                    params![hash, msg_id],
                )?;
            }
        }
        {
            let msg_ids2: Vec<(String, String, String)> = {
                let mut stmt = conn.prepare(
                    "SELECT id, sender_id, dm_channel_id FROM dm_messages WHERE sender_id_hash IS NULL"
                )?;
                let rows = stmt.query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
                })?;
                let mut v = Vec::new();
                for r in rows { v.push(r?); }
                v
            };
            for (msg_id, sender_id, dm_channel_id) in &msg_ids2 {
                let hash = sha256_hex(&format!("{}:{}", sender_id, dm_channel_id));
                conn.execute(
                    "UPDATE dm_messages SET sender_id_hash = ?1 WHERE id = ?2",
                    params![hash, msg_id],
                )?;
            }
        }

        // Migration 035: remove server_stickers table (unused — chat client never used it)
        let _ = conn.execute_batch(include_str!("../migrations/035_remove_server_stickers.sql"));

        // Migration 036: drop plaintext profile style columns (username_color, username_border_color, profile_background_color)
        // These are now exclusively stored in encrypted_profile_data

        // Migration 039: add file_id TEXT column to messages and dm_messages tables
        // This stores the SHA-256 hash of the file_id when a message has an attached file,
        // so the server can clean up the file record and disk chunks when the message is deleted.
        for tbl in ["messages", "dm_messages"] {
            let col_exists: bool = conn
                .query_row(
                    &format!("SELECT COUNT(*) > 0 FROM pragma_table_info('{}') WHERE name = 'file_id'", tbl),
                    [],
                    |row| row.get::<_, i32>(0),
                )
                .map(|c| c > 0)
                .unwrap_or(false);
            if !col_exists {
                if let Err(e) = conn.execute(
                    &format!("ALTER TABLE {} ADD COLUMN file_id TEXT", tbl),
                    [],
                ) {
                    let _ = e;
                }
            }
        }

        // Migration 041: add file_id_hash to servers and user_stickers tables
        // server_picture_file_id_hash: allows hash-based serving of server icons
        for tbl_col in [("servers", "server_picture_file_id_hash"), ("user_stickers", "file_id_hash")] {
            let (tbl, col) = tbl_col;
            let col_exists: bool = conn
                .query_row(
                    &format!("SELECT COUNT(*) > 0 FROM pragma_table_info('{}') WHERE name = '{}'", tbl, col),
                    [],
                    |row| row.get::<_, i32>(0),
                )
                .map(|c| c > 0)
                .unwrap_or(false);
            if !col_exists {
                let _ = conn.execute(&format!("ALTER TABLE {} ADD COLUMN {} TEXT", tbl, col), []);
            }
        }
        // Backfill hashes for existing server pictures
        {
            let ids: Vec<(String, Option<String>)> = {
                let mut stmt = conn.prepare(
                    "SELECT id, server_picture_file_id FROM servers WHERE server_picture_file_id IS NOT NULL AND server_picture_file_id_hash IS NULL"
                )?;
                let rows = stmt.query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                })?;
                let mut v = Vec::new();
                for r in rows { v.push(r?); }
                v
            };
            for (sid, maybe_fid) in ids {
                if let Some(fid) = maybe_fid {
                    let hash = sha256_hex(&fid);
                    let _ = conn.execute(
                        "UPDATE servers SET server_picture_file_id_hash = ?1 WHERE id = ?2",
                        params![hash, sid],
                    );
                }
            }
        }
        // Backfill hashes for existing user stickers (only if table exists — it's created later)
        {
            let has_table: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM sqlite_master WHERE name = 'user_stickers' AND type = 'table'",
                    [],
                    |row| row.get::<_, i32>(0),
                )
                .map(|c| c > 0)
                .unwrap_or(false);
            if has_table {
                let ids: Vec<(String, Option<String>)> = {
                    let mut stmt = conn.prepare(
                        "SELECT id, file_id FROM user_stickers WHERE file_id IS NOT NULL AND file_id_hash IS NULL"
                    )?;
                    let rows = stmt.query_map([], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                    })?;
                    let mut v = Vec::new();
                    for r in rows { v.push(r?); }
                    v
                };
                for (stid, maybe_fid) in ids {
                    if let Some(fid) = maybe_fid {
                        let hash = sha256_hex(&fid);
                        let _ = conn.execute(
                            "UPDATE user_stickers SET file_id_hash = ?1 WHERE id = ?2",
                            params![hash, stid],
                        );
                    }
                }
            }
        }

        // Migration 040: add file_id_hash TEXT column to files table
        // Allows resolving file_id from its SHA-256 hash (used by messages.file_id).
        let hash_col_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('files') WHERE name = 'file_id_hash'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);
        if !hash_col_exists {
            if let Err(e) = conn.execute("ALTER TABLE files ADD COLUMN file_id_hash TEXT", []) {
                let _ = e;
            }
        }
        // Backfill hashes for existing file records
        {
            let ids: Vec<(String,)> = {
                let mut stmt = conn.prepare(
                    "SELECT id FROM files WHERE file_id_hash IS NULL"
                )?;
                let rows = stmt.query_map([], |row| {
                    Ok((row.get::<_, String>(0)?,))
                })?;
                let mut v = Vec::new();
                for r in rows { v.push(r?); }
                v
            };
            for (fid,) in ids {
                let hash = sha256_hex(&fid);
                if let Err(e) = conn.execute(
                    "UPDATE files SET file_id_hash = ?1 WHERE id = ?2",
                    params![hash, fid],
                ) {
                    let _ = e;
                }
            }
        }

        // Migration 038: add profile_picture_file_id_hash and profile_banner_file_id_hash columns
        // These store SHA-256 hashes of the raw file_ids so the API can return
        // hashes instead of exposing the raw file_id UUIDs on the wire.
        for col in ["profile_picture_file_id_hash", "profile_banner_file_id_hash"] {
            let col_exists: bool = conn
                .query_row(
                    &format!("SELECT COUNT(*) > 0 FROM pragma_table_info('users') WHERE name = '{}'", col),
                    [],
                    |row| row.get::<_, i32>(0),
                )
                .map(|c| c > 0)
                .unwrap_or(false);
            if !col_exists {
                let _ = conn.execute(&format!("ALTER TABLE users ADD COLUMN {} TEXT", col), []);
            }
        }
        // Backfill hashes for existing profile pictures
        {
            let ids: Vec<(String, Option<String>)> = {
                let mut stmt = conn.prepare(
                    "SELECT id, profile_picture_file_id FROM users WHERE profile_picture_file_id IS NOT NULL AND profile_picture_file_id_hash IS NULL"
                )?;
                let rows = stmt.query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                })?;
                let mut v = Vec::new();
                for r in rows { v.push(r?); }
                v
            };
            for (uid, maybe_fid) in ids {
                if let Some(fid) = maybe_fid {
                    let hash = sha256_hex(&fid);
                    conn.execute(
                        "UPDATE users SET profile_picture_file_id_hash = ?1 WHERE id = ?2",
                        params![hash, uid],
                    )?;
                }
            }
        }
        // Backfill hashes for existing banners
        {
            let ids: Vec<(String, Option<String>)> = {
                let mut stmt = conn.prepare(
                    "SELECT id, profile_banner_file_id FROM users WHERE profile_banner_file_id IS NOT NULL AND profile_banner_file_id_hash IS NULL"
                )?;
                let rows = stmt.query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                })?;
                let mut v = Vec::new();
                for r in rows { v.push(r?); }
                v
            };
            for (uid, maybe_fid) in ids {
                if let Some(fid) = maybe_fid {
                    let hash = sha256_hex(&fid);
                    conn.execute(
                        "UPDATE users SET profile_banner_file_id_hash = ?1 WHERE id = ?2",
                        params![hash, uid],
                    )?;
                }
            }
        }

        // Migration 037: add friend_requests_disabled_hash column
        // Client sends HMAC(hmac_key, user_id + ":fr_disabled:" + "1"/"0") when toggling.
        // Server stores the hash and derives the boolean.
        let fr_hash_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('users') WHERE name = 'friend_requests_disabled_hash'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);
        if !fr_hash_exists {
            let _ = conn.execute("ALTER TABLE users ADD COLUMN friend_requests_disabled_hash TEXT", []);
        }
        for col in ["username_color", "username_border_color", "profile_background_color"] {
            let col_exists: bool = conn
                .query_row(
                    &format!("SELECT COUNT(*) > 0 FROM pragma_table_info('users') WHERE name = '{}'", col),
                    [],
                    |row| row.get::<_, i32>(0),
                )
                .map(|c| c > 0)
                .unwrap_or(false);
            if col_exists {
                let _ = conn.execute(&format!("ALTER TABLE users DROP COLUMN {}", col), []);
            }
        }

        // Migration P1.5: conversation_profile_data — per-conversation encrypted profile data
        // so any user with access to a DM/channel can decrypt the user's current profile.
        let _ = conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS conversation_profile_data (
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                conversation_type TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                encrypted_profile_data TEXT NOT NULL,
                nonce TEXT NOT NULL,
                updated_at TEXT DEFAULT '',
                PRIMARY KEY (user_id, conversation_type, conversation_id)
            );"
        );

        // Migration: Drop legacy plaintext profile columns (now in encrypted_profile_data)
        // Note: username_color, username_border_color, profile_background_color are handled by migration 036
        for col in ["display_name", "description", "nickname"] {
            let col_exists: bool = conn
                .query_row(
                    &format!("SELECT COUNT(*) > 0 FROM pragma_table_info('users') WHERE name = '{}'", col),
                    [],
                    |row| row.get::<_, i32>(0),
                )
                .map(|c| c > 0)
                .unwrap_or(false);
            if col_exists {
                let _ = conn.execute(&format!("ALTER TABLE users DROP COLUMN {}", col), []);
            }
        }


        // Migration: Drop sender_username and sender_profile_pic from messages/dm_messages (plaintext sender info)
        for tbl in ["messages", "dm_messages"] {
            for col in ["sender_username", "sender_profile_pic"] {
                let col_exists: bool = conn
                    .query_row(
                        &format!("SELECT COUNT(*) > 0 FROM pragma_table_info('{}') WHERE name = '{}'", tbl, col),
                        [],
                        |row| row.get::<_, i32>(0),
                    )
                    .map(|c| c > 0)
                    .unwrap_or(false);
                if col_exists {
                    let _ = conn.execute(&format!("ALTER TABLE {} DROP COLUMN {}", tbl, col), []);
                }
            }
        }

        // Migration: Drop plaintext server.name and channels.name columns
        for tbl_col in [("servers", "name"), ("channels", "name")] {
            let (tbl, col) = tbl_col;
            let col_exists: bool = conn
                .query_row(
                    &format!("SELECT COUNT(*) > 0 FROM pragma_table_info('{}') WHERE name = '{}'", tbl, col),
                    [],
                    |row| row.get::<_, i32>(0),
                )
                .map(|c| c > 0)
                .unwrap_or(false);
            if col_exists {
                let _ = conn.execute(&format!("ALTER TABLE {} DROP COLUMN {}", tbl, col), []);
            }
        }

        // P3 Migration: Add encrypted_sender_username and sender_username_nonce columns
        // to messages and dm_messages tables (for sender username encryption)
        for tbl in ["messages", "dm_messages"] {
            let col_exists: bool = conn
                .query_row(
                    &format!("SELECT COUNT(*) > 0 FROM pragma_table_info('{}') WHERE name = 'encrypted_sender_username'", tbl),
                    [],
                    |row| row.get::<_, i32>(0),
                )
                .map(|c| c > 0)
                .unwrap_or(false);
            if !col_exists {
                let _ = conn.execute(
                    &format!("ALTER TABLE {} ADD COLUMN encrypted_sender_username TEXT", tbl),
                    [],
                );
            }
            let nonce_col_exists: bool = conn
                .query_row(
                    &format!("SELECT COUNT(*) > 0 FROM pragma_table_info('{}') WHERE name = 'sender_username_nonce'", tbl),
                    [],
                    |row| row.get::<_, i32>(0),
                )
                .map(|c| c > 0)
                .unwrap_or(false);
            if !nonce_col_exists {
                let _ = conn.execute(
                    &format!("ALTER TABLE {} ADD COLUMN sender_username_nonce TEXT", tbl),
                    [],
                );
            }
        }

        // Re-create tables that are still used by the codebase but were dropped by migration 022/023
        // notification_sounds: used for cross-device notification sound sync
        let _ = conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS notification_sounds (
                user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                encrypted_sound BLOB NOT NULL,
                nonce BLOB NOT NULL,
                sender_public_key BLOB NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );"
        );
        // server_stickers was removed in migration 035 — table no longer exists
        // user_stickers: still referenced by API handlers
        let _ = conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS user_stickers (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
                encrypted_file_key BLOB,
                file_key_nonce BLOB,
                encrypted_sticker_name BLOB,
                sticker_name_nonce BLOB,
                file_id_hash TEXT,
                encrypted_mime_type BLOB,
                mime_nonce BLOB,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );"
        );

        // Migration 038: encrypted_mime_type for files and user_stickers
        // Store MIME types encrypted with the file key so the server can't read them.
        let _ = conn.execute_batch(include_str!("../migrations/038_encrypted_mime_type.sql"));

        // Migration 039: HMAC-hash social graph columns, encrypt notification sound file_name,
        // and add request_id_hash for friend accept/decline anti-enumeration.
        let _ = conn.execute_batch(include_str!("../migrations/039_social_graph_hashes.sql"));

        // Migration 040: Add invite_code_salt and friend_code_hash_salt columns for salted invite/friend codes
        let _ = conn.execute_batch(include_str!("../migrations/040_invite_code_salt.sql"));

        // Migration 041: encrypted_sticker_name — encrypt sticker/emoji names with identity key
        let _ = conn.execute_batch(include_str!("../migrations/041_encrypted_sticker_name.sql"));

        // Migration 042: Drop legacy plaintext columns (file_key, friend_code, invite_code)
        let _ = conn.execute_batch(include_str!("../migrations/042_drop_legacy_plaintext_columns.sql"));

        // Migration 043: Encrypt profile_picture_file_key and profile_banner_file_key
        let _ = conn.execute_batch(include_str!("../migrations/043_encrypted_profile_file_keys.sql"));

        // Migration 044: Drop never-populated message_signature column
        let _ = conn.execute_batch(include_str!("../migrations/044_drop_message_signature.sql"));

        // Migration 045: Drop plaintext sticker_name and file_name columns (encrypted counterparts exist)
        let _ = conn.execute_batch(include_str!("../migrations/045_drop_plaintext_metadata.sql"));

        // Migration 046: Drop plaintext mime_type from user_stickers (encrypted_mime_type + mime_nonce exist)
        let _ = conn.execute_batch(include_str!("../migrations/046_drop_sticker_mime_type.sql"));

        // Migration 047: Drop plaintext mime_type from files (encrypted_mime_type + mime_nonce exist)
        let _ = conn.execute_batch(include_str!("../migrations/047_drop_files_mime_type.sql"));

        // Migration 048: Drop dead legacy columns (message_nonce, per-message profile/banner/file keys,
        // users escrow/eph BLOBs, plaintext pic keys, servers.invite_code, key device_id/eph_pub)
        let _ = conn.execute_batch(include_str!("../migrations/048_drop_legacy_message_and_key_columns.sql"));

        // Migration 049: Voice calls & voice channels (sessions, participants, sanctions)
        let _ = conn.execute_batch(include_str!("../migrations/049_voice.sql"));

        // Migration 050: Ringtone sync — encrypted ringtone for DM call ring,
        // same client-side-encrypted pattern as notification sounds.
        let _ = conn.execute_batch(include_str!("../migrations/050_ringtone.sql"));

        // Migration 051: Persistent DM-call waiting state — survives refreshes
        // so the "waiting for you to join" indicator persists in the DM chat.
        let _ = conn.execute_batch(include_str!("../migrations/051_dm_call_waiting.sql"));

        // Migration 052: Per-channel message pinning. Pins are metadata only
        // (message IDs); message content stays encrypted in messages/dm_messages.
        let _ = conn.execute_batch(include_str!("../migrations/052_pins.sql"));

        // Migration 053: Auth sessions (Settings → Security → Devices). One row
        // per signed-in device so sessions can be listed and force-kicked.
        let _ = conn.execute_batch(include_str!("../migrations/053_auth_sessions.sql"));

        // Migration 054: Conversation-profile field-presence metadata so the
        // server can reject non-authoritative uploads that would drop fields
        // (banner/PFP) a previous upload (or the users table) already carries.
        let _ = conn.execute_batch(include_str!("../migrations/054_conv_profile_meta.sql"));

        // Migration 055: Append-only admin audit log (G4) — who did what in
        // the admin panel, when, to which target, from which IP.
        let _ = conn.execute_batch(include_str!("../migrations/055_admin_audit.sql"));
        // Migration 056: TOTP 2FA (encrypted secret) + one-time recovery codes.
        let _ = conn.execute_batch(include_str!("../migrations/056_2fa.sql"));
        // Migration 057 (F4): drop dead X3DH-era tables (sessions / user_devices /
        // prekey_bundles) — 0 rows, no code references left.
        let _ = conn.execute_batch(include_str!("../migrations/057_drop_legacy_x3dh.sql"));
        // Migration 058 (B1): drop the last 3 dead plaintext columns. Run each
        // ALTER separately so one "already dropped" failure can't block the rest
        // (the 042/043/048 multi-statement batches silently aborted early on
        // databases where an earlier statement in the batch had already applied).
        let _ = conn.execute_batch("ALTER TABLE servers DROP COLUMN invite_code");
        let _ = conn.execute_batch("ALTER TABLE users DROP COLUMN profile_picture_file_key");
        let _ = conn.execute_batch("ALTER TABLE users DROP COLUMN profile_banner_file_key");
        // Migration 059 (Kill Switch): second password that deletes the account
        // when entered at login. Verifier is Argon2id-wrapped client-side with
        // the kill-switch password itself — the server stores no replayable
        // credential, only the wrapped blob + a check HMAC. Each ALTER runs
        // separately so a restart can't block the batch on the first duplicate
        // column (same pattern as 058).
        for col in ["kill_switch_verifier_encrypted", "kill_switch_wrap_salt", "kill_switch_wrap_nonce", "kill_switch_salt", "kill_switch_check"] {
            let _ = conn.execute_batch(&format!("ALTER TABLE users ADD COLUMN {} TEXT", col));
        }

        // Migration 060: E2E blind-index message search tokens (metadata only —
        // content stays encrypted; the HMAC key never leaves the client).
        let _ = conn.execute_batch(include_str!("../migrations/060_search_index.sql"));
        // Migration 061: E2E-encrypted message reactions (ciphertext + blind
        // emoji token per reactor; counts are computed client-side).
        let _ = conn.execute_batch(include_str!("../migrations/061_reactions.sql"));
        // Migration 062: E2E-encrypted polls — the question/options ride in the
        // message's encrypted content; each vote stores only a blind HMAC
        // option token (keyed by the conversation key) so the host can never
        // read which option was chosen.
        let _ = conn.execute_batch(include_str!("../migrations/062_polls.sql"));
        // Migration 063: E2E per-message delivery/read acks — each row stores
        // the recipient + a blind HMAC proof token (conversation-keyed) so the
        // host can store/relay receipts but never forge one for ciphertext it
        // can't decrypt.
        let _ = conn.execute_batch(include_str!("../migrations/063_message_acks.sql"));
        // Migration 064: disappearing messages — expires_at (NULL = never) on
        // messages + dm_messages; the sweeper shreds expired rows + files.
        let _ = conn.execute_batch(include_str!("../migrations/064_disappearing.sql"));
        // Migration 065: files.chunk_bytes — cumulative actual bytes written per
        // file, so chunk uploads are bounded by the declared size (H1).
        let _ = conn.execute_batch(include_str!("../migrations/065_file_chunk_bytes.sql"));
        // Migration 066: threads + channel categories
        let _ = conn.execute_batch(include_str!("../migrations/066_threads_and_categories.sql"));
        // Migration 067: user CSS slots
        let _ = conn.execute_batch(include_str!("../migrations/067_user_css_slots.sql"));
        // Migration 068: Recreate user_key_escrow (dropped by 023, still referenced by code)
        let _ = conn.execute_batch(include_str!("../migrations/068_recreate_key_escrow.sql"));
        let _ = conn.execute_batch(include_str!("../migrations/069_file_vault.sql"));
        let _ = conn.execute_batch(include_str!("../migrations/070_self_destruct.sql"));
        let _ = conn.execute_batch(include_str!("../migrations/071_vault_compression.sql"));
        let _ = conn.execute_batch(include_str!("../migrations/072_vault_disk_storage.sql"));
        let _ = conn.execute_batch(include_str!("../migrations/073_server_order.sql"));
        let _ = conn.execute_batch(include_str!("../migrations/074_dm_order.sql"));
        let _ = conn.execute_batch(include_str!("../migrations/075_user_blocks.sql"));
        let _ = conn.execute_batch(include_str!("../migrations/076_soundboard.sql"));
        let _ = conn.execute_batch(include_str!("../migrations/077_device_pairing.sql"));
        let _ = conn.execute_batch(include_str!("../migrations/078_soundboard_global_mute.sql"));
        let _ = conn.execute_batch(include_str!("../migrations/079_server_groups.sql"));
        let _ = conn.execute_batch(include_str!("../migrations/080_soundboard_per_account.sql"));
        let _ = conn.execute_batch(include_str!("../migrations/081_soundboard_user_disable.sql"));
        let _ = conn.execute_batch(include_str!("../migrations/082_server_group_color.sql"));
        let _ = conn.execute_batch(include_str!("../migrations/083_soundboard_clip_no_fk.sql"));

        // Data migration: normalize legacy space-separated CURRENT_TIMESTAMP values
        // ("YYYY-MM-DD HH:MM:SS") to fixed-width RFC3339 ("YYYY-MM-DDTHH:MM:SS.000000Z")
        // so lexicographic ordering is consistent with newly-inserted messages.
        // Idempotent: after the first run no length-19 space-separated rows remain.
        let _ = conn.execute_batch(
            "UPDATE messages SET timestamp = replace(timestamp, ' ', 'T') || '.000000Z' WHERE instr(timestamp, ' ') > 0 AND length(timestamp) = 19;\n\
             UPDATE dm_messages SET timestamp = replace(timestamp, ' ', 'T') || '.000000Z' WHERE instr(timestamp, ' ') > 0 AND length(timestamp) = 19;",
        );

        // --- Startup schema verification check ---
        // Verify that the last migration's expected columns exist.
        // If any expected migration was skipped, log a warning so the operator knows.
        if let Ok(cols) = (|| -> Result<Vec<String>, rusqlite::Error> {
            let mut stmt = conn.prepare(
                "SELECT name FROM pragma_table_info('files') WHERE name IN ('encrypted_mime_type', 'mime_nonce', 'file_id_hash')"
            )?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            let mut v = Vec::new();
            for r in rows { v.push(r?); }
            Ok(v)
        })() {
            let expected = ["encrypted_mime_type", "mime_nonce", "file_id_hash"];
            for col in &expected {
                if !cols.contains(&col.to_string()) {
                    eprintln!("WARN: Migration column '{}' not found on files table — schema may be outdated.", col);
                }
            }
        } else {
            eprintln!("WARN: Could not verify files table schema — the files table may not exist or is corrupted.");
        }

        // Ensure max_length is high enough for vault blobs (default 1 GB is too
        // small for files up to 4 GiB; the vault quota is the real gate).
        conn.execute_batch("PRAGMA max_length=4294967296;")?;

        Ok(())
    }

    /// 8-character friend code: A-Z, 2-9 (no 0/O/1/I to avoid ambiguous chars).
    fn generate_friend_code() -> String {
        use rand::Rng;
        const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        let mut rng = rand::thread_rng();
        (0..8)
            .map(|_| {
                let idx = rng.gen_range(0..ALPHABET.len());
                ALPHABET[idx] as char
            })
            .collect()
    }

    /// Prepare a SQL statement for admin diagnostic queries.
    /// Returns `Ok(None)` if the table or referenced column doesn't exist
    /// (dropped by a schema migration) so the caller can return an empty result
    /// instead of crashing with a 500 error.
    fn prepare_optional<'a>(conn: &'a rusqlite::Connection, sql: &str) -> Result<Option<rusqlite::Statement<'a>>, String> {
        match conn.prepare(sql) {
            Ok(s) => Ok(Some(s)),
            Err(e) => {
                if e.to_string().contains("no such") {
                    Ok(None)
                } else {
                    Err(e.to_string())
                }
            }
        }
    }

    // --- Users ---

    pub fn create_user(&self, username: &str, password_hash: &str, identity_public_key: Option<&[u8]>, friend_code_hash: Option<&str>, friend_code_hash_salt: Option<&str>, encrypted_friend_code: Option<&str>, friend_code_salt: Option<&str>, friend_code_nonce: Option<&str>, encrypted_hash_key: Option<&str>, hash_key_salt: Option<&str>, hash_key_nonce: Option<&str>) -> Result<User, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();

        conn.execute(
            "INSERT INTO users (id, username, password_hash, identity_public_key, friend_code_hash, friend_code_hash_salt, encrypted_friend_code, friend_code_salt, friend_code_nonce, encrypted_hash_key, hash_key_salt, hash_key_nonce) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![id, username, password_hash, identity_public_key, friend_code_hash, friend_code_hash_salt, encrypted_friend_code, friend_code_salt, friend_code_nonce, encrypted_hash_key, hash_key_salt, hash_key_nonce],
        )
        .map_err(|e| {
            if e.to_string().contains("UNIQUE") {
                "Username already taken".to_string()
            } else {
                e.to_string()
            }
        })?;

        Ok(User {
            id,
            username: username.to_string(),
        })
    }

    /// Username lookup for admin views (rate-limit usage). None when unknown.
    pub fn get_username_by_id(&self, user_id: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        match conn.query_row(
            "SELECT username FROM users WHERE id = ?1",
            params![user_id],
            |row| row.get::<_, String>(0),
        ) {
            Ok(u) => Ok(Some(u)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn get_user_by_username(&self, username: &str) -> Result<User, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT id, username FROM users WHERE username = ?1",
            params![username],
            |row| {
                Ok(User {
                    id: row.get(0)?,
                    username: row.get(1)?,
                })
            },
        )
        .map_err(|_| "User not found".to_string())
    }

    pub fn get_user_by_id(&self, id: &str) -> Result<User, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT id, username FROM users WHERE id = ?1",
            params![id],
            |row| {
                Ok(User {
                    id: row.get(0)?,
                    username: row.get(1)?,
                })
            },
        )
        .map_err(|_| "User not found".to_string())
    }

    pub fn get_user_profile(&self, id: &str) -> Result<(String, String, Option<String>, Option<String>, Option<String>, Option<String>, Option<Vec<u8>>, Option<Vec<u8>>, Option<Vec<u8>>, Option<Vec<u8>>), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let has_banner: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('users') WHERE name = 'profile_banner_file_id'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);

        let sql = if has_banner {
            "SELECT id, username, profile_picture_file_id, profile_picture_file_id_hash,
                    profile_banner_file_id, profile_banner_file_id_hash,
                    encrypted_pic_key, pic_key_nonce, encrypted_banner_key, banner_key_nonce
             FROM users WHERE id = ?1"
        } else {
            "SELECT id, username, profile_picture_file_id, profile_picture_file_id_hash,
                    NULL as banner_id, NULL as banner_hash,
                    encrypted_pic_key, pic_key_nonce, encrypted_banner_key, banner_key_nonce
             FROM users WHERE id = ?1"
        };

        conn.query_row(sql, params![id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<Vec<u8>>>(6)?,
                row.get::<_, Option<Vec<u8>>>(7)?,
                row.get::<_, Option<Vec<u8>>>(8)?,
                row.get::<_, Option<Vec<u8>>>(9)?,
            ))
        })
        .map_err(|_| "User not found".to_string())
    }

    pub fn update_profile_picture(&self, user_id: &str, file_id: Option<&str>, encrypted_key: Option<&[u8]>, key_nonce: Option<&[u8]>) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let hash = file_id.map(|fid| sha256_hex(fid));
        conn.execute(
            "UPDATE users SET profile_picture_file_id = ?1, profile_picture_file_id_hash = ?2, encrypted_pic_key = ?3, pic_key_nonce = ?4 WHERE id = ?5",
            params![file_id, hash, encrypted_key, key_nonce, user_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE users SET profile_updated_at = datetime('now') WHERE id = ?1",
            params![user_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn update_profile_banner(&self, user_id: &str, file_id: Option<&str>, encrypted_key: Option<&[u8]>, key_nonce: Option<&[u8]>) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let hash = file_id.map(|fid| sha256_hex(fid));
        conn.execute(
            "UPDATE users SET profile_banner_file_id = ?1, profile_banner_file_id_hash = ?2, encrypted_banner_key = ?3, banner_key_nonce = ?4 WHERE id = ?5",
            params![file_id, hash, encrypted_key, key_nonce, user_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE users SET profile_updated_at = datetime('now') WHERE id = ?1",
            params![user_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    // description/nickname no longer stored as plaintext — use encrypted_profile_data

    pub fn save_encrypted_profile(&self, user_id: &str, encrypted_data: &str, salt: &str, nonce: &str, encrypted_data_key: Option<&str>) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        match encrypted_data_key {
            Some(key) => {
                conn.execute(
                    "UPDATE users SET encrypted_profile_data = ?1, encrypted_profile_salt = ?2, encrypted_profile_nonce = ?3, encrypted_profile_data_key = ?4 WHERE id = ?5",
                    params![encrypted_data, salt, nonce, key, user_id],
                )
                .map_err(|e| e.to_string())?;
            }
            None => {
                conn.execute(
                    "UPDATE users SET encrypted_profile_data = ?1, encrypted_profile_salt = ?2, encrypted_profile_nonce = ?3 WHERE id = ?4",
                    params![encrypted_data, salt, nonce, user_id],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        conn.execute(
            "UPDATE users SET profile_updated_at = datetime('now') WHERE id = ?1",
            params![user_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_encrypted_profile(&self, user_id: &str) -> Result<Option<(String, String, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // Check if encrypted_profile_data_key column exists
        let key_col_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('users') WHERE name = 'encrypted_profile_data_key'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);
        
        if key_col_exists {
            let result = conn.query_row(
                "SELECT encrypted_profile_data, encrypted_profile_salt, encrypted_profile_nonce, encrypted_profile_data_key FROM users WHERE id = ?1",
                params![user_id],
                |row| Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                )),
            );
            match result {
                Ok((data, salt, nonce, key)) => Ok(Some((data, salt, nonce, key))),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(e.to_string()),
            }
        } else {
            let result = conn.query_row(
                "SELECT encrypted_profile_data, encrypted_profile_salt, encrypted_profile_nonce FROM users WHERE id = ?1",
                params![user_id],
                |row| Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                )),
            );
            match result {
                Ok((data, salt, nonce)) => Ok(Some((data, salt, nonce, String::new()))),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(e.to_string()),
            }
        }
    }

    pub fn get_profile_updated_at(&self, user_id: &str) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT profile_updated_at FROM users WHERE id = ?1",
            params![user_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .map(|t| t.unwrap_or_default())
        .map_err(|_| "User not found".to_string())
    }

    pub fn upsert_conversation_profile(&self, user_id: &str, conv_type: &str, conv_id: &str, encrypted_data: &str, nonce: &str, pfp_file_id: Option<&str>, banner_file_id: Option<&str>) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO conversation_profile_data (user_id, conversation_type, conversation_id, encrypted_profile_data, nonce, profile_picture_file_id, profile_banner_file_id, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'))",
            params![user_id, conv_type, conv_id, encrypted_data, nonce, pfp_file_id, banner_file_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Last-uploaded field-presence metadata (pfp id, banner id) for a
    /// conversation profile. None = no row (never uploaded).
    pub fn get_conversation_profile_meta(&self, user_id: &str, conv_type: &str, conv_id: &str) -> Result<Option<(Option<String>, Option<String>)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let result = conn.query_row(
            "SELECT profile_picture_file_id, profile_banner_file_id FROM conversation_profile_data WHERE user_id = ?1 AND conversation_type = ?2 AND conversation_id = ?3",
            params![user_id, conv_type, conv_id],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?)),
        );
        match result {
            Ok(val) => Ok(Some(val)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn get_conversation_profile(&self, user_id: &str, conv_type: &str, conv_id: &str) -> Result<Option<(String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let result = conn.query_row(
            "SELECT encrypted_profile_data, nonce FROM conversation_profile_data WHERE user_id = ?1 AND conversation_type = ?2 AND conversation_id = ?3",
            params![user_id, conv_type, conv_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        );
        match result {
            Ok(val) => Ok(Some(val)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn get_conversation_profiles_batch(&self, conv_type: &str, conv_id: &str, user_ids: &[&str]) -> Result<std::collections::HashMap<String, (String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut map = std::collections::HashMap::new();
        for uid in user_ids {
            match conn.query_row(
                "SELECT encrypted_profile_data, nonce FROM conversation_profile_data WHERE user_id = ?1 AND conversation_type = ?2 AND conversation_id = ?3",
                params![uid, conv_type, conv_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            ) {
                Ok(val) => { map.insert(uid.to_string(), val); }
                Err(_) => {}
            }
        }
        Ok(map)
    }

    pub fn get_password_hash(&self, username: &str) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT password_hash FROM users WHERE username = ?1",
            params![username],
            |row| row.get(0),
        )
        .map_err(|_| "User not found".to_string())
    }

    pub fn get_password_hash_by_id(&self, user_id: &str) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT password_hash FROM users WHERE id = ?1",
            params![user_id],
            |row| row.get(0),
        )
        .map_err(|_| "User not found".to_string())
    }

    /// Returns (encrypted_hash_key, hash_key_salt, hash_key_nonce) for the given username.
    /// These are the Argon2id-encrypted hash_key that the client uses to derive the
    /// pre-hashed password for authentication.
    pub fn get_server_owner_id(&self, server_id: &str) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT user_id FROM server_members WHERE server_id = ?1 AND role = 'owner'",
            params![server_id],
            |row| row.get(0),
        )
        .map_err(|_| "Server owner not found".to_string())
    }

    // --- Pending Events (offline owner key rotation) ---

    pub fn save_pending_event(&self, user_id: &str, server_id: &str, event_type: &str, affected_user_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO pending_events (user_id, server_id, event_type, affected_user_id) VALUES (?1, ?2, ?3, ?4)",
            params![user_id, server_id, event_type, affected_user_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_and_delete_pending_events(&self, user_id: &str) -> Result<Vec<(String, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT server_id, event_type, affected_user_id FROM pending_events WHERE user_id = ?1 ORDER BY created_at ASC"
            )
            .map_err(|e| e.to_string())?;
        let events: Vec<(String, String, String)> = stmt
            .query_map(params![user_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        conn.execute("DELETE FROM pending_events WHERE user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;

        Ok(events)
    }

    // --- Pending Notifications (ECDH + XChaCha20-Poly1305) ---
    //
    // Server encrypts notifications with ECDH(ephemeral_private, user_identity_public)
    // → shared_secret → SHA-256 → XChaCha20 key, then stores
    // "ephemeral_pubkey_b64:nonce_b64:ciphertext_b64" in the payload column.
    // The client decrypts with ECDH(identity_private, ephemeral_public) → same key.
    // This matches the notification sound pattern: data encrypted with identity key.
    // The server generates a fresh ephemeral key pair per notification.

    /// Encrypt a notification payload using ECDH + XChaCha20-Poly1305
    /// Returns "epk_b64:nonce_b64:ciphertext_b64" composite string
    fn encrypt_notification_payload(payload: &str, identity_pub_key: &[u8]) -> Result<String, String> {
        // Generate ephemeral X25519 key pair
        let mut rng = OsRng;
        let ephemeral_secret = EphemeralSecret::random_from_rng(&mut rng);
        let ephemeral_pub = PublicKey::from(&ephemeral_secret);
        
        // User's identity public key (32 bytes)
        let user_pub_bytes: [u8; 32] = identity_pub_key.try_into()
            .map_err(|_| "Identity public key must be 32 bytes".to_string())?;
        let user_pub = PublicKey::from(user_pub_bytes);
        
        // ECDH: shared secret = ephemeral_private * user_public
        let shared_secret = ephemeral_secret.diffie_hellman(&user_pub);
        
        // Derive XChaCha20 key: SHA-256(shared_secret)
        let chacha_key_bytes = Sha256::digest(shared_secret.as_bytes());
        let chacha_key = GenericArray::<u8, U32>::from_slice(&chacha_key_bytes);
        let cipher = XChaCha20Poly1305::new(chacha_key);
        
        // Generate random 24-byte nonce (XChaCha20 extended nonce)
        let nonce_bytes = XChaCha20Poly1305::generate_nonce(&mut rng);
        
        // Encrypt payload
        let ciphertext = cipher
            .encrypt(&nonce_bytes, payload.as_bytes())
            .map_err(|e| format!("XChaCha20Poly1305 encrypt failed: {:?}", e))?;
        
        // Format: ephemeral_pubkey_b64:nonce_b64:ciphertext_b64
        let epk_b64 = base64::engine::general_purpose::STANDARD.encode(ephemeral_pub.as_bytes());
        let nonce_b64 = base64::engine::general_purpose::STANDARD.encode(&nonce_bytes);
        let ct_b64 = base64::engine::general_purpose::STANDARD.encode(&ciphertext);
        
        Ok(format!("{}:{}:{}", epk_b64, nonce_b64, ct_b64))
    }

    pub fn save_pending_notification(&self, user_id: &str, notification_type: &str, payload: &str, hmac_key: &[u8]) -> Result<(), String> {
        // Fetch user's identity public key from DB
        let identity_pub = self.get_identity_public_key(user_id)
            .map_err(|_| "User has no identity public key".to_string())?;
        
        let encrypted_payload = Self::encrypt_notification_payload(payload, &identity_pub)?;
        // B4: blind the notification_type column — the real type already rides
        // inside the encrypted payload (mention/reply/friend payloads carry
        // "type"; dm_new is wrapped with one at the save site), so the client
        // dispatches from the decrypted payload, not this column.
        let blind_type = hmac_sha256_hex(hmac_key, &format!("notif_type:{}", notification_type));
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO pending_notifications (user_id, notification_type, payload) VALUES (?1, ?2, ?3)",
            params![user_id, blind_type, encrypted_payload],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// B2: encrypt a plaintext notification payload for a specific user (ECDH +
    /// XChaCha20, identical scheme to the offline queue) so the live WS relay can
    /// deliver the same encrypted envelope the client already decrypts on the
    /// offline path. Returns "epk_b64:nonce_b64:ciphertext_b64".
    pub fn encrypt_notification_for_user(&self, user_id: &str, payload: &str) -> Result<String, String> {
        let identity_pub = self.get_identity_public_key(user_id)
            .map_err(|_| "User has no identity public key".to_string())?;
        Self::encrypt_notification_payload(payload, &identity_pub)
    }

    pub fn get_and_delete_pending_notifications(&self, user_id: &str) -> Result<Vec<(String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT notification_type, payload FROM pending_notifications WHERE user_id = ?1 ORDER BY created_at ASC"
            )
            .map_err(|e| e.to_string())?;
        let notifs: Vec<(String, String)> = stmt
            .query_map(params![user_id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        conn.execute("DELETE FROM pending_notifications WHERE user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;

        Ok(notifs)
    }

    /// Returns (encrypted_hash_key, hash_key_salt, hash_key_nonce) plus the
    /// Kill Switch blob (verifier_encrypted, wrap_salt, wrap_nonce, ks_salt,
    /// check) — each an Option for the 5 kill-switch fields (NULL when unset).
    pub fn get_auth_params(&self, username: &str) -> Result<(String, String, String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT encrypted_hash_key, hash_key_salt, hash_key_nonce, \
                    kill_switch_verifier_encrypted, kill_switch_wrap_salt, kill_switch_wrap_nonce, \
                    kill_switch_salt, kill_switch_check \
             FROM users WHERE username = ?1",
            params![username],
            |row| Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
            )),
        )
        .map_err(|_| "User not found".to_string())
    }

    /// Kill Switch columns for the account owner (used by the settings UI status).
    pub fn get_kill_switch_status(&self, user_id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT kill_switch_check IS NOT NULL FROM users WHERE id = ?1",
            params![user_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|_| "User not found".to_string())
    }

    /// Kill Switch check HMAC for the LOGIN path (username lookup). Returns
    /// None when no kill switch is configured.
    pub fn get_kill_switch_check(&self, username: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT kill_switch_check FROM users WHERE username = ?1",
            params![username],
            |row| row.get::<_, Option<String>>(0),
        )
        .map_err(|_| "User not found".to_string())
    }

    /// Store the client-computed Kill Switch blob. The verifier itself is
    /// Argon2id-wrapped with the kill-switch password, so the server never
    /// holds a credential it could replay.
    pub fn set_kill_switch(
        &self,
        user_id: &str,
        verifier_encrypted: &str,
        wrap_salt: &str,
        wrap_nonce: &str,
        ks_salt: &str,
        check: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE users SET kill_switch_verifier_encrypted = ?1, kill_switch_wrap_salt = ?2, \
             kill_switch_wrap_nonce = ?3, kill_switch_salt = ?4, kill_switch_check = ?5 WHERE id = ?6",
            params![verifier_encrypted, wrap_salt, wrap_nonce, ks_salt, check, user_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Remove the Kill Switch (off by default — no kill-switch columns = disabled).
    pub fn clear_kill_switch(&self, user_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE users SET kill_switch_verifier_encrypted = NULL, kill_switch_wrap_salt = NULL, \
             kill_switch_wrap_nonce = NULL, kill_switch_salt = NULL, kill_switch_check = NULL WHERE id = ?1",
            params![user_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    // --- Servers ---

    pub fn create_server(&self, owner_id: &str, invite_code_hash: &str, invite_code_salt: &str, encrypted_name: Option<&[u8]>, name_nonce: Option<&[u8]>, channel_encrypted_name: Option<&[u8]>, channel_name_nonce: Option<&[u8]>, voice_channel_encrypted_name: Option<&[u8]>, voice_channel_name_nonce: Option<&[u8]>) -> Result<Server, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let server_id = Uuid::new_v4().to_string();
        let general_id = Uuid::new_v4().to_string();

        let has_name_col: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('servers') WHERE name = 'name'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);
        if has_name_col {
            conn.execute(
                "INSERT INTO servers (id, owner_id, invite_code_hash, invite_code_salt, encrypted_name, name_nonce, name) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '')",
                params![server_id, owner_id, invite_code_hash, invite_code_salt, encrypted_name, name_nonce],
            )
            .map_err(|e| e.to_string())?;
        } else {
            conn.execute(
                "INSERT INTO servers (id, owner_id, invite_code_hash, invite_code_salt, encrypted_name, name_nonce) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![server_id, owner_id, invite_code_hash, invite_code_salt, encrypted_name, name_nonce],
            )
            .map_err(|e| e.to_string())?;
        }

        conn.execute(
            "INSERT INTO server_members (user_id, server_id, role) VALUES (?1, ?2, 'owner')",
            params![owner_id, server_id],
        )
        .map_err(|e| e.to_string())?;

        // F4: Create default categories "Text Channels" and "Voice Channels"
        let text_cat_id = Uuid::new_v4().to_string();
        let voice_cat_id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO channel_categories (id, server_id, position, created_at) VALUES (?1, ?2, 0, datetime('now'))",
            params![text_cat_id, server_id],
        ).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO channel_categories (id, server_id, position, created_at) VALUES (?1, ?2, 1, datetime('now'))",
            params![voice_cat_id, server_id],
        ).map_err(|e| e.to_string())?;

        // Check if channels table has encrypted_name and name_nonce columns
        let has_ch_name_col: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('channels') WHERE name = 'encrypted_name'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);
        let has_ch_nonce_col: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('channels') WHERE name = 'name_nonce'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);        if has_ch_name_col && has_ch_nonce_col {
            conn.execute(
                "INSERT INTO channels (id, server_id, encrypted_name, name_nonce, type, position, category_id) VALUES (?1, ?2, ?3, ?4, 'text', 0, ?5)",
                params![general_id, server_id, channel_encrypted_name, channel_name_nonce, text_cat_id],
            ).map_err(|e| e.to_string())?;
        } else {
            conn.execute(
                "INSERT INTO channels (id, server_id, type, position, category_id) VALUES (?1, ?2, 'text', 0, ?3)",
                params![general_id, server_id, text_cat_id],
            ).map_err(|e| e.to_string())?;
        }

        // Create a default voice channel in the Voice Channels category
        let voice_ch_id = uuid::Uuid::new_v4().to_string();
        if has_ch_name_col && has_ch_nonce_col && voice_channel_encrypted_name.is_some() {
            conn.execute(
                "INSERT INTO channels (id, server_id, encrypted_name, name_nonce, type, position, category_id) VALUES (?1, ?2, ?3, ?4, 'voice', 0, ?5)",
                params![voice_ch_id, server_id, voice_channel_encrypted_name, voice_channel_name_nonce, voice_cat_id],
            ).map_err(|e| e.to_string())?;
        } else {
            conn.execute(
                "INSERT INTO channels (id, server_id, type, position, category_id) VALUES (?1, ?2, 'voice', 0, ?3)",
                params![voice_ch_id, server_id, voice_cat_id],
            ).map_err(|e| e.to_string())?;
        }

        Ok(Server {
            id: server_id,
            encrypted_name: encrypted_name.map(|v| v.to_vec()),
            name_nonce: name_nonce.map(|v| v.to_vec()),
            owner_id: owner_id.to_string(),
            invite_code_hash: invite_code_hash.to_string(),
            joins_disabled: false,
            created_at: String::new(),
            server_picture_file_id: None,
            server_picture_file_id_hash: None,
            encrypted_server_picture_key: None,
            server_picture_key_nonce: None,
            group_id: None,
        })
    }

    pub fn update_server_name(&self, server_id: &str, encrypted_name: &[u8], name_nonce: &[u8]) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE servers SET encrypted_name = ?1, name_nonce = ?2 WHERE id = ?3",
            params![encrypted_name, name_nonce, server_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn update_server_picture(&self, server_id: &str, file_id: &str, encrypted_key: &[u8], key_nonce: &[u8]) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let hash = sha256_hex(file_id);
        conn.execute(
            "UPDATE servers SET server_picture_file_id = ?1, server_picture_file_id_hash = ?2, encrypted_server_picture_key = ?3, server_picture_key_nonce = ?4 WHERE id = ?5",
            params![file_id, hash, encrypted_key, key_nonce, server_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn remove_server_picture(&self, server_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE servers SET server_picture_file_id = NULL, server_picture_file_id_hash = NULL, encrypted_server_picture_key = NULL, server_picture_key_nonce = NULL WHERE id = ?1",
            params![server_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn update_channel_name(&self, channel_id: &str, encrypted_name: &[u8], name_nonce: &[u8]) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE channels SET encrypted_name = ?1, name_nonce = ?2 WHERE id = ?3",
            params![encrypted_name, name_nonce, channel_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_user_servers(&self, user_id: &str) -> Result<Vec<Server>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT s.id, s.encrypted_name, s.name_nonce, s.owner_id, COALESCE(s.invite_code_hash, ''), COALESCE(s.joins_disabled, 0), s.server_picture_file_id, s.server_picture_file_id_hash, s.encrypted_server_picture_key, s.server_picture_key_nonce, s.group_id
                 FROM servers s
                 INNER JOIN server_members sm ON s.id = sm.server_id
                 WHERE sm.user_id = ?1
                 ORDER BY sm.position ASC, s.id",
            )
            .map_err(|e| e.to_string())?;
        let servers = stmt
            .query_map(params![user_id], |row| {
                Ok(Server {
                    id: row.get(0)?,
                    encrypted_name: row.get(1)?,
                    name_nonce: row.get(2)?,
                    owner_id: row.get(3)?,
                    invite_code_hash: row.get(4)?,
                    joins_disabled: row.get::<_, i64>(5)? != 0,
                    created_at: String::new(),
                    server_picture_file_id: row.get(6)?,
                    server_picture_file_id_hash: row.get(7)?,
                    encrypted_server_picture_key: row.get(8)?,
                    server_picture_key_nonce: row.get(9)?,
                    group_id: row.get(10)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(servers)
    }

    pub fn is_member_of_server(&self, user_id: &str, server_id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        Self::is_member_of_server_c(&conn, user_id, server_id)
    }

    fn is_member_of_server_c(conn: &Connection, user_id: &str, server_id: &str) -> Result<bool, String> {
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM server_members WHERE user_id = ?1 AND server_id = ?2",
                params![user_id, server_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(count > 0)
    }

    pub fn is_server_owner(&self, user_id: &str, server_id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        Self::is_server_owner_c(&conn, user_id, server_id)
    }

    fn is_server_owner_c(conn: &Connection, user_id: &str, server_id: &str) -> Result<bool, String> {
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM servers WHERE id = ?1 AND owner_id = ?2",
                params![server_id, user_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(count > 0)
    }

    pub fn find_server_by_invite_code(&self, code: &str, hmac_key: &[u8]) -> Result<(String, bool), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let code_upper = code.trim().to_uppercase();

        // Try unsalted lookup first (backward compat)
        // Old records may have either HMAC-SHA256 (old client registrations) or
        // plain SHA-256 (migration backfill of legacy data). Try both.
        let unsalted_hmac = hmac_sha256_hex(hmac_key, &code_upper);
        if let Ok(server_id) = conn.query_row::<String, _, _>(
            "SELECT id FROM servers WHERE (invite_code_hash = ?1 OR invite_code_hash = ?2) AND (invite_code_salt IS NULL OR invite_code_salt = '')",
            params![unsalted_hmac, sha256_hex(&code_upper)],
            |row| row.get(0),
        ) {
            return Ok((server_id, false));
        }

        // Try salted lookup: iterate servers with a salt
        let mut stmt = conn.prepare(
            "SELECT id, invite_code_hash, COALESCE(invite_code_salt, '') FROM servers WHERE invite_code_salt IS NOT NULL AND invite_code_salt != ''"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        }).map_err(|e| e.to_string())?;

        for row in rows {
            let (sid, stored_hash, salt) = row.map_err(|e| e.to_string())?;
            let computed = hmac_sha256_hex(hmac_key, &format!("{}{}", salt, code_upper));
            if computed == stored_hash {
                return Ok((sid, true));
            }
        }

        Err("Invalid invite code".to_string())
    }

    pub fn join_server_by_invite(&self, code: &str, user_id: &str, hmac_key: &[u8]) -> Result<Server, String> {
        let (server_id, _was_salted) = self.find_server_by_invite_code(code, hmac_key)?;
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let server: Server = conn
            .query_row(
                "SELECT id, encrypted_name, name_nonce, owner_id, COALESCE(invite_code_hash, ''), COALESCE(joins_disabled, 0), server_picture_file_id, COALESCE(server_picture_file_id_hash, ''), encrypted_server_picture_key, server_picture_key_nonce FROM servers WHERE id = ?1",
                params![server_id],
                |row| {
                    Ok(Server {
                        id: row.get(0)?,
                        encrypted_name: row.get(1)?,
                        name_nonce: row.get(2)?,
                        owner_id: row.get(3)?,
                        invite_code_hash: row.get(4)?,
                        joins_disabled: row.get::<_, i64>(5)? != 0,
                        created_at: String::new(),
                        server_picture_file_id: row.get(6)?,
                        server_picture_file_id_hash: row.get(7)?,
                        encrypted_server_picture_key: row.get(8)?,
                        server_picture_key_nonce: row.get(9)?,
                        group_id: row.get(10).ok(),
                    })
                },
            )
            .map_err(|_| "Invalid invite code".to_string())?;

        if server.joins_disabled {
            return Err("This server has disabled invites".to_string());
        }

        let banned: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM server_bans WHERE server_id = ?1 AND user_id = ?2",
                params![server.id, user_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|e| e.to_string())?
            > 0;

        if banned {
            return Err("You are banned from this server".to_string());
        }

        let already_member: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM server_members WHERE user_id = ?1 AND server_id = ?2",
                params![user_id, server.id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|e| e.to_string())?
            > 0;

        if !already_member {
            conn.execute(
                "INSERT INTO server_members (user_id, server_id, role) VALUES (?1, ?2, 'member')",
                params![user_id, server.id],
            )
            .map_err(|e| e.to_string())?;
        }

        Ok(server)
    }

    pub fn set_joins_disabled(&self, server_id: &str, user_id: &str, disabled: bool) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        if !Self::is_server_owner_c(&conn, user_id, server_id).unwrap_or(false) {
            return Err("Only the server owner can change join settings".to_string());
        }

        conn.execute(
            "UPDATE servers SET joins_disabled = ?1 WHERE id = ?2",
            params![disabled as i64, server_id],
        )
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn regenerate_invite(&self, server_id: &str, user_id: &str, new_invite_code_hash: &str, new_invite_code_salt: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        if !Self::is_server_owner_c(&conn, user_id, server_id).unwrap_or(false) {
            return Err("Only the server owner can regenerate the invite".to_string());
        }

        conn.execute(
            "UPDATE servers SET invite_code_hash = ?1, invite_code_salt = ?2 WHERE id = ?3",
            params![new_invite_code_hash, new_invite_code_salt, server_id],
        )
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn get_server_id_for_channel(&self, channel_id: &str) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT server_id FROM channels WHERE id = ?1",
            params![channel_id],
            |row| row.get(0),
        )
        .map_err(|_| "Channel not found".to_string())
    }

    pub fn get_channel_name(&self, channel_id: &str) -> Result<String, String> {
        // name column has been removed — return channel_id as fallback
        Ok(channel_id.to_string())
    }

    pub fn get_server_name(&self, server_id: &str) -> Result<String, String> {
        // name column has been removed — return server_id as fallback
        Ok(server_id.to_string())
    }

    pub fn get_channel_encrypted_name(&self, channel_id: &str) -> Result<(Vec<u8>, Vec<u8>), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT encrypted_name, name_nonce FROM channels WHERE id = ?1",
            params![channel_id],
            |row| Ok((row.get::<_, Option<Vec<u8>>>(0)?.unwrap_or_default(), row.get::<_, Option<Vec<u8>>>(1)?.unwrap_or_default())),
        )
        .map_err(|e| e.to_string())
    }

    pub fn get_server_encrypted_name(&self, server_id: &str) -> Result<(Vec<u8>, Vec<u8>), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT encrypted_name, name_nonce FROM servers WHERE id = ?1",
            params![server_id],
            |row| Ok((row.get::<_, Option<Vec<u8>>>(0)?.unwrap_or_default(), row.get::<_, Option<Vec<u8>>>(1)?.unwrap_or_default())),
        )
        .map_err(|e| e.to_string())
    }

    pub fn get_server_members(&self, server_id: &str) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT user_id FROM server_members WHERE server_id = ?1")
            .map_err(|e| e.to_string())?;
        let members = stmt
            .query_map(params![server_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(members)
    }

    pub fn get_server_members_with_names(&self, server_id: &str) -> Result<Vec<(String, String, String, Option<String>, Option<String>)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT u.id, u.username, sm.role, NULL as display_name, u.profile_picture_file_id
                 FROM server_members sm
                 INNER JOIN users u ON sm.user_id = u.id
                 WHERE sm.server_id = ?1
                 ORDER BY sm.role = 'owner' DESC, u.username ASC",
            )
            .map_err(|e| e.to_string())?;
        let members = stmt
            .query_map(params![server_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?, row.get::<_, Option<String>>(4)?))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(members)
    }

    pub fn kick_member(&self, server_id: &str, target_user_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM server_members WHERE server_id = ?1 AND user_id = ?2 AND role != 'owner'",
            params![server_id, target_user_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM server_keys WHERE server_id = ?1 AND user_id = ?2",
            params![server_id, target_user_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn leave_server(&self, server_id: &str, user_id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let is_owner = Self::is_server_owner_c(&conn, user_id, server_id)?;

        if is_owner {
            // Owner leaving: delete the entire server and everything in it.
            // messages/dm-ish rows cascade their reactions/votes/acks/pins/
            // search tokens via message_id FKs; voice_sessions cascade their
            // participants via channel_id. Tables with NO FK to servers need
            // explicit cleanup: conversation_profile_data (keyed by server id),
            // pending_events (server_id is a plain column) and voice_sanctions.
            conn.execute("DELETE FROM server_keys WHERE server_id = ?1", params![server_id])
                .map_err(|e| e.to_string())?;
            conn.execute(
                "DELETE FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE server_id = ?1)",
                params![server_id],
            )
            .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM server_members WHERE server_id = ?1", params![server_id])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM server_bans WHERE server_id = ?1", params![server_id])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM voice_sanctions WHERE server_id = ?1", params![server_id])
                .map_err(|e| e.to_string())?;
            conn.execute(
                "DELETE FROM pending_events WHERE server_id = ?1",
                params![server_id],
            )
            .map_err(|e| e.to_string())?;
            // Per-server profile snapshots must be removed BEFORE channels are
            // deleted (the channel-scoped rows match by channel id).
            conn.execute(
                "DELETE FROM conversation_profile_data WHERE conversation_type = 'channel' AND (conversation_id = ?1 OR conversation_id IN (SELECT id FROM channels WHERE server_id = ?1))",
                params![server_id],
            )
            .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM channels WHERE server_id = ?1", params![server_id])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM servers WHERE id = ?1", params![server_id])
                .map_err(|e| e.to_string())?;
            return Ok(true); // true = server was deleted
        }

        // Non-owner leaving: delete their messages in the server, then remove
        // membership. Message rows cascade their OWN reactions/votes/acks/pins
        // via message_id FKs, but the leaver's rows on OTHER members' messages
        // (and every other user-scoped row in this server) must be wiped too so
        // no member can still see any trace of them: reactions, poll votes, read
        // acks, pins, per-server profile snapshots, voice state + sanctions, and
        // pending events about them.
        conn.execute(
            "DELETE FROM messages WHERE sender_id = ?1 AND channel_id IN (SELECT id FROM channels WHERE server_id = ?2)",
            params![user_id, server_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM message_reactions WHERE reactor_id = ?1 AND message_id IN (SELECT id FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE server_id = ?2))",
            params![user_id, server_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM message_poll_votes WHERE voter_id = ?1 AND message_id IN (SELECT id FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE server_id = ?2))",
            params![user_id, server_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM message_acks WHERE acker_id = ?1 AND message_id IN (SELECT id FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE server_id = ?2))",
            params![user_id, server_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM message_pins WHERE pinned_by = ?1 AND message_id IN (SELECT id FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE server_id = ?2))",
            params![user_id, server_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM conversation_profile_data WHERE user_id = ?1 AND conversation_type = 'channel' AND (conversation_id = ?2 OR conversation_id IN (SELECT id FROM channels WHERE server_id = ?2))",
            params![user_id, server_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM voice_sanctions WHERE server_id = ?1 AND user_id = ?2",
            params![server_id, user_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM voice_participants WHERE user_id = ?1 AND voice_session_id IN (SELECT id FROM voice_sessions WHERE channel_id IN (SELECT id FROM channels WHERE server_id = ?2))",
            params![user_id, server_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM pending_events WHERE server_id = ?1 AND (user_id = ?2 OR affected_user_id = ?2)",
            params![server_id, user_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM server_members WHERE server_id = ?1 AND user_id = ?2",
            params![server_id, user_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM server_keys WHERE server_id = ?1 AND user_id = ?2",
            params![server_id, user_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(false) // false = only member removed
    }

    pub fn ban_member(&self, server_id: &str, target_user_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // Remove from server_keys
        conn.execute(
            "DELETE FROM server_keys WHERE server_id = ?1 AND user_id = ?2",
            params![server_id, target_user_id],
        )
        .map_err(|e| e.to_string())?;
        // Remove from server_members
        conn.execute(
            "DELETE FROM server_members WHERE server_id = ?1 AND user_id = ?2 AND role != 'owner'",
            params![server_id, target_user_id],
        )
        .map_err(|e| e.to_string())?;
        // Add to server_bans (INSERT OR IGNORE if already banned)
        conn.execute(
            "INSERT OR IGNORE INTO server_bans (server_id, user_id) VALUES (?1, ?2)",
            params![server_id, target_user_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn unban_member(&self, server_id: &str, target_user_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM server_bans WHERE server_id = ?1 AND user_id = ?2",
            params![server_id, target_user_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn is_banned(&self, server_id: &str, user_id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM server_bans WHERE server_id = ?1 AND user_id = ?2",
                params![server_id, user_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(count > 0)
    }

    pub fn list_server_bans(&self, server_id: &str) -> Result<Vec<(String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT u.id, u.username FROM server_bans sb
                 INNER JOIN users u ON sb.user_id = u.id
                 WHERE sb.server_id = ?1 ORDER BY sb.banned_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let bans = stmt
            .query_map(params![server_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(bans)
    }

    pub fn delete_channel_by_owner(&self, channel_id: &str, user_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let server_id: String = conn
            .query_row(
                "SELECT server_id FROM channels WHERE id = ?1",
                params![channel_id],
                |row| row.get(0),
            )
            .map_err(|_| "Channel not found".to_string())?;
        if !Self::is_server_owner_c(&conn, user_id, &server_id)? {
            return Err("Only the server owner can delete channels".to_string());
        }
        conn.execute("DELETE FROM messages WHERE channel_id = ?1", params![channel_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM channels WHERE id = ?1", params![channel_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    // --- Channels ---

    pub fn list_server_channels(&self, server_id: &str) -> Result<Vec<Channel>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, server_id, encrypted_name, name_nonce, type, COALESCE(position, 0), COALESCE(created_at, ''), category_id FROM channels
                 WHERE server_id = ?1 ORDER BY position",
            )
            .map_err(|e| e.to_string())?;
        let channels = stmt
            .query_map(params![server_id], |row| {
                Ok(Channel {
                    id: row.get(0)?,
                    server_id: row.get(1)?,
                    encrypted_name: row.get(2)?,
                    name_nonce: row.get(3)?,
                    channel_type: row.get(4)?,
                    position: row.get::<_, i32>(5)?,
                    created_at: row.get::<_, String>(6)?,
                    category_id: row.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(channels)
    }

    pub fn create_channel(&self, server_id: &str, encrypted_name: Option<&[u8]>, name_nonce: Option<&[u8]>, channel_type: &str, category_id: Option<&str>) -> Result<Channel, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();
        let ctype = if channel_type == "voice" { "voice" } else { "text" };

        let max_pos: i32 = conn
            .query_row(
                "SELECT COALESCE(MAX(position), -1) FROM channels WHERE server_id = ?1",
                params![server_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        // If the legacy 'name' column still exists, include a default value
        let has_name_col: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('channels') WHERE name = 'name'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);
        if has_name_col {
            conn.execute(
                "INSERT INTO channels (id, server_id, encrypted_name, name_nonce, type, position, category_id, name) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '')",
                params![id, server_id, encrypted_name, name_nonce, ctype, max_pos + 1, category_id],
            )
            .map_err(|e| e.to_string())?;
        } else {
            conn.execute(
                "INSERT INTO channels (id, server_id, encrypted_name, name_nonce, type, position, category_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![id, server_id, encrypted_name, name_nonce, ctype, max_pos + 1, category_id],
            )
            .map_err(|e| e.to_string())?;
        }

        Ok(Channel {
            id,
            server_id: server_id.to_string(),
            encrypted_name: encrypted_name.map(|v| v.to_vec()),
            name_nonce: name_nonce.map(|v| v.to_vec()),
            channel_type: ctype.to_string(),
            position: 0,
            created_at: String::new(),
            category_id: category_id.map(|s| s.to_string()),
        })
    }

    /// Returns the channel type ('text' | 'voice') for a channel, or an error if not found.
    pub fn get_channel_type(&self, channel_id: &str) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT type FROM channels WHERE id = ?1",
            params![channel_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|e| e.to_string())
    }

    // ---- Voice calls: sanctions + sessions ----

    /// Returns (force_muted, force_deafened) for a user in a server.
    pub fn get_voice_sanction(&self, server_id: &str, user_id: &str) -> Result<(bool, bool), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT force_muted, force_deafened FROM voice_sanctions WHERE server_id = ?1 AND user_id = ?2",
            params![server_id, user_id],
            |row| Ok((row.get::<_, i64>(0)? != 0, row.get::<_, i64>(1)? != 0)),
        )
        .map_err(|e| e.to_string())
    }

    /// All sanctions for a server (map user_id -> (force_muted, force_deafened)).
    pub fn get_all_voice_sanctions(&self, server_id: &str) -> Result<std::collections::HashMap<String, (bool, bool)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT user_id, force_muted, force_deafened FROM voice_sanctions WHERE server_id = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![server_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)? != 0,
                    row.get::<_, i64>(2)? != 0,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut out = std::collections::HashMap::new();
        for r in rows {
            let (uid, fm, fd) = r.map_err(|e| e.to_string())?;
            out.insert(uid, (fm, fd));
        }
        Ok(out)
    }

    /// Upsert a voice sanction. `force_muted`/`force_deafened` true enables the flag.
    pub fn set_voice_sanction(&self, server_id: &str, user_id: &str, force_muted: bool, force_deafened: bool) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO voice_sanctions (server_id, user_id, force_muted, force_deafened) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(server_id, user_id) DO UPDATE SET force_muted = ?3, force_deafened = ?4",
            params![server_id, user_id, if force_muted { 1 } else { 0 }, if force_deafened { 1 } else { 0 }],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Remove a voice sanction entirely (used when both flags are cleared).
    pub fn clear_voice_sanction(&self, server_id: &str, user_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM voice_sanctions WHERE server_id = ?1 AND user_id = ?2 AND force_muted = 0 AND force_deafened = 0",
            params![server_id, user_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Create a voice session row, returning its id.
    pub fn create_voice_session(&self, channel_id: &str) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO voice_sessions (id, channel_id) VALUES (?1, ?2)",
            params![id, channel_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(id)
    }

    /// Mark a voice session as ended.
    pub fn end_voice_session(&self, session_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE voice_sessions SET ended_at = CURRENT_TIMESTAMP WHERE id = ?1",
            params![session_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Record a participant joining a voice session.
    pub fn add_voice_participant(&self, session_id: &str, user_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR IGNORE INTO voice_participants (voice_session_id, user_id) VALUES (?1, ?2)",
            params![session_id, user_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Mark a participant as left a voice session.
    pub fn remove_voice_participant(&self, session_id: &str, user_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE voice_participants SET left_at = CURRENT_TIMESTAMP WHERE voice_session_id = ?1 AND user_id = ?2",
            params![session_id, user_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    // --- Messages ---

    pub fn list_messages(&self, channel_id: &str, limit: i64) -> Result<Vec<Message>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT m.id, m.channel_id, m.sender_id, u.username, u.profile_picture_file_id,
                        m.encrypted_content, m.nonce, m.timestamp,
                        m.edited_at,
                        m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce,
                        m.encrypted_sender_username, m.sender_username_nonce,
                        m.sender_id_hash
                 FROM (
                     SELECT id, channel_id, sender_id, encrypted_content, nonce, timestamp,
                            edited_at,
                            key_version, encrypted_profile_snapshot, profile_snapshot_nonce,
                            encrypted_sender_username, sender_username_nonce,
                            sender_id_hash
                     FROM messages
                     WHERE channel_id = ?1
                     ORDER BY timestamp DESC, id DESC
                     LIMIT ?2
                 ) m
                 INNER JOIN users u ON m.sender_id = u.id
                 ORDER BY m.timestamp ASC, m.id ASC",
            )
            .map_err(|e| e.to_string())?;
        let messages = stmt
            .query_map(params![channel_id, limit], |row| {
                Ok(Message {
                    id: row.get(0)?,
                    channel_id: row.get(1)?,
                    sender_id: row.get(2)?,
                    encrypted_content: row.get(5)?,
                    nonce: row.get(6)?,
                    timestamp: row.get(7)?,
                    edited_at: row.get(8)?,
                    key_version: row.get(9)?,
                    encrypted_profile_snapshot: row.get(10)?,
                    profile_snapshot_nonce: row.get(11)?,
                    encrypted_sender_username: row.get(12)?,
                    sender_username_nonce: row.get(13)?,
                    sender_id_hash: row.get(14).ok().flatten(),
                    file_id: None,
                    thread_parent_id: None,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(messages)
    }

    pub fn list_messages_before(&self, channel_id: &str, before_timestamp: &str, before_id: Option<&str>, limit: i64) -> Result<Vec<Message>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT m.id, m.channel_id, m.sender_id, u.username, u.profile_picture_file_id,
                        m.encrypted_content, m.nonce, m.timestamp,
                        m.edited_at,
                        m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce,
                        m.encrypted_sender_username, m.sender_username_nonce,
                        m.sender_id_hash
                 FROM (
                     SELECT id, channel_id, sender_id, encrypted_content, nonce, timestamp,
                            edited_at,
                            key_version, encrypted_profile_snapshot, profile_snapshot_nonce,
                            encrypted_sender_username, sender_username_nonce,
                            sender_id_hash
                     FROM messages
                     WHERE channel_id = ?1 AND (timestamp < ?3 OR (timestamp = ?3 AND id < ?4))
                     ORDER BY timestamp DESC, id DESC
                     LIMIT ?2
                 ) m
                 INNER JOIN users u ON m.sender_id = u.id
                 ORDER BY m.timestamp ASC, m.id ASC",
            )
            .map_err(|e| e.to_string())?;
        let messages = stmt
            .query_map(params![channel_id, limit, before_timestamp, before_id.unwrap_or("")], |row| {
                Ok(Message {
                    id: row.get(0)?,
                    channel_id: row.get(1)?,
                    sender_id: row.get(2)?,
                    encrypted_content: row.get(5)?,
                    nonce: row.get(6)?,
                    timestamp: row.get(7)?,
                    edited_at: row.get(8)?,
                    key_version: row.get(9)?,
                    encrypted_profile_snapshot: row.get(10)?,
                    profile_snapshot_nonce: row.get(11)?,
                    encrypted_sender_username: row.get(12)?,
                    sender_username_nonce: row.get(13)?,
                    sender_id_hash: row.get(14).ok().flatten(),
                    file_id: None,
                    thread_parent_id: None,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(messages)
    }

    /// Return up to `limit` messages centered around the message with ID `around_message_id`.

    /// Return up to `limit` messages centered around the message with ID `around_message_id`.


    /// Return up to `limit` messages centered around the message with ID `around_message_id`.
    /// Half will be before (older than) the target and half after (newer than) the target.
    pub fn list_messages_around(&self, channel_id: &str, around_message_id: &str, limit: i64) -> Result<Vec<Message>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let half = limit / 2;

        // Query messages before the target (inclusive) — newest first, limited to half
        let mut before_stmt = conn
            .prepare(
                "SELECT m.id, m.channel_id, m.sender_id,
                        m.encrypted_content, m.nonce, m.timestamp,
                        m.edited_at,
                        m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce,
                        m.encrypted_sender_username, m.sender_username_nonce,
                        m.sender_id_hash
                 FROM messages m
                 WHERE m.channel_id = ?1 AND m.timestamp <= (SELECT COALESCE(timestamp, '') FROM messages WHERE id = ?2)
                 ORDER BY m.timestamp DESC, m.id DESC
                 LIMIT ?3",
            )
            .map_err(|e| e.to_string())?;
        let mut before: Vec<Message> = before_stmt
            .query_map(params![channel_id, around_message_id, half], |row| {
                Ok(Message {
                    id: row.get(0)?,
                    channel_id: row.get(1)?,
                    sender_id: row.get(2)?,
                    encrypted_content: row.get(3)?,
                    nonce: row.get(4)?,
                    timestamp: row.get(5)?,
                    edited_at: row.get(6)?,
                    key_version: row.get(7)?,
                    encrypted_profile_snapshot: row.get(8)?,
                    profile_snapshot_nonce: row.get(9)?,
                    encrypted_sender_username: row.get(10)?,
                    sender_username_nonce: row.get(11)?,
                    sender_id_hash: row.get(12).ok().flatten(),
                    file_id: None,
                    thread_parent_id: None,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        // before is newest-first, reverse to get oldest-first
        before.reverse();

        // Query messages after the target — oldest first, limited to half
        let mut after_stmt = conn
            .prepare(
                "SELECT m.id, m.channel_id, m.sender_id,
                        m.encrypted_content, m.nonce, m.timestamp,
                        m.edited_at,
                        m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce,
                        m.encrypted_sender_username, m.sender_username_nonce,
                        m.sender_id_hash
                 FROM messages m
                 WHERE m.channel_id = ?1 AND m.timestamp > (SELECT COALESCE(timestamp, '') FROM messages WHERE id = ?2)
                 ORDER BY m.timestamp ASC, m.id ASC
                 LIMIT ?3",
            )
            .map_err(|e| e.to_string())?;
        let after: Vec<Message> = after_stmt
            .query_map(params![channel_id, around_message_id, half], |row| {
                Ok(Message {
                    id: row.get(0)?,
                    channel_id: row.get(1)?,
                    sender_id: row.get(2)?,
                    encrypted_content: row.get(3)?,
                    nonce: row.get(4)?,
                    timestamp: row.get(5)?,
                    edited_at: row.get(6)?,
                    key_version: row.get(7)?,
                    encrypted_profile_snapshot: row.get(8)?,
                    profile_snapshot_nonce: row.get(9)?,
                    encrypted_sender_username: row.get(10)?,
                    sender_username_nonce: row.get(11)?,
                    sender_id_hash: row.get(12).ok().flatten(),
                    file_id: None,
                    thread_parent_id: None,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        // Combine: before (oldest-first) + after (oldest-first)
        before.extend(after);
        Ok(before)
    }
    pub fn save_encrypted_message(
        &self,
        channel_id: &str,
        sender_id: &str,
        encrypted_content: &[u8],
        nonce: &[u8],
        // Streamlined E2E fields
        encrypted_profile_snapshot: Option<&[u8]>,
        profile_snapshot_nonce: Option<&[u8]>,
        encrypted_sender_username: Option<&str>,
        sender_username_nonce: Option<&str>,
        file_id: Option<&str>,
        // Disappearing-message TTL: fixed-width RFC3339 wall-clock expiry
        // (NULL = never). The server enforces it; the content stays encrypted.
        expires_at: Option<&str>,
        // F3: threaded reply — NULL = top-level, non-NULL = reply in thread
        thread_parent_id: Option<&str>,
    ) -> Result<Message, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();

        let username: String = conn
            .query_row(
                "SELECT username FROM users WHERE id = ?1",
                params![sender_id],
                |row| row.get(0),
            )
            .map_err(|_| "Sender not found".to_string())?;

        let h = sha256_hex(&format!("{}:{}", sender_id, channel_id));
        let ts = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.6fZ").to_string();
        conn.execute(
            "INSERT INTO messages (id, channel_id, sender_id, encrypted_content, nonce, timestamp, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_sender_username, sender_username_nonce, sender_id_hash, file_id, expires_at, thread_parent_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![id, channel_id, sender_id, encrypted_content, nonce, ts, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_sender_username, sender_username_nonce, h, file_id, expires_at, thread_parent_id],
        )
        .map_err(|e| e.to_string())?;

        Ok(Message {
            id,
            channel_id: channel_id.to_string(),
            sender_id: sender_id.to_string(),
            encrypted_content: encrypted_content.to_vec(),
            nonce: nonce.to_vec(),
            timestamp: ts,
            edited_at: None,
            key_version: Some(1),
            encrypted_profile_snapshot: encrypted_profile_snapshot.map(|v| v.to_vec()),
            profile_snapshot_nonce: profile_snapshot_nonce.map(|v| v.to_vec()),
            encrypted_sender_username: encrypted_sender_username.map(|s| s.to_string()),
            sender_username_nonce: sender_username_nonce.map(|s| s.to_string()),
            sender_id_hash: Some(sha256_hex(&format!("{}:{}", sender_id, channel_id))),
            file_id: file_id.map(|s| s.to_string()),
            thread_parent_id: thread_parent_id.map(|s| s.to_string()),
        })
    }

    // --- PreKey Bundles ---




    // --- Sessions ---



    pub fn update_session_ratchet(
        &self,
        our_user_id: &str,
        their_user_id: &str,
        ratchet_counter: i32,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE sessions SET ratchet_counter = ?3 WHERE our_user_id = ?1 AND their_user_id = ?2",
            params![our_user_id, their_user_id, ratchet_counter],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    // --- Identity Keys ---

    pub fn get_identity_public_key(&self, user_id: &str) -> Result<Vec<u8>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT identity_public_key FROM users WHERE id = ?1",
            params![user_id],
            |row| row.get(0),
        )
        .map_err(|_| "User not found or no public key".to_string())
    }

    pub fn update_identity_public_key(&self, user_id: &str, key: &[u8]) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE users SET identity_public_key = ?1 WHERE id = ?2",
            params![key, user_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    // --- User Devices (multi-device support) ---





    pub fn update_device_last_active(&self, user_id: &str, device_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE user_devices SET last_active_at = CURRENT_TIMESTAMP WHERE user_id = ?1 AND device_id = ?2",
            params![user_id, device_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    // Legacy: get all identity keys across all devices for a user
    pub fn get_all_user_identity_keys(&self, user_id: &str) -> Result<Vec<(String, Vec<u8>)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT device_id, identity_key FROM user_devices WHERE user_id = ?1")
            .map_err(|e| e.to_string())?;
        let keys = stmt
            .query_map(params![user_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(keys)
    }

    // --- Key Escrow ---

    // --- Per-Device Key Escrow ---



    pub fn save_escrowed_key(&self, user_id: &str, encrypted_key: &[u8], salt: &[u8], nonce: &[u8]) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO user_key_escrow (user_id, encrypted_private_key, salt, nonce, updated_at)
             VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP)
             ON CONFLICT(user_id) DO UPDATE SET
                encrypted_private_key = excluded.encrypted_private_key,
                salt = excluded.salt,
                nonce = excluded.nonce,
                updated_at = CURRENT_TIMESTAMP",
            params![user_id, encrypted_key, salt, nonce],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    // --- User Key Blob (password-encrypted key bundle) ---

    pub fn save_user_key_blob(&self, user_id: &str, encrypted_blob: &str, salt: &str, nonce: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        upsert_user_key_blob(&conn, user_id, encrypted_blob, salt, nonce)
    }

    /// Password change: swap the client-side password hash and every
    /// password-wrapped credential blob (hash_key, identity escrow, friend
    /// code) plus the key blob — all produced client-side with the NEW
    /// password. The identity keys themselves never change, so messages,
    /// profile data and other devices are unaffected.
    pub fn change_password_credentials(
        &self,
        user_id: &str,
        keep_session_id: &str,
        password_hash: &str,
        encrypted_hash_key: &str,
        hash_key_salt: &str,
        hash_key_nonce: &str,
        encrypted_identity_priv: Option<&[u8]>,
        escrow_salt: Option<&[u8]>,
        escrow_nonce: Option<&[u8]>,
        encrypted_friend_code: Option<&str>,
        friend_code_salt: Option<&str>,
        friend_code_nonce: Option<&str>,
        encrypted_blob: Option<&str>,
        blob_salt: Option<&str>,
        blob_nonce: Option<&str>,
    ) -> Result<(), String> {
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        // All writes land in ONE transaction: a partial password change (new
        // hash stored but blobs still wrapped with the old password) would
        // otherwise leave other devices unable to decrypt anything.
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        // Omitted trios are set to NULL rather than kept: a value left over
        // from the OLD password can never be decrypted again, so a clean NULL
        // beats a dead blob that fails with a confusing "wrong password".
        tx.execute(
            "UPDATE users SET password_hash = ?1, encrypted_hash_key = ?2,
             hash_key_salt = ?3, hash_key_nonce = ?4,
             encrypted_friend_code = ?5,
             friend_code_salt = ?6,
             friend_code_nonce = ?7
             WHERE id = ?8",
            params![
                password_hash,
                encrypted_hash_key,
                hash_key_salt,
                hash_key_nonce,
                encrypted_friend_code,
                friend_code_salt,
                friend_code_nonce,
                user_id
            ],
        )
        .map_err(|e| e.to_string())?;

        if let (Some(k), Some(s), Some(n)) = (encrypted_identity_priv, escrow_salt, escrow_nonce) {
            tx.execute(
                "INSERT INTO user_key_escrow (user_id, encrypted_private_key, salt, nonce, updated_at)
                 VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP)
                 ON CONFLICT(user_id) DO UPDATE SET
                    encrypted_private_key = excluded.encrypted_private_key,
                    salt = excluded.salt,
                    nonce = excluded.nonce,
                    updated_at = CURRENT_TIMESTAMP",
                params![user_id, k, s, n],
            )
            .map_err(|e| e.to_string())?;
        }

        if let (Some(b), Some(s), Some(n)) = (encrypted_blob, blob_salt, blob_nonce) {
            upsert_user_key_blob(&tx, user_id, b, s, n)?;
        }
        // A password change revokes EVERY other signed-in session in the same
        // transaction: the new password may be required to re-enter, so old
        // sessions must not keep running. The current device (keep_session_id)
        // stays signed in, matching the Devices-panel "sign out all others".
        tx.execute(
            "UPDATE auth_sessions SET revoked = 1, revoked_at = CURRENT_TIMESTAMP
             WHERE user_id = ?1 AND id != ?2 AND revoked = 0",
            params![user_id, keep_session_id],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn get_user_key_blob(&self, user_id: &str) -> Result<Option<(String, String, String, bool, Option<String>)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // Check if needs_rebuild column exists (migration 026)
        let rebuild_col: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('user_key_blobs') WHERE name = 'needs_rebuild'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);
        if rebuild_col {
            let result = conn.query_row(
                "SELECT encrypted_blob, salt, nonce, COALESCE(needs_rebuild, 0), updated_at FROM user_key_blobs WHERE user_id = ?1",
                params![user_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i32>(3)? != 0, row.get::<_, Option<String>>(4)?)),
            );
            match result {
                Ok(row) => Ok(Some(row)),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(e.to_string()),
            }
        } else {
            let result = conn.query_row(
                "SELECT encrypted_blob, salt, nonce, updated_at FROM user_key_blobs WHERE user_id = ?1",
                params![user_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, false, row.get::<_, Option<String>>(3)?)),
            );
            match result {
                Ok(row) => Ok(Some(row)),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(e.to_string()),
            }
        }
    }

    // --- Profile Data Key (server-side backup) ---

    pub fn save_profile_data_key(&self, user_id: &str, encrypted_key: &str, nonce: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO profile_data_keys (user_id, encrypted_key, nonce, created_at)
             VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP)
             ON CONFLICT(user_id) DO UPDATE SET
                encrypted_key = excluded.encrypted_key,
                nonce = excluded.nonce,
                created_at = CURRENT_TIMESTAMP",
            params![user_id, encrypted_key, nonce],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_profile_data_key(&self, user_id: &str) -> Result<Option<(String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let result = conn.query_row(
            "SELECT encrypted_key, nonce FROM profile_data_keys WHERE user_id = ?1",
            params![user_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        );
        match result {
            Ok(row) => Ok(Some(row)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    // --- Shared Profile Data Keys (pre-encrypted for friends/server-mates) ---

    /// Stores a profile_data_key that was pre-encrypted with a DM channel or server key.
    /// The owner encrypts their profile_data_key with the shared target key and uploads it.
    /// Any member of the DM or server can fetch it and decrypt with their copy of the key.
    pub fn save_shared_profile_data_key(
        &self,
        owner_user_id: &str,
        target_type: &str,
        target_id: &str,
        encrypted_key: &str,
        nonce: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO shared_profile_data_keys
             (owner_user_id, target_type, target_id, encrypted_key, nonce, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))",
            params![owner_user_id, target_type, target_id, encrypted_key, nonce],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Fetches a shared profile_data_key by target type and ID.
    /// Returns the owner_user_id, encrypted_key, and nonce for all entries matching the target.
    /// The caller must authenticate and be a member of the target DM/server.
    pub fn get_shared_profile_data_keys(
        &self,
        target_type: &str,
        target_id: &str,
    ) -> Result<Vec<(String, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT owner_user_id, encrypted_key, nonce
             FROM shared_profile_data_keys
             WHERE target_type = ?1 AND target_id = ?2",
        )
        .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![target_type, target_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| e.to_string())?);
        }
        Ok(results)
    }

    /// Batch version: accepts multiple (target_type, target_id) pairs and returns
    /// results grouped by a composite key "{target_type}:{target_id}".
    /// Each member of the caller must pass membership check externally.
    pub fn get_shared_profile_data_keys_batch(
        &self,
        targets: &[(String, String)],
    ) -> Result<Vec<(String, Vec<(String, String, String)>)>, String> {
        if targets.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // Build a WHERE clause with OR conditions for each target
        let mut conditions: Vec<String> = Vec::new();
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        for (i, (ttype, tid)) in targets.iter().enumerate() {
            let ttype_idx = i * 2 + 1;
            let tid_idx = i * 2 + 2;
            conditions.push(format!("(target_type = ?{} AND target_id = ?{})", ttype_idx, tid_idx));
            param_values.push(Box::new(ttype.clone()));
            param_values.push(Box::new(tid.clone()));
        }
        let sql = format!(
            "SELECT target_type, target_id, owner_user_id, encrypted_key, nonce
             FROM shared_profile_data_keys
             WHERE {}",
            conditions.join(" OR ")
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let params_refs: Vec<&dyn rusqlite::types::ToSql> = param_values.iter().map(|p| p.as_ref()).collect();
        let rows = stmt
            .query_map(params_refs.as_slice(), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        // Group by composite key "{target_type}:{target_id}"
        let mut grouped: std::collections::HashMap<String, Vec<(String, String, String)>> =
            std::collections::HashMap::new();
        for row in rows {
            let (ttype, tid, owner, ekey, nonce) = row.map_err(|e| e.to_string())?;
            let composite = format!("{}:{}", ttype, tid);
            grouped.entry(composite).or_default().push((owner, ekey, nonce));
        }
        // Preserve the order of the requested targets
        let mut result: Vec<(String, Vec<(String, String, String)>)> = Vec::new();
        for (ttype, tid) in targets {
            let composite = format!("{}:{}", ttype, tid);
            let keys = grouped.remove(&composite).unwrap_or_default();
            result.push((composite, keys));
        }
        Ok(result)
    }

    /// Deletes a shared profile_data_key entry. Only the owner can delete their own key.
    pub fn delete_shared_profile_data_key(
        &self,
        owner_user_id: &str,
        target_type: &str,
        target_id: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM shared_profile_data_keys
             WHERE owner_user_id = ?1 AND target_type = ?2 AND target_id = ?3",
            params![owner_user_id, target_type, target_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    // --- Notification Sound Sync ---

    pub fn save_notification_sound(&self, user_id: &str, encrypted_sound: &[u8], nonce: &[u8], sender_public_key: &[u8], encrypted_file_name: Option<Vec<u8>>, file_name_nonce: Option<Vec<u8>>) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // Migration 045 dropped the plaintext file_name column — the display name
        // is stored exclusively in encrypted_file_name + file_name_nonce.
        // The legacy else-branch (pre-039 schema without encrypted_file_name) is kept
        // only for DBs that haven't run migration 039 yet; it stores no file name at all.
        let has_enc_fn_col: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('notification_sounds') WHERE name = 'encrypted_file_name'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);
        if has_enc_fn_col {
            conn.execute(
                "INSERT INTO notification_sounds (user_id, encrypted_sound, nonce, sender_public_key, updated_at, encrypted_file_name, file_name_nonce)
                 VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP, ?5, ?6)
                 ON CONFLICT(user_id) DO UPDATE SET
                    encrypted_sound = excluded.encrypted_sound,
                    nonce = excluded.nonce,
                    sender_public_key = excluded.sender_public_key,
                    encrypted_file_name = excluded.encrypted_file_name,
                    file_name_nonce = excluded.file_name_nonce,
                    updated_at = CURRENT_TIMESTAMP",
                params![user_id, encrypted_sound, nonce, sender_public_key, encrypted_file_name, file_name_nonce],
            )
            .map_err(|e| e.to_string())?;
        } else {
            conn.execute(
                "INSERT INTO notification_sounds (user_id, encrypted_sound, nonce, sender_public_key, updated_at)
                 VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP)
                 ON CONFLICT(user_id) DO UPDATE SET
                    encrypted_sound = excluded.encrypted_sound,
                    nonce = excluded.nonce,
                    sender_public_key = excluded.sender_public_key,
                    updated_at = CURRENT_TIMESTAMP",
                params![user_id, encrypted_sound, nonce, sender_public_key],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn get_notification_sound(&self, user_id: &str) -> Result<Option<(Vec<u8>, Vec<u8>, Vec<u8>, String, Option<Vec<u8>>, Option<Vec<u8>>)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let has_enc_fn_col: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('notification_sounds') WHERE name = 'encrypted_file_name'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);
        if has_enc_fn_col {
            let result = conn.query_row(
                "SELECT encrypted_sound, nonce, sender_public_key, '', encrypted_file_name, file_name_nonce FROM notification_sounds WHERE user_id = ?1",
                params![user_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
            );
            match result {
                Ok(row) => Ok(Some(row)),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(e.to_string()),
            }
        } else {
            let result = conn.query_row(
                "SELECT encrypted_sound, nonce, sender_public_key, '', NULL, NULL FROM notification_sounds WHERE user_id = ?1",
                params![user_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
            );
            match result {
                Ok(row) => Ok(Some(row)),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(e.to_string()),
            }
        }
    }

    pub fn delete_notification_sound(&self, user_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM notification_sounds WHERE user_id = ?1",
            params![user_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    // --- Ringtone Sync (encrypted ringtone for DM call ring) ---

    pub fn save_ringtone(&self, user_id: &str, encrypted_sound: &[u8], nonce: &[u8], sender_public_key: &[u8], encrypted_file_name: Option<Vec<u8>>, file_name_nonce: Option<Vec<u8>>) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO ringtones (user_id, encrypted_sound, nonce, sender_public_key, encrypted_file_name, file_name_nonce, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP)
             ON CONFLICT(user_id) DO UPDATE SET
                encrypted_sound = excluded.encrypted_sound,
                nonce = excluded.nonce,
                sender_public_key = excluded.sender_public_key,
                encrypted_file_name = excluded.encrypted_file_name,
                file_name_nonce = excluded.file_name_nonce,
                updated_at = CURRENT_TIMESTAMP",
            params![user_id, encrypted_sound, nonce, sender_public_key, encrypted_file_name, file_name_nonce],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_ringtone(&self, user_id: &str) -> Result<Option<(Vec<u8>, Vec<u8>, Vec<u8>, Option<Vec<u8>>, Option<Vec<u8>>)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let result = conn.query_row(
            "SELECT encrypted_sound, nonce, sender_public_key, encrypted_file_name, file_name_nonce FROM ringtones WHERE user_id = ?1",
            params![user_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        );
        match result {
            Ok(row) => Ok(Some(row)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn delete_ringtone(&self, user_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM ringtones WHERE user_id = ?1",
            params![user_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    // --- DM call waiting state ---

    /// Record that `user_id` is waiting in a DM call for this channel (the
    /// 30s-unanswered caller, or the side left behind when the partner leaves).
    /// Survives page refreshes so the waiting indicator persists in the DM chat.
    pub fn set_dm_call_waiting(&self, dm_channel_id: &str, user_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO dm_call_waiting (dm_channel_id, waiting_user_id, created_at)
             VALUES (?1, ?2, CURRENT_TIMESTAMP)
             ON CONFLICT(dm_channel_id) DO UPDATE SET
                waiting_user_id = excluded.waiting_user_id,
                created_at = CURRENT_TIMESTAMP",
            params![dm_channel_id, user_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Clear the waiting state for a DM channel (call connected or ended).
    pub fn clear_dm_call_waiting(&self, dm_channel_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM dm_call_waiting WHERE dm_channel_id = ?1",
            params![dm_channel_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Clear EVERY persisted DM-call waiting row. Called on server startup: a
    /// restart invalidates all in-memory voice rooms, so every waiting record
    /// is stale (the waiting user's connection died with the server). Without
    /// this, users keep seeing phantom "waiting for you to join" indicators
    /// until the next conversation reload.
    pub fn clear_all_dm_call_waiting(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM dm_call_waiting", [])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Clear waiting entries where a specific user is the one waiting.
    /// Called on WS disconnect so the other side doesn't see a stale banner.
    pub fn clear_dm_call_waiting_for_user(&self, user_id: &str) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("DELETE FROM dm_call_waiting WHERE waiting_user_id = ?1 RETURNING dm_channel_id")
            .map_err(|e| e.to_string())?;
        let channels = stmt
            .query_map(params![user_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(channels)
    }

    /// List DM-call waiting rows older than `older_than_secs` (age computed in
    /// SQL against created_at). Used by the periodic sweep to clear markers
    /// whose owner vanished without a clean disconnect.
    pub fn list_stale_dm_call_waiting(&self, older_than_secs: i64) -> Result<Vec<(String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT dm_channel_id, waiting_user_id FROM dm_call_waiting
                 WHERE (strftime('%s','now') - strftime('%s', created_at)) > ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![older_than_secs], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    /// Who is waiting in a DM call for this channel, if anyone.
    pub fn get_dm_call_waiting(&self, dm_channel_id: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let result = conn.query_row(
            "SELECT waiting_user_id FROM dm_call_waiting WHERE dm_channel_id = ?1",
            params![dm_channel_id],
            |row| row.get(0),
        );
        match result {
            Ok(uid) => Ok(Some(uid)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    // --- Friend Codes ---

    /// Returns the friend_code_hash (used for matching)
    pub fn get_friend_code(&self, user_id: &str) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let code: Option<String> = conn
            .query_row(
                "SELECT friend_code_hash FROM users WHERE id = ?1",
                params![user_id],
                |row| row.get(0),
            )
            .ok();
        code.ok_or_else(|| "No friend code set".to_string())
    }

    /// Returns the encrypted friend_code + salt + nonce (for password-based recovery)
    pub fn get_encrypted_friend_code(&self, user_id: &str) -> Result<(String, String, String), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT encrypted_friend_code, friend_code_salt, friend_code_nonce FROM users WHERE id = ?1",
            params![user_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .map_err(|_| "No encrypted friend code set".to_string())
    }

    /// Update/regenerate the friend_code hash AND encrypted backup
    pub fn update_encrypted_friend_code(&self, user_id: &str, new_code_hash: &str, hash_salt: &str, encrypted_friend_code: &str, salt: &str, nonce: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE users SET friend_code_hash = ?1, friend_code_hash_salt = ?2, encrypted_friend_code = ?3, friend_code_salt = ?4, friend_code_nonce = ?5 WHERE id = ?6",
            params![new_code_hash, hash_salt, encrypted_friend_code, salt, nonce, user_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Update only the friend_code_hash (for server-generated codes without encrypted backup)
    pub fn update_friend_code_hash(&self, user_id: &str, new_code_hash: &str, hash_salt: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE users SET friend_code_hash = ?1, friend_code_hash_salt = ?2 WHERE id = ?3",
            params![new_code_hash, hash_salt, user_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Server-side regeneration only stores the hash — the password-encrypted
    /// backup (encrypted_friend_code + salt + nonce) can no longer be produced
    /// without the user's password. Clear it so a subsequent login does not
    /// restore a STALE code that no longer matches the stored hash (which was
    /// the root cause of "friend code needs to be regenerated" after a
    /// server-side regen: the client would decrypt the old backup and display
    /// a code that no longer resolves to this user).
    pub fn clear_encrypted_friend_code(&self, user_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE users SET encrypted_friend_code = NULL, friend_code_salt = NULL, friend_code_nonce = NULL WHERE id = ?1",
            params![user_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_user_by_friend_code(&self, code: &str, hmac_key: &[u8]) -> Result<User, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let code_upper = code.trim().to_uppercase();

        // Try unsalted lookup first (backward compat)
        // Old records may have either HMAC-SHA256 (old client registrations) or
        // plain SHA-256 (migration backfill of legacy data). Try both in one query.
        let unsalted_hmac = hmac_sha256_hex(hmac_key, &code_upper);
        let unsalted_sha256 = sha256_hex(&code_upper);
        if let Ok(user) = conn.query_row(
            "SELECT id, username FROM users WHERE (friend_code_hash = ?1 OR friend_code_hash = ?2) AND (friend_code_hash_salt IS NULL OR friend_code_hash_salt = '')",
            params![unsalted_hmac, unsalted_sha256],
            |row| {
                Ok(User {
                    id: row.get(0)?,
                    username: row.get(1)?,
                })
            },
        ) {
            return Ok(user);
        }

        // Try salted lookup
        let mut stmt = conn.prepare(
            "SELECT id, username, friend_code_hash, COALESCE(friend_code_hash_salt, '') FROM users WHERE friend_code_hash IS NOT NULL AND friend_code_hash_salt IS NOT NULL AND friend_code_hash_salt != ''"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        }).map_err(|e| e.to_string())?;

        for row in rows {
            let (uid, uname, stored_hash, salt) = row.map_err(|e| e.to_string())?;
            let computed = hmac_sha256_hex(hmac_key, &format!("{}{}", salt, code_upper));
            if computed == stored_hash {
                return Ok(User { id: uid, username: uname });
            }
        }

        Err("No user with that friend code".to_string())
    }

    // --- Friendships ---

    pub fn get_friend_requests_disabled(&self, user_id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // Legacy fallback: friend_requests_disabled_hash is the primary source.
        // The handler derives the boolean from the hash using the HMAC key.
        let disabled: i64 = conn
            .query_row(
                "SELECT COALESCE(friend_requests_disabled, 0) FROM users WHERE id = ?1",
                params![user_id],
                |row| row.get(0),
            )
            .map_err(|_| "User not found".to_string())?;
        Ok(disabled != 0)
    }

    pub fn set_friend_requests_disabled(&self, user_id: &str, disabled_hash: &str, disabled: bool) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE users SET friend_requests_disabled_hash = ?1, friend_requests_disabled = ?2 WHERE id = ?3",
            params![disabled_hash, disabled as i64, user_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_friend_requests_disabled_hash(&self, user_id: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT friend_requests_disabled_hash FROM users WHERE id = ?1",
            params![user_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .map_err(|_| "User not found".to_string())
    }

    /// Returns true if a friendship row exists between the two users.
    pub fn are_friends(&self, user_a: &str, user_b: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let (a, b) = if user_a < user_b {
            (user_a, user_b)
        } else {
            (user_b, user_a)
        };
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM friendships WHERE user_id_a = ?1 AND user_id_b = ?2",
                params![a, b],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(count > 0)
    }

    pub fn is_member_of_dm(&self, user_id: &str, dm_channel_id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM dm_members WHERE dm_channel_id = ?1 AND user_id = ?2",
                params![dm_channel_id, user_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(count > 0)
    }

    pub fn share_server(&self, user_a: &str, user_b: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM server_members sm1
                 INNER JOIN server_members sm2 ON sm1.server_id = sm2.server_id
                 WHERE sm1.user_id = ?1 AND sm2.user_id = ?2",
                params![user_a, user_b],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(count > 0)
    }

    pub fn list_friends(&self, user_id: &str) -> Result<Vec<FriendRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT u.id, u.username
             FROM friendships f
             INNER JOIN users u ON u.id = CASE WHEN f.user_id_a = ?1 THEN f.user_id_b ELSE f.user_id_a END
             WHERE f.user_id_a = ?1 OR f.user_id_b = ?1
             ORDER BY u.username ASC",
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![user_id], |row| {
            Ok(FriendRow {
                user_id: row.get(0)?,
                username: row.get(1)?,
            })
        }).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    /// Insert the friendship edge (canonical ordering). Idempotent.
    fn add_friendship_c(conn: &Connection, user_a: &str, user_b: &str) -> Result<(), rusqlite::Error> {
        let (a, b) = if user_a < user_b {
            (user_a, user_b)
        } else {
            (user_b, user_a)
        };
        conn.execute(
            "INSERT OR IGNORE INTO friendships (user_id_a, user_id_b) VALUES (?1, ?2)",
            params![a, b],
        )?;
        Ok(())
    }

    pub fn create_friend_request(
        &self,
        from_user_id: &str,
        to_user_id: &str,
        to_username: &str,
        recipient_disabled: bool,
    ) -> Result<User, String> {
        if from_user_id.is_empty() {
            return Err("Not authenticated".to_string());
        }
        if recipient_disabled {
            return Err("This user is not accepting friend requests".to_string());
        }
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let target = User {
            id: to_user_id.to_string(),
            username: to_username.to_string(),
        };

        if target.id == from_user_id {
            return Err("You can't add yourself as a friend".to_string());
        }

        if Self::are_friends_c(&conn, from_user_id, &target.id).map_err(|e| e.to_string())? {
            return Err("You are already friends".to_string());
        }

        // If the target already requested us, accept their pending request instead of duplicating.
        let existing_to_us: Option<(String, String)> = conn
            .query_row(
                "SELECT id, status FROM friend_requests WHERE from_user_id = ?1 AND to_user_id = ?2",
                params![target.id, from_user_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();
        if let Some((req_id, status)) = existing_to_us {
            if status == "pending" {
                Self::accept_friend_request_c(&conn, &req_id, from_user_id).map_err(|_| "Failed to accept".to_string())?;
                return Ok(target);
            }
        }

        // A pending request from us to them already exists?
        let dup: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM friend_requests WHERE from_user_id = ?1 AND to_user_id = ?2 AND status = 'pending'",
                params![from_user_id, target.id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if dup > 0 {
            return Err("Friend request already sent".to_string());
        }

        // A declined request is not a permanent block. Re-open the existing
        // row so the pair remains unique while allowing a later request.
        let reopened = conn.execute(
            "UPDATE friend_requests
             SET status = 'pending', created_at = CURRENT_TIMESTAMP, responded_at = NULL
             WHERE from_user_id = ?1 AND to_user_id = ?2 AND status = 'declined'",
            params![from_user_id, target.id],
        ).map_err(|e| e.to_string())?;
        if reopened > 0 {
            return Ok(target);
        }

        let id = Uuid::new_v4().to_string();
        // Check if request_id_hash column exists (migration 039)
        let has_hash_col: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('friend_requests') WHERE name = 'request_id_hash'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);
        if has_hash_col {
            let req_id_hash = crate::db::sha256_hex(&id);
            conn.execute(
                "INSERT INTO friend_requests (id, from_user_id, to_user_id, status, request_id_hash) VALUES (?1, ?2, ?3, 'pending', ?4)",
                params![id, from_user_id, target.id, req_id_hash],
            )
            .map_err(|e| e.to_string())?;
        } else {
            conn.execute(
                "INSERT INTO friend_requests (id, from_user_id, to_user_id, status) VALUES (?1, ?2, ?3, 'pending')",
                params![id, from_user_id, target.id],
            )
            .map_err(|e| e.to_string())?;
        }

        Ok(target)
    }

    fn accept_friend_request_c(
        conn: &Connection,
        request_id: &str,
        accepting_user_id: &str,
    ) -> Result<(), rusqlite::Error> {
        let row: Option<(String, String, String)> = conn
            .query_row(
                "SELECT from_user_id, to_user_id, status FROM friend_requests WHERE id = ?1",
                params![request_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .ok();
        let (from_id, to_id, status) = match row {
            Some(v) => v,
            None => return Err(rusqlite::Error::ExecuteReturnedResults),
        };
        if status != "pending" {
            return Err(rusqlite::Error::InvalidQuery);
        }
        if to_id != accepting_user_id {
            // Only the recipient may accept.
            return Err(rusqlite::Error::InvalidQuery);
        }
        conn.execute(
            "DELETE FROM friend_requests WHERE id = ?1",
            params![request_id],
        )?;
        Self::add_friendship_c(conn, &from_id, &to_id)?;
        Ok(())
    }

    pub fn accept_friend_request(
        &self,
        request_id: &str,
        accepting_user_id: &str,
    ) -> Result<(String, String), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // Check if request_id_hash column exists (migration 039)
        let has_hash_col: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('friend_requests') WHERE name = 'request_id_hash'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);
        // Try to find by request_id_hash first, fall back to raw request_id
        // Must return raw UUID id for accept_friend_request_c to work correctly.
        let (req_raw_id, from_id, to_id): (String, String, String) = if has_hash_col {
            conn.query_row(
                "SELECT id, from_user_id, to_user_id FROM friend_requests WHERE request_id_hash = ?1 AND status = 'pending'",
                params![request_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .or_else(|_| {
                conn.query_row(
                    "SELECT id, from_user_id, to_user_id FROM friend_requests WHERE id = ?1 AND status = 'pending'",
                    params![request_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
            })
            .map_err(|_| "Friend request not found".to_string())?
        } else {
            conn.query_row(
                "SELECT id, from_user_id, to_user_id FROM friend_requests WHERE id = ?1 AND status = 'pending'",
                params![request_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|_| "Friend request not found".to_string())?
        };
        if to_id != accepting_user_id {
            return Err("Only the recipient can accept a friend request".to_string());
        }
        // Pass the raw UUID (req_raw_id), not the hash, to accept_friend_request_c
        Self::accept_friend_request_c(&conn, &req_raw_id, accepting_user_id)
            .map_err(|_| "Friend request not found".to_string())?;
        Ok((from_id, to_id))
    }

    pub fn decline_friend_request(
        &self,
        request_id: &str,
        declining_user_id: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // Check if request_id_hash column exists (migration 039)
        let has_hash_col: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('friend_requests') WHERE name = 'request_id_hash'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);
        let count = if has_hash_col {
            conn.execute(
                "DELETE FROM friend_requests
                 WHERE (request_id_hash = ?1 OR id = ?1) AND to_user_id = ?2 AND status = 'pending'",
                params![request_id, declining_user_id],
            ).map_err(|e| e.to_string())?
        } else {
            conn.execute(
                "DELETE FROM friend_requests
                 WHERE id = ?1 AND to_user_id = ?2 AND status = 'pending'",
                params![request_id, declining_user_id],
            ).map_err(|e| e.to_string())?
        };
        if count == 0 {
            return Err("Friend request not found".to_string());
        }
        Ok(())
    }

    pub fn list_incoming_friend_requests(&self, user_id: &str) -> Result<Vec<FriendRequestRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT fr.id, fr.from_user_id, fu.username, fr.to_user_id, tu.username, fr.status, fr.created_at
             FROM friend_requests fr
             INNER JOIN users fu ON fr.from_user_id = fu.id
             INNER JOIN users tu ON fr.to_user_id = tu.id
             WHERE fr.to_user_id = ?1 AND fr.status = 'pending'
             ORDER BY fr.created_at DESC",
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![user_id], |row| {
            Ok(FriendRequestRow {
                id: row.get(0)?,
                from_user_id: row.get(1)?,
                from_username: row.get(2)?,
                to_user_id: row.get(3)?,
                to_username: row.get(4)?,
                status: row.get(5)?,
                created_at: row.get(6)?,
            })
        }).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    pub fn list_outgoing_friend_requests(&self, user_id: &str) -> Result<Vec<FriendRequestRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT fr.id, fr.from_user_id, fu.username, fr.to_user_id, tu.username, fr.status, fr.created_at
             FROM friend_requests fr
             INNER JOIN users fu ON fr.from_user_id = fu.id
             INNER JOIN users tu ON fr.to_user_id = tu.id
             WHERE fr.from_user_id = ?1 AND fr.status = 'pending'
             ORDER BY fr.created_at DESC",
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![user_id], |row| {
            Ok(FriendRequestRow {
                id: row.get(0)?,
                from_user_id: row.get(1)?,
                from_username: row.get(2)?,
                to_user_id: row.get(3)?,
                to_username: row.get(4)?,
                status: row.get(5)?,
                created_at: row.get(6)?,
            })
        }).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    pub fn remove_friend(&self, user_id: &str, other_user_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let (a, b) = if user_id < other_user_id {
            (user_id, other_user_id)
        } else {
            (other_user_id, user_id)
        };
        conn.execute(
            "DELETE FROM friendships WHERE user_id_a = ?1 AND user_id_b = ?2",
            params![a, b],
        )
        .map_err(|e| e.to_string())?;

        // Also delete any DM channel between these two users (including any
        // DM-call waiting row — the call can't linger after unfriending).
        if let Ok(Some(dm_id)) = Self::find_dm_channel_c(&conn, user_id, other_user_id) {
            conn.execute("DELETE FROM dm_messages WHERE dm_channel_id = ?1", params![dm_id])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM dm_members WHERE dm_channel_id = ?1", params![dm_id])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM dm_channels WHERE id = ?1", params![dm_id])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM dm_call_waiting WHERE dm_channel_id = ?1", params![dm_id])
                .map_err(|e| e.to_string())?;
        }

        // Also delete any pending friend requests between them
        conn.execute(
            "DELETE FROM friend_requests WHERE (from_user_id = ?1 AND to_user_id = ?2) OR (from_user_id = ?2 AND to_user_id = ?1)",
            params![user_id, other_user_id],
        )
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    fn are_friends_c(conn: &Connection, user_a: &str, user_b: &str) -> Result<bool, rusqlite::Error> {
        let (a, b) = if user_a < user_b {
            (user_a, user_b)
        } else {
            (user_b, user_a)
        };
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM friendships WHERE user_id_a = ?1 AND user_id_b = ?2",
            params![a, b],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    // --- DM Channels ---

    /// Find an existing 1:1 DM channel between two users (members must be exactly these two).
    pub fn find_dm_channel(&self, user_a: &str, user_b: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        Self::find_dm_channel_c(&conn, user_a, user_b).map_err(|e| e.to_string())
    }

    fn find_dm_channel_c(conn: &Connection, user_a: &str, user_b: &str) -> Result<Option<String>, rusqlite::Error> {
        let result: Option<String> = conn
            .query_row(
                "SELECT dm_channel_id FROM dm_members
                 WHERE user_id IN (?1, ?2)
                 GROUP BY dm_channel_id
                 HAVING COUNT(DISTINCT user_id) = 2
                    AND SUM(CASE WHEN user_id IN (?1, ?2) THEN 1 ELSE 0 END) = 2
                 LIMIT 1",
                params![user_a, user_b],
                |row| row.get(0),
            )
            .ok();
        Ok(result)
    }

    /// Create a fresh DM channel with the two given members.
    pub fn create_dm_channel(&self, user_a: &str, user_b: &str) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();
        conn.execute("INSERT INTO dm_channels (id) VALUES (?1)", params![id])
            .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?1, ?2)",
            params![id, user_a],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?1, ?2)",
            params![id, user_b],
        )
        .map_err(|e| e.to_string())?;
        Ok(id)
    }

    pub fn find_or_create_dm_channel(&self, user_a: &str, user_b: &str) -> Result<String, String> {
        match self.find_dm_channel(user_a, user_b)? {
            Some(id) => Ok(id),
            None => self.create_dm_channel(user_a, user_b),
        }
    }

    pub fn list_dm_channels_for_user(&self, user_id: &str) -> Result<Vec<(String, String, String, Option<String>, Option<String>)>, String> {
        // Returns (dm_channel_id, other_user_id, other_username, other_display_name, other_profile_pic) ordered by most recent message.
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
             "SELECT dm.id, other.user_id, u.username, NULL as display_name, u.profile_picture_file_id
              FROM dm_members mine
             INNER JOIN dm_channels dm ON dm.id = mine.dm_channel_id
             INNER JOIN (
                 SELECT dm_channel_id, user_id
                 FROM dm_members
                 WHERE user_id != ?1
             ) other ON other.dm_channel_id = mine.dm_channel_id
             INNER JOIN users u ON u.id = other.user_id
             WHERE mine.user_id = ?1
             ORDER BY COALESCE(dm.position, 0) ASC, (SELECT MAX(timestamp) FROM dm_messages WHERE dm_channel_id = dm.id) DESC NULLS LAST",
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![user_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        }).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    pub fn get_dm_members(&self, dm_channel_id: &str) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("SELECT user_id FROM dm_members WHERE dm_channel_id = ?1").map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![dm_channel_id], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    pub fn is_dm_member(&self, dm_channel_id: &str, user_id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM dm_members WHERE dm_channel_id = ?1 AND user_id = ?2",
            params![dm_channel_id, user_id],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        Ok(count > 0)
    }

    /// Count new DM messages (from other users) for a user since a given timestamp.
    pub fn count_new_dm_messages(&self, user_id: &str, since_rfc3339: &str) -> Result<i64, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM dm_messages dm
             JOIN dm_members dmem ON dm.dm_channel_id = dmem.dm_channel_id
             WHERE dmem.user_id = ?1
               AND dm.sender_id != ?1
               AND dm.timestamp > ?2",
            params![user_id, since_rfc3339],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        Ok(count)
    }

    /// Count new server messages (in channels of servers the user belongs to) since a timestamp.
    pub fn count_new_server_messages(&self, user_id: &str, since_rfc3339: &str) -> Result<i64, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM messages m
             JOIN channels ch ON m.channel_id = ch.id
             JOIN server_members sm ON ch.server_id = sm.server_id AND sm.user_id = ?1
             WHERE m.sender_id != ?1
               AND m.timestamp > ?2",
            params![user_id, since_rfc3339],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        Ok(count)
    }

    // --- DM Keys (envelope-encrypted per member, same pattern as server_keys) ---

    pub fn save_dm_key(
        &self,
        dm_channel_id: &str,
        user_id: &str,
        encrypted_key: &[u8],
        sender_public_key: &[u8],
        nonce: &[u8],
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO dm_keys (dm_channel_id, user_id, encrypted_key, sender_public_key, nonce)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![dm_channel_id, user_id, encrypted_key, sender_public_key, nonce],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_dm_keys_for_user(
        &self,
        dm_channel_id: &str,
        user_id: &str,
    ) -> Result<Vec<(Vec<u8>, Vec<u8>, Vec<u8>)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT encrypted_key, sender_public_key, nonce FROM dm_keys
             WHERE dm_channel_id = ?1 AND user_id = ?2",
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![dm_channel_id, user_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        }).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    // --- DM Messages ---

    pub fn list_dm_messages(&self, dm_channel_id: &str, limit: i64) -> Result<Vec<DmMessage>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT m.id, m.dm_channel_id, m.sender_id, u.username, u.profile_picture_file_id,
                    m.encrypted_content, m.nonce, m.timestamp,
                    m.edited_at,
                    m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce,
                    m.encrypted_sender_username, m.sender_username_nonce,
                    m.sender_id_hash
             FROM (
                  SELECT id, dm_channel_id, sender_id, encrypted_content, nonce, timestamp,
                         edited_at,
                         key_version, encrypted_profile_snapshot, profile_snapshot_nonce,
                         encrypted_sender_username, sender_username_nonce,
                         sender_id_hash
                  FROM dm_messages
                  WHERE dm_channel_id = ?1
                  ORDER BY timestamp DESC, id DESC
                  LIMIT ?2
              ) m
              INNER JOIN users u ON m.sender_id = u.id
              ORDER BY m.timestamp ASC, m.id ASC",
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![dm_channel_id, limit], |row| {
            Ok(DmMessage {
                id: row.get(0)?,
                dm_channel_id: row.get(1)?,
                sender_id: row.get(2)?,
                // cols 3=u.username, 4=u.profile_picture_file_id (skipped)
                encrypted_content: row.get(5)?,
                nonce: row.get(6)?,
                timestamp: row.get(7)?,
                edited_at: row.get(8)?,
                key_version: row.get(9)?,
                encrypted_profile_snapshot: row.get(10)?,
                profile_snapshot_nonce: row.get(11)?,
                encrypted_sender_username: row.get(12)?,
                sender_username_nonce: row.get(13)?,
                sender_id_hash: row.get(14).ok().flatten(),
                file_id: None,
            })
        })
        .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    pub fn list_dm_messages_before(&self, dm_channel_id: &str, before_timestamp: &str, before_id: Option<&str>, limit: i64) -> Result<Vec<DmMessage>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT m.id, m.dm_channel_id, m.sender_id, u.username, u.profile_picture_file_id,
                    m.encrypted_content, m.nonce, m.timestamp,
                    m.edited_at,
                    m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce,
                    m.encrypted_sender_username, m.sender_username_nonce,
                    m.sender_id_hash
             FROM (
                  SELECT id, dm_channel_id, sender_id, encrypted_content, nonce, timestamp,
                         edited_at,
                         key_version, encrypted_profile_snapshot, profile_snapshot_nonce,
                         encrypted_sender_username, sender_username_nonce,
                         sender_id_hash
                  FROM dm_messages
                  WHERE dm_channel_id = ?1 AND (timestamp < ?3 OR (timestamp = ?3 AND id < ?4))
                  ORDER BY timestamp DESC, id DESC
                  LIMIT ?2
              ) m
              INNER JOIN users u ON m.sender_id = u.id
              ORDER BY m.timestamp ASC, m.id ASC",
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![dm_channel_id, limit, before_timestamp, before_id.unwrap_or("")], |row| {
            Ok(DmMessage {
                id: row.get(0)?,
                dm_channel_id: row.get(1)?,
                sender_id: row.get(2)?,
                // cols 3=u.username, 4=u.profile_picture_file_id (skipped)
                encrypted_content: row.get(5)?,
                nonce: row.get(6)?,
                timestamp: row.get(7)?,
                edited_at: row.get(8)?,
                key_version: row.get(9)?,
                encrypted_profile_snapshot: row.get(10)?,
                profile_snapshot_nonce: row.get(11)?,
                encrypted_sender_username: row.get(12)?,
                sender_username_nonce: row.get(13)?,
                sender_id_hash: row.get(14).ok().flatten(),
                file_id: None,
            })
        }).map_err(|e| e.to_string())?;
        let mut output = Vec::new();
        for r in rows {
            output.push(r.map_err(|e| e.to_string())?);
        }
        Ok(output)
    }

    pub fn save_dm_message(
        &self,
        dm_channel_id: &str,
        sender_id: &str,
        encrypted_content: &[u8],
        nonce: &[u8],
        // Streamlined E2E fields
        encrypted_profile_snapshot: Option<&[u8]>,
        profile_snapshot_nonce: Option<&[u8]>,
        encrypted_sender_username: Option<&str>,
        sender_username_nonce: Option<&str>,
        file_id: Option<&str>,
        // Disappearing-message TTL: fixed-width RFC3339 wall-clock expiry
        // (NULL = never). The server enforces it; the content stays encrypted.
        expires_at: Option<&str>,
    ) -> Result<DmMessage, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();
        let username: String = conn
            .query_row(
                "SELECT username FROM users WHERE id = ?1",
                params![sender_id],
                |row| row.get(0),
            )
            .map_err(|_| "Sender not found".to_string())?;
        let h = sha256_hex(&format!("{}:{}", sender_id, dm_channel_id));
        // Same fixed-width RFC3339 timestamp as channel messages (see save_message).
        let ts = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.6fZ").to_string();
        conn.execute(
            "INSERT INTO dm_messages (id, dm_channel_id, sender_id, encrypted_content, nonce, timestamp, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_sender_username, sender_username_nonce, sender_id_hash, file_id, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![id, dm_channel_id, sender_id, encrypted_content, nonce, ts, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_sender_username, sender_username_nonce, h, file_id, expires_at],
        )
        .map_err(|e| e.to_string())?;

        Ok(DmMessage {
            id,
            dm_channel_id: dm_channel_id.to_string(),
            sender_id: sender_id.to_string(),
            encrypted_content: encrypted_content.to_vec(),
            nonce: nonce.to_vec(),
            timestamp: ts,
            edited_at: None,
            key_version: None,
            encrypted_profile_snapshot: encrypted_profile_snapshot.map(|v| v.to_vec()),
            profile_snapshot_nonce: profile_snapshot_nonce.map(|v| v.to_vec()),
            encrypted_sender_username: encrypted_sender_username.map(|s| s.to_string()),
            sender_username_nonce: sender_username_nonce.map(|s| s.to_string()),
            sender_id_hash: Some(sha256_hex(&format!("{}:{}", sender_id, dm_channel_id))),
            file_id: file_id.map(|s| s.to_string()),
        })
    }

    pub fn edit_encrypted_message(
        &self,
        message_id: &str,
        sender_id: &str,
        new_encrypted_content: &[u8],
        new_nonce: &[u8],
    ) -> Result<Message, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // Verify sender owns this message
        let existing_sender: String = conn
            .query_row(
                "SELECT sender_id FROM messages WHERE id = ?1",
                params![message_id],
                |row| row.get(0),
            )
            .map_err(|_| "Message not found".to_string())?;
        if existing_sender != sender_id {
            return Err("Not authorized to edit this message".to_string());
        }
        conn.execute(
            "UPDATE messages SET encrypted_content = ?, nonce = ?, edited_at = CURRENT_TIMESTAMP WHERE id = ?",
            params![new_encrypted_content, new_nonce, message_id],
        )
        .map_err(|e| e.to_string())?;
        // Return updated message
        let username: String = conn
            .query_row(
                "SELECT u.username FROM messages m INNER JOIN users u ON m.sender_id = u.id WHERE m.id = ?1",
                params![message_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let msg = conn
            .query_row(
                "SELECT m.id, m.channel_id, m.sender_id, m.encrypted_content, m.nonce, m.timestamp, m.edited_at, m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.encrypted_sender_username, m.sender_username_nonce, m.sender_id_hash, m.file_id                         FROM messages m WHERE m.id = ?1",
                params![message_id],
                |row| {
                    Ok(Message {
                        id: row.get(0)?,
                        channel_id: row.get(1)?,
                        sender_id: row.get(2)?,

                        encrypted_content: row.get(3)?,
                        nonce: row.get(4)?,
                        timestamp: row.get(5)?,
                        edited_at: row.get(6)?,
                        key_version: row.get(7)?,
                        encrypted_profile_snapshot: row.get(8)?,
                        profile_snapshot_nonce: row.get(9)?,
                        encrypted_sender_username: row.get(10)?,
                        sender_username_nonce: row.get(11)?,
                        sender_id_hash: row.get(12)?,
                        file_id: row.get(13)?,
                        thread_parent_id: None,
                    })
                },
            )
            .map_err(|e| e.to_string())?;
        Ok(msg)
    }

    pub fn delete_message(&self, message_id: &str, sender_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let existing: (String, Option<String>) = conn
            .query_row(
                "SELECT sender_id, file_id FROM messages WHERE id = ?1",
                params![message_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .map_err(|_| "Message not found".to_string())?;
        if existing.0 != sender_id {
            return Err("Not authorized to delete this message".to_string());
        }
        // Save the file_id_hash before deleting the message row
        let file_id_hash = existing.1.clone();
        conn.execute("DELETE FROM messages WHERE id = ?1", params![message_id])
            .map_err(|e| e.to_string())?;
        // Clean up associated file if present — resolve hash to actual file_id from files table
        if let Some(hash) = file_id_hash {
            if let Ok(fid) = self.get_file_id_by_hash_from_files(&hash) {
                if let Ok(info) = self.delete_file_record(&fid) {
                    let dir = format!("{}/{}", self.upload_dir, fid);
                    for i in 0..info.chunk_count {
                        let chunk_path = format!("{}/{}.enc", dir, i);
                        let _ = std::fs::remove_file(&chunk_path);
                    }
                    let _ = std::fs::remove_dir(&dir);
                }
            }
        }
        Ok(())
    }

    pub fn edit_dm_message(
        &self,
        message_id: &str,
        sender_id: &str,
        new_encrypted_content: &[u8],
        new_nonce: &[u8],
    ) -> Result<DmMessage, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let existing_sender: String = conn
            .query_row(
                "SELECT sender_id FROM dm_messages WHERE id = ?1",
                params![message_id],
                |row| row.get(0),
            )
            .map_err(|_| "Message not found".to_string())?;
        if existing_sender != sender_id {
            return Err("Not authorized to edit this message".to_string());
        }
        conn.execute(
            "UPDATE dm_messages SET encrypted_content = ?, nonce = ?, edited_at = CURRENT_TIMESTAMP WHERE id = ?",
            params![new_encrypted_content, new_nonce, message_id],
        )
        .map_err(|e| e.to_string())?;
        let username: String = conn
            .query_row(
                "SELECT u.username FROM dm_messages m INNER JOIN users u ON m.sender_id = u.id WHERE m.id = ?1",
                params![message_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let msg = conn
            .query_row(
                "SELECT m.id, m.dm_channel_id, m.sender_id, m.encrypted_content, m.nonce, m.timestamp, m.edited_at, m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.encrypted_sender_username, m.sender_username_nonce, m.sender_id_hash, m.file_id                         FROM dm_messages m WHERE m.id = ?1",
                params![message_id],
                |row| {
                    Ok(DmMessage {
                        id: row.get(0)?,
                        dm_channel_id: row.get(1)?,
                        sender_id: row.get(2)?,

                        encrypted_content: row.get(3)?,
                        nonce: row.get(4)?,
                        timestamp: row.get(5)?,
                        edited_at: row.get(6)?,
                        key_version: row.get(7)?,
                        encrypted_profile_snapshot: row.get(8)?,
                        profile_snapshot_nonce: row.get(9)?,
                        encrypted_sender_username: row.get(10)?,
                        sender_username_nonce: row.get(11)?,
                        sender_id_hash: row.get(12)?,
                        file_id: row.get(13)?,
                    })
                },
            )
            .map_err(|e| e.to_string())?;
        Ok(msg)
    }

    pub fn delete_dm_message(&self, message_id: &str, sender_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let existing: (String, Option<String>) = conn
            .query_row(
                "SELECT sender_id, file_id FROM dm_messages WHERE id = ?1",
                params![message_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .map_err(|_| "Message not found".to_string())?;
        if existing.0 != sender_id {
            return Err("Not authorized to delete this message".to_string());
        }
        // Save the file_id_hash before deleting the message row
        let file_id_hash = existing.1.clone();
        conn.execute("DELETE FROM dm_messages WHERE id = ?1", params![message_id])
            .map_err(|e| e.to_string())?;
        // Clean up associated file if present — resolve hash to actual file_id from files table
        if let Some(hash) = file_id_hash {
            if let Ok(fid) = self.get_file_id_by_hash_from_files(&hash) {
                if let Ok(info) = self.delete_file_record(&fid) {
                    let dir = format!("{}/{}", self.upload_dir, fid);
                    for i in 0..info.chunk_count {
                        let chunk_path = format!("{}/{}.enc", dir, i);
                        let _ = std::fs::remove_file(&chunk_path);
                    }
                    let _ = std::fs::remove_dir(&dir);
                }
            }
        }
        Ok(())
    }

    /// Delete a file record + its chunks on disk from a stored file_id_hash.
    /// Shared by normal message deletion and disappearing-message shredding.
    fn shred_file_by_hash(&self, file_id_hash: &str) {
        if let Ok(fid) = self.get_file_id_by_hash_from_files(file_id_hash) {
            if let Ok(info) = self.delete_file_record(&fid) {
                let dir = format!("{}/{}", self.upload_dir, fid);
                for i in 0..info.chunk_count {
                    let chunk_path = format!("{}/{}.enc", dir, i);
                    let _ = std::fs::remove_file(&chunk_path);
                }
                let _ = std::fs::remove_dir(&dir);
            }
        }
    }

    // --- Disappearing messages (server-enforced TTL + shredding) ---
    // Expired rows are listed by the sweeper, then hard-deleted. All dependent
    // rows (search tokens, reactions, poll votes, acks, pins) cascade via their
    // message_id FKs; attached files are shredded from the files table + disk.

    /// Return every expired channel message as (id, channel_id, file_id_hash).
    pub fn list_expired_messages(&self, now_rfc3339: &str) -> Result<Vec<(String, String, Option<String>)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, channel_id, file_id FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![now_rfc3339], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?))
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows.flatten() { out.push(r); }
        Ok(out)
    }

    /// Return every expired DM message as (id, dm_channel_id, file_id_hash).
    pub fn list_expired_dm_messages(&self, now_rfc3339: &str) -> Result<Vec<(String, String, Option<String>)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, dm_channel_id, file_id FROM dm_messages WHERE expires_at IS NOT NULL AND expires_at <= ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![now_rfc3339], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?))
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows.flatten() { out.push(r); }
        Ok(out)
    }

    /// Hard-delete one channel message + its file (no sender check — used by
    /// the TTL sweeper). All dependent rows cascade via message_id FKs.
    pub fn shred_message(&self, message_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let file_id_hash: Option<String> = conn
            .query_row(
                "SELECT file_id FROM messages WHERE id = ?1",
                params![message_id],
                |row| row.get(0),
            )
            .unwrap_or(None);
        conn.execute("DELETE FROM messages WHERE id = ?1", params![message_id])
            .map_err(|e| e.to_string())?;
        drop(conn);
        if let Some(h) = file_id_hash {
            self.shred_file_by_hash(&h);
        }
        Ok(())
    }

    /// Hard-delete one DM message + its file (no sender check — TTL sweeper).
    pub fn shred_dm_message(&self, message_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let file_id_hash: Option<String> = conn
            .query_row(
                "SELECT file_id FROM dm_messages WHERE id = ?1",
                params![message_id],
                |row| row.get(0),
            )
            .unwrap_or(None);
        conn.execute("DELETE FROM dm_messages WHERE id = ?1", params![message_id])
            .map_err(|e| e.to_string())?;
        drop(conn);
        if let Some(h) = file_id_hash {
            self.shred_file_by_hash(&h);
        }
        Ok(())
    }

    /// Fetch expires_at for a batch of message ids (for the message-list JSON;
    /// NULL = never expires). Clients use it to render the countdown banner.
    pub fn get_message_expiries(&self, message_ids: &[String]) -> Result<std::collections::HashMap<String, Option<String>>, String> {
        if message_ids.is_empty() { return Ok(std::collections::HashMap::new()); }
        let placeholders: Vec<String> = (1..=message_ids.len()).map(|i| format!("?{}", i)).collect();
        let sql = format!(
            "SELECT id, expires_at FROM messages WHERE id IN ({})",
            placeholders.join(",")
        );
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let values: Vec<rusqlite::types::Value> = message_ids.iter().map(|s| rusqlite::types::Value::Text(s.clone())).collect();
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut out: std::collections::HashMap<String, Option<String>> = std::collections::HashMap::new();
        let rows = stmt
            .query_map(rusqlite::params_from_iter(values), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for r in rows.flatten() { out.insert(r.0, r.1); }
        Ok(out)
    }

    pub fn get_dm_message_expiries(&self, message_ids: &[String]) -> Result<std::collections::HashMap<String, Option<String>>, String> {
        if message_ids.is_empty() { return Ok(std::collections::HashMap::new()); }
        let placeholders: Vec<String> = (1..=message_ids.len()).map(|i| format!("?{}", i)).collect();
        let sql = format!(
            "SELECT id, expires_at FROM dm_messages WHERE id IN ({})",
            placeholders.join(",")
        );
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let values: Vec<rusqlite::types::Value> = message_ids.iter().map(|s| rusqlite::types::Value::Text(s.clone())).collect();
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut out: std::collections::HashMap<String, Option<String>> = std::collections::HashMap::new();
        let rows = stmt
            .query_map(rusqlite::params_from_iter(values), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for r in rows.flatten() { out.insert(r.0, r.1); }
        Ok(out)
    }

    pub fn get_message_channel_id(&self, message_id: &str) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT channel_id FROM messages WHERE id = ?1",
            params![message_id],
            |row| row.get(0),
        )
        .map_err(|_| "Message not found".to_string())
    }

    pub fn get_dm_message_channel_id(&self, message_id: &str) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT dm_channel_id FROM dm_messages WHERE id = ?1",
            params![message_id],
            |row| row.get(0),
        )
        .map_err(|_| "Message not found".to_string())
    }

    /// Get the sender_user_id (raw UUID) of a server message.
    // --- E2E message search (blind index) ---
    // Clients store HMAC-SHA256 tokens per searchable keyword, keyed by a key
    // derived from the server/DM encryption key that the server never sees. The
    // server matches keyword queries against these tokens without ever seeing
    // plaintext (and cannot run a dictionary attack — it lacks the HMAC key).
    // Tokens are insert-only metadata; message content stays fully encrypted.

    pub fn index_message_tokens(&self, message_id: &str, tokens: &[String]) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        for t in tokens {
            let _ = conn.execute(
                "INSERT OR IGNORE INTO message_search_tokens (message_id, token) VALUES (?1, ?2)",
                params![message_id, t],
            );
        }
        Ok(())
    }

    pub fn index_dm_message_tokens(&self, message_id: &str, tokens: &[String]) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        for t in tokens {
            let _ = conn.execute(
                "INSERT OR IGNORE INTO dm_message_search_tokens (message_id, token) VALUES (?1, ?2)",
                params![message_id, t],
            );
        }
        Ok(())
    }

    /// Replace a message's search tokens (used after an edit — the new
    /// plaintext has a new token set). DELETE + INSERT in one lock hold.
    pub fn replace_message_tokens(&self, message_id: &str, tokens: &[String]) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM message_search_tokens WHERE message_id = ?1", params![message_id])
            .map_err(|e| e.to_string())?;
        for t in tokens {
            let _ = conn.execute(
                "INSERT OR IGNORE INTO message_search_tokens (message_id, token) VALUES (?1, ?2)",
                params![message_id, t],
            );
        }
        Ok(())
    }

    pub fn replace_dm_message_tokens(&self, message_id: &str, tokens: &[String]) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM dm_message_search_tokens WHERE message_id = ?1", params![message_id])
            .map_err(|e| e.to_string())?;
        for t in tokens {
            let _ = conn.execute(
                "INSERT OR IGNORE INTO dm_message_search_tokens (message_id, token) VALUES (?1, ?2)",
                params![message_id, t],
            );
        }
        Ok(())
    }

    /// Search server-channel messages by blind-index tokens (AND semantics — a
    /// message must contain every token). Empty tokens matches by sender only
    /// (the "filter by user" mode). Membership is checked by the caller.
    pub fn search_messages(&self, channel_id: &str, tokens: &[String], sender_id: Option<&str>, limit: i64) -> Result<Vec<Message>, String> {
        let mut sql = String::from(
            "SELECT m.id, m.channel_id, m.sender_id, m.encrypted_content, m.nonce, m.timestamp, m.edited_at,
                    m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce,
                    m.encrypted_sender_username, m.sender_username_nonce, m.sender_id_hash, m.file_id
             FROM messages m
             INNER JOIN users u ON m.sender_id = u.id
             WHERE m.channel_id = ?1",
        );
        let mut values: Vec<rusqlite::types::Value> = vec![rusqlite::types::Value::Text(channel_id.to_string())];
        if !tokens.is_empty() {
            sql.push_str(" AND m.id IN (SELECT message_id FROM message_search_tokens WHERE token IN (");
            for (i, t) in tokens.iter().enumerate() {
                if i > 0 { sql.push_str(", "); }
                sql.push_str(&format!("?{}", values.len() + 1));
                values.push(rusqlite::types::Value::Text(t.clone()));
            }
            sql.push_str(&format!(") GROUP BY message_id HAVING COUNT(DISTINCT token) = ?{})", values.len() + 1));
            values.push(rusqlite::types::Value::Integer(tokens.len() as i64));
        }
        if let Some(sid) = sender_id {
            sql.push_str(&format!(" AND m.sender_id = ?{}", values.len() + 1));
            values.push(rusqlite::types::Value::Text(sid.to_string()));
        }
        sql.push_str(&format!(" ORDER BY m.timestamp DESC, m.id DESC LIMIT ?{}", values.len() + 1));
        values.push(rusqlite::types::Value::Integer(limit));

        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(values), |row| message_from_row(row))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// Global channel search: every channel of every server the user belongs to.
    pub fn search_messages_global(&self, user_id: &str, tokens: &[String], sender_id: Option<&str>, limit: i64) -> Result<Vec<Message>, String> {
        let mut sql = String::from(
            "SELECT m.id, m.channel_id, m.sender_id, m.encrypted_content, m.nonce, m.timestamp, m.edited_at,
                    m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce,
                    m.encrypted_sender_username, m.sender_username_nonce, m.sender_id_hash, m.file_id
             FROM messages m
             INNER JOIN message_search_tokens t ON t.message_id = m.id
             INNER JOIN channels c ON c.id = m.channel_id
             INNER JOIN server_members sm ON sm.server_id = c.server_id
             WHERE sm.user_id = ?1",
        );
        let mut values: Vec<rusqlite::types::Value> = vec![rusqlite::types::Value::Text(user_id.to_string())];
        if !tokens.is_empty() {
            sql.push_str(" AND t.token IN (");
            for (i, t) in tokens.iter().enumerate() {
                if i > 0 { sql.push_str(", "); }
                sql.push_str(&format!("?{}", values.len() + 1));
                values.push(rusqlite::types::Value::Text(t.clone()));
            }
            sql.push_str(&format!(") GROUP BY m.id HAVING COUNT(DISTINCT t.token) = ?{}", values.len() + 1));
            values.push(rusqlite::types::Value::Integer(tokens.len() as i64));
        }
        if let Some(sid) = sender_id {
            sql.push_str(&format!(" AND m.sender_id = ?{}", values.len() + 1));
            values.push(rusqlite::types::Value::Text(sid.to_string()));
        }
        sql.push_str(&format!(" ORDER BY m.timestamp DESC, m.id DESC LIMIT ?{}", values.len() + 1));
        values.push(rusqlite::types::Value::Integer(limit));

        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(values), |row| message_from_row(row))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn search_dm_messages(&self, dm_channel_id: &str, tokens: &[String], sender_id: Option<&str>, limit: i64) -> Result<Vec<DmMessage>, String> {
        let mut sql = String::from(
            "SELECT m.id, m.dm_channel_id, m.sender_id, m.encrypted_content, m.nonce, m.timestamp, m.edited_at,
                    m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce,
                    m.encrypted_sender_username, m.sender_username_nonce, m.sender_id_hash, m.file_id
             FROM dm_messages m
             WHERE m.dm_channel_id = ?1",
        );
        let mut values: Vec<rusqlite::types::Value> = vec![rusqlite::types::Value::Text(dm_channel_id.to_string())];
        if !tokens.is_empty() {
            sql.push_str(" AND m.id IN (SELECT message_id FROM dm_message_search_tokens WHERE token IN (");
            for (i, t) in tokens.iter().enumerate() {
                if i > 0 { sql.push_str(", "); }
                sql.push_str(&format!("?{}", values.len() + 1));
                values.push(rusqlite::types::Value::Text(t.clone()));
            }
            sql.push_str(&format!(") GROUP BY message_id HAVING COUNT(DISTINCT token) = ?{})", values.len() + 1));
            values.push(rusqlite::types::Value::Integer(tokens.len() as i64));
        }
        if let Some(sid) = sender_id {
            sql.push_str(&format!(" AND m.sender_id = ?{}", values.len() + 1));
            values.push(rusqlite::types::Value::Text(sid.to_string()));
        }
        sql.push_str(&format!(" ORDER BY m.timestamp DESC, m.id DESC LIMIT ?{}", values.len() + 1));
        values.push(rusqlite::types::Value::Integer(limit));

        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(values), |row| dm_message_from_row(row))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// Global DM search: every DM channel the user is a member of.
    pub fn search_dm_messages_global(&self, user_id: &str, tokens: &[String], sender_id: Option<&str>, limit: i64) -> Result<Vec<DmMessage>, String> {
        let mut sql = String::from(
            "SELECT m.id, m.dm_channel_id, m.sender_id, m.encrypted_content, m.nonce, m.timestamp, m.edited_at,
                    m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce,
                    m.encrypted_sender_username, m.sender_username_nonce, m.sender_id_hash, m.file_id
             FROM dm_messages m
             INNER JOIN dm_message_search_tokens t ON t.message_id = m.id
             INNER JOIN dm_members dm ON dm.dm_channel_id = m.dm_channel_id
             WHERE dm.user_id = ?1",
        );
        let mut values: Vec<rusqlite::types::Value> = vec![rusqlite::types::Value::Text(user_id.to_string())];
        if !tokens.is_empty() {
            sql.push_str(" AND t.token IN (");
            for (i, t) in tokens.iter().enumerate() {
                if i > 0 { sql.push_str(", "); }
                sql.push_str(&format!("?{}", values.len() + 1));
                values.push(rusqlite::types::Value::Text(t.clone()));
            }
            sql.push_str(&format!(") GROUP BY m.id HAVING COUNT(DISTINCT t.token) = ?{}", values.len() + 1));
            values.push(rusqlite::types::Value::Integer(tokens.len() as i64));
        }
        if let Some(sid) = sender_id {
            sql.push_str(&format!(" AND m.sender_id = ?{}", values.len() + 1));
            values.push(rusqlite::types::Value::Text(sid.to_string()));
        }
        sql.push_str(&format!(" ORDER BY m.timestamp DESC, m.id DESC LIMIT ?{}", values.len() + 1));
        values.push(rusqlite::types::Value::Integer(limit));

        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(values), |row| dm_message_from_row(row))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    // --- Message reactions (E2E-encrypted) ---
    // Each row is an emoji payload encrypted with the channel/DM key plus a
    // blind HMAC emoji_token (UNIQUE per message/reactor/emoji) so identical
    // emoji from one reactor are deduped and can be toggled off without the
    // server ever reading the emoji. Counts are computed client-side.

    /// Insert a reaction. Returns true if newly added, false if the exact
    /// (message, reactor, emoji) already exists (the caller toggles it off).
    pub fn add_reaction(&self, message_id: &str, reactor_id: &str, emoji_token: &str, encrypted_emoji: &str, emoji_nonce: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();
        let n = conn
            .execute(
                "INSERT OR IGNORE INTO message_reactions (id, message_id, reactor_id, emoji_token, encrypted_emoji, emoji_nonce) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, message_id, reactor_id, emoji_token, encrypted_emoji, emoji_nonce],
            )
            .map_err(|e| e.to_string())?;
        Ok(n > 0)
    }

    pub fn add_dm_reaction(&self, message_id: &str, reactor_id: &str, emoji_token: &str, encrypted_emoji: &str, emoji_nonce: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();
        let n = conn
            .execute(
                "INSERT OR IGNORE INTO dm_message_reactions (id, message_id, reactor_id, emoji_token, encrypted_emoji, emoji_nonce) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, message_id, reactor_id, emoji_token, encrypted_emoji, emoji_nonce],
            )
            .map_err(|e| e.to_string())?;
        Ok(n > 0)
    }

    /// Remove the reactor's reaction for one emoji. Returns true if removed.
    pub fn remove_reaction(&self, message_id: &str, reactor_id: &str, emoji_token: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let n = conn
            .execute(
                "DELETE FROM message_reactions WHERE message_id = ?1 AND reactor_id = ?2 AND emoji_token = ?3",
                params![message_id, reactor_id, emoji_token],
            )
            .map_err(|e| e.to_string())?;
        Ok(n > 0)
    }

    pub fn remove_dm_reaction(&self, message_id: &str, reactor_id: &str, emoji_token: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let n = conn
            .execute(
                "DELETE FROM dm_message_reactions WHERE message_id = ?1 AND reactor_id = ?2 AND emoji_token = ?3",
                params![message_id, reactor_id, emoji_token],
            )
            .map_err(|e| e.to_string())?;
        Ok(n > 0)
    }

    /// Fetch reactions for a batch of message ids (for message-list loading,
    /// infinite scroll, pins, and around-message jumps).
    pub fn get_message_reactions(&self, message_ids: &[String]) -> Result<std::collections::HashMap<String, Vec<ReactionRow>>, String> {
        if message_ids.is_empty() { return Ok(std::collections::HashMap::new()); }
        let placeholders: Vec<String> = (1..=message_ids.len()).map(|i| format!("?{}", i)).collect();
        let sql = format!(
            "SELECT message_id, reactor_id, emoji_token, encrypted_emoji, emoji_nonce, created_at FROM message_reactions WHERE message_id IN ({})",
            placeholders.join(",")
        );
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let values: Vec<rusqlite::types::Value> = message_ids.iter().map(|s| rusqlite::types::Value::Text(s.clone())).collect();
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut out: std::collections::HashMap<String, Vec<ReactionRow>> = std::collections::HashMap::new();
        let rows = stmt
            .query_map(rusqlite::params_from_iter(values), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    ReactionRow {
                        reactor_id: row.get(1)?,
                        emoji_token: row.get(2)?,
                        encrypted_emoji: row.get(3)?,
                        emoji_nonce: row.get(4)?,
                        created_at: row.get(5)?,
                    },
                ))
            })
            .map_err(|e| e.to_string())?;
        for r in rows.flatten() {
            out.entry(r.0).or_default().push(r.1);
        }
        Ok(out)
    }

    pub fn get_dm_message_reactions(&self, message_ids: &[String]) -> Result<std::collections::HashMap<String, Vec<ReactionRow>>, String> {
        if message_ids.is_empty() { return Ok(std::collections::HashMap::new()); }
        let placeholders: Vec<String> = (1..=message_ids.len()).map(|i| format!("?{}", i)).collect();
        let sql = format!(
            "SELECT message_id, reactor_id, emoji_token, encrypted_emoji, emoji_nonce, created_at FROM dm_message_reactions WHERE message_id IN ({})",
            placeholders.join(",")
        );
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let values: Vec<rusqlite::types::Value> = message_ids.iter().map(|s| rusqlite::types::Value::Text(s.clone())).collect();
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut out: std::collections::HashMap<String, Vec<ReactionRow>> = std::collections::HashMap::new();
        let rows = stmt
            .query_map(rusqlite::params_from_iter(values), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    ReactionRow {
                        reactor_id: row.get(1)?,
                        emoji_token: row.get(2)?,
                        encrypted_emoji: row.get(3)?,
                        emoji_nonce: row.get(4)?,
                        created_at: row.get(5)?,
                    },
                ))
            })
            .map_err(|e| e.to_string())?;
        for r in rows.flatten() {
            out.entry(r.0).or_default().push(r.1);
        }
        Ok(out)
    }

    // --- E2E-encrypted polls (blind-index votes) ---
    // Each vote is a row of (voter_id, option_token) where option_token is an
    // HMAC-SHA256 of the option id keyed by the conversation key. The server
    // never sees the option text — it just stores/returns opaque tokens and
    // lets clients match them against the option ids from the decrypted poll.
    // UNIQUE(message_id, voter_id, option_token) makes re-sending the same
    // token a toggle-off (same pattern as reactions).

    /// Insert a vote. Returns true if newly added, false if the exact
    /// (message, voter, option) already exists (the caller toggles it off).
    pub fn add_poll_vote(&self, message_id: &str, voter_id: &str, option_token: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();
        let n = conn
            .execute(
                "INSERT OR IGNORE INTO message_poll_votes (id, message_id, voter_id, option_token) VALUES (?1, ?2, ?3, ?4)",
                params![id, message_id, voter_id, option_token],
            )
            .map_err(|e| e.to_string())?;
        Ok(n > 0)
    }

    pub fn add_dm_poll_vote(&self, message_id: &str, voter_id: &str, option_token: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();
        let n = conn
            .execute(
                "INSERT OR IGNORE INTO dm_message_poll_votes (id, message_id, voter_id, option_token) VALUES (?1, ?2, ?3, ?4)",
                params![id, message_id, voter_id, option_token],
            )
            .map_err(|e| e.to_string())?;
        Ok(n > 0)
    }

    /// Remove the voter's vote for one option token. Returns true if removed.
    pub fn remove_poll_vote(&self, message_id: &str, voter_id: &str, option_token: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let n = conn
            .execute(
                "DELETE FROM message_poll_votes WHERE message_id = ?1 AND voter_id = ?2 AND option_token = ?3",
                params![message_id, voter_id, option_token],
            )
            .map_err(|e| e.to_string())?;
        Ok(n > 0)
    }

    pub fn remove_dm_poll_vote(&self, message_id: &str, voter_id: &str, option_token: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let n = conn
            .execute(
                "DELETE FROM dm_message_poll_votes WHERE message_id = ?1 AND voter_id = ?2 AND option_token = ?3",
                params![message_id, voter_id, option_token],
            )
            .map_err(|e| e.to_string())?;
        Ok(n > 0)
    }

    /// Remove the voter's votes matching ANY of the given option tokens on one
    /// message (single-choice poll switch). Returns how many rows were removed.
    pub fn remove_poll_votes(&self, message_id: &str, voter_id: &str, option_tokens: &[String]) -> Result<usize, String> {
        if option_tokens.is_empty() { return Ok(0); }
        let placeholders: Vec<String> = (1..=option_tokens.len()).map(|i| format!("?{}", i + 3)).collect();
        let sql = format!(
            "DELETE FROM message_poll_votes WHERE message_id = ?1 AND voter_id = ?2 AND option_token IN ({})",
            placeholders.join(",")
        );
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut params_vec: Vec<rusqlite::types::Value> = vec![
            rusqlite::types::Value::Text(message_id.to_string()),
            rusqlite::types::Value::Text(voter_id.to_string()),
        ];
        for t in option_tokens { params_vec.push(rusqlite::types::Value::Text(t.clone())); }
        let n = conn
            .execute(&sql, rusqlite::params_from_iter(params_vec))
            .map_err(|e| e.to_string())?;
        Ok(n)
    }

    pub fn remove_dm_poll_votes(&self, message_id: &str, voter_id: &str, option_tokens: &[String]) -> Result<usize, String> {
        if option_tokens.is_empty() { return Ok(0); }
        let placeholders: Vec<String> = (1..=option_tokens.len()).map(|i| format!("?{}", i + 3)).collect();
        let sql = format!(
            "DELETE FROM dm_message_poll_votes WHERE message_id = ?1 AND voter_id = ?2 AND option_token IN ({})",
            placeholders.join(",")
        );
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut params_vec: Vec<rusqlite::types::Value> = vec![
            rusqlite::types::Value::Text(message_id.to_string()),
            rusqlite::types::Value::Text(voter_id.to_string()),
        ];
        for t in option_tokens { params_vec.push(rusqlite::types::Value::Text(t.clone())); }
        let n = conn
            .execute(&sql, rusqlite::params_from_iter(params_vec))
            .map_err(|e| e.to_string())?;
        Ok(n)
    }

    /// Fetch poll votes for a batch of message ids (message-list loading,
    /// infinite scroll, pins, and around-message jumps).
    pub fn get_message_poll_votes(&self, message_ids: &[String]) -> Result<std::collections::HashMap<String, Vec<PollVoteRow>>, String> {
        if message_ids.is_empty() { return Ok(std::collections::HashMap::new()); }
        let placeholders: Vec<String> = (1..=message_ids.len()).map(|i| format!("?{}", i)).collect();
        let sql = format!(
            "SELECT message_id, voter_id, option_token, created_at FROM message_poll_votes WHERE message_id IN ({})",
            placeholders.join(",")
        );
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let values: Vec<rusqlite::types::Value> = message_ids.iter().map(|s| rusqlite::types::Value::Text(s.clone())).collect();
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut out: std::collections::HashMap<String, Vec<PollVoteRow>> = std::collections::HashMap::new();
        let rows = stmt
            .query_map(rusqlite::params_from_iter(values), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    PollVoteRow {
                        voter_id: row.get(1)?,
                        option_token: row.get(2)?,
                        created_at: row.get(3)?,
                    },
                ))
            })
            .map_err(|e| e.to_string())?;
        for r in rows.flatten() {
            out.entry(r.0).or_default().push(r.1);
        }
        Ok(out)
    }

    pub fn get_dm_message_poll_votes(&self, message_ids: &[String]) -> Result<std::collections::HashMap<String, Vec<PollVoteRow>>, String> {
        if message_ids.is_empty() { return Ok(std::collections::HashMap::new()); }
        let placeholders: Vec<String> = (1..=message_ids.len()).map(|i| format!("?{}", i)).collect();
        let sql = format!(
            "SELECT message_id, voter_id, option_token, created_at FROM dm_message_poll_votes WHERE message_id IN ({})",
            placeholders.join(",")
        );
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let values: Vec<rusqlite::types::Value> = message_ids.iter().map(|s| rusqlite::types::Value::Text(s.clone())).collect();
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut out: std::collections::HashMap<String, Vec<PollVoteRow>> = std::collections::HashMap::new();
        let rows = stmt
            .query_map(rusqlite::params_from_iter(values), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    PollVoteRow {
                        voter_id: row.get(1)?,
                        option_token: row.get(2)?,
                        created_at: row.get(3)?,
                    },
                ))
            })
            .map_err(|e| e.to_string())?;
        for r in rows.flatten() {
            out.entry(r.0).or_default().push(r.1);
        }
        Ok(out)
    }

    // --- Per-message delivery/read acks (E2E blind-token receipts) ---
    // Each row is one recipient's receipt on one message. `ack_token` is an
    // HMAC-SHA256 of the message id keyed by the conversation key — the server
    // stores it (and sanity-checks its shape) but can never forge a receipt
    // because it never holds the key. UNIQUE(message_id, acker_id) gives one
    // row per recipient; re-acking upgrades delivered -> read, never downgrades.

    /// Record (or upgrade) one ack. Returns true when the row was inserted or
    /// its status was upgraded to 'read'; false when it was already at least as
    /// high (e.g. 'read' re-acked, or a stale 'delivered' on a 'read' row).
    pub fn record_message_ack(&self, message_id: &str, acker_id: &str, status: &str, ack_token: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();
        let n = conn
            .execute(
                "INSERT INTO message_acks (id, message_id, acker_id, status, ack_token) VALUES (?1, ?2, ?3, ?4, ?5)\n\
                 ON CONFLICT(message_id, acker_id) DO UPDATE SET\n\
                    status = excluded.status,\n\
                    ack_token = excluded.ack_token,\n\
                    created_at = CURRENT_TIMESTAMP\n\
                 WHERE message_acks.status != 'read'",
                params![id, message_id, acker_id, status, ack_token],
            )
            .map_err(|e| e.to_string())?;
        Ok(n > 0)
    }

    pub fn record_dm_message_ack(&self, message_id: &str, acker_id: &str, status: &str, ack_token: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();
        let n = conn
            .execute(
                "INSERT INTO dm_message_acks (id, message_id, acker_id, status, ack_token) VALUES (?1, ?2, ?3, ?4, ?5)\n\
                 ON CONFLICT(message_id, acker_id) DO UPDATE SET\n\
                    status = excluded.status,\n\
                    ack_token = excluded.ack_token,\n\
                    created_at = CURRENT_TIMESTAMP\n\
                 WHERE dm_message_acks.status != 'read'",
                params![id, message_id, acker_id, status, ack_token],
            )
            .map_err(|e| e.to_string())?;
        Ok(n > 0)
    }

    /// Fetch ack rows for a batch of message ids (message-list loading,
    /// infinite scroll, pins, and around-message jumps).
    pub fn get_message_acks(&self, message_ids: &[String]) -> Result<std::collections::HashMap<String, Vec<AckRow>>, String> {
        if message_ids.is_empty() { return Ok(std::collections::HashMap::new()); }
        let placeholders: Vec<String> = (1..=message_ids.len()).map(|i| format!("?{}", i)).collect();
        let sql = format!(
            "SELECT message_id, acker_id, status, created_at FROM message_acks WHERE message_id IN ({})",
            placeholders.join(",")
        );
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let values: Vec<rusqlite::types::Value> = message_ids.iter().map(|s| rusqlite::types::Value::Text(s.clone())).collect();
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut out: std::collections::HashMap<String, Vec<AckRow>> = std::collections::HashMap::new();
        let rows = stmt
            .query_map(rusqlite::params_from_iter(values), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    AckRow {
                        acker_id: row.get(1)?,
                        status: row.get(2)?,
                        created_at: row.get(3)?,
                    },
                ))
            })
            .map_err(|e| e.to_string())?;
        for r in rows.flatten() {
            out.entry(r.0).or_default().push(r.1);
        }
        Ok(out)
    }

    pub fn get_dm_message_acks(&self, message_ids: &[String]) -> Result<std::collections::HashMap<String, Vec<AckRow>>, String> {
        if message_ids.is_empty() { return Ok(std::collections::HashMap::new()); }
        let placeholders: Vec<String> = (1..=message_ids.len()).map(|i| format!("?{}", i)).collect();
        let sql = format!(
            "SELECT message_id, acker_id, status, created_at FROM dm_message_acks WHERE message_id IN ({})",
            placeholders.join(",")
        );
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let values: Vec<rusqlite::types::Value> = message_ids.iter().map(|s| rusqlite::types::Value::Text(s.clone())).collect();
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut out: std::collections::HashMap<String, Vec<AckRow>> = std::collections::HashMap::new();
        let rows = stmt
            .query_map(rusqlite::params_from_iter(values), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    AckRow {
                        acker_id: row.get(1)?,
                        status: row.get(2)?,
                        created_at: row.get(3)?,
                    },
                ))
            })
            .map_err(|e| e.to_string())?;
        for r in rows.flatten() {
            out.entry(r.0).or_default().push(r.1);
        }
        Ok(out)
    }

    pub fn get_message_sender_user_id(&self, message_id: &str) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT sender_id FROM messages WHERE id = ?1",
            params![message_id],
            |row| row.get(0),
        )
        .map_err(|_| "Message not found".to_string())
    }

    /// Get the sender_user_id (raw UUID) of a DM message.
    pub fn get_dm_message_sender_user_id(&self, message_id: &str) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT sender_id FROM dm_messages WHERE id = ?1",
            params![message_id],
            |row| row.get(0),
        )
        .map_err(|_| "Message not found".to_string())
    }

    // --- Per-channel message pinning (migration 052) ---
    // Pins are metadata only: the server records WHICH message IDs are pinned
    // per channel / DM channel. Message content stays encrypted in
    // messages / dm_messages — the server never sees pinned content plaintext.

    pub fn pin_message(&self, channel_id: &str, message_id: &str, user_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // Verify the message belongs to this channel (prevents cross-channel pinning)
        let actual_channel: String = conn
            .query_row(
                "SELECT channel_id FROM messages WHERE id = ?1",
                params![message_id],
                |row| row.get(0),
            )
            .map_err(|_| "Message not found".to_string())?;
        if actual_channel != channel_id {
            return Err("Message is not in this channel".to_string());
        }
        conn.execute(
            "INSERT OR IGNORE INTO message_pins (channel_id, message_id, pinned_by) VALUES (?1, ?2, ?3)",
            params![channel_id, message_id, user_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn unpin_message(&self, channel_id: &str, message_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM message_pins WHERE channel_id = ?1 AND message_id = ?2",
            params![channel_id, message_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn pin_dm_message(&self, dm_channel_id: &str, message_id: &str, user_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let actual_channel: String = conn
            .query_row(
                "SELECT dm_channel_id FROM dm_messages WHERE id = ?1",
                params![message_id],
                |row| row.get(0),
            )
            .map_err(|_| "Message not found".to_string())?;
        if actual_channel != dm_channel_id {
            return Err("Message is not in this DM channel".to_string());
        }
        conn.execute(
            "INSERT OR IGNORE INTO dm_message_pins (dm_channel_id, message_id, pinned_by) VALUES (?1, ?2, ?3)",
            params![dm_channel_id, message_id, user_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn unpin_dm_message(&self, dm_channel_id: &str, message_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM dm_message_pins WHERE dm_channel_id = ?1 AND message_id = ?2",
            params![dm_channel_id, message_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Pinned message IDs for a server channel, newest pin first.
    pub fn get_pinned_message_ids(&self, channel_id: &str) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT message_id FROM message_pins WHERE channel_id = ?1 ORDER BY pinned_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![channel_id], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    /// Pinned message IDs for a DM channel, newest pin first.
    pub fn get_pinned_dm_message_ids(&self, dm_channel_id: &str) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT message_id FROM dm_message_pins WHERE dm_channel_id = ?1 ORDER BY pinned_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![dm_channel_id], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    /// Full encrypted Message rows for pinned server-channel messages (newest pin first).
    pub fn get_pinned_messages(&self, channel_id: &str) -> Result<Vec<Message>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT m.id, m.channel_id, m.sender_id, u.username, u.profile_picture_file_id,
                        m.encrypted_content, m.nonce, m.timestamp, m.edited_at,
                        m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce,
                        m.encrypted_sender_username, m.sender_username_nonce, m.sender_id_hash, m.file_id
                 FROM message_pins p
                 INNER JOIN messages m ON m.id = p.message_id
                 INNER JOIN users u ON m.sender_id = u.id
                 WHERE p.channel_id = ?1
                 ORDER BY p.pinned_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![channel_id], |row| {
                Ok(Message {
                    id: row.get(0)?,
                    channel_id: row.get(1)?,
                    sender_id: row.get(2)?,
                    encrypted_content: row.get(5)?,
                    nonce: row.get(6)?,
                    timestamp: row.get(7)?,
                    edited_at: row.get(8)?,
                    key_version: row.get(9)?,
                    encrypted_profile_snapshot: row.get(10)?,
                    profile_snapshot_nonce: row.get(11)?,
                    encrypted_sender_username: row.get(12)?,
                    sender_username_nonce: row.get(13)?,
                    sender_id_hash: row.get(14).ok().flatten(),
                    file_id: row.get(15).ok().flatten(),
                    thread_parent_id: None,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    /// Full encrypted DmMessage rows for pinned DM messages (newest pin first).
    pub fn get_pinned_dm_messages(&self, dm_channel_id: &str) -> Result<Vec<DmMessage>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT m.id, m.dm_channel_id, m.sender_id, u.username, u.profile_picture_file_id,
                        m.encrypted_content, m.nonce, m.timestamp, m.edited_at,
                        m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce,
                        m.encrypted_sender_username, m.sender_username_nonce, m.sender_id_hash, m.file_id
                 FROM dm_message_pins p
                 INNER JOIN dm_messages m ON m.id = p.message_id
                 INNER JOIN users u ON m.sender_id = u.id
                 WHERE p.dm_channel_id = ?1
                 ORDER BY p.pinned_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![dm_channel_id], |row| {
                Ok(DmMessage {
                    id: row.get(0)?,
                    dm_channel_id: row.get(1)?,
                    sender_id: row.get(2)?,
                    encrypted_content: row.get(5)?,
                    nonce: row.get(6)?,
                    timestamp: row.get(7)?,
                    edited_at: row.get(8)?,
                    key_version: row.get(9)?,
                    encrypted_profile_snapshot: row.get(10)?,
                    profile_snapshot_nonce: row.get(11)?,
                    encrypted_sender_username: row.get(12)?,
                    sender_username_nonce: row.get(13)?,
                    sender_id_hash: row.get(14).ok().flatten(),
                    file_id: row.get(15).ok().flatten(),
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    // --- User Stickers --- (server_stickers removed in migration 035)

    pub fn add_user_sticker(
        &self,
        user_id: &str,
        file_id: &str,
        encrypted_mime: Option<&[u8]>,
        mime_nonce: Option<&[u8]>,
        encrypted_file_key: Option<&[u8]>,
        file_key_nonce: Option<&[u8]>,
        encrypted_sticker_name: Option<&[u8]>,
        sticker_name_nonce: Option<&[u8]>,
    ) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();
        let hash = sha256_hex(file_id);
        // Mime type is stored encrypted (encrypted_mime_type + mime_nonce, migration 038),
        // keyed with the sticker's own shareable file key so the client can decrypt it after
        // identity-decrypting encrypted_file_key. The plaintext mime_type column was dropped
        // in migration 046 so a DB dump reveals nothing about the sticker/emoji/gif type.
        conn.execute(
            "INSERT INTO user_stickers (id, user_id, file_id, file_id_hash, encrypted_mime_type, mime_nonce, encrypted_file_key, file_key_nonce, encrypted_sticker_name, sticker_name_nonce) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![id, user_id, file_id, hash, encrypted_mime, mime_nonce, encrypted_file_key, file_key_nonce, encrypted_sticker_name, sticker_name_nonce],
        )
        .map_err(|e| e.to_string())?;
        Ok(id)
    }

    pub fn remove_user_sticker(&self, sticker_id: &str, user_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM user_stickers WHERE id = ?1 AND user_id = ?2",
            params![sticker_id, user_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_user_stickers(&self, user_id: &str) -> Result<Vec<(String, String, String, String, Option<Vec<u8>>, Option<Vec<u8>>, Option<Vec<u8>>, Option<Vec<u8>>, Option<Vec<u8>>, Option<Vec<u8>>)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                // mime_type column was dropped in migration 046 — position 3 is a literal ''
                // so the tuple shape is preserved; the real mime travels encrypted in
                // encrypted_mime_type/mime_nonce (decrypted client-side with the file key).
                "SELECT s.id, s.file_id, s.file_id_hash, '', s.encrypted_mime_type, s.mime_nonce, s.encrypted_file_key, s.file_key_nonce, s.encrypted_sticker_name, s.sticker_name_nonce
                 FROM user_stickers s
                 WHERE s.user_id = ?1
                 ORDER BY s.created_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![user_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<Vec<u8>>>(4)?,
                    row.get::<_, Option<Vec<u8>>>(5)?,
                    row.get::<_, Option<Vec<u8>>>(6)?,
                    row.get::<_, Option<Vec<u8>>>(7)?,
                    row.get::<_, Option<Vec<u8>>>(8)?,
                    row.get::<_, Option<Vec<u8>>>(9)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn get_dm_last_message(&self, dm_channel_id: &str) -> Result<Option<DmMessage>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let result = conn.query_row(
            "SELECT m.id, m.dm_channel_id, m.sender_id, u.username, u.profile_picture_file_id,
                        m.encrypted_content, m.nonce, m.timestamp, m.edited_at
             FROM dm_messages m INNER JOIN users u ON m.sender_id = u.id
             WHERE m.dm_channel_id = ?1
             ORDER BY m.timestamp DESC LIMIT 1",
            params![dm_channel_id],
            |row| {
                Ok(DmMessage {
                    id: row.get(0)?,
                    dm_channel_id: row.get(1)?,
                    sender_id: row.get(2)?,

                    encrypted_content: row.get(5)?,
                    nonce: row.get(6)?,
                    timestamp: row.get(7)?,
                    edited_at: row.get(8)?,
                    key_version: None,
                    encrypted_profile_snapshot: None,
                    profile_snapshot_nonce: None,
                    sender_id_hash: None,
                    file_id: None,
                    encrypted_sender_username: None,
                    sender_username_nonce: None,
                })
            },
        );
        match result {
            Ok(m) => Ok(Some(m)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn get_dm_other_user(&self, dm_channel_id: &str, user_id: &str) -> Result<Option<User>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let result = conn.query_row(
            "SELECT u.id, u.username
             FROM dm_members m INNER JOIN users u ON u.id = m.user_id
             WHERE m.dm_channel_id = ?1 AND m.user_id != ?2 LIMIT 1",
            params![dm_channel_id, user_id],
            |row| {
                Ok(User {
                    id: row.get(0)?,
                    username: row.get(1)?,
                })
            },
        );
        match result {
            Ok(u) => Ok(Some(u)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    // --- Server Keys (envelope-encrypted) ---

    pub fn save_server_key(
        &self,
        server_id: &str,
        user_id: &str,
        encrypted_key: &[u8],
        sender_public_key: &[u8],
        nonce: &[u8],
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO server_keys (server_id, user_id, encrypted_key, sender_public_key, nonce, version)
             VALUES (?1, ?2, ?3, ?4, ?5, COALESCE((SELECT MAX(version) FROM server_keys WHERE server_id = ?1), 0) + 1)",
            params![server_id, user_id, encrypted_key, sender_public_key, nonce],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_server_keys_for_user(&self, server_id: &str, user_id: &str) -> Result<Vec<(Vec<u8>, Vec<u8>, Vec<u8>, i32)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT encrypted_key, sender_public_key, nonce, version
                 FROM server_keys WHERE server_id = ?1 AND user_id = ?2",
            )
            .map_err(|e| e.to_string())?;
        let keys = stmt
            .query_map(params![server_id, user_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(keys)
    }

    pub fn get_all_server_keys(&self, server_id: &str) -> Result<Vec<(String, Vec<u8>, Vec<u8>, Vec<u8>, i32)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT user_id, encrypted_key, sender_public_key, nonce, version
                 FROM server_keys WHERE server_id = ?1",
            )
            .map_err(|e| e.to_string())?;
        let keys = stmt
            .query_map(params![server_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(keys)
    }

    pub fn delete_server_keys(&self, server_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM server_keys WHERE server_id = ?1", params![server_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_server_keys_for_user(&self, server_id: &str, user_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM server_keys WHERE server_id = ?1 AND user_id = ?2",
            params![server_id, user_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    // --- Admin ---

    pub fn get_admin_password_hash(&self) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let result = conn.query_row(
            "SELECT value FROM admin_config WHERE key = 'password_hash'",
            [],
            |row| row.get::<_, String>(0),
        );
        match result {
            Ok(hash) => Ok(Some(hash)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn set_admin_password_hash(&self, hash: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO admin_config (key, value) VALUES ('password_hash', ?1)",
            params![hash],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn is_admin_password_set(&self) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM admin_config WHERE key = 'password_hash'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(count > 0)
    }

    /// Generic admin_config accessor (used for G2 runtime-tunable limits).
    pub fn get_config_value(&self, key: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        match conn.query_row(
            "SELECT value FROM admin_config WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        ) {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    /// Generic admin_config upsert (used for G2 runtime-tunable limits).
    pub fn set_config_value(&self, key: &str, value: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO admin_config (key, value) VALUES (?1, ?2)",
            params![key, value],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    // --- Two-factor auth (TOTP + recovery codes) ---

    pub fn totp_enabled(&self, user_id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM totp_secrets WHERE user_id = ?1",
                params![user_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(count > 0)
    }

    pub fn save_totp_secret(&self, user_id: &str, secret_encrypted: &str, nonce: &str, salt: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO totp_secrets (user_id, secret_encrypted, nonce, salt) VALUES (?1, ?2, ?3, ?4)",
            params![user_id, secret_encrypted, nonce, salt],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// (secret_encrypted_b64, nonce_b64, salt) for a user, or None when 2FA is off.
    pub fn get_totp_secret(&self, user_id: &str) -> Result<Option<(String, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let res = conn.query_row(
            "SELECT secret_encrypted, nonce, salt FROM totp_secrets WHERE user_id = ?1",
            params![user_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
        );
        match res {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn save_recovery_code_hashes(&self, user_id: &str, hashes: &[String]) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        for h in hashes {
            conn.execute(
                "INSERT OR IGNORE INTO recovery_codes (user_id, code_hash) VALUES (?1, ?2)",
                params![user_id, h],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// (code_hash, used) for a user's recovery codes.
    pub fn list_recovery_code_hashes(&self, user_id: &str) -> Result<Vec<(String, bool)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT code_hash, used FROM recovery_codes WHERE user_id = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![user_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? != 0))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn mark_recovery_code_used(&self, user_id: &str, hash: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE recovery_codes SET used = 1, used_at = datetime('now') WHERE user_id = ?1 AND code_hash = ?2",
            params![user_id, hash],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_totp(&self, user_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM totp_secrets WHERE user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM recovery_codes WHERE user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// (id, username, two_factor_enabled) for the admin Users tab.
    pub fn list_users_with_2fa(&self) -> Result<Vec<(String, String, bool)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT u.id, u.username, CASE WHEN t.user_id IS NULL THEN 0 ELSE 1 END
                 FROM users u LEFT JOIN totp_secrets t ON t.user_id = u.id ORDER BY u.created_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)? != 0)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// Append to the admin audit log (G4). Tokens/passwords are never logged.
    pub fn log_admin_action(
        &self,
        actor: &str,
        action: &str,
        target: Option<&str>,
        ip: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO admin_audit (actor, action, target, ip) VALUES (?1, ?2, ?3, ?4)",
            params![actor, action, target, ip],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Read the admin audit log, newest first.
    pub fn list_admin_audit(
        &self,
        limit: i64,
    ) -> Result<Vec<(i64, String, String, String, Option<String>, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, timestamp, actor, action, target, ip FROM admin_audit ORDER BY id DESC LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![limit], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    /// Total bytes of files uploaded by a user (G2 storage quota).
    pub fn get_user_storage_usage(&self, uploader_id: &str) -> Result<i64, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT COALESCE(SUM(original_size), 0) FROM files WHERE uploader_id = ?1",
            params![uploader_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())
    }

    pub fn list_all_users(
        &self,
    ) -> Result<
        Vec<(
            String,  // 0: id
            String,  // 1: username
            String,  // 2: password_hash
            String,  // 3: created_at
            String,  // 4: display_name (legacy)
            String,  // 5: identity_public_key
            String,  // 6: profile_picture_file_id
            i32,     // 7: friend_requests_disabled
            String,  // 8: encrypted_friend_code
            String,  // 9: friend_code_salt
            String,  // 10: friend_code_nonce
            String,  // 11: encrypted_profile_data
            String,  // 12: encrypted_profile_salt
            String,  // 13: encrypted_profile_nonce
            String,  // 14: profile_banner_file_id
            String,  // 15: description (legacy)
            String,  // 16: nickname (legacy)
            String,  // 17: friend_code_hash
            String,  // 18: encrypted_hash_key
            String,  // 19: hash_key_salt
            String,  // 20: hash_key_nonce
        )>,
        String,
    > {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, username, password_hash, created_at, '' as display_name, COALESCE(hex(identity_public_key), ''), COALESCE(profile_picture_file_id, ''), COALESCE(friend_requests_disabled, 0), COALESCE(encrypted_friend_code, ''), COALESCE(friend_code_salt, ''), COALESCE(friend_code_nonce, ''), COALESCE(encrypted_profile_data, ''), COALESCE(encrypted_profile_salt, ''), COALESCE(encrypted_profile_nonce, ''), COALESCE(profile_banner_file_id, ''), '' as description, '' as nickname, COALESCE(friend_code_hash, ''), COALESCE(encrypted_hash_key, ''), COALESCE(hash_key_salt, ''), COALESCE(hash_key_nonce, '') FROM users ORDER BY created_at",
            )
            .map_err(|e| e.to_string())?;
        let users = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, i32>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?,
                    row.get::<_, String>(12)?,
                    row.get::<_, String>(13)?,
                    row.get::<_, String>(14)?,
                    row.get::<_, String>(15)?,
                    row.get::<_, String>(16)?,
                    row.get::<_, String>(17)?,
                    row.get::<_, String>(18)?,
                    row.get::<_, String>(19)?,
                    row.get::<_, String>(20)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(users)
    }

    pub fn list_all_servers_admin(&self) -> Result<Vec<Server>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, encrypted_name, name_nonce, owner_id, COALESCE(invite_code_hash, ''), COALESCE(joins_disabled, 0), COALESCE(created_at, ''), server_picture_file_id, server_picture_file_id_hash, encrypted_server_picture_key, server_picture_key_nonce, group_id FROM servers ORDER BY created_at")
            .map_err(|e| e.to_string())?;
        let servers = stmt
            .query_map([], |row| {
                Ok(Server {
                    id: row.get(0)?,
                    encrypted_name: row.get(1)?,
                    name_nonce: row.get(2)?,
                    owner_id: row.get(3)?,
                    invite_code_hash: row.get(4)?,
                    joins_disabled: row.get::<_, i64>(5)? != 0,
                    created_at: row.get(6)?,
                    server_picture_file_id: row.get(7)?,
                    server_picture_file_id_hash: row.get(8)?,
                    encrypted_server_picture_key: row.get(9)?,
                    server_picture_key_nonce: row.get(10)?,
                    group_id: row.get(11).ok(),
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(servers)
    }

    pub fn list_all_channels_admin(&self) -> Result<Vec<Channel>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, server_id, encrypted_name, name_nonce, type, COALESCE(position, 0), COALESCE(created_at, '') FROM channels ORDER BY created_at")
            .map_err(|e| e.to_string())?;
        let channels = stmt
            .query_map([], |row| {
                Ok(Channel {
                    id: row.get(0)?,
                    server_id: row.get(1)?,
                    encrypted_name: row.get(2)?,
                    name_nonce: row.get(3)?,
                    channel_type: row.get(4)?,
                    position: row.get::<_, i32>(5)?,
                    created_at: row.get(6)?,
                    category_id: row.get(7).ok().flatten(),
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(channels)
    }

    pub fn list_all_messages_admin(&self) -> Result<Vec<Message>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT m.id, m.channel_id, m.sender_id, COALESCE(u.username, '?'), u.profile_picture_file_id,
                        m.encrypted_content, m.nonce, m.timestamp, COALESCE(m.edited_at, ''), m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, COALESCE(m.sender_id_hash, '')
                 FROM messages m LEFT JOIN users u ON m.sender_id = u.id ORDER BY m.timestamp DESC LIMIT 500",
            )
            .map_err(|e| e.to_string())?;
        let messages = stmt
            .query_map([], |row| {
                Ok(Message {
                    id: row.get(0)?,
                    channel_id: row.get(1)?,
                    sender_id: row.get(2)?,

                    encrypted_content: row.get(5)?,
                    nonce: row.get(6)?,
                    timestamp: row.get(7)?,
                    edited_at: row.get(8)?,
                    key_version: row.get(9)?,
                    encrypted_profile_snapshot: row.get(10)?,
                    profile_snapshot_nonce: row.get(11)?,
                    encrypted_sender_username: None,
                    sender_username_nonce: None,
                    sender_id_hash: Some(row.get(12)?),
                    file_id: None,
                    thread_parent_id: None,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(messages)
    }

    pub fn list_all_server_keys_admin(
        &self,
    ) -> Result<Vec<(String, String, String, Vec<u8>, Vec<u8>, Vec<u8>, i32, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT sk.server_id, s.id, sk.user_id, sk.encrypted_key, sk.sender_public_key, sk.nonce, sk.version, sk.created_at
                 FROM server_keys sk LEFT JOIN servers s ON sk.server_id = s.id ORDER BY sk.created_at",
            )
            .map_err(|e| e.to_string())?;
        let keys = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                    row.get::<_, Vec<u8>>(4)?,
                    row.get::<_, Vec<u8>>(5)?,
                    row.get::<_, i32>(6)?,
                    row.get::<_, String>(7)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(keys)
    }

    pub fn list_all_server_members_admin(
        &self,
    ) -> Result<Vec<(String, String, String, String, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT sm.user_id, COALESCE(u.username, '?'), sm.server_id, s.id, COALESCE(sm.role, 'member'), COALESCE(sm.joined_at, '')
                 FROM server_members sm
                 LEFT JOIN users u ON sm.user_id = u.id
                 LEFT JOIN servers s ON sm.server_id = s.id
                 ORDER BY sm.joined_at",
            )
            .map_err(|e| e.to_string())?;
        let members = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(members)
    }



    pub fn list_all_server_bans_admin(
        &self,
    ) -> Result<Vec<(String, String, String, String, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT sb.server_id, s.id, sb.user_id, COALESCE(u.username, '?'), '', sb.banned_at
                 FROM server_bans sb
                 LEFT JOIN servers s ON sb.server_id = s.id
                 LEFT JOIN users u ON sb.user_id = u.id
                 ORDER BY sb.banned_at",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn list_all_dm_channels_admin(&self) -> Result<Vec<(String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, created_at FROM dm_channels ORDER BY created_at")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn list_all_dm_members_admin(
        &self,
    ) -> Result<Vec<(String, String, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT dm.dm_channel_id, dm.user_id, COALESCE(u.username, '?'), COALESCE(dc.created_at, '')
                 FROM dm_members dm
                 LEFT JOIN users u ON dm.user_id = u.id
                 LEFT JOIN dm_channels dc ON dm.dm_channel_id = dc.id
                 ORDER BY dc.created_at",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn list_all_dm_messages_admin(
        &self,
    ) -> Result<Vec<(String, String, String, String, Vec<u8>, Vec<u8>, String, Option<i32>, Option<Vec<u8>>, Option<Vec<u8>>, Option<String>)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT m.id, m.dm_channel_id, m.sender_id, COALESCE(u.username, '?'), m.encrypted_content, m.nonce, m.timestamp, m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.sender_id_hash
                 FROM dm_messages m LEFT JOIN users u ON m.sender_id = u.id ORDER BY m.timestamp DESC LIMIT 500",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Vec<u8>>(4)?,
                    row.get::<_, Vec<u8>>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<i32>>(7)?,
                    row.get::<_, Option<Vec<u8>>>(8)?,
                    row.get::<_, Option<Vec<u8>>>(9)?,
                    row.get::<_, Option<String>>(10)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn list_all_dm_keys_admin(
        &self,
    ) -> Result<Vec<(String, String, String, Vec<u8>, Vec<u8>, Vec<u8>, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let sql = "SELECT dk.dm_channel_id, dk.user_id, COALESCE(u.username, '?'), dk.encrypted_key, dk.sender_public_key, dk.nonce, dk.created_at
                 FROM dm_keys dk LEFT JOIN users u ON dk.user_id = u.id ORDER BY dk.id";
        let Some(mut stmt) = Self::prepare_optional(&conn, sql)? else {
            return Ok(Vec::new());
        };
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                    row.get::<_, Vec<u8>>(4)?,
                    row.get::<_, Vec<u8>>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn list_all_friend_requests_admin(
        &self,
    ) -> Result<Vec<(String, String, String, String, String, String, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT fr.id, fr.from_user_id, COALESCE(u1.username, '?'), fr.to_user_id, COALESCE(u2.username, '?'), fr.status, fr.created_at, COALESCE(fr.responded_at, '')
                 FROM friend_requests fr
                 LEFT JOIN users u1 ON fr.from_user_id = u1.id
                 LEFT JOIN users u2 ON fr.to_user_id = u2.id
                 ORDER BY fr.created_at",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn list_all_friendships_admin(
        &self,
    ) -> Result<Vec<(String, String, String, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT f.user_id_a, COALESCE(u1.username, '?'), f.user_id_b, COALESCE(u2.username, '?'), f.created_at
                 FROM friendships f
                 LEFT JOIN users u1 ON f.user_id_a = u1.id
                 LEFT JOIN users u2 ON f.user_id_b = u2.id
                 ORDER BY f.created_at",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }


    pub fn list_all_files_admin(
        &self,
    ) -> Result<Vec<(String, String, String, String, String, i64, Option<String>, String, i64, i32, Option<Vec<u8>>, Option<Vec<u8>>)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT f.id, f.uploader_id, COALESCE(u.username, '?'), f.id, '', f.original_size, f.file_id_hash, f.created_at, COALESCE(f.chunk_count, 0), COALESCE(f.upload_complete, 0), f.encrypted_mime_type, f.mime_nonce
                 FROM files f LEFT JOIN users u ON f.uploader_id = u.id ORDER BY f.created_at",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, i32>(9)?,
                    row.get::<_, Option<Vec<u8>>>(10)?,
                    row.get::<_, Option<Vec<u8>>>(11)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn get_user_cascade_stats(&self, user_id: &str) -> Result<serde_json::Value, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let msg_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE sender_id = ?1",
                params![user_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        let member_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM server_members WHERE user_id = ?1",
                params![user_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        let key_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM server_keys WHERE user_id = ?1",
                params![user_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        let owned_servers: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT id FROM servers WHERE owner_id = ?1")
                .map_err(|e| e.to_string())?;
            let rows: Vec<String> = stmt
                .query_map(params![user_id], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            rows
        };

        Ok(serde_json::json!({
            "messages": msg_count,
            "memberships": member_count,
            "server_keys": key_count,
            "owned_servers": owned_servers.len(),
            "owned_server_ids": owned_servers,
        }))
    }

    pub fn delete_server_admin(&self, server_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM server_keys WHERE server_id = ?1", params![server_id])
            .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE server_id = ?1)",
            params![server_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM channels WHERE server_id = ?1", params![server_id])
            .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM server_members WHERE server_id = ?1",
            params![server_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM servers WHERE id = ?1", params![server_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_channel_admin(&self, channel_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM messages WHERE channel_id = ?1",
            params![channel_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM channels WHERE id = ?1", params![channel_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Deletes every trace of the user and returns the list of their file ids
    /// so the caller can remove the on-disk chunk dirs (uploads/{file_id}).
    pub fn delete_user(&self, user_id: &str) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        // 0. Collect the user's file ids BEFORE deleting the rows so the caller
        //    can clean up the on-disk chunks (uploads/{file_id}/).
        let user_file_ids: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT id FROM files WHERE uploader_id = ?1")
                .map_err(|e| e.to_string())?;
            let rows: Vec<String> = stmt
                .query_map(params![user_id], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            rows
        };

        // 1. Delete messages sent by user (messages.sender_id -> users(id) has NO CASCADE)
        conn.execute("DELETE FROM messages WHERE sender_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;

        // 2. Fully delete each server owned by user (cascades channels, members, keys, messages)
        let owned_server_ids: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT id FROM servers WHERE owner_id = ?1")
                .map_err(|e| e.to_string())?;
            let rows: Vec<String> = stmt
                .query_map(params![user_id], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            rows
        };
        for sid in &owned_server_ids {
            conn.execute("DELETE FROM server_keys WHERE server_id = ?1", params![sid])
                .map_err(|e| e.to_string())?;
            conn.execute(
                "DELETE FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE server_id = ?1)",
                params![sid],
            )
            .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM server_members WHERE server_id = ?1", params![sid])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM channels WHERE server_id = ?1", params![sid])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM server_bans WHERE server_id = ?1", params![sid])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM servers WHERE id = ?1", params![sid])
                .map_err(|e| e.to_string())?;
        }

        // 3. Clean up remaining memberships and keys in other servers
        conn.execute("DELETE FROM server_keys WHERE user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM server_members WHERE user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;
        // Legacy delete removed

        // 4a. Clean up DM channels where user is a member (removes dm_messages, dm_keys, dm_members via CASCADE)
        let dm_channel_ids: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT dm_channel_id FROM dm_members WHERE user_id = ?1")
                .map_err(|e| e.to_string())?;
            let rows: Vec<String> = stmt
                .query_map(params![user_id], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            rows
        };
        for dm_id in &dm_channel_ids {
            conn.execute("DELETE FROM dm_messages WHERE dm_channel_id = ?1", params![dm_id])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM dm_members WHERE dm_channel_id = ?1", params![dm_id])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM dm_channels WHERE id = ?1", params![dm_id])
                .map_err(|e| e.to_string())?;
        }

        // 4b. Clean up DM + friend data. dm_messages/dm_members cascade on user delete,
        //     but friendships + friend_requests are bidirectional so handle both directions.
        conn.execute(
            "DELETE FROM friendships WHERE user_id_a = ?1 OR user_id_b = ?1",
            params![user_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM friend_requests WHERE from_user_id = ?1 OR to_user_id = ?1",
            params![user_id],
        )
        .map_err(|e| e.to_string())?;

        // 4c. Clean up files owned by user (files.uploader_id has no ON DELETE CASCADE)
        conn.execute("DELETE FROM files WHERE uploader_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;

        // 4c5. Clean up encrypted file vault (ON DELETE CASCADE exists but be explicit)
        conn.execute("DELETE FROM user_vault_files WHERE user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;

        // 4c2. Clean up the user's reactions on other people's messages
        //      (message rows cascade their own reactions via message_id FK).
        conn.execute("DELETE FROM message_reactions WHERE reactor_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM dm_message_reactions WHERE reactor_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;

        // 4c3. Clean up the user's poll votes on other people's polls
        //      (poll rows cascade their own votes via message_id FK).
        conn.execute("DELETE FROM message_poll_votes WHERE voter_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM dm_message_poll_votes WHERE voter_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;

        // 4c4. Clean up the user's delivery/read acks on other people's messages
        //      (message rows cascade their own acks via message_id FK).
        conn.execute("DELETE FROM message_acks WHERE acker_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM dm_message_acks WHERE acker_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;

        // 4f. Clean up server_bans where user is the banned user
        conn.execute("DELETE FROM server_bans WHERE user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;

        // 4g. Clean up conversation_profile_data and user_media for this user
        conn.execute("DELETE FROM conversation_profile_data WHERE user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM user_media WHERE user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM user_stickers WHERE user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;

        // 4h. 2FA, recovery codes, key blobs/escrow, profile-data keys.
        conn.execute("DELETE FROM totp_secrets WHERE user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM recovery_codes WHERE user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM user_key_blobs WHERE user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM user_key_escrow WHERE user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM profile_data_keys WHERE user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM shared_profile_data_keys WHERE owner_user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;

        // 4i. Notifications, pending events, pins, sounds.
        conn.execute("DELETE FROM pending_notifications WHERE user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM pending_events WHERE user_id = ?1 OR affected_user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM message_pins WHERE pinned_by = ?1", params![user_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM dm_message_pins WHERE pinned_by = ?1", params![user_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM notification_sounds WHERE user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM ringtones WHERE user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;

        // 4j. Voice + call state.
        conn.execute("DELETE FROM voice_participants WHERE user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM voice_sanctions WHERE user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM dm_call_waiting WHERE waiting_user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;

        // 4k. Active auth sessions — every device is signed out immediately.
        conn.execute("DELETE FROM auth_sessions WHERE user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;

        // 5. Delete the user
        conn.execute("DELETE FROM users WHERE id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;
        Ok(user_file_ids)
    }

    // --- Files (Phase 5) ---

    pub fn create_file_record(&self, uploader_id: &str, original_size: i64, encrypted_mime: Option<&[u8]>, mime_nonce: Option<&[u8]>) -> Result<(String, String), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // B3: never store the plaintext random UUID. The id IS the SHA-256 blind
        // index of a one-time random UUID, so a file reference (message file_id,
        // profile pic id, by-hash URL) can't be correlated back to the raw
        // identity namespace. file_id_hash stays sha256(id) for the by-hash
        // lookup path used by messages/profile pics (the client already serves
        // 64-hex ids via /api/files/by-hash/).
        let raw_uuid = Uuid::new_v4().to_string();
        let id = sha256_hex(&raw_uuid);
        let hash = sha256_hex(&id);
        // Store only the encrypted MIME type (migration 038). The plaintext mime_type
        // column was dropped in migration 047 — the client receives the file's mime inside
        // the E2E-encrypted message payload (never from this table), and download_file
        // serves application/octet-stream regardless.
        conn.execute(
            "INSERT INTO files (id, uploader_id, original_size, file_id_hash, encrypted_mime_type, mime_nonce) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, uploader_id, original_size, hash, encrypted_mime, mime_nonce],
        )
        .map_err(|e| e.to_string())?;
        Ok((id, hash))
    }

    pub fn delete_file_record(&self, file_id: &str) -> Result<FileRecord, String> {
        // Returns the deleted file info so caller can clean up chunks
        let info = self.get_file_info(file_id)?;
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM files WHERE id = ?1", params![file_id])
            .map_err(|e| e.to_string())?;
        Ok(info)
    }

    pub fn update_file_chunks(&self, file_id: &str, chunk_count: i32) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE files SET chunk_count = MAX(chunk_count, ?1) WHERE id = ?2",
            params![chunk_count, file_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn mark_file_complete(&self, file_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE files SET upload_complete = 1 WHERE id = ?1",
            params![file_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// H1: atomically add `delta` (new chunk size minus the overwritten chunk's
    /// old size) to the file's cumulative chunk_bytes, but only while the file
    /// is still in progress AND the running total stays at or below `allowed`.
    /// Returns Ok(false) when the charge would exceed the cap (caller rejects
    /// the chunk before writing it).
    pub fn charge_file_chunk(&self, file_id: &str, delta: i64, allowed: i64) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let affected = conn
            .execute(
                "UPDATE files SET chunk_bytes = chunk_bytes + ?1 \
                 WHERE id = ?2 AND upload_complete = 0 AND chunk_bytes + ?1 <= ?3",
                params![delta, file_id, allowed],
            )
            .map_err(|e| e.to_string())?;
        Ok(affected > 0)
    }

    /// H1: current cumulative chunk bytes written for a file (0 if none).
    pub fn get_file_chunk_bytes(&self, file_id: &str) -> Result<i64, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT COALESCE(chunk_bytes, 0) FROM files WHERE id = ?1",
            params![file_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())
    }

    /// H3: replace the stored password verifier (used by the self-healing
    /// upgrade when a legacy bare client-hash credential verifies successfully).
    pub fn update_password_hash(&self, user_id: &str, new_hash: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE users SET password_hash = ?1 WHERE id = ?2",
            params![new_hash, user_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Given a SHA-256 hash of a file_id, look up the actual file_id from the files table.
    pub fn get_file_id_by_hash_from_files(&self, hash: &str) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT id FROM files WHERE file_id_hash = ?1 OR id = ?1 LIMIT 1",
            params![hash],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| "File not found by hash".to_string())
    }

    /// Given a SHA-256 hash of a file_id, look up the actual file_id from the users table.
    /// Searches both profile_picture_file_id_hash and profile_banner_file_id_hash columns.
    /// B3: since new file ids ARE the blind SHA-256 index (id = sha256(random uuid),
    /// file_id_hash = sha256(id)), match the stored id directly as well — the client
    /// passes the file id itself to /api/files/by-hash/.
    pub fn get_file_id_by_hash(&self, hash: &str) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // Try profile picture hash first
        let result: Result<String, String> = conn
            .query_row(
                "SELECT profile_picture_file_id FROM users WHERE (profile_picture_file_id_hash = ?1 OR profile_picture_file_id = ?1) AND profile_picture_file_id IS NOT NULL LIMIT 1",
                params![hash],
                |row| row.get::<_, String>(0),
            )
            .map_err(|_| "File not found by hash".to_string());
        match result {
            Ok(fid) => Ok(fid),
            Err(_) => {
                // Try banner hash
                conn.query_row(
                    "SELECT profile_banner_file_id FROM users WHERE (profile_banner_file_id_hash = ?1 OR profile_banner_file_id = ?1) AND profile_banner_file_id IS NOT NULL LIMIT 1",
                    params![hash],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|_| "File not found by hash".to_string())
            }
        }
    }

    pub fn get_file_info(&self, file_id: &str) -> Result<FileRecord, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // Check if encrypted_mime_type column exists (migration 038)
        let has_enc_mime_col: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('files') WHERE name = 'encrypted_mime_type'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);
        if has_enc_mime_col {
            conn.query_row(
                "SELECT id, uploader_id, original_size, '', chunk_count, upload_complete, created_at, encrypted_mime_type, mime_nonce
                 FROM files WHERE id = ?1",
                params![file_id],
                |row| {
                    Ok(FileRecord {
                        id: row.get(0)?,
                        uploader_id: row.get(1)?,
                        original_size: row.get(2)?,
                        mime_type: row.get(3)?,
                        chunk_count: row.get(4)?,
                        upload_complete: row.get::<_, i32>(5)? != 0,
                        created_at: row.get(6)?,
                        encrypted_mime_type: row.get(7)?,
                        mime_nonce: row.get(8)?,
                    })
                },
            )
            .map_err(|e| e.to_string())
        } else {
            conn.query_row(
                "SELECT id, uploader_id, original_size, '', chunk_count, upload_complete, created_at
                 FROM files WHERE id = ?1",
                params![file_id],
                |row| {
                    Ok(FileRecord {
                        id: row.get(0)?,
                        uploader_id: row.get(1)?,
                        original_size: row.get(2)?,
                        mime_type: row.get(3)?,
                        chunk_count: row.get(4)?,
                        upload_complete: row.get::<_, i32>(5)? != 0,
                        created_at: row.get(6)?,
                        encrypted_mime_type: None,
                        mime_nonce: None,
                    })
                },
            )
            .map_err(|e| e.to_string())
        }
    }

    // --- Admin: missing tables ---

    pub fn list_all_user_stickers_admin(&self) -> Result<Vec<(String, String, String, String, String, Option<Vec<u8>>, Option<Vec<u8>>, String, Option<Vec<u8>>, Option<Vec<u8>>)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT us.id, us.user_id, COALESCE(u.username, '?'), us.file_id, '', us.encrypted_file_key, us.file_key_nonce, COALESCE(us.created_at, ''), us.encrypted_sticker_name, us.sticker_name_nonce
                 FROM user_stickers us LEFT JOIN users u ON us.user_id = u.id ORDER BY us.created_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<Vec<u8>>>(5)?,
                    row.get::<_, Option<Vec<u8>>>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<Vec<u8>>>(8)?,
                    row.get::<_, Option<Vec<u8>>>(9)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn list_all_notification_sounds_admin(&self) -> Result<Vec<(String, String, String, Vec<u8>, Vec<u8>, Vec<u8>, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT ns.user_id, COALESCE(u.username, '?'), ns.file_name, ns.encrypted_sound, ns.nonce, ns.sender_public_key, ns.created_at, COALESCE(ns.updated_at, '')
                 FROM notification_sounds ns LEFT JOIN users u ON ns.user_id = u.id ORDER BY ns.created_at",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                    row.get::<_, Vec<u8>>(4)?,
                    row.get::<_, Vec<u8>>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn list_all_config_admin(&self) -> Result<Vec<(String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // Never expose the password hash in the panel — it is write-only here.
        let mut stmt = conn
            .prepare("SELECT key, value FROM admin_config WHERE key != 'password_hash' ORDER BY key")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }
    // F4 — legacy X3DH admin listers removed with migration 057 (the tables
    // sessions / user_devices / prekey_bundles no longer exist).

    pub fn list_all_user_key_escrow_admin(&self) -> Result<Vec<(String, String, String, String, String, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let sql = "SELECT COALESCE(u.username, e.user_id), e.user_id, COALESCE(e.encrypted_private_key, ''), COALESCE(e.salt, ''),
                    COALESCE(e.nonce, ''), COALESCE(e.created_at, ''), COALESCE(e.updated_at, '')
             FROM user_key_escrow e
             LEFT JOIN users u ON e.user_id = u.id
             ORDER BY e.created_at";
        let Some(mut stmt) = Self::prepare_optional(&conn, sql)? else {
            return Ok(Vec::new());
        };
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
            ))
        }).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn list_all_user_device_escrow_admin(&self) -> Result<Vec<(String, String, String, String, String, String, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let sql = "SELECT COALESCE(u.username, e.user_id), e.user_id, COALESCE(e.device_id, ''), COALESCE(e.encrypted_private_key, ''),
                    COALESCE(e.salt, ''), COALESCE(e.nonce, ''), COALESCE(e.created_at, ''), COALESCE(e.updated_at, '')
             FROM user_device_escrow e
             LEFT JOIN users u ON e.user_id = u.id
             ORDER BY e.created_at";
        let Some(mut stmt) = Self::prepare_optional(&conn, sql)? else {
            return Ok(Vec::new());
        };
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
            ))        }).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn list_all_pending_events_admin(&self) -> Result<Vec<(String, String, String, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, user_id, server_id, event_type, affected_user_id FROM pending_events ORDER BY created_at")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?.to_string(),
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn list_all_pending_notifications_admin(&self) -> Result<Vec<(String, String, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, user_id, notification_type, payload FROM pending_notifications ORDER BY created_at")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?.to_string(),
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn list_all_voice_sessions_admin(&self) -> Result<Vec<(String, String, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("SELECT id, channel_id, COALESCE(started_at,''), COALESCE(ended_at,'') FROM voice_sessions ORDER BY started_at DESC").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| Ok((row.get::<_,String>(0)?, row.get::<_,String>(1)?, row.get::<_,String>(2)?, row.get::<_,String>(3)?))).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn list_all_voice_participants_admin(&self) -> Result<Vec<(String, String, String, String, i64, i64, i64, i64)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("SELECT voice_session_id, user_id, COALESCE(joined_at,''), COALESCE(left_at,''), COALESCE(is_muted,0), COALESCE(is_deafened,0), COALESCE(is_camera_on,0), COALESCE(is_screen_sharing,0) FROM voice_participants ORDER BY joined_at DESC").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| Ok((row.get::<_,String>(0)?, row.get::<_,String>(1)?, row.get::<_,String>(2)?, row.get::<_,String>(3)?, row.get::<_,i64>(4)?, row.get::<_,i64>(5)?, row.get::<_,i64>(6)?, row.get::<_,i64>(7)?))).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn list_all_user_media_admin(&self) -> Result<Vec<(String, String, String, Option<Vec<u8>>, Option<Vec<u8>>, Option<Vec<u8>>, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("SELECT um.id, COALESCE(u.username,'?'), um.file_id, um.encrypted_file_key, um.eph_pub, um.nonce, um.media_type, COALESCE(um.created_at,'') FROM user_media um LEFT JOIN users u ON um.user_id = u.id ORDER BY um.created_at DESC").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| Ok((row.get::<_,String>(0)?, row.get::<_,String>(1)?, row.get::<_,String>(2)?, row.get::<_,Option<Vec<u8>>>(3)?, row.get::<_,Option<Vec<u8>>>(4)?, row.get::<_,Option<Vec<u8>>>(5)?, row.get::<_,String>(6)?, row.get::<_,String>(7)?))).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn list_all_user_key_blobs_admin(&self) -> Result<Vec<(String, String, String, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("SELECT COALESCE(u.username,'?'), ukb.user_id, ukb.encrypted_blob, ukb.salt, ukb.nonce FROM user_key_blobs ukb LEFT JOIN users u ON ukb.user_id = u.id ORDER BY ukb.updated_at DESC").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| Ok((row.get::<_,String>(0)?, row.get::<_,String>(1)?, row.get::<_,String>(2)?, row.get::<_,String>(3)?, row.get::<_,String>(4)?))).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn list_all_profile_data_keys_admin(&self) -> Result<Vec<(String, String, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("SELECT COALESCE(u.username,'?'), pdk.user_id, pdk.encrypted_key, pdk.nonce FROM profile_data_keys pdk LEFT JOIN users u ON pdk.user_id = u.id ORDER BY pdk.user_id").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| Ok((row.get::<_,String>(0)?, row.get::<_,String>(1)?, row.get::<_,String>(2)?, row.get::<_,String>(3)?))).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn list_all_shared_profile_data_keys_admin(&self) -> Result<Vec<(String, String, String, String, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("SELECT spdk.id, COALESCE(u.username,'?'), spdk.owner_user_id, spdk.target_type, spdk.target_id, spdk.encrypted_key FROM shared_profile_data_keys spdk LEFT JOIN users u ON spdk.owner_user_id = u.id ORDER BY spdk.created_at DESC").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| Ok((row.get::<_,String>(0)?, row.get::<_,String>(1)?, row.get::<_,String>(2)?, row.get::<_,String>(3)?, row.get::<_,String>(4)?, row.get::<_,String>(5)?))).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// Return all file IDs currently tracked in the database.
    pub fn list_all_file_ids(&self) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id FROM files")
            .map_err(|e| e.to_string())?;
        let ids = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(ids)
    }

    /// Remove orphaned file directories from disk that have no matching DB record.
    /// This is a best-effort cleanup — errors are logged but not propagated.
    /// Check if the database is freshly initialized — no admin password AND no users.
    /// Used by the server to redirect visitors to the admin setup page.
    pub fn is_fresh_db(&self) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // Check if admin password is set
        let admin_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM admin_config WHERE key = 'password_hash'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if admin_count > 0 {
            return Ok(false);
        }
        // Check if any users exist
        let user_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM users",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(user_count == 0)
    }

    pub fn cleanup_orphan_files(&self, upload_dir: &str) {
        let known_ids = match self.list_all_file_ids() {
            Ok(ids) => ids.into_iter().collect::<std::collections::HashSet<_>>(),
            Err(e) => {
                tracing::warn!("orphan cleanup: failed to list file IDs: {}", e);
                return;
            }
        };

        let dir = std::path::Path::new(upload_dir);
        if !dir.exists() {
            return;
        }

        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!("orphan cleanup: failed to read upload dir: {}", e);
                return;
            }
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if let Some(dir_name) = path.file_name().and_then(|n| n.to_str()) {
                if !known_ids.contains(dir_name) {
                    tracing::info!("orphan cleanup: removing orphaned file directory: {}", dir_name);
                    if let Err(e) = std::fs::remove_dir_all(&path) {
                        tracing::warn!("orphan cleanup: failed to remove {}: {}", dir_name, e);
                    }
                }
            }
        }
    }

    pub fn clear_all(&self, upload_dir: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // Delete uploaded files directory first
        if let Ok(entries) = std::fs::read_dir(upload_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let _ = std::fs::remove_dir_all(&path);
                } else {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
        // Wipe EVERY table so "clear all" really clears the whole database,
        // including every table added by later migrations (reactions, read
        // acks, polls, pins, search tokens, ringtones, escrow, sessions, …).
        // The connection is exclusively locked for the duration, so toggling
        // foreign_keys is safe — deleting children before parents is handled
        // implicitly by disabling FK enforcement while wiping.
        conn.execute_batch("PRAGMA foreign_keys = OFF;")
            .map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
            .map_err(|e| e.to_string())?;
        let names: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        for name in names {
            conn.execute(&format!("DELETE FROM \"{}\"", name), [])
                .map_err(|e| e.to_string())?;
        }
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Admin raw-table browser: list every table with its row count.
    pub fn admin_list_tables(&self) -> Result<Vec<(String, i64)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .map_err(|e| e.to_string())?;
        let names: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        let mut out = Vec::new();
        for name in names {
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM \"{}\"", name), [], |r| r.get(0))
                .unwrap_or(0);
            out.push((name, count));
        }
        Ok(out)
    }

    /// Admin raw-table browser: columns + (latest-first, capped) rows for one table.
    pub fn admin_table_rows(&self, table: &str) -> Result<(Vec<String>, Vec<Vec<serde_json::Value>>), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
                params![table],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !exists {
            return Err(format!("Unknown table: {}", table));
        }
        let cols: Vec<String> = {
            let mut stmt = conn
                .prepare(&format!("PRAGMA table_info(\"{}\")", table))
                .map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            let mut q = stmt.query([]).map_err(|e| e.to_string())?;
            while let Some(row) = q.next().map_err(|e| e.to_string())? {
                out.push(row.get::<_, String>(1).map_err(|e| e.to_string())?);
            }
            out
        };
        let sql = format!("SELECT * FROM \"{}\" ORDER BY rowid DESC LIMIT 1000", table);
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut rows = Vec::new();
        let mut q = stmt.query([]).map_err(|e| e.to_string())?;
        while let Some(row) = q.next().map_err(|e| e.to_string())? {
            let mut r = Vec::new();
            for i in 0..cols.len() {
                let v: rusqlite::types::Value = row.get(i).map_err(|e| e.to_string())?;
                let jv = match v {
                    rusqlite::types::Value::Null => serde_json::Value::Null,
                    rusqlite::types::Value::Integer(i) => serde_json::Value::from(i),
                    rusqlite::types::Value::Real(f) => serde_json::Value::from(f),
                    rusqlite::types::Value::Text(t) => serde_json::Value::String(t),
                    rusqlite::types::Value::Blob(b) => serde_json::Value::String(base64::engine::general_purpose::STANDARD.encode(b)),
                };
                r.push(jv);
            }
            rows.push(r);
        }
        Ok((cols, rows))
    }

    // ---- Auth sessions (Settings → Security → Devices) ----

    /// Insert or refresh the session row for a (user, device) pair. A device
    /// that signs in again keeps ONE row (new id, new token) instead of
    /// accumulating stale entries.
    pub fn upsert_auth_session(
        &self,
        id: &str,
        user_id: &str,
        device_id: &str,
        device_name: &str,
        expires_at: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO auth_sessions (id, user_id, device_id, device_name, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, user_id, device_id, device_name, expires_at],
        )
        .map_err(|e| e.to_string())?;
        // Any OLDER session rows on the same device are replaced by this one:
        // delete them (a re-auth on the same browser must not leave a stale
        // "signed in" ghost, nor an extra row for the same device). Deletion
        // also invalidates the old token on the next validation.
        conn.execute(
            "DELETE FROM auth_sessions WHERE user_id = ?1 AND device_id = ?2 AND id != ?3",
            rusqlite::params![user_id, device_id, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn touch_auth_session(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE auth_sessions SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?1",
            rusqlite::params![id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Returns Ok(true) when the session exists and is NOT revoked.
    pub fn auth_session_valid(&self, id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let revoked: i64 = conn
            .query_row(
                "SELECT COALESCE(revoked, 0) FROM auth_sessions WHERE id = ?1",
                rusqlite::params![id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(revoked == 0)
    }

    pub fn list_auth_sessions(
        &self,
        user_id: &str,
    ) -> Result<Vec<(String, String, String, String, String, String, i64)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, device_id, device_name, COALESCE(created_at,''), COALESCE(last_active_at,''), COALESCE(expires_at,''), COALESCE(revoked,0) \
                 FROM auth_sessions WHERE user_id = ?1 ORDER BY last_active_at DESC, created_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![user_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// Revoke a single session. Returns true if a live (non-revoked) row was
    /// actually revoked (false = already revoked or nonexistent).
    pub fn revoke_auth_session(&self, id: &str, user_id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let n = conn
            .execute(
                "UPDATE auth_sessions SET revoked = 1, revoked_at = CURRENT_TIMESTAMP WHERE id = ?1 AND user_id = ?2 AND revoked = 0",
                rusqlite::params![id, user_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(n > 0)
    }

    /// Revoke every session of a user EXCEPT the one with `keep_id` (used by
    /// the "log out all other devices" button).
    pub fn revoke_auth_sessions_except(&self, user_id: &str, keep_id: &str) -> Result<usize, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let n = conn
            .execute(
                "UPDATE auth_sessions SET revoked = 1, revoked_at = CURRENT_TIMESTAMP WHERE user_id = ?1 AND id != ?2 AND revoked = 0",
                rusqlite::params![user_id, keep_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(n)
    }

    /// Fetch the device_id bound to a session (used to target the live WS
    /// connection of the device being kicked).
    pub fn get_auth_session_device(&self, id: &str) -> Result<Option<(String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT user_id, device_id FROM auth_sessions WHERE id = ?1")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query_map(rusqlite::params![id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        rows.next().transpose().map_err(|e| e.to_string())
    }

    // ==================== F3: Threaded Replies ====================

    /// List thread replies for a parent message, ordered by timestamp.
    pub fn list_thread_messages(&self, parent_id: &str, limit: i64) -> Result<Vec<Message>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, channel_id, sender_id, encrypted_content, nonce, timestamp, edited_at, key_version, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_sender_username, sender_username_nonce, sender_id_hash, file_id, thread_parent_id FROM messages WHERE thread_parent_id = ?1 ORDER BY timestamp ASC LIMIT ?2",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![parent_id, limit], |row| {
                Ok(Message {
                    id: row.get(0)?,
                    channel_id: row.get(1)?,
                    sender_id: row.get(2)?,
                    encrypted_content: row.get(3)?,
                    nonce: row.get(4)?,
                    timestamp: row.get(5)?,
                    edited_at: row.get(6)?,
                    key_version: row.get(7)?,
                    encrypted_profile_snapshot: row.get(8)?,
                    profile_snapshot_nonce: row.get(9)?,
                    encrypted_sender_username: row.get(10)?,
                    sender_username_nonce: row.get(11)?,
                    sender_id_hash: row.get(12).ok().flatten(),
                    file_id: row.get(13).ok().flatten(),
                    thread_parent_id: Some(row.get::<_, String>(14)?),
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// Count thread replies for a set of parent message IDs.
    pub fn get_thread_reply_counts(&self, parent_ids: &[&str]) -> Result<std::collections::HashMap<String, i64>, String> {
        if parent_ids.is_empty() {
            return Ok(std::collections::HashMap::new());
        }
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let placeholders: Vec<String> = parent_ids.iter().enumerate().map(|(i, _)| format!("?{}", i + 1)).collect();
        let sql = format!("SELECT thread_parent_id, COUNT(*) FROM messages WHERE thread_parent_id IN ({}) GROUP BY thread_parent_id", placeholders.join(","));
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let params: Vec<&dyn rusqlite::types::ToSql> = parent_ids.iter().map(|p| p as &dyn rusqlite::types::ToSql).collect();
        let rows = stmt.query_map(params.as_slice(), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        }).map_err(|e| e.to_string())?;
        let mut map = std::collections::HashMap::new();
        for row in rows {
            let (id, count) = row.map_err(|e| e.to_string())?;
            map.insert(id, count);
        }
        Ok(map)
    }

    // ==================== F4: Channel Categories ====================

    /// Create a channel category.
    pub fn create_category(&self, server_id: &str, encrypted_name: Option<&[u8]>, name_nonce: Option<&[u8]>, position: i32) -> Result<ChannelCategory, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO channel_categories (id, server_id, encrypted_name, name_nonce, position) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, server_id, encrypted_name, name_nonce, position],
        ).map_err(|e| e.to_string())?;
        Ok(ChannelCategory {
            id,
            server_id: server_id.to_string(),
            encrypted_name: encrypted_name.map(|v| v.to_vec()),
            name_nonce: name_nonce.map(|v| v.to_vec()),
            position,
        })
    }

    /// List categories for a server.
    pub fn list_categories(&self, server_id: &str) -> Result<Vec<ChannelCategory>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, server_id, encrypted_name, name_nonce, position FROM channel_categories WHERE server_id = ?1 ORDER BY position ASC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![server_id], |row| {
                Ok(ChannelCategory {
                    id: row.get(0)?,
                    server_id: row.get(1)?,
                    encrypted_name: row.get(2)?,
                    name_nonce: row.get(3)?,
                    position: row.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// Delete a channel category and set its channels to uncategorized.
    pub fn delete_category(&self, category_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // Cascade: delete all channels in this category + their messages
        let channel_ids: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT id FROM channels WHERE category_id = ?1")
                .map_err(|e| e.to_string())?;
            let rows = stmt.query_map(rusqlite::params![category_id], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            rows.filter_map(|r| r.ok()).collect()
        };
        for ch_id in &channel_ids {
            conn.execute("DELETE FROM messages WHERE channel_id = ?1", rusqlite::params![ch_id])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM channels WHERE id = ?1", rusqlite::params![ch_id])
                .map_err(|e| e.to_string())?;
        }
        conn.execute(
            "DELETE FROM channel_categories WHERE id = ?1",
            rusqlite::params![category_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Rename a channel category (owner only enforced by caller).
    pub fn update_category_name(&self, category_id: &str, encrypted_name: Option<&[u8]>, name_nonce: Option<&[u8]>) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE channel_categories SET encrypted_name = ?1, name_nonce = ?2 WHERE id = ?3",
            rusqlite::params![encrypted_name, name_nonce, category_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Move a channel to a category (or NULL to uncategory).
    pub fn move_channel_to_category(&self, channel_id: &str, category_id: Option<&str>) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE channels SET category_id = ?1 WHERE id = ?2",
            rusqlite::params![category_id, channel_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Move all channels in a server into a category (used when creating the default category).
    pub fn move_channel_to_category_by_server(&self, server_id: &str, category_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE channels SET category_id = ?1 WHERE server_id = ?2",
            rusqlite::params![category_id, server_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Check if a user is the owner of the server a category belongs to.
    pub fn is_category_owner(&self, user_id: &str, category_id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM channel_categories cc JOIN servers s ON cc.server_id = s.id WHERE cc.id = ?1 AND s.owner_id = ?2",
                rusqlite::params![category_id, user_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(count > 0)
    }

    /// Get category_id for a channel.
    pub fn get_channel_category_id(&self, channel_id: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT category_id FROM channels WHERE id = ?1",
            rusqlite::params![channel_id],
            |row| row.get(0),
        ).map_err(|e| e.to_string())
    }

    /// Get the server_id that owns a category.
    pub fn get_category_server_id(&self, category_id: &str) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT server_id FROM channel_categories WHERE id = ?1",
            rusqlite::params![category_id],
            |row| row.get(0),
        ).map_err(|e| e.to_string())
    }

    /// Bulk-reorder categories for a server. Accepts an ordered list of category IDs;
    /// each ID gets position = its index in the list.
    pub fn reorder_categories(&self, server_id: &str, ordered_ids: &[&str]) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        for (i, cat_id) in ordered_ids.iter().enumerate() {
            conn.execute(
                "UPDATE channel_categories SET position = ?1 WHERE id = ?2 AND server_id = ?3",
                rusqlite::params![i as i32, cat_id, server_id],
            ).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Bulk-reorder channels within a category (or server-wide for uncategorized).
    /// Accepts an ordered list of channel IDs; each gets position = its index.
    pub fn reorder_channels(&self, server_id: &str, ordered_ids: &[&str]) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        for (i, ch_id) in ordered_ids.iter().enumerate() {
            conn.execute(
                "UPDATE channels SET position = ?1 WHERE id = ?2 AND server_id = ?3",
                rusqlite::params![i as i32, ch_id, server_id],
            ).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    // ── F14: User Custom CSS Slots ─────────────────────────────────────────────

    pub fn reorder_dms(&self, user_id: &str, ordered_ids: &[&str]) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        for (i, dm_id) in ordered_ids.iter().enumerate() {
            conn.execute(
                "UPDATE dm_channels SET position = ?1 WHERE id = ?2",
                rusqlite::params![i as i32, dm_id],
            ).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn reorder_servers(&self, user_id: &str, ordered_ids: &[&str]) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        for (i, sv_id) in ordered_ids.iter().enumerate() {
            conn.execute(
                "UPDATE server_members SET position = ?1 WHERE user_id = ?2 AND server_id = ?3",
                rusqlite::params![i as i32, user_id, sv_id],
            ).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn block_user(&self, blocker_id: &str, blocked_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR IGNORE INTO user_blocks (blocker_id, blocked_id) VALUES (?1, ?2)",
            rusqlite::params![blocker_id, blocked_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn unblock_user(&self, blocker_id: &str, blocked_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM user_blocks WHERE blocker_id = ?1 AND blocked_id = ?2",
            rusqlite::params![blocker_id, blocked_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn is_blocked(&self, blocker_id: &str, blocked_id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM user_blocks WHERE blocker_id = ?1 AND blocked_id = ?2",
            rusqlite::params![blocker_id, blocked_id],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        Ok(count > 0)
    }

    pub fn get_blocked_users(&self, user_id: &str) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT blocked_id FROM user_blocks WHERE blocker_id = ?1"
        ).map_err(|e| e.to_string())?;
        let ids = stmt.query_map(rusqlite::params![user_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok()).collect();
        Ok(ids)
    }

    pub fn get_css_slots(&self, user_id: &str) -> Result<(String, String, String, String, i64), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let (s1_css, s1_nonce) = conn
            .query_row(
                "SELECT encrypted_css, nonce FROM user_css_slots WHERE user_id = ?1 AND slot = 1",
                rusqlite::params![user_id],
                |row| Ok((row.get::<_, String>(0).unwrap_or_default(), row.get::<_, String>(1).unwrap_or_default())),
            )
            .unwrap_or_default();
        let (s2_css, s2_nonce) = conn
            .query_row(
                "SELECT encrypted_css, nonce FROM user_css_slots WHERE user_id = ?1 AND slot = 2",
                rusqlite::params![user_id],
                |row| Ok((row.get::<_, String>(0).unwrap_or_default(), row.get::<_, String>(1).unwrap_or_default())),
            )
            .unwrap_or_default();
        let active = conn
            .query_row(
                "SELECT active_slot FROM user_css_prefs WHERE user_id = ?1",
                rusqlite::params![user_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0);
        Ok((s1_css, s1_nonce, s2_css, s2_nonce, active))
    }

    pub fn save_css_slot(&self, user_id: &str, slot: i64, encrypted_css: &str, nonce: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO user_css_slots (user_id, slot, encrypted_css, nonce) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![user_id, slot, encrypted_css, nonce],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_css_slot(&self, user_id: &str, slot: i64) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM user_css_slots WHERE user_id = ?1 AND slot = ?2",
            rusqlite::params![user_id, slot],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_css_active_slot(&self, user_id: &str, active: i64) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO user_css_prefs (user_id, active_slot) VALUES (?1, ?2)",
            rusqlite::params![user_id, active],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    // --- F3-15: Encrypted File Vault ---

    /// Return the on-disk path for a vault file, creating dirs as needed.
    fn vault_file_path(&self, user_id: &str, file_id: &str) -> Result<std::path::PathBuf, String> {
        let dir = std::path::Path::new(&self.upload_dir).join("vault").join(user_id);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(dir.join(format!("{}.enc", file_id)))
    }

    /// Store a file in the user's encrypted vault.
    /// The encrypted blob is written to disk; only metadata lives in SQLite.
    pub fn vault_store_file(
        &self, user_id: &str, file_id: &str, encrypted_data: &[u8],
        encrypted_filename: &str, filename_nonce: &str,
        encrypted_mime: &str, mime_nonce: &str,
        original_size: i64, stored_size: i64,
        enc_file_key: &str, file_key_nonce: &str, content_hash: &str,
        compression: &str,
    ) -> Result<(), String> {
        // Write encrypted blob to disk (no SQLite BLOB size limit).
        let path = self.vault_file_path(user_id, file_id)?;
        std::fs::write(&path, encrypted_data).map_err(|e| e.to_string())?;
        let path_str = path.to_string_lossy().to_string();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO user_vault_files (id, user_id, encrypted_data, encrypted_filename, filename_nonce, encrypted_mime_type, mime_type_nonce, original_size, stored_size, encrypted_file_key, file_key_nonce, content_hash, compression, storage_path) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            rusqlite::params![file_id, user_id, b"", encrypted_filename, filename_nonce, encrypted_mime, mime_nonce, original_size, stored_size, enc_file_key, file_key_nonce, content_hash, compression, path_str],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// List files in the user's vault.
    pub fn vault_list_files(&self, user_id: &str) -> Result<Vec<serde_json::Value>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT id, encrypted_filename, filename_nonce, encrypted_mime_type, mime_type_nonce, original_size, stored_size, encrypted_file_key, file_key_nonce, content_hash, created_at, compression FROM user_vault_files WHERE user_id = ?1 ORDER BY created_at DESC"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(rusqlite::params![user_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "encrypted_filename": row.get::<_, String>(1)?,
                "filename_nonce": row.get::<_, String>(2)?,
                "encrypted_mime_type": row.get::<_, String>(3)?,
                "mime_type_nonce": row.get::<_, String>(4)?,
                "original_size": row.get::<_, i64>(5)?,
                "stored_size": row.get::<_, i64>(6)?,
                "encrypted_file_key": row.get::<_, String>(7)?,
                "file_key_nonce": row.get::<_, String>(8)?,
                "content_hash": row.get::<_, String>(9)?,
                "created_at": row.get::<_, String>(10)?,
                "compression": row.get::<_, String>(11).unwrap_or_else(|_| "none".to_string()),
            }))
        }).map_err(|e| e.to_string())?;
        let mut result = Vec::new();
        for row in rows { result.push(row.map_err(|e| e.to_string())?); }
        Ok(result)
    }

    /// Download a vault file (encrypted data blob).
    /// Reads from disk (new storage_path path) or falls back to the legacy
    /// encrypted_data BLOB column for files uploaded before the disk migration.
    pub fn vault_get_file(&self, user_id: &str, file_id: &str) -> Result<Option<(Vec<u8>, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT encrypted_data, encrypted_mime_type, mime_type_nonce, storage_path FROM user_vault_files WHERE user_id = ?1 AND id = ?2"
        ).map_err(|e| e.to_string())?;
        let mut rows = stmt.query_map(rusqlite::params![user_id, file_id], |row| {
            Ok((
                row.get::<_, Vec<u8>>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        }).map_err(|e| e.to_string())?;
        match rows.next() {
            Some(r) => {
                let (blob, mime, nonce, disk_path) = r.map_err(|e| e.to_string())?;
                let data = if let Some(ref p) = disk_path {
                    // New path: read from disk
                    std::fs::read(p).map_err(|e| format!("{} (path={})", e, p))?
                } else {
                    // Legacy: data still in the BLOB column
                    blob
                };
                Ok(Some((data, mime, nonce)))
            }
            None => Ok(None),
        }
    }

    /// Delete a vault file (disk blob + DB row).
    pub fn vault_delete_file(&self, user_id: &str, file_id: &str) -> Result<(), String> {
        // Remove disk file first (best-effort).
        if let Ok(path) = self.vault_file_path(user_id, file_id) {
            let _ = std::fs::remove_file(&path);
        }
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM user_vault_files WHERE user_id = ?1 AND id = ?2",
            rusqlite::params![user_id, file_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Get total stored size for a user's vault.
    pub fn vault_total_size(&self, user_id: &str) -> Result<i64, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let result: i64 = conn.query_row(
            "SELECT COALESCE(SUM(stored_size), 0) FROM user_vault_files WHERE user_id = ?1",
            rusqlite::params![user_id],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        Ok(result)
    }

    /// Delete all vault files for a user (account deletion).
    pub fn vault_delete_all_for_user(&self, user_id: &str) -> Result<(), String> {
        // Collect disk paths before deleting rows.
        let paths: Vec<String> = {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            let mut stmt = conn.prepare(
                "SELECT storage_path FROM user_vault_files WHERE user_id = ?1 AND storage_path IS NOT NULL"
            ).map_err(|e| e.to_string())?;
            let rows: Vec<String> = stmt.query_map(rusqlite::params![user_id], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            rows
        };
        for p in &paths {
            let _ = std::fs::remove_file(p);
        }
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM user_vault_files WHERE user_id = ?1",
            rusqlite::params![user_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }


    // --- F3-14: Self-Destructing Accounts (per-user setting) ---

    /// Update the last_active_at timestamp for a user.
    pub fn touch_last_active(&self, user_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE users SET last_active_at = datetime('now') WHERE id = ?1",
            rusqlite::params![user_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Get users with self-destruct enabled who have been inactive past their threshold.
    pub fn get_inactive_users_for_deletion(&self) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT id FROM users WHERE self_destruct_days > 0 AND last_active_at IS NOT NULL AND last_active_at < datetime('now', '-' || self_destruct_days || ' days')"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            row.get::<_, String>(0)
        }).map_err(|e| e.to_string())?;
        let mut result = Vec::new();
        for row in rows { result.push(row.map_err(|e| e.to_string())?); }
        Ok(result)
    }

    /// Get the self-destruct setting for a user.
    pub fn get_self_destruct_days(&self, user_id: &str) -> Result<i64, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let result: i64 = conn.query_row(
            "SELECT COALESCE(self_destruct_days, 0) FROM users WHERE id = ?1",
            rusqlite::params![user_id],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        Ok(result)
    }

    /// Set the self-destruct setting for a user.
    pub fn set_self_destruct_days(&self, user_id: &str, days: i64) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE users SET self_destruct_days = ?1 WHERE id = ?2",
            rusqlite::params![days, user_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Delete a user and all related data (reuses the full delete_user cleanup).
    /// Returns file IDs for the caller to clean up on-disk chunks.
    pub fn self_destruct_user(&self, user_id: &str) -> Result<Vec<String>, String> {
        self.delete_user(user_id)
    }

    // -- Soundboard --
    pub fn save_soundboard_clip(&self, id: &str, user_id: &str, server_id: &str, name: &str, encrypted_audio: &[u8], audio_nonce: &[u8], duration_ms: i64) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO soundboard_clips (id, user_id, server_id, name, encrypted_audio, audio_nonce, duration_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![id, user_id, server_id, name, encrypted_audio, audio_nonce, duration_ms],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// List all soundboard clips for a user (across all servers).
    pub fn list_soundboard_clips_for_user(&self, user_id: &str) -> Result<Vec<(String, String, String, Vec<u8>, Vec<u8>, i64)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT id, user_id, name, encrypted_audio, audio_nonce, duration_ms FROM soundboard_clips WHERE user_id = ?1 ORDER BY created_at DESC"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(rusqlite::params![user_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, Vec<u8>>(3)?, row.get::<_, Vec<u8>>(4)?, row.get::<_, i64>(5)?))
        }).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows { out.push(r.map_err(|e| e.to_string())?); }
        Ok(out)
    }

    pub fn list_soundboard_clips(&self, _user_id: &str, server_id: &str) -> Result<Vec<(String, String, String, Vec<u8>, Vec<u8>, i64)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT id, user_id, name, encrypted_audio, audio_nonce, duration_ms FROM soundboard_clips WHERE server_id = ?1 ORDER BY created_at DESC"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(rusqlite::params![server_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, Vec<u8>>(3)?, row.get::<_, Vec<u8>>(4)?, row.get::<_, i64>(5)?))
        }).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows { out.push(r.map_err(|e| e.to_string())?); }
        Ok(out)
    }

    pub fn delete_soundboard_clip(&self, clip_id: &str, user_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM soundboard_clips WHERE id = ?1 AND user_id = ?2",
            rusqlite::params![clip_id, user_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn mute_soundboard_user(&self, server_id: &str, user_id: &str, muted_by: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR IGNORE INTO soundboard_mutes (server_id, user_id, muted_by) VALUES (?1, ?2, ?3)",
            rusqlite::params![server_id, user_id, muted_by],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn unmute_soundboard_user(&self, server_id: &str, user_id: &str, muted_by: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM soundboard_mutes WHERE server_id = ?1 AND user_id = ?2 AND muted_by = ?3",
            rusqlite::params![server_id, user_id, muted_by],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn is_soundboard_muted(&self, server_id: &str, user_id: &str, muted_by: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM soundboard_mutes WHERE server_id = ?1 AND user_id = ?2 AND muted_by = ?3",
            rusqlite::params![server_id, user_id, muted_by],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        Ok(count > 0)
    }

    pub fn get_muted_soundboard_users(&self, server_id: &str, muted_by: &str) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT user_id FROM soundboard_mutes WHERE server_id = ?1 AND muted_by = ?2"
        ).map_err(|e| e.to_string())?;
        let ids = stmt.query_map(rusqlite::params![server_id, muted_by], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        Ok(ids.filter_map(|r| r.ok()).collect())
    }

    // -- Soundboard global mute (owner kill-switch) --
    pub fn set_soundboard_global_mute(&self, server_id: &str, muted: bool) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE servers SET soundboard_global_mute = ?1 WHERE id = ?2",
            rusqlite::params![if muted { 1 } else { 0 }, server_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn is_soundboard_global_muted(&self, server_id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let val: i64 = conn.query_row(
            "SELECT COALESCE(soundboard_global_mute, 0) FROM servers WHERE id = ?1",
            rusqlite::params![server_id],
            |row| row.get(0),
        ).unwrap_or(0);
        Ok(val != 0)
    }

    // -- Per-user soundboard disable (owner can disable one user's soundboard for everyone) --
    pub fn disable_soundboard_user(&self, server_id: &str, user_id: &str, disabled_by: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR IGNORE INTO soundboard_user_disabled (server_id, user_id, disabled_by) VALUES (?1, ?2, ?3)",
            rusqlite::params![server_id, user_id, disabled_by],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn enable_soundboard_user(&self, server_id: &str, user_id: &str, disabled_by: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM soundboard_user_disabled WHERE server_id = ?1 AND user_id = ?2 AND disabled_by = ?3",
            rusqlite::params![server_id, user_id, disabled_by],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn is_soundboard_user_disabled(&self, server_id: &str, user_id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM soundboard_user_disabled WHERE server_id = ?1 AND user_id = ?2",
            rusqlite::params![server_id, user_id],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        Ok(count > 0)
    }

    pub fn get_disabled_soundboard_users(&self, server_id: &str) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT user_id FROM soundboard_user_disabled WHERE server_id = ?1"
        ).map_err(|e| e.to_string())?;
        let ids = stmt.query_map(rusqlite::params![server_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        Ok(ids.filter_map(|r| r.ok()).collect())
    }

    // -- Device Pairing (QR-code second-device login) --
    pub fn create_pairing_ticket(&self, id: &str, user_id: &str, public_key: &[u8], encrypted_key_blob: &[u8], key_blob_nonce: &[u8], expires_at: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO device_pairing_tickets (id, user_id, public_key, encrypted_key_blob, key_blob_nonce, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![id, user_id, public_key, encrypted_key_blob, key_blob_nonce, expires_at],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_pairing_ticket(&self, ticket_id: &str) -> Result<Option<(String, Vec<u8>, Vec<u8>, Vec<u8>, String, Option<String>)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let result = conn.query_row(
            "SELECT user_id, public_key, encrypted_key_blob, key_blob_nonce, expires_at, claimed_by FROM device_pairing_tickets WHERE id = ?1",
            rusqlite::params![ticket_id],
            |row| Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, Vec<u8>>(2)?,
                row.get::<_, Vec<u8>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
            )),
        );
        match result {
            Ok(r) => Ok(Some(r)),
            Err(_) => Ok(None),
        }
    }

    pub fn claim_pairing_ticket(&self, ticket_id: &str, claimed_by: &str) -> Result<Option<String>, String> {
        let ticket = self.get_pairing_ticket(ticket_id)?;
        let ticket = match ticket {
            Some(t) => t,
            None => return Ok(None),
        };
        if ticket.4 <= chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.6fZ").to_string() {
            return Ok(None);
        }
        if ticket.5.is_some() {
            return Ok(None);
        }
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE device_pairing_tickets SET claimed_by = ?2 WHERE id = ?1",
            rusqlite::params![ticket_id, claimed_by],
        ).map_err(|e| e.to_string())?;
        Ok(Some(ticket.0))
    }

    pub fn delete_expired_pairing_tickets(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let _ = conn.execute(
            "DELETE FROM device_pairing_tickets WHERE expires_at < datetime('now')",
            [],
        );
        Ok(())
    }

    // ─── Server groups (folders) ──────────────────────────────────────

    pub fn list_server_groups(&self, user_id: &str) -> Result<Vec<(String, String, i32, bool, Option<String>, Option<String>)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, name, position, collapsed, parent_group_id, color FROM server_groups WHERE user_id = ?1 ORDER BY position")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![user_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i32>(2)?,
                    row.get::<_, bool>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut result = Vec::new();
        for r in rows { result.push(r.map_err(|e| e.to_string())?); }
        Ok(result)
    }

    pub fn create_server_group(&self, user_id: &str, group_id: &str, name: &str, position: i32) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO server_groups (id, user_id, name, position) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![group_id, user_id, name, position],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn rename_server_group(&self, user_id: &str, group_id: &str, name: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE server_groups SET name = ?3 WHERE id = ?1 AND user_id = ?2",
            rusqlite::params![group_id, user_id, name],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn update_group_color(&self, user_id: &str, group_id: &str, color: Option<&str>) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE server_groups SET color = ?3 WHERE id = ?1 AND user_id = ?2",
            rusqlite::params![group_id, user_id, color],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Merge source_group into target_group: move all servers, then delete source.
    pub fn merge_groups(&self, user_id: &str, source_id: &str, target_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // Move all servers from source to target
        conn.execute(
            "UPDATE servers SET group_id = ?2 WHERE group_id = ?1",
            rusqlite::params![source_id, target_id],
        ).map_err(|e| e.to_string())?;
        // Delete the source group
        conn.execute(
            "DELETE FROM server_groups WHERE id = ?1 AND user_id = ?2",
            rusqlite::params![source_id, user_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_server_group(&self, user_id: &str, group_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // Move servers out of the group before deleting
        conn.execute(
            "UPDATE servers SET group_id = NULL WHERE group_id = ?1",
            rusqlite::params![group_id],
        ).map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM server_groups WHERE id = ?1 AND user_id = ?2",
            rusqlite::params![group_id, user_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn toggle_server_group_collapsed(&self, user_id: &str, group_id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE server_groups SET collapsed = CASE WHEN collapsed = 0 THEN 1 ELSE 0 END WHERE id = ?1 AND user_id = ?2",
            rusqlite::params![group_id, user_id],
        ).map_err(|e| e.to_string())?;
        let val: bool = conn
            .query_row("SELECT collapsed FROM server_groups WHERE id = ?1", rusqlite::params![group_id], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        Ok(val)
    }

    pub fn move_server_to_group(&self, user_id: &str, server_id: &str, group_id: Option<&str>) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE servers SET group_id = ?2 WHERE id = ?1",
            rusqlite::params![server_id, group_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn reorder_server_groups(&self, user_id: &str, ordered_ids: &[&str]) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        for (i, gid) in ordered_ids.iter().enumerate() {
            conn.execute(
                "UPDATE server_groups SET position = ?1 WHERE id = ?2 AND user_id = ?3",
                rusqlite::params![i as i32, gid, user_id],
            ).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn move_group_to_group(&self, user_id: &str, group_id: &str, parent_id: Option<&str>) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // Prevent circular nesting (group can't be its own parent or ancestor)
        if let Some(pid) = parent_id {
            if pid == group_id {
                return Err("Cannot nest a group inside itself".into());
            }
            // Check for indirect cycles (parent's parent === group_id)
            let mut check_id = pid.to_string();
            loop {
                let row: Result<Option<String>, _> = conn.query_row(
                    "SELECT parent_group_id FROM server_groups WHERE id = ?1 AND user_id = ?2",
                    rusqlite::params![check_id, user_id],
                    |row| row.get(0),
                );
                match row {
                    Ok(Some(ref next)) if next == group_id => return Err("Circular group nesting detected".into()),
                    Ok(Some(next)) => check_id = next,
                    _ => break,
                }
            }
        }
        conn.execute(
            "UPDATE server_groups SET parent_group_id = ?1 WHERE id = ?2 AND user_id = ?3",
            rusqlite::params![parent_id, group_id, user_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

}
