use rusqlite::{params, Connection};
use sha2::{Sha256, Digest};
use std::sync::Mutex;
use uuid::Uuid;

fn sha256_hex(data: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data.as_bytes());
    let result = hasher.finalize();
    result.iter().map(|b| format!("{:02x}", b)).collect()
}

#[allow(dead_code)]
fn hmac_sha256_hex(key: &[u8], data: &str) -> String {
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

pub struct Database {
    conn: Mutex<Connection>,
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
}

#[derive(Debug, Clone)]
pub struct Message {
    pub id: String,
    pub channel_id: String,
    pub sender_id: String,
    pub sender_username: String,
    pub sender_profile_pic: Option<String>,
    pub encrypted_content: Vec<u8>,
    pub nonce: Vec<u8>,
    pub timestamp: String,
    pub message_nonce: Option<String>,
    pub edited_at: Option<String>,
    pub message_signature: Option<String>,
    pub encrypted_profile_key: Option<String>,
    pub profile_key_nonce: Option<String>,
    pub encrypted_banner_key: Option<String>,
    pub banner_key_nonce: Option<String>,
    // Streamlined E2E fields (migration 022)
    pub key_version: Option<i32>,
    pub encrypted_profile_snapshot: Option<Vec<u8>>,
    pub profile_snapshot_nonce: Option<Vec<u8>>,
    pub encrypted_file_key: Option<Vec<u8>>,
    pub file_key_nonce: Option<Vec<u8>>,
    pub encrypted_sender_username: Option<String>,
    pub sender_username_nonce: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DmMessage {
    pub id: String,
    pub dm_channel_id: String,
    pub sender_id: String,
    pub sender_username: String,
    pub sender_profile_pic: Option<String>,
    pub encrypted_content: Vec<u8>,
    pub nonce: Vec<u8>,
    pub timestamp: String,
    pub message_nonce: Option<String>,
    pub edited_at: Option<String>,
    pub message_signature: Option<String>,
    pub encrypted_profile_key: Option<String>,
    pub profile_key_nonce: Option<String>,
    pub encrypted_banner_key: Option<String>,
    pub banner_key_nonce: Option<String>,
    // Streamlined E2E fields (migration 022)
    pub key_version: Option<i32>,
    pub encrypted_profile_snapshot: Option<Vec<u8>>,
    pub profile_snapshot_nonce: Option<Vec<u8>>,
    pub encrypted_file_key: Option<Vec<u8>>,
    pub file_key_nonce: Option<Vec<u8>>,
    pub encrypted_sender_username: Option<String>,
    pub sender_username_nonce: Option<String>,
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
}

impl Database {
    pub fn new(path: &str) -> Result<Self, rusqlite::Error> {
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;

        let db = Self {
            conn: Mutex::new(conn),
        };
        db.run_migrations()?;
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

        // Migration 010: edit tracking + server stickers
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
        let profile_key_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('users') WHERE name = 'profile_picture_file_key'",
                [],
                |row| row.get(0),
            )?;
        if !profile_key_exists {
            conn.execute("ALTER TABLE users ADD COLUMN profile_picture_file_key TEXT", [])?;
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
            ("profile_banner_file_key", "TEXT"),
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
        for col in ["display_name", "username_color", "username_border_color", "description", "nickname", "profile_background_color"] {
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
                file_name TEXT NOT NULL DEFAULT 'notification.mp3',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );"
        );
        // server_stickers: still referenced by admin and API handlers
        let _ = conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS server_stickers (
                id TEXT PRIMARY KEY,
                server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
                file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
                uploaded_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                sticker_name TEXT NOT NULL,
                file_key TEXT,
                encrypted_file_key BLOB,
                file_key_nonce BLOB,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );"
        );
        // user_stickers: still referenced by API handlers
        let _ = conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS user_stickers (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
                sticker_name TEXT NOT NULL,
                file_key TEXT,
                mime_type TEXT DEFAULT 'image/png',
                encrypted_file_key BLOB,
                file_key_nonce BLOB,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );"
        );

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

    // --- Users ---

    pub fn create_user(&self, username: &str, password_hash: &str, identity_public_key: Option<&[u8]>, friend_code_hash: Option<&str>, encrypted_friend_code: Option<&str>, friend_code_salt: Option<&str>, friend_code_nonce: Option<&str>) -> Result<User, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();

        conn.execute(
            "INSERT INTO users (id, username, password_hash, identity_public_key, friend_code_hash, encrypted_friend_code, friend_code_salt, friend_code_nonce) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, username, password_hash, identity_public_key, friend_code_hash, encrypted_friend_code, friend_code_salt, friend_code_nonce],
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

    pub fn get_user_profile(&self, id: &str) -> Result<(String, String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        // Check which banner columns exist (display_name, username_color, username_border_color dropped)
        let has_banner: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('users') WHERE name = 'profile_banner_file_id'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);
        let has_banner_key: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('users') WHERE name = 'profile_banner_file_key'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);

        let sql = if has_banner && has_banner_key {
            "SELECT id, username, NULL as display_name, profile_picture_file_id, profile_picture_file_key,
                    NULL as color, NULL as border,
                    profile_banner_file_id, profile_banner_file_key
             FROM users WHERE id = ?1"
        } else {
            "SELECT id, username, NULL as display_name, profile_picture_file_id, profile_picture_file_key,
                    NULL as color, NULL as border,
                    NULL as banner_id, NULL as banner_key
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
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<String>>(8)?,
            ))
        })
        .map_err(|_| "User not found".to_string())
    }

    pub fn update_profile_picture(&self, user_id: &str, file_id: Option<&str>, file_key: Option<&str>) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE users SET profile_picture_file_id = ?1, profile_picture_file_key = ?2 WHERE id = ?3",
            params![file_id, file_key, user_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE users SET profile_updated_at = datetime('now') WHERE id = ?1",
            params![user_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn update_profile_banner(&self, user_id: &str, file_id: Option<&str>, file_key: Option<&str>) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE users SET profile_banner_file_id = ?1, profile_banner_file_key = ?2 WHERE id = ?3",
            params![file_id, file_key, user_id],
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

    pub fn upsert_conversation_profile(&self, user_id: &str, conv_type: &str, conv_id: &str, encrypted_data: &str, nonce: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO conversation_profile_data (user_id, conversation_type, conversation_id, encrypted_profile_data, nonce, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))",
            params![user_id, conv_type, conv_id, encrypted_data, nonce],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
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

    // --- Servers ---

    pub fn create_server(&self, owner_id: &str, invite_code_hash: &str, encrypted_name: Option<&[u8]>, name_nonce: Option<&[u8]>) -> Result<Server, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let server_id = Uuid::new_v4().to_string();
        let general_id = Uuid::new_v4().to_string();

        // If the legacy 'name' column still exists (e.g., on older SQLite where DROP COLUMN failed),
        // include a default value to avoid NOT NULL constraint errors.
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
                "INSERT INTO servers (id, owner_id, invite_code_hash, encrypted_name, name_nonce, name) VALUES (?1, ?2, ?3, ?4, ?5, '')",
                params![server_id, owner_id, invite_code_hash, encrypted_name, name_nonce],
            )
            .map_err(|e| e.to_string())?;
        } else {
            conn.execute(
                "INSERT INTO servers (id, owner_id, invite_code_hash, encrypted_name, name_nonce) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![server_id, owner_id, invite_code_hash, encrypted_name, name_nonce],
            )
            .map_err(|e| e.to_string())?;
        }

        conn.execute(
            "INSERT INTO server_members (user_id, server_id, role) VALUES (?1, ?2, 'owner')",
            params![owner_id, server_id],
        )
        .map_err(|e| e.to_string())?;

        conn.execute(
            "INSERT INTO channels (id, server_id, type, position) VALUES (?1, ?2, 'text', 0)",
            params![general_id, server_id],
        )
        .map_err(|e| e.to_string())?;

        Ok(Server {
            id: server_id,
            encrypted_name: encrypted_name.map(|v| v.to_vec()),
            name_nonce: name_nonce.map(|v| v.to_vec()),
            owner_id: owner_id.to_string(),
            invite_code_hash: invite_code_hash.to_string(),
            joins_disabled: false,
            created_at: String::new(),
        })
    }

    pub fn list_user_servers(&self, user_id: &str) -> Result<Vec<Server>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT s.id, s.encrypted_name, s.name_nonce, s.owner_id, COALESCE(s.invite_code_hash, ''), COALESCE(s.joins_disabled, 0)
                 FROM servers s
                 INNER JOIN server_members sm ON s.id = sm.server_id
                 WHERE sm.user_id = ?1
                 ORDER BY s.id",
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

    pub fn join_server_by_invite(&self, code_hash: &str, user_id: &str) -> Result<Server, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;


        let server: Server = conn
            .query_row(
                "SELECT id, encrypted_name, name_nonce, owner_id, COALESCE(invite_code_hash, ''), COALESCE(joins_disabled, 0) FROM servers WHERE invite_code_hash = ?1",
                params![code_hash],
                |row| {
                    Ok(Server {
                        id: row.get(0)?,
                        encrypted_name: row.get(1)?,
                        name_nonce: row.get(2)?,
                        owner_id: row.get(3)?,
                        invite_code_hash: row.get(4)?,
                        joins_disabled: row.get::<_, i64>(5)? != 0,
                        created_at: String::new(),
                    })
                },
            )
            .map_err(|_| "Invalid invite code".to_string())?;

        // Check if joins are disabled
        if server.joins_disabled {
            return Err("This server has disabled invites".to_string());
        }

        // Check if user is banned from this server
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

    pub fn regenerate_invite(&self, server_id: &str, user_id: &str, new_invite_code_hash: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        if !Self::is_server_owner_c(&conn, user_id, server_id).unwrap_or(false) {
            return Err("Only the server owner can regenerate the invite".to_string());
        }

        conn.execute(
            "UPDATE servers SET invite_code_hash = ?1 WHERE id = ?2",
            params![new_invite_code_hash, server_id],
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
            // Owner leaving: delete the entire server and everything in it
            conn.execute("DELETE FROM server_keys WHERE server_id = ?1", params![server_id])
                .map_err(|e| e.to_string())?;
            conn.execute(
                "DELETE FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE server_id = ?1)",
                params![server_id],
            )
            .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM server_members WHERE server_id = ?1", params![server_id])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM channels WHERE server_id = ?1", params![server_id])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM server_bans WHERE server_id = ?1", params![server_id])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM servers WHERE id = ?1", params![server_id])
                .map_err(|e| e.to_string())?;
            return Ok(true); // true = server was deleted
        }

        // Non-owner leaving: delete their messages in the server, then remove membership
        conn.execute(
            "DELETE FROM messages WHERE sender_id = ?1 AND channel_id IN (SELECT id FROM channels WHERE server_id = ?2)",
            params![user_id, server_id],
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
                "SELECT id, server_id, encrypted_name, name_nonce, type, COALESCE(position, 0), COALESCE(created_at, '') FROM channels
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
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(channels)
    }

    pub fn create_channel(&self, server_id: &str, encrypted_name: Option<&[u8]>, name_nonce: Option<&[u8]>) -> Result<Channel, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();

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
                "INSERT INTO channels (id, server_id, encrypted_name, name_nonce, type, position, name) VALUES (?1, ?2, ?3, ?4, 'text', ?5, '')",
                params![id, server_id, encrypted_name, name_nonce, max_pos + 1],
            )
            .map_err(|e| e.to_string())?;
        } else {
            conn.execute(
                "INSERT INTO channels (id, server_id, encrypted_name, name_nonce, type, position) VALUES (?1, ?2, ?3, ?4, 'text', ?5)",
                params![id, server_id, encrypted_name, name_nonce, max_pos + 1],
            )
            .map_err(|e| e.to_string())?;
        }

        Ok(Channel {
            id,
            server_id: server_id.to_string(),
            encrypted_name: encrypted_name.map(|v| v.to_vec()),
            name_nonce: name_nonce.map(|v| v.to_vec()),
            channel_type: "text".to_string(),
            position: 0,
            created_at: String::new(),
        })
    }

    // --- Messages ---

    pub fn list_messages(&self, channel_id: &str, limit: i64) -> Result<Vec<Message>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT m.id, m.channel_id, m.sender_id, u.username, u.profile_picture_file_id,
                        m.encrypted_content, m.nonce, m.timestamp,
                        m.message_nonce, m.edited_at, m.message_signature,
                        m.encrypted_profile_key, m.profile_key_nonce, m.encrypted_banner_key, m.banner_key_nonce,
                        m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.encrypted_file_key, m.file_key_nonce,
                        m.encrypted_sender_username, m.sender_username_nonce
                 FROM (
                     SELECT id, channel_id, sender_id, encrypted_content, nonce, timestamp,
                            message_nonce, edited_at, message_signature,
                            encrypted_profile_key, profile_key_nonce, encrypted_banner_key, banner_key_nonce,
                            key_version, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_file_key, file_key_nonce,
                            encrypted_sender_username, sender_username_nonce
                     FROM messages
                     WHERE channel_id = ?1
                     ORDER BY timestamp DESC
                     LIMIT ?2
                 ) m
                 INNER JOIN users u ON m.sender_id = u.id
                 ORDER BY m.timestamp ASC",
            )
            .map_err(|e| e.to_string())?;
        let messages = stmt
            .query_map(params![channel_id, limit], |row| {
                Ok(Message {
                    id: row.get(0)?,
                    channel_id: row.get(1)?,
                    sender_id: row.get(2)?,
                    sender_username: row.get(3)?,
                    sender_profile_pic: row.get(4)?,
                    encrypted_content: row.get(5)?,
                    nonce: row.get(6)?,
                    timestamp: row.get(7)?,
                    message_nonce: row.get(8)?,
                    edited_at: row.get(9)?,
                    message_signature: row.get(10)?,
                    encrypted_profile_key: row.get(11)?,
                    profile_key_nonce: row.get(12)?,
                    encrypted_banner_key: row.get(13)?,
                    banner_key_nonce: row.get(14)?,
                    key_version: row.get(15)?,
                    encrypted_profile_snapshot: row.get(16)?,
                    profile_snapshot_nonce: row.get(17)?,
                    encrypted_file_key: row.get(18)?,
                    file_key_nonce: row.get(19)?,
                    encrypted_sender_username: row.get(20)?,
                    sender_username_nonce: row.get(21)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(messages)
    }

    /// Return up to `limit` messages centered around the message with ID `around_message_id`.
    /// Half will be before (older than) the target and half after (newer than) the target.
    pub fn list_messages_around(&self, channel_id: &str, around_message_id: &str, limit: i64) -> Result<Vec<Message>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let half = limit / 2;
        let mut stmt = conn
            .prepare(
                "SELECT m.id, m.channel_id, m.sender_id, u.username, u.profile_picture_file_id,
                        m.encrypted_content, m.nonce, m.timestamp,
                        m.message_nonce, m.edited_at, m.message_signature,
                        m.encrypted_profile_key, m.profile_key_nonce, m.encrypted_banner_key, m.banner_key_nonce,
                        m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.encrypted_file_key, m.file_key_nonce,
                        m.encrypted_sender_username, m.sender_username_nonce
                 FROM (
                     SELECT id, channel_id, sender_id, encrypted_content, nonce, timestamp,
                            message_nonce, edited_at, message_signature,
                            encrypted_profile_key, profile_key_nonce, encrypted_banner_key, banner_key_nonce,
                            key_version, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_file_key, file_key_nonce,
                            encrypted_sender_username, sender_username_nonce
                     FROM messages
                     WHERE channel_id = ?1 AND timestamp <= (SELECT COALESCE(timestamp, '') FROM messages WHERE id = ?2)
                     ORDER BY timestamp DESC
                     LIMIT ?3
                     UNION ALL
                     SELECT id, channel_id, sender_id, encrypted_content, nonce, timestamp,
                            message_nonce, edited_at, message_signature,
                            encrypted_profile_key, profile_key_nonce, encrypted_banner_key, banner_key_nonce,
                            key_version, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_file_key, file_key_nonce,
                            encrypted_sender_username, sender_username_nonce
                     FROM messages
                     WHERE channel_id = ?1 AND timestamp > (SELECT COALESCE(timestamp, '') FROM messages WHERE id = ?2)
                     ORDER BY timestamp ASC
                     LIMIT ?3
                 ) m
                 INNER JOIN users u ON m.sender_id = u.id
                 ORDER BY m.timestamp ASC",
            )
            .map_err(|e| e.to_string())?;
        let messages = stmt
            .query_map(params![channel_id, around_message_id, half], |row| {
                Ok(Message {
                    id: row.get(0)?,
                    channel_id: row.get(1)?,
                    sender_id: row.get(2)?,
                    sender_username: row.get(3)?,
                    sender_profile_pic: row.get(4)?,
                    encrypted_content: row.get(5)?,
                    nonce: row.get(6)?,
                    timestamp: row.get(7)?,
                    message_nonce: row.get(8)?,
                    edited_at: row.get(9)?,
                    message_signature: row.get(10)?,
                    encrypted_profile_key: row.get(11)?,
                    profile_key_nonce: row.get(12)?,
                    encrypted_banner_key: row.get(13)?,
                    banner_key_nonce: row.get(14)?,
                    key_version: row.get(15)?,
                    encrypted_profile_snapshot: row.get(16)?,
                    profile_snapshot_nonce: row.get(17)?,
                    encrypted_file_key: row.get(18)?,
                    file_key_nonce: row.get(19)?,
                    encrypted_sender_username: row.get(20)?,
                    sender_username_nonce: row.get(21)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(messages)
    }

    pub fn save_encrypted_message(
        &self,
        channel_id: &str,
        sender_id: &str,
        encrypted_content: &[u8],
        nonce: &[u8],
        message_nonce: Option<&str>,
        message_signature: Option<&str>,
        encrypted_profile_key: Option<&str>,
        profile_key_nonce: Option<&str>,
        encrypted_banner_key: Option<&str>,
        banner_key_nonce: Option<&str>,
        // Streamlined E2E fields
        encrypted_profile_snapshot: Option<&[u8]>,
        profile_snapshot_nonce: Option<&[u8]>,
        encrypted_file_key: Option<&[u8]>,
        file_key_nonce: Option<&[u8]>,
        encrypted_sender_username: Option<&str>,
        sender_username_nonce: Option<&str>,
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

        conn.execute(
            "INSERT INTO messages (id, channel_id, sender_id, encrypted_content, nonce, message_nonce, message_signature, encrypted_profile_key, profile_key_nonce, encrypted_banner_key, banner_key_nonce, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_file_key, file_key_nonce, encrypted_sender_username, sender_username_nonce) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            params![id, channel_id, sender_id, encrypted_content, nonce, message_nonce, message_signature, encrypted_profile_key, profile_key_nonce, encrypted_banner_key, banner_key_nonce, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_file_key, file_key_nonce, encrypted_sender_username, sender_username_nonce],
        )
        .map_err(|e| e.to_string())?;

        Ok(Message {
            id,
            channel_id: channel_id.to_string(),
            sender_id: sender_id.to_string(),
            sender_username: username,
            sender_profile_pic: None,
            encrypted_content: encrypted_content.to_vec(),
            nonce: nonce.to_vec(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            message_nonce: message_nonce.map(|s| s.to_string()),
            edited_at: None,
            message_signature: message_signature.map(|s| s.to_string()),
            encrypted_profile_key: encrypted_profile_key.map(|s| s.to_string()),
            profile_key_nonce: profile_key_nonce.map(|s| s.to_string()),
            encrypted_banner_key: encrypted_banner_key.map(|s| s.to_string()),
            banner_key_nonce: banner_key_nonce.map(|s| s.to_string()),
            key_version: Some(1),
            encrypted_profile_snapshot: encrypted_profile_snapshot.map(|v| v.to_vec()),
            profile_snapshot_nonce: profile_snapshot_nonce.map(|v| v.to_vec()),
            encrypted_file_key: encrypted_file_key.map(|v| v.to_vec()),
            file_key_nonce: file_key_nonce.map(|v| v.to_vec()),
            encrypted_sender_username: encrypted_sender_username.map(|s| s.to_string()),
            sender_username_nonce: sender_username_nonce.map(|s| s.to_string()),
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

    pub fn get_escrowed_key(&self, user_id: &str) -> Result<Option<(Vec<u8>, Vec<u8>, Vec<u8>)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let result = conn.query_row(
            "SELECT encrypted_private_key, salt, nonce FROM user_key_escrow WHERE user_id = ?1",
            params![user_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        );
        match result {
            Ok(row) => Ok(Some(row)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    // --- Notification Sound Sync ---

    pub fn save_notification_sound(&self, user_id: &str, encrypted_sound: &[u8], nonce: &[u8], sender_public_key: &[u8], file_name: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO notification_sounds (user_id, encrypted_sound, nonce, sender_public_key, file_name, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, CURRENT_TIMESTAMP)
             ON CONFLICT(user_id) DO UPDATE SET
                encrypted_sound = excluded.encrypted_sound,
                nonce = excluded.nonce,
                sender_public_key = excluded.sender_public_key,
                file_name = excluded.file_name,
                updated_at = CURRENT_TIMESTAMP",
            params![user_id, encrypted_sound, nonce, sender_public_key, file_name],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_notification_sound(&self, user_id: &str) -> Result<Option<(Vec<u8>, Vec<u8>, Vec<u8>, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let result = conn.query_row(
            "SELECT encrypted_sound, nonce, sender_public_key, file_name FROM notification_sounds WHERE user_id = ?1",
            params![user_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        );
        match result {
            Ok(row) => Ok(Some(row)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
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
    pub fn update_encrypted_friend_code(&self, user_id: &str, new_code_hash: &str, encrypted_friend_code: &str, salt: &str, nonce: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE users SET friend_code_hash = ?1, encrypted_friend_code = ?2, friend_code_salt = ?3, friend_code_nonce = ?4 WHERE id = ?5",
            params![new_code_hash, encrypted_friend_code, salt, nonce, user_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Update only the friend_code_hash (for server-generated codes without encrypted backup)
    pub fn update_friend_code_hash(&self, user_id: &str, new_code_hash: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE users SET friend_code_hash = ?1 WHERE id = ?2",
            params![new_code_hash, user_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_user_by_friend_code(&self, code_hash: &str) -> Result<User, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        conn.query_row(
            "SELECT id, username FROM users WHERE friend_code_hash = ?1",
            params![code_hash],
            |row| {
                Ok(User {
                    id: row.get(0)?,
                    username: row.get(1)?,
                })
            },
        )
        .map_err(|_| "No user with that friend code".to_string())
    }

    // --- Friendships ---

    pub fn get_friend_requests_disabled(&self, user_id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let disabled: i64 = conn
            .query_row(
                "SELECT COALESCE(friend_requests_disabled, 0) FROM users WHERE id = ?1",
                params![user_id],
                |row| row.get(0),
            )
            .map_err(|_| "User not found".to_string())?;
        Ok(disabled != 0)
    }

    pub fn set_friend_requests_disabled(&self, user_id: &str, disabled: bool) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE users SET friend_requests_disabled = ?1 WHERE id = ?2",
            params![disabled as i64, user_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
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
                "SELECT COUNT(*) FROM dm_channels WHERE id = ?1 AND (user_a = ?2 OR user_b = ?2)",
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
        to_user_code_hash: &str,
    ) -> Result<User, String> {
        if from_user_id.is_empty() {
            return Err("Not authenticated".to_string());
        }
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let target: User = {
            conn
            .query_row(
                "SELECT id, username FROM users WHERE friend_code_hash = ?1",
                params![to_user_code_hash],
                |row| {
                    Ok(User {
                        id: row.get(0)?,
                        username: row.get(1)?,
                    })
                },
            )
            .map_err(|_| "No user with that friend code".to_string())?
        };

        if target.id == from_user_id {
            return Err("You can't add yourself as a friend".to_string());
        }

        // Check if recipient has disabled friend requests
        let recipient_disabled: i64 = conn
            .query_row(
                "SELECT COALESCE(friend_requests_disabled, 0) FROM users WHERE id = ?1",
                params![target.id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if recipient_disabled != 0 {
            return Err("This user is not accepting friend requests".to_string());
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
        conn.execute(
            "INSERT INTO friend_requests (id, from_user_id, to_user_id, status) VALUES (?1, ?2, ?3, 'pending')",
            params![id, from_user_id, target.id],
        )
        .map_err(|e| e.to_string())?;

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
        // Read first for validation + return value.
        let row: (String, String) = conn
            .query_row(
                "SELECT from_user_id, to_user_id FROM friend_requests WHERE id = ?1 AND status = 'pending'",
                params![request_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|_| "Friend request not found".to_string())?;
        if row.1 != accepting_user_id {
            return Err("Only the recipient can accept a friend request".to_string());
        }
        Self::accept_friend_request_c(&conn, request_id, accepting_user_id)
            .map_err(|_| "Friend request not found".to_string())?;
        Ok(row)
    }

    pub fn decline_friend_request(
        &self,
        request_id: &str,
        declining_user_id: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let count = conn.execute(
            "DELETE FROM friend_requests
             WHERE id = ?1 AND to_user_id = ?2 AND status = 'pending'",
            params![request_id, declining_user_id],
        ).map_err(|e| e.to_string())?;
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

        // Also delete any DM channel between these two users
        if let Ok(Some(dm_id)) = Self::find_dm_channel_c(&conn, user_id, other_user_id) {
            conn.execute("DELETE FROM dm_messages WHERE dm_channel_id = ?1", params![dm_id])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM dm_members WHERE dm_channel_id = ?1", params![dm_id])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM dm_channels WHERE id = ?1", params![dm_id])
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
             ORDER BY (SELECT MAX(timestamp) FROM dm_messages WHERE dm_channel_id = dm.id) DESC NULLS LAST",
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
        device_id: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO dm_keys (dm_channel_id, user_id, encrypted_key, sender_public_key, nonce, device_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![dm_channel_id, user_id, encrypted_key, sender_public_key, nonce, device_id.unwrap_or("")],
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
                    m.message_nonce, m.edited_at, m.message_signature,
                    m.encrypted_profile_key, m.profile_key_nonce, m.encrypted_banner_key, m.banner_key_nonce,
                    m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.encrypted_file_key, m.file_key_nonce,
                    m.encrypted_sender_username, m.sender_username_nonce
             FROM (
                  SELECT id, dm_channel_id, sender_id, encrypted_content, nonce, timestamp,
                         message_nonce, edited_at, message_signature,
                         encrypted_profile_key, profile_key_nonce, encrypted_banner_key, banner_key_nonce,
                         key_version, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_file_key, file_key_nonce,
                         encrypted_sender_username, sender_username_nonce
                  FROM dm_messages
                  WHERE dm_channel_id = ?1
                  ORDER BY timestamp DESC
                  LIMIT ?2
              ) m
              INNER JOIN users u ON m.sender_id = u.id
              ORDER BY m.timestamp ASC",
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![dm_channel_id, limit], |row| {
            Ok(DmMessage {
                id: row.get(0)?,
                dm_channel_id: row.get(1)?,
                sender_id: row.get(2)?,
                sender_username: row.get(3)?,
                sender_profile_pic: row.get(4)?,
                encrypted_content: row.get(5)?,
                nonce: row.get(6)?,
                timestamp: row.get(7)?,
                message_nonce: row.get(8)?,
                edited_at: row.get(9)?,
                message_signature: row.get(10)?,
                encrypted_profile_key: row.get(11)?,
                profile_key_nonce: row.get(12)?,
                encrypted_banner_key: row.get(13)?,
                banner_key_nonce: row.get(14)?,
                key_version: row.get(15)?,
                encrypted_profile_snapshot: row.get(16)?,
                profile_snapshot_nonce: row.get(17)?,
                encrypted_file_key: row.get(18)?,
                file_key_nonce: row.get(19)?,
                encrypted_sender_username: row.get(20)?,
                sender_username_nonce: row.get(21)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    pub fn save_dm_message(
        &self,
        dm_channel_id: &str,
        sender_id: &str,
        encrypted_content: &[u8],
        nonce: &[u8],
        message_nonce: Option<&str>,
        message_signature: Option<&str>,
        encrypted_profile_key: Option<&str>,
        profile_key_nonce: Option<&str>,
        encrypted_banner_key: Option<&str>,
        banner_key_nonce: Option<&str>,
        // Streamlined E2E fields
        encrypted_profile_snapshot: Option<&[u8]>,
        profile_snapshot_nonce: Option<&[u8]>,
        encrypted_file_key: Option<&[u8]>,
        file_key_nonce: Option<&[u8]>,
        encrypted_sender_username: Option<&str>,
        sender_username_nonce: Option<&str>,
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
        conn.execute(
            "INSERT INTO dm_messages (id, dm_channel_id, sender_id, encrypted_content, nonce, message_nonce, message_signature, encrypted_profile_key, profile_key_nonce, encrypted_banner_key, banner_key_nonce, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_file_key, file_key_nonce, encrypted_sender_username, sender_username_nonce) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            params![id, dm_channel_id, sender_id, encrypted_content, nonce, message_nonce, message_signature, encrypted_profile_key, profile_key_nonce, encrypted_banner_key, banner_key_nonce, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_file_key, file_key_nonce, encrypted_sender_username, sender_username_nonce],
        )
        .map_err(|e| e.to_string())?;

        Ok(DmMessage {
            id,
            dm_channel_id: dm_channel_id.to_string(),
            sender_id: sender_id.to_string(),
            sender_username: username,
            sender_profile_pic: None,
            encrypted_content: encrypted_content.to_vec(),
            nonce: nonce.to_vec(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            message_nonce: message_nonce.map(|s| s.to_string()),
            edited_at: None,
            message_signature: message_signature.map(|s| s.to_string()),
            encrypted_profile_key: encrypted_profile_key.map(|s| s.to_string()),
            profile_key_nonce: profile_key_nonce.map(|s| s.to_string()),
            encrypted_banner_key: encrypted_banner_key.map(|s| s.to_string()),
            banner_key_nonce: banner_key_nonce.map(|s| s.to_string()),
            key_version: None,
            encrypted_profile_snapshot: encrypted_profile_snapshot.map(|v| v.to_vec()),
            profile_snapshot_nonce: profile_snapshot_nonce.map(|v| v.to_vec()),
            encrypted_file_key: encrypted_file_key.map(|v| v.to_vec()),
            file_key_nonce: file_key_nonce.map(|v| v.to_vec()),
            encrypted_sender_username: encrypted_sender_username.map(|s| s.to_string()),
            sender_username_nonce: sender_username_nonce.map(|s| s.to_string()),
        })
    }

    pub fn edit_encrypted_message(
        &self,
        message_id: &str,
        sender_id: &str,
        new_encrypted_content: &[u8],
        new_nonce: &[u8],
        new_message_nonce: Option<&str>,
        new_message_signature: Option<&str>,
        new_encrypted_profile_key: Option<&str>,
        new_profile_key_nonce: Option<&str>,
        new_encrypted_banner_key: Option<&str>,
        new_banner_key_nonce: Option<&str>,
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
            "UPDATE messages SET encrypted_content = ?1, nonce = ?2, message_nonce = ?3, message_signature = ?5, encrypted_profile_key = ?6, profile_key_nonce = ?7, encrypted_banner_key = ?8, banner_key_nonce = ?9, edited_at = CURRENT_TIMESTAMP WHERE id = ?4",
            params![new_encrypted_content, new_nonce, new_message_nonce, message_id, new_message_signature, new_encrypted_profile_key, new_profile_key_nonce, new_encrypted_banner_key, new_banner_key_nonce],
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
                "SELECT m.id, m.channel_id, m.sender_id, m.encrypted_content, m.nonce, m.timestamp, m.message_nonce, m.edited_at, m.message_signature, m.encrypted_profile_key, m.profile_key_nonce, m.encrypted_banner_key, m.banner_key_nonce, m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.encrypted_file_key, m.file_key_nonce                         FROM messages m WHERE m.id = ?1",
                params![message_id],
                |row| {
                    Ok(Message {
                        id: row.get(0)?,
                        channel_id: row.get(1)?,
                        sender_id: row.get(2)?,
                        sender_username: username.clone(),
            sender_profile_pic: None,
                        encrypted_content: row.get(3)?,
                        nonce: row.get(4)?,
                        timestamp: row.get(5)?,
                        message_nonce: row.get(6)?,
                        edited_at: row.get(7)?,
                        message_signature: row.get(8)?,
                        encrypted_profile_key: row.get(9)?,
                        profile_key_nonce: row.get(10)?,
                        encrypted_banner_key: row.get(11)?,
                        banner_key_nonce: row.get(12)?,
                        key_version: row.get(13)?,
                        encrypted_profile_snapshot: row.get(14)?,
                        profile_snapshot_nonce: row.get(15)?,
                        encrypted_file_key: row.get(16)?,
                        file_key_nonce: None,
                    encrypted_sender_username: None,
                    sender_username_nonce: None,
                    })
                },
            )
            .map_err(|e| e.to_string())?;
        Ok(msg)
    }

    pub fn delete_message(&self, message_id: &str, sender_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let existing_sender: String = conn
            .query_row(
                "SELECT sender_id FROM messages WHERE id = ?1",
                params![message_id],
                |row| row.get(0),
            )
            .map_err(|_| "Message not found".to_string())?;
        if existing_sender != sender_id {
            return Err("Not authorized to delete this message".to_string());
        }
        conn.execute("DELETE FROM messages WHERE id = ?1", params![message_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn edit_dm_message(
        &self,
        message_id: &str,
        sender_id: &str,
        new_encrypted_content: &[u8],
        new_nonce: &[u8],
        new_message_nonce: Option<&str>,
        new_message_signature: Option<&str>,
        new_encrypted_profile_key: Option<&str>,
        new_profile_key_nonce: Option<&str>,
        new_encrypted_banner_key: Option<&str>,
        new_banner_key_nonce: Option<&str>,
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
            "UPDATE dm_messages SET encrypted_content = ?1, nonce = ?2, message_nonce = ?3, message_signature = ?5, encrypted_profile_key = ?6, profile_key_nonce = ?7, encrypted_banner_key = ?8, banner_key_nonce = ?9, edited_at = CURRENT_TIMESTAMP WHERE id = ?4",
            params![new_encrypted_content, new_nonce, new_message_nonce, message_id, new_message_signature, new_encrypted_profile_key, new_profile_key_nonce, new_encrypted_banner_key, new_banner_key_nonce],
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
                "SELECT m.id, m.dm_channel_id, m.sender_id, m.encrypted_content, m.nonce, m.timestamp, m.message_nonce, m.edited_at, m.message_signature, m.encrypted_profile_key, m.profile_key_nonce, m.encrypted_banner_key, m.banner_key_nonce, m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.encrypted_file_key, m.file_key_nonce                         FROM dm_messages m WHERE m.id = ?1",
                params![message_id],
                |row| {
                    Ok(DmMessage {
                        id: row.get(0)?,
                        dm_channel_id: row.get(1)?,
                        sender_id: row.get(2)?,
            sender_profile_pic: None,
                        sender_username: username.clone(),
                        encrypted_content: row.get(3)?,
                        nonce: row.get(4)?,
                        timestamp: row.get(5)?,
                        message_nonce: row.get(6)?,
                        edited_at: row.get(7)?,
                        message_signature: row.get(8)?,
                        encrypted_profile_key: row.get(9)?,
                        profile_key_nonce: row.get(10)?,
                        encrypted_banner_key: row.get(11)?,
                        banner_key_nonce: row.get(12)?,
                        key_version: row.get(13)?,
                        encrypted_profile_snapshot: row.get(14)?,
                        profile_snapshot_nonce: row.get(15)?,
                        encrypted_file_key: row.get(16)?,
                        file_key_nonce: None,
                    encrypted_sender_username: None,
                    sender_username_nonce: None,
                    })
                },
            )
            .map_err(|e| e.to_string())?;
        Ok(msg)
    }

    pub fn delete_dm_message(&self, message_id: &str, sender_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let existing_sender: String = conn
            .query_row(
                "SELECT sender_id FROM dm_messages WHERE id = ?1",
                params![message_id],
                |row| row.get(0),
            )
            .map_err(|_| "Message not found".to_string())?;
        if existing_sender != sender_id {
            return Err("Not authorized to delete this message".to_string());
        }
        conn.execute("DELETE FROM dm_messages WHERE id = ?1", params![message_id])
            .map_err(|e| e.to_string())?;
        Ok(())
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

    // --- Server Stickers ---

    pub fn add_server_sticker(
        &self,
        server_id: &str,
        file_id: &str,
        uploaded_by: &str,
        sticker_name: &str,
        file_key: &str,
        encrypted_file_key: Option<&[u8]>,
        file_key_nonce: Option<&[u8]>,
    ) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO server_stickers (id, server_id, file_id, uploaded_by, sticker_name, file_key, encrypted_file_key, file_key_nonce) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, server_id, file_id, uploaded_by, sticker_name, file_key, encrypted_file_key, file_key_nonce],
        )
        .map_err(|e| e.to_string())?;
        Ok(id)
    }

    pub fn remove_server_sticker(&self, sticker_id: &str, server_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM server_stickers WHERE id = ?1 AND server_id = ?2",
            params![sticker_id, server_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_server_stickers(&self, server_id: &str) -> Result<Vec<(String, String, String, String, String, Option<String>, Option<Vec<u8>>, Option<Vec<u8>>)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT s.id, s.file_id, s.sticker_name, f.mime_type, COALESCE(u.username, '?'), s.file_key, s.encrypted_file_key, s.file_key_nonce
                 FROM server_stickers s
                 INNER JOIN files f ON s.file_id = f.id
                 LEFT JOIN users u ON s.uploaded_by = u.id
                 WHERE s.server_id = ?1
                 ORDER BY s.created_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![server_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<Vec<u8>>>(6)?,
                    row.get::<_, Option<Vec<u8>>>(7)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    // --- User Stickers ---

    pub fn add_user_sticker(
        &self,
        user_id: &str,
        file_id: &str,
        sticker_name: &str,
        file_key: &str,
        mime_type: &str,
        encrypted_file_key: Option<&[u8]>,
        file_key_nonce: Option<&[u8]>,
    ) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO user_stickers (id, user_id, file_id, sticker_name, file_key, mime_type, encrypted_file_key, file_key_nonce) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, user_id, file_id, sticker_name, file_key, mime_type, encrypted_file_key, file_key_nonce],
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

    pub fn list_user_stickers(&self, user_id: &str) -> Result<Vec<(String, String, String, String, String, Option<Vec<u8>>, Option<Vec<u8>>)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT s.id, s.file_id, s.sticker_name, f.mime_type, s.file_key, s.encrypted_file_key, s.file_key_nonce
                 FROM user_stickers s
                 INNER JOIN files f ON s.file_id = f.id
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
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<Vec<u8>>>(5)?,
                    row.get::<_, Option<Vec<u8>>>(6)?,
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
                        m.encrypted_content, m.nonce, m.timestamp, m.message_nonce, m.edited_at
             FROM dm_messages m INNER JOIN users u ON m.sender_id = u.id
             WHERE m.dm_channel_id = ?1
             ORDER BY m.timestamp DESC LIMIT 1",
            params![dm_channel_id],
            |row| {
                Ok(DmMessage {
                    id: row.get(0)?,
                    dm_channel_id: row.get(1)?,
                    sender_id: row.get(2)?,
                    sender_username: row.get(3)?,
                sender_profile_pic: row.get(4)?,
                    encrypted_content: row.get(5)?,
                    nonce: row.get(6)?,
                    timestamp: row.get(7)?,
                    message_nonce: row.get(8)?,
                    edited_at: row.get(9)?,
                    message_signature: None,
                    encrypted_profile_key: None,
                    profile_key_nonce: None,
                    encrypted_banner_key: None,
                    banner_key_nonce: None,
                    key_version: None,
                    encrypted_profile_snapshot: None,
                    profile_snapshot_nonce: None,
                    encrypted_file_key: None,
                    file_key_nonce: None,
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
        device_id: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO server_keys (server_id, user_id, encrypted_key, sender_public_key, nonce, version, device_id)
             VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)",
            params![server_id, user_id, encrypted_key, sender_public_key, nonce, device_id.unwrap_or("")],
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

    pub fn list_all_users(
        &self,
    ) -> Result<
        Vec<(
            String,
            String,
            String,
            String,
            String,
            String,
            String,
            String,
            String,
            String,
            i32,
            String,
            String,
            String,
            String,
            String,
            String,
            String,
            String,
            String,
            String,
            String,
            String,
        )>,
        String,
    > {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, username, password_hash, created_at, '' as display_name, COALESCE(identity_public_key, ''), COALESCE(profile_picture_file_id, ''), COALESCE(profile_picture_file_key, ''), '' as username_color, '' as username_border_color, COALESCE(friend_requests_disabled, 0), COALESCE(encrypted_friend_code, ''), COALESCE(friend_code_salt, ''), COALESCE(friend_code_nonce, ''), COALESCE(encrypted_profile_data, ''), COALESCE(encrypted_profile_salt, ''), COALESCE(encrypted_profile_nonce, ''), COALESCE(profile_banner_file_id, ''), COALESCE(profile_banner_file_key, ''), '' as description, '' as nickname, '#16213e' as profile_background_color, COALESCE(friend_code_hash, '') FROM users ORDER BY created_at",
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
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, i32>(10)?,
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
                    row.get::<_, String>(21)?,
                    row.get::<_, String>(22)?,
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
            .prepare("SELECT id, owner_id, COALESCE(invite_code_hash, ''), COALESCE(joins_disabled, 0), COALESCE(created_at, '') FROM servers ORDER BY created_at")
            .map_err(|e| e.to_string())?;
        let servers = stmt
            .query_map([], |row| {
                Ok(Server {
                    id: row.get(0)?,
                    encrypted_name: None,
                    name_nonce: None,
                    owner_id: row.get(1)?,
                    invite_code_hash: row.get(2)?,
                    joins_disabled: row.get::<_, i64>(3)? != 0,
                    created_at: row.get(4)?,
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
            .prepare("SELECT id, server_id, type, COALESCE(position, 0), COALESCE(created_at, '') FROM channels ORDER BY created_at")
            .map_err(|e| e.to_string())?;
        let channels = stmt
            .query_map([], |row| {
                Ok(Channel {
                    id: row.get(0)?,
                    server_id: row.get(1)?,
                    encrypted_name: None,
                    name_nonce: None,
                    channel_type: row.get(2)?,
                    position: row.get::<_, i32>(3)?,
                    created_at: row.get(4)?,
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
                        m.encrypted_content, m.nonce, m.timestamp, COALESCE(m.message_nonce, ''), COALESCE(m.edited_at, ''), COALESCE(m.message_signature, ''), COALESCE(m.encrypted_profile_key, ''), COALESCE(m.profile_key_nonce, ''), COALESCE(m.encrypted_banner_key, ''), COALESCE(m.banner_key_nonce, ''), m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.encrypted_file_key, m.file_key_nonce
                 FROM messages m LEFT JOIN users u ON m.sender_id = u.id ORDER BY m.timestamp DESC LIMIT 500",
            )
            .map_err(|e| e.to_string())?;
        let messages = stmt
            .query_map([], |row| {
                Ok(Message {
                    id: row.get(0)?,
                    channel_id: row.get(1)?,
                    sender_id: row.get(2)?,
                    sender_username: row.get(3)?,
                sender_profile_pic: row.get(4)?,
                    encrypted_content: row.get(5)?,
                    nonce: row.get(6)?,
                    timestamp: row.get(7)?,
                    message_nonce: row.get(8)?,
                    edited_at: row.get(9)?,
                    message_signature: row.get(10)?,
                    encrypted_profile_key: row.get(11)?,
                    profile_key_nonce: row.get(12)?,
                    encrypted_banner_key: row.get(13)?,
                    banner_key_nonce: row.get(14)?,
                    key_version: row.get(15)?,
                    encrypted_profile_snapshot: row.get(16)?,
                    profile_snapshot_nonce: row.get(17)?,
                    encrypted_file_key: row.get(18)?,
                    file_key_nonce: row.get(19)?,
                    encrypted_sender_username: row.get(20)?,
                    sender_username_nonce: row.get(21)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(messages)
    }

    pub fn list_all_server_keys_admin(
        &self,
    ) -> Result<Vec<(String, String, String, Vec<u8>, Vec<u8>, Vec<u8>, i32, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT sk.server_id, s.id, sk.user_id, sk.encrypted_key, sk.sender_public_key, sk.nonce, sk.version, COALESCE(sk.device_id, ''), sk.created_at
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
                    row.get::<_, String>(8)?,
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
                "SELECT sb.server_id, s.id, sb.user_id, COALESCE(u.username, '?'), COALESCE(sb.reason, ''), sb.created_at
                 FROM server_bans sb
                 LEFT JOIN servers s ON sb.server_id = s.id
                 LEFT JOIN users u ON sb.user_id = u.id
                 ORDER BY sb.created_at",
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
    ) -> Result<Vec<(String, String, String, String, Vec<u8>, Vec<u8>, String, Option<i32>, Option<Vec<u8>>, Option<Vec<u8>>, Option<Vec<u8>>, Option<Vec<u8>>)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT m.id, m.dm_channel_id, m.sender_id, COALESCE(u.username, '?'), m.encrypted_content, m.nonce, m.timestamp, m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.encrypted_file_key, m.file_key_nonce
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
                    row.get::<_, Option<Vec<u8>>>(10)?,
                    row.get::<_, Option<Vec<u8>>>(11)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn list_all_dm_keys_admin(
        &self,
    ) -> Result<Vec<(String, String, String, Vec<u8>, Vec<u8>, Vec<u8>, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT dk.dm_channel_id, dk.user_id, COALESCE(u.username, '?'), dk.encrypted_key, dk.sender_public_key, dk.nonce, COALESCE(dk.device_id, ''), dk.created_at
                 FROM dm_keys dk LEFT JOIN users u ON dk.user_id = u.id ORDER BY dk.id",
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
                "SELECT f.user_id_1, COALESCE(u1.username, '?'), f.user_id_2, COALESCE(u2.username, '?'), f.created_at
                 FROM friendships f
                 LEFT JOIN users u1 ON f.user_id_1 = u1.id
                 LEFT JOIN users u2 ON f.user_id_2 = u2.id
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
    ) -> Result<Vec<(String, String, String, String, String, i64, String, String, String, i64, i32)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT f.id, f.uploader_id, COALESCE(u.username, '?'), f.original_name, COALESCE(f.mime_type, ''), f.file_size, COALESCE(f.server_id, ''), COALESCE(f.channel_id, ''), f.created_at, COALESCE(f.chunk_count, 0), COALESCE(f.upload_complete, 0)
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
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, i32>(10)?,
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

    pub fn delete_user(&self, user_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

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

        // 4f. Clean up server_bans where user is the banned user
        conn.execute("DELETE FROM server_bans WHERE user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;

        // 4g. Clean up server_stickers where user was uploader
        conn.execute("DELETE FROM server_stickers WHERE uploaded_by = ?1", params![user_id])
            .map_err(|e| e.to_string())?;

        // 4h. Clean up conversation_profile_data and user_media for this user
        conn.execute("DELETE FROM conversation_profile_data WHERE user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM user_media WHERE user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM user_stickers WHERE user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;

        // 5. Delete the user
        conn.execute("DELETE FROM users WHERE id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    // --- Files (Phase 5) ---

    pub fn create_file_record(&self, uploader_id: &str, original_size: i64, mime_type: &str) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO files (id, uploader_id, original_size, mime_type) VALUES (?1, ?2, ?3, ?4)",
            params![id, uploader_id, original_size, mime_type],
        )
        .map_err(|e| e.to_string())?;
        Ok(id)
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

    pub fn get_file_info(&self, file_id: &str) -> Result<FileRecord, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT id, uploader_id, original_size, mime_type, chunk_count, upload_complete, created_at
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
                })
            },
        )
        .map_err(|e| e.to_string())
    }

    // --- Admin: missing tables ---

    pub fn list_all_user_stickers_admin(&self) -> Result<Vec<(String, String, String, String, String, String, String, Option<Vec<u8>>, Option<Vec<u8>>, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT us.id, us.user_id, COALESCE(u.username, '?'), us.file_id, us.sticker_name, us.file_key, COALESCE(us.mime_type, ''), us.encrypted_file_key, us.file_key_nonce, COALESCE(us.created_at, '')
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
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<Vec<u8>>>(7)?,
                    row.get::<_, Option<Vec<u8>>>(8)?,
                    row.get::<_, String>(9)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn list_all_server_stickers_admin(&self) -> Result<Vec<(String, String, String, String, String, String, String, Option<Vec<u8>>, Option<Vec<u8>>, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT ss.id, ss.server_id, s.id, ss.file_id, ss.uploaded_by, ss.sticker_name, COALESCE(ss.file_key, ''), ss.encrypted_file_key, ss.file_key_nonce, COALESCE(ss.created_at, '')
                 FROM server_stickers ss LEFT JOIN servers s ON ss.server_id = s.id ORDER BY ss.created_at DESC",
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
                    row.get::<_, Option<Vec<u8>>>(7)?,
                    row.get::<_, Option<Vec<u8>>>(8)?,
                    row.get::<_, String>(9)?,
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
        let mut stmt = conn.prepare("SELECT key, value FROM admin_config ORDER BY key").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }
    pub fn list_all_prekey_bundles_admin(&self) -> Result<Vec<(String, String, String, String, Option<String>, Option<i32>, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT p.user_id, p.identity_key_public, p.signed_prekey_public, p.signed_prekey_signature, p.one_time_prekey_public, p.one_time_prekey_id, COALESCE(p.created_at, '')
             FROM prekey_bundles p
             ORDER BY p.created_at"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<i32>>(5)?,
                row.get::<_, String>(6)?,
            ))
        }).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn list_all_sessions_admin(&self) -> Result<Vec<(String, String, String, String, String, i32, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT COALESCE(u1.username, s.our_user_id), s.our_user_id, COALESCE(u2.username, s.their_user_id), s.their_user_id,
                    s.session_data, COALESCE(s.ratchet_counter, 0), COALESCE(s.created_at, '')
             FROM sessions s
             LEFT JOIN users u1 ON s.our_user_id = u1.id
             LEFT JOIN users u2 ON s.their_user_id = u2.id
             ORDER BY s.created_at"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i32>(5)?,
                row.get::<_, String>(6)?,
            ))
        }).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn list_all_user_devices_admin(&self) -> Result<Vec<(String, String, String, String, String, Option<String>, Option<String>, Option<String>, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT COALESCE(u.username, d.user_id), d.user_id, d.device_id, COALESCE(d.device_name, ''),
                    d.identity_key, d.signed_prekey, d.signed_prekey_signature, d.last_active_at, COALESCE(d.created_at, '')
             FROM user_devices d
             LEFT JOIN users u ON d.user_id = u.id
             ORDER BY d.created_at"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, String>(8)?,
            ))
        }).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn list_all_user_key_escrow_admin(&self) -> Result<Vec<(String, String, String, String, String, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT COALESCE(u.username, e.user_id), e.user_id, COALESCE(e.encrypted_private_key, ''), COALESCE(e.salt, ''),
                    COALESCE(e.nonce, ''), COALESCE(e.created_at, ''), COALESCE(e.updated_at, '')
             FROM user_key_escrow e
             LEFT JOIN users u ON e.user_id = u.id
             ORDER BY e.created_at"
        ).map_err(|e| e.to_string())?;
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
        let mut stmt = conn.prepare(
            "SELECT COALESCE(u.username, e.user_id), e.user_id, COALESCE(e.device_id, ''), COALESCE(e.encrypted_private_key, ''),
                    COALESCE(e.salt, ''), COALESCE(e.nonce, ''), COALESCE(e.created_at, ''), COALESCE(e.updated_at, '')
             FROM user_device_escrow e
             LEFT JOIN users u ON e.user_id = u.id
             ORDER BY e.created_at"
        ).map_err(|e| e.to_string())?;
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
            ))
        }).map_err(|e| e.to_string())?;
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
        // Wipe all tables in dependency-safe order
        conn.execute("DELETE FROM voice_participants", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM voice_sessions", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM user_media", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM files", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM messages", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM dm_messages", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM server_keys", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM server_bans", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM server_members", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM channels", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM servers", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM dm_members", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM dm_channels", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM friend_requests", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM friendships", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM user_stickers", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM server_stickers", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM conversation_profile_data", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM notification_sounds", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM users", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM admin_config", []).map_err(|e| e.to_string())?;
        Ok(())
    }
}
