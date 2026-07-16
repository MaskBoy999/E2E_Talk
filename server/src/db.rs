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
    pub name: String,
    pub owner_id: String,
    pub invite_code_hash: String,
    pub joins_disabled: bool,
}

#[derive(Debug, Clone)]
pub struct Channel {
    pub id: String,
    pub server_id: String,
    pub name: String,
    pub channel_type: String,
}

#[derive(Debug, Clone)]
pub struct Message {
    pub id: String,
    pub channel_id: String,
    pub sender_id: String,
    pub sender_username: String,
    pub encrypted_content: Vec<u8>,
    pub nonce: Vec<u8>,
    pub timestamp: String,
    pub message_nonce: Option<String>,
    pub edited_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PreKeyBundle {
    pub user_id: String,
    pub identity_key_public: Vec<u8>,
    pub signed_prekey_public: Vec<u8>,
    pub signed_prekey_signature: Vec<u8>,
    pub one_time_prekey_public: Option<Vec<u8>>,
    pub one_time_prekey_id: Option<i32>,
}

#[derive(Debug, Clone)]
pub struct Session {
    pub id: i64,
    pub our_user_id: String,
    pub their_user_id: String,
    pub session_data: Vec<u8>,
    pub ratchet_counter: i32,
}

#[derive(Debug, Clone)]
pub struct DmMessage {
    pub id: String,
    pub dm_channel_id: String,
    pub sender_id: String,
    pub sender_username: String,
    pub encrypted_content: Vec<u8>,
    pub nonce: Vec<u8>,
    pub timestamp: String,
    pub message_nonce: Option<String>,
    pub edited_at: Option<String>,
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

    pub fn create_user(&self, username: &str, password_hash: &str, identity_public_key: Option<&[u8]>, friend_code_hash: Option<&str>) -> Result<User, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();

        conn.execute(
            "INSERT INTO users (id, username, password_hash, identity_public_key, friend_code_hash) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, username, password_hash, identity_public_key, friend_code_hash],
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

    pub fn create_server(&self, name: &str, owner_id: &str, invite_code_hash: &str) -> Result<Server, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let server_id = Uuid::new_v4().to_string();
        let general_id = Uuid::new_v4().to_string();

        conn.execute(
            "INSERT INTO servers (id, name, owner_id, invite_code_hash) VALUES (?1, ?2, ?3, ?4)",
            params![server_id, name, owner_id, invite_code_hash],
        )
        .map_err(|e| e.to_string())?;

        conn.execute(
            "INSERT INTO server_members (user_id, server_id, role) VALUES (?1, ?2, 'owner')",
            params![owner_id, server_id],
        )
        .map_err(|e| e.to_string())?;

        conn.execute(
            "INSERT INTO channels (id, server_id, name, type, position) VALUES (?1, ?2, 'general', 'text', 0)",
            params![general_id, server_id],
        )
        .map_err(|e| e.to_string())?;

        Ok(Server {
            id: server_id,
            name: name.to_string(),
            owner_id: owner_id.to_string(),
            invite_code_hash: invite_code_hash.to_string(),
            joins_disabled: false,
        })
    }

    pub fn list_user_servers(&self, user_id: &str) -> Result<Vec<Server>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT s.id, s.name, s.owner_id, COALESCE(s.invite_code_hash, ''), COALESCE(s.joins_disabled, 0)
                 FROM servers s
                 INNER JOIN server_members sm ON s.id = sm.server_id
                 WHERE sm.user_id = ?1
                 ORDER BY s.name",
            )
            .map_err(|e| e.to_string())?;
        let servers = stmt
            .query_map(params![user_id], |row| {
                Ok(Server {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    owner_id: row.get(2)?,
                    invite_code_hash: row.get(3)?,
                    joins_disabled: row.get::<_, i64>(4)? != 0,
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

    pub fn join_server_by_invite(&self, code: &str, user_id: &str) -> Result<Server, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let code_hash = sha256_hex(code.trim());

        let server: Server = conn
            .query_row(
                "SELECT id, name, owner_id, COALESCE(invite_code_hash, ''), COALESCE(joins_disabled, 0) FROM servers WHERE invite_code_hash = ?1",
                params![code_hash],
                |row| {
                    Ok(Server {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        owner_id: row.get(2)?,
                        invite_code_hash: row.get(3)?,
                        joins_disabled: row.get::<_, i64>(4)? != 0,
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
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT name FROM channels WHERE id = ?1",
            params![channel_id],
            |row| row.get(0),
        )
        .map_err(|_| "Channel not found".to_string())
    }

    pub fn get_server_name(&self, server_id: &str) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT name FROM servers WHERE id = ?1",
            params![server_id],
            |row| row.get(0),
        )
        .map_err(|_| "Server not found".to_string())
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

    pub fn get_server_members_with_names(&self, server_id: &str) -> Result<Vec<(String, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT u.id, u.username, sm.role
                 FROM server_members sm
                 INNER JOIN users u ON sm.user_id = u.id
                 WHERE sm.server_id = ?1
                 ORDER BY sm.role = 'owner' DESC, u.username ASC",
            )
            .map_err(|e| e.to_string())?;
        let members = stmt
            .query_map(params![server_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
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
                "SELECT id, server_id, name, type FROM channels
                 WHERE server_id = ?1 ORDER BY position",
            )
            .map_err(|e| e.to_string())?;
        let channels = stmt
            .query_map(params![server_id], |row| {
                Ok(Channel {
                    id: row.get(0)?,
                    server_id: row.get(1)?,
                    name: row.get(2)?,
                    channel_type: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(channels)
    }

    pub fn create_channel(&self, server_id: &str, name: &str) -> Result<Channel, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();

        let max_pos: i32 = conn
            .query_row(
                "SELECT COALESCE(MAX(position), -1) FROM channels WHERE server_id = ?1",
                params![server_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        conn.execute(
            "INSERT INTO channels (id, server_id, name, type, position) VALUES (?1, ?2, ?3, 'text', ?4)",
            params![id, server_id, name, max_pos + 1],
        )
        .map_err(|e| e.to_string())?;

        Ok(Channel {
            id,
            server_id: server_id.to_string(),
            name: name.to_string(),
            channel_type: "text".to_string(),
        })
    }

    // --- Messages ---

    pub fn list_messages(&self, channel_id: &str, limit: i64) -> Result<Vec<Message>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // Return the `limit` most recent messages in ASCENDING order (oldest -> newest).
        // The subquery picks the newest `limit` rows; the outer query re-sorts them oldest
        // first so the client can render top-to-bottom chronologically.
        let mut stmt = conn
            .prepare(
                "SELECT m.id, m.channel_id, m.sender_id, u.username, m.encrypted_content, m.nonce, m.timestamp, m.message_nonce, m.edited_at
                 FROM (
                     SELECT id, channel_id, sender_id, encrypted_content, nonce, timestamp, message_nonce, edited_at
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
                    encrypted_content: row.get(4)?,
                    nonce: row.get(5)?,
                    timestamp: row.get(6)?,
                    message_nonce: row.get(7)?,
                    edited_at: row.get(8)?,
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
                "SELECT m.id, m.channel_id, m.sender_id, u.username, m.encrypted_content, m.nonce, m.timestamp, m.message_nonce, m.edited_at
                 FROM (
                     -- Get half_limit messages before-and-including the target
                     SELECT id, channel_id, sender_id, encrypted_content, nonce, timestamp, message_nonce, edited_at
                     FROM messages
                     WHERE channel_id = ?1 AND timestamp <= (SELECT COALESCE(timestamp, '') FROM messages WHERE id = ?2)
                     ORDER BY timestamp DESC
                     LIMIT ?3
                     UNION ALL
                     -- Get half_limit messages after the target
                     SELECT id, channel_id, sender_id, encrypted_content, nonce, timestamp, message_nonce, edited_at
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
                    encrypted_content: row.get(4)?,
                    nonce: row.get(5)?,
                    timestamp: row.get(6)?,
                    message_nonce: row.get(7)?,
                    edited_at: row.get(8)?,
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
            "INSERT INTO messages (id, channel_id, sender_id, encrypted_content, nonce, message_nonce) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, channel_id, sender_id, encrypted_content, nonce, message_nonce],
        )
        .map_err(|e| e.to_string())?;

        Ok(Message {
            id,
            channel_id: channel_id.to_string(),
            sender_id: sender_id.to_string(),
            sender_username: username,
            encrypted_content: encrypted_content.to_vec(),
            nonce: nonce.to_vec(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            message_nonce: message_nonce.map(|s| s.to_string()),
            edited_at: None,
        })
    }

    // --- PreKey Bundles ---

    pub fn save_prekey_bundle(
        &self,
        user_id: &str,
        identity_key_public: &[u8],
        signed_prekey_public: &[u8],
        signed_prekey_signature: &[u8],
        one_time_prekey_public: Option<&[u8]>,
        one_time_prekey_id: Option<i32>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO prekey_bundles (user_id, identity_key_public, signed_prekey_public, signed_prekey_signature, one_time_prekey_public, one_time_prekey_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![user_id, identity_key_public, signed_prekey_public, signed_prekey_signature, one_time_prekey_public, one_time_prekey_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_prekey_bundle(&self, user_id: &str) -> Result<PreKeyBundle, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT user_id, identity_key_public, signed_prekey_public, signed_prekey_signature, one_time_prekey_public, one_time_prekey_id
             FROM prekey_bundles WHERE user_id = ?1",
            params![user_id],
            |row| {
                Ok(PreKeyBundle {
                    user_id: row.get(0)?,
                    identity_key_public: row.get(1)?,
                    signed_prekey_public: row.get(2)?,
                    signed_prekey_signature: row.get(3)?,
                    one_time_prekey_public: row.get(4)?,
                    one_time_prekey_id: row.get(5)?,
                })
            },
        )
        .map_err(|e| e.to_string())
    }

    pub fn consume_one_time_prekey(&self, user_id: &str) -> Result<Option<(Vec<u8>, i32)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let result: Option<(Vec<u8>, i32)> = conn
            .query_row(
                "SELECT one_time_prekey_public, one_time_prekey_id
                 FROM prekey_bundles
                 WHERE user_id = ?1 AND one_time_prekey_public IS NOT NULL
                 LIMIT 1",
                params![user_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();

        if let Some((key, key_id)) = result {
            conn.execute(
                "UPDATE prekey_bundles SET one_time_prekey_public = NULL, one_time_prekey_id = NULL
                 WHERE user_id = ?1 AND one_time_prekey_id = ?2",
                params![user_id, key_id],
            )
            .map_err(|e| e.to_string())?;
            Ok(Some((key, key_id)))
        } else {
            Ok(None)
        }
    }

    // --- Sessions ---

    pub fn save_session(
        &self,
        our_user_id: &str,
        their_user_id: &str,
        session_data: &[u8],
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO sessions (our_user_id, their_user_id, session_data, ratchet_counter)
             VALUES (?1, ?2, ?3, 0)",
            params![our_user_id, their_user_id, session_data],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_session(
        &self,
        our_user_id: &str,
        their_user_id: &str,
    ) -> Result<Option<Session>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let result = conn.query_row(
            "SELECT id, our_user_id, their_user_id, session_data, ratchet_counter
             FROM sessions
             WHERE our_user_id = ?1 AND their_user_id = ?2",
            params![our_user_id, their_user_id],
            |row| {
                Ok(Session {
                    id: row.get(0)?,
                    our_user_id: row.get(1)?,
                    their_user_id: row.get(2)?,
                    session_data: row.get(3)?,
                    ratchet_counter: row.get(4)?,
                })
            },
        );

        match result {
            Ok(session) => Ok(Some(session)),
            Err(_) => Ok(None),
        }
    }

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

    // --- Multi-device public keys ---

    pub fn add_user_public_key(&self, user_id: &str, public_key: &[u8]) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO user_public_keys (id, user_id, public_key) VALUES (?1, ?2, ?3)",
            params![id, user_id, public_key],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_all_user_public_keys(&self, user_id: &str) -> Result<Vec<Vec<u8>>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT public_key FROM user_public_keys WHERE user_id = ?1")
            .map_err(|e| e.to_string())?;
        let keys = stmt
            .query_map(params![user_id], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(keys)
    }

    // --- Key Escrow ---

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

    pub fn get_user_by_friend_code(&self, code: &str) -> Result<User, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let code_hash = sha256_hex(code.trim());
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
        to_user_code: &str,
    ) -> Result<User, String> {
        if from_user_id.is_empty() {
            return Err("Not authenticated".to_string());
        }
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let target: User = {
            let code_hash = sha256_hex(to_user_code.trim());
            conn
            .query_row(
                "SELECT id, username FROM users WHERE friend_code_hash = ?1",
                params![code_hash],
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
            "UPDATE friend_requests SET status = 'accepted', responded_at = CURRENT_TIMESTAMP WHERE id = ?1",
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
            "UPDATE friend_requests SET status = 'declined', responded_at = CURRENT_TIMESTAMP
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
            conn.execute("DELETE FROM dm_keys WHERE dm_channel_id = ?1", params![dm_id])
                .map_err(|e| e.to_string())?;
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

    pub fn list_dm_channels_for_user(&self, user_id: &str) -> Result<Vec<(String, String, String)>, String> {
        // Returns (dm_channel_id, other_user_id, other_username) ordered by most recent message.
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
             "SELECT dm.id, other.user_id, u.username
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
            "INSERT OR REPLACE INTO dm_keys (dm_channel_id, user_id, encrypted_key, sender_public_key, nonce)
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
        // Newest `limit` rows, re-sorted oldest -> newest (same pattern as channel messages).
        let mut stmt = conn.prepare(
            "SELECT m.id, m.dm_channel_id, m.sender_id, u.username, m.encrypted_content, m.nonce, m.timestamp, m.message_nonce, m.edited_at
             FROM (
                 SELECT id, dm_channel_id, sender_id, encrypted_content, nonce, timestamp, message_nonce, edited_at
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
                encrypted_content: row.get(4)?,
                nonce: row.get(5)?,
                timestamp: row.get(6)?,
                message_nonce: row.get(7)?,
                edited_at: row.get(8)?,
            })
        }).map_err(|e| e.to_string())?;
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
            "INSERT INTO dm_messages (id, dm_channel_id, sender_id, encrypted_content, nonce, message_nonce)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, dm_channel_id, sender_id, encrypted_content, nonce, message_nonce],
        )
        .map_err(|e| e.to_string())?;
        Ok(DmMessage {
            id,
            dm_channel_id: dm_channel_id.to_string(),
            sender_id: sender_id.to_string(),
            sender_username: username,
            encrypted_content: encrypted_content.to_vec(),
            nonce: nonce.to_vec(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            message_nonce: message_nonce.map(|s| s.to_string()),
            edited_at: None,
        })
    }

    pub fn edit_encrypted_message(
        &self,
        message_id: &str,
        sender_id: &str,
        new_encrypted_content: &[u8],
        new_nonce: &[u8],
        new_message_nonce: Option<&str>,
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
            "UPDATE messages SET encrypted_content = ?1, nonce = ?2, message_nonce = ?3, edited_at = CURRENT_TIMESTAMP WHERE id = ?4",
            params![new_encrypted_content, new_nonce, new_message_nonce, message_id],
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
                "SELECT m.id, m.channel_id, m.sender_id, m.encrypted_content, m.nonce, m.timestamp, m.message_nonce, m.edited_at
                 FROM messages m WHERE m.id = ?1",
                params![message_id],
                |row| {
                    Ok(Message {
                        id: row.get(0)?,
                        channel_id: row.get(1)?,
                        sender_id: row.get(2)?,
                        sender_username: username.clone(),
                        encrypted_content: row.get(3)?,
                        nonce: row.get(4)?,
                        timestamp: row.get(5)?,
                        message_nonce: row.get(6)?,
                        edited_at: row.get(7)?,
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
            "UPDATE dm_messages SET encrypted_content = ?1, nonce = ?2, message_nonce = ?3, edited_at = CURRENT_TIMESTAMP WHERE id = ?4",
            params![new_encrypted_content, new_nonce, new_message_nonce, message_id],
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
                "SELECT m.id, m.dm_channel_id, m.sender_id, m.encrypted_content, m.nonce, m.timestamp, m.message_nonce, m.edited_at
                 FROM dm_messages m WHERE m.id = ?1",
                params![message_id],
                |row| {
                    Ok(DmMessage {
                        id: row.get(0)?,
                        dm_channel_id: row.get(1)?,
                        sender_id: row.get(2)?,
                        sender_username: username.clone(),
                        encrypted_content: row.get(3)?,
                        nonce: row.get(4)?,
                        timestamp: row.get(5)?,
                        message_nonce: row.get(6)?,
                        edited_at: row.get(7)?,
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
    ) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO server_stickers (id, server_id, file_id, uploaded_by, sticker_name, file_key) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, server_id, file_id, uploaded_by, sticker_name, file_key],
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

    pub fn list_server_stickers(&self, server_id: &str) -> Result<Vec<(String, String, String, String, String, Option<String>)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT s.id, s.file_id, s.sticker_name, f.mime_type, COALESCE(u.username, '?'), s.file_key
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
    ) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();
        // file_key can be empty — the key is derived from the user's identity key on the client
        conn.execute(
            "INSERT INTO user_stickers (id, user_id, file_id, sticker_name, file_key, mime_type) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, user_id, file_id, sticker_name, file_key, mime_type],
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

    pub fn list_user_stickers(&self, user_id: &str) -> Result<Vec<(String, String, String, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT s.id, s.file_id, s.sticker_name, f.mime_type, s.file_key
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
            "SELECT m.id, m.dm_channel_id, m.sender_id, u.username, m.encrypted_content, m.nonce, m.timestamp, m.message_nonce, m.edited_at
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
                    encrypted_content: row.get(4)?,
                    nonce: row.get(5)?,
                    timestamp: row.get(6)?,
                    message_nonce: row.get(7)?,
                    edited_at: row.get(8)?,
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
            "INSERT OR REPLACE INTO server_keys (server_id, user_id, encrypted_key, sender_public_key, nonce, version)
             VALUES (?1, ?2, ?3, ?4, ?5, 1)",
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

    pub fn list_all_users(&self) -> Result<Vec<User>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, username FROM users ORDER BY created_at")
            .map_err(|e| e.to_string())?;
        let users = stmt
            .query_map([], |row| {
                Ok(User {
                    id: row.get(0)?,
                    username: row.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(users)
    }

    pub fn list_all_servers_admin(&self) -> Result<Vec<Server>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, name, owner_id, COALESCE(invite_code_hash, ''), COALESCE(joins_disabled, 0) FROM servers ORDER BY created_at")
            .map_err(|e| e.to_string())?;
        let servers = stmt
            .query_map([], |row| {
                Ok(Server {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    owner_id: row.get(2)?,
                    invite_code_hash: row.get(3)?,
                    joins_disabled: row.get::<_, i64>(4)? != 0,
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
            .prepare("SELECT id, server_id, name, type FROM channels ORDER BY created_at")
            .map_err(|e| e.to_string())?;
        let channels = stmt
            .query_map([], |row| {
                Ok(Channel {
                    id: row.get(0)?,
                    server_id: row.get(1)?,
                    name: row.get(2)?,
                    channel_type: row.get(3)?,
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
                "SELECT m.id, m.channel_id, m.sender_id, COALESCE(u.username, '?'), m.encrypted_content, m.nonce, m.timestamp, m.message_nonce, m.edited_at
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
                    encrypted_content: row.get(4)?,
                    nonce: row.get(5)?,
                    timestamp: row.get(6)?,
                    message_nonce: row.get(7)?,
                    edited_at: row.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(messages)
    }

    pub fn list_all_server_keys_admin(
        &self,
    ) -> Result<Vec<(String, String, String, Vec<u8>, Vec<u8>, Vec<u8>, i32)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT sk.server_id, COALESCE(s.name, '?'), sk.user_id, sk.encrypted_key, sk.sender_public_key, sk.nonce, sk.version
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
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(keys)
    }

    pub fn list_all_server_members_admin(
        &self,
    ) -> Result<Vec<(String, String, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT sm.user_id, COALESCE(u.username, '?'), sm.server_id, COALESCE(s.name, '?')
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
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(members)
    }

    pub fn list_all_prekey_bundles_admin(
        &self,
    ) -> Result<Vec<(String, Vec<u8>, Vec<u8>, Vec<u8>, Option<Vec<u8>>, Option<i32>)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT user_id, identity_key_public, signed_prekey_public, signed_prekey_signature, one_time_prekey_public, one_time_prekey_id
                 FROM prekey_bundles ORDER BY created_at",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Vec<u8>>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                    row.get::<_, Option<Vec<u8>>>(4)?,
                    row.get::<_, Option<i32>>(5)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn list_all_sessions_admin(
        &self,
    ) -> Result<Vec<(String, String, String, String, Vec<u8>, i32)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT s.our_user_id, COALESCE(u1.username, '?'), s.their_user_id, COALESCE(u2.username, '?'), s.session_data, s.ratchet_counter
                 FROM sessions s
                 LEFT JOIN users u1 ON s.our_user_id = u1.id
                 LEFT JOIN users u2 ON s.their_user_id = u2.id
                 ORDER BY s.id",
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
                    row.get::<_, i32>(5)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn list_all_server_bans_admin(
        &self,
    ) -> Result<Vec<(String, String, String, String, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT sb.server_id, COALESCE(s.name, '?'), sb.user_id, COALESCE(u.username, '?'), COALESCE(sb.reason, ''), sb.created_at
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
    ) -> Result<Vec<(String, String, String, String, Vec<u8>, Vec<u8>, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT m.id, m.dm_channel_id, m.sender_id, COALESCE(u.username, '?'), m.encrypted_content, m.nonce, m.timestamp
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
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn list_all_dm_keys_admin(
        &self,
    ) -> Result<Vec<(String, String, String, Vec<u8>, Vec<u8>, Vec<u8>)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT dk.dm_channel_id, dk.user_id, COALESCE(u.username, '?'), dk.encrypted_key, dk.sender_public_key, dk.nonce
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
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn list_all_friend_requests_admin(
        &self,
    ) -> Result<Vec<(String, String, String, String, String, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT fr.id, fr.from_user_id, COALESCE(u1.username, '?'), fr.to_user_id, COALESCE(u2.username, '?'), fr.status, fr.created_at
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

    pub fn list_all_user_public_keys_admin(
        &self,
    ) -> Result<Vec<(String, String, String, Vec<u8>, Vec<u8>, Option<Vec<u8>>, Option<i32>)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT upk.user_id, COALESCE(u.username, '?'), upk.device_id, upk.identity_key, upk.signed_prekey, upk.one_time_prekey, upk.one_time_prekey_id
                 FROM user_public_keys upk LEFT JOIN users u ON upk.user_id = u.id ORDER BY upk.id",
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
                    row.get::<_, Option<Vec<u8>>>(5)?,
                    row.get::<_, Option<i32>>(6)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn list_all_files_admin(
        &self,
    ) -> Result<Vec<(String, String, String, String, String, i64, String, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT f.id, f.uploader_id, COALESCE(u.username, '?'), f.original_name, COALESCE(f.mime_type, ''), f.file_size, COALESCE(f.server_id, ''), COALESCE(f.channel_id, ''), f.created_at
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
            conn.execute("DELETE FROM servers WHERE id = ?1", params![sid])
                .map_err(|e| e.to_string())?;
        }

        // 3. Clean up remaining memberships and keys in other servers
        conn.execute("DELETE FROM server_keys WHERE user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM server_members WHERE user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;

        // 4. Clean up Signal protocol tables
        conn.execute("DELETE FROM prekey_bundles WHERE user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM sessions WHERE our_user_id = ?1 OR their_user_id = ?1",
            params![user_id],
        )
        .map_err(|e| e.to_string())?;

        // 4b. Clean up DM + friend data. dm_messages/dm_keys/dm_members cascade on user delete,
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

    pub fn list_all_user_stickers_admin(&self) -> Result<Vec<(String, String, String, String, String, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT us.id, us.user_id, COALESCE(u.username, '?'), us.file_id, us.sticker_name, us.file_key, COALESCE(us.mime_type, '')
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
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn list_all_server_stickers_admin(&self) -> Result<Vec<(String, String, String, String, String, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT ss.id, ss.server_id, COALESCE(s.name, '?'), ss.file_id, ss.uploaded_by, ss.sticker_name, COALESCE(ss.file_key, '')
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
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn list_all_user_key_escrow_admin(&self) -> Result<Vec<(String, String, String, String, i32)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT eke.user_id, COALESCE(u.username, '?'), eke.created_at, eke.updated_at,
                 CASE WHEN eke.encrypted_private_key IS NOT NULL THEN 1 ELSE 0 END
                 FROM user_key_escrow eke LEFT JOIN users u ON eke.user_id = u.id ORDER BY eke.created_at",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i32>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn clear_all(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM user_stickers", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM server_stickers", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM user_key_escrow", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM files", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM messages", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM server_keys", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM server_bans", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM server_members", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM channels", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM servers", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM prekey_bundles", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM sessions", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM dm_messages", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM dm_keys", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM dm_members", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM dm_channels", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM friend_requests", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM friendships", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM user_public_keys", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM users", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM admin_config", []).map_err(|e| e.to_string())?;
        Ok(())
    }
}
