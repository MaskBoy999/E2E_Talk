use rusqlite::{params, Connection};
use std::sync::Mutex;
use uuid::Uuid;

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
    pub invite_code: String,
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
        Ok(())
    }

    fn generate_invite_code() -> String {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        Uuid::new_v4().hash(&mut hasher);
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
            .hash(&mut hasher);
        let hash = hasher.finish();
        // 8-char lowercase hex code
        format!("{:08x}", hash & 0xFFFFFFFF)
    }

    // --- Users ---

    pub fn create_user(&self, username: &str, password_hash: &str) -> Result<User, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();

        conn.execute(
            "INSERT INTO users (id, username, password_hash) VALUES (?1, ?2, ?3)",
            params![id, username, password_hash],
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

    // --- Servers ---

    pub fn create_server(&self, name: &str, owner_id: &str) -> Result<Server, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let server_id = Uuid::new_v4().to_string();
        let general_id = Uuid::new_v4().to_string();
        let invite_code = Self::generate_invite_code();

        conn.execute(
            "INSERT INTO servers (id, name, owner_id, invite_code) VALUES (?1, ?2, ?3, ?4)",
            params![server_id, name, owner_id, invite_code],
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
            invite_code,
        })
    }

    pub fn list_user_servers(&self, user_id: &str) -> Result<Vec<Server>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT s.id, s.name, s.owner_id, s.invite_code
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
                    invite_code: row.get(3)?,
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

        let server: Server = conn
            .query_row(
                "SELECT id, name, owner_id, invite_code FROM servers WHERE invite_code = ?1",
                params![code],
                |row| {
                    Ok(Server {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        owner_id: row.get(2)?,
                        invite_code: row.get(3)?,
                    })
                },
            )
            .map_err(|_| "Invalid invite code".to_string())?;

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

    pub fn regenerate_invite(&self, server_id: &str, user_id: &str) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        if !Self::is_server_owner_c(&conn, user_id, server_id).unwrap_or(false) {
            return Err("Only the server owner can regenerate the invite".to_string());
        }

        let new_code = Self::generate_invite_code();
        conn.execute(
            "UPDATE servers SET invite_code = ?1 WHERE id = ?2",
            params![new_code, server_id],
        )
        .map_err(|e| e.to_string())?;

        Ok(new_code)
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
        let mut stmt = conn
            .prepare(
                "SELECT m.id, m.channel_id, m.sender_id, u.username, m.encrypted_content, m.nonce, m.timestamp
                 FROM messages m
                 INNER JOIN users u ON m.sender_id = u.id
                 WHERE m.channel_id = ?1
                 ORDER BY m.timestamp DESC
                 LIMIT ?2",
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
            "INSERT INTO messages (id, channel_id, sender_id, encrypted_content, nonce) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, channel_id, sender_id, encrypted_content, nonce],
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

    // --- Admin ---

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

    pub fn delete_user(&self, user_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM messages WHERE sender_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM server_members WHERE user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM prekey_bundles WHERE user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM sessions WHERE our_user_id = ?1 OR their_user_id = ?1",
            params![user_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM users WHERE id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
