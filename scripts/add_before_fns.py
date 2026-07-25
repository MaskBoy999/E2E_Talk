with open('server/src/db.rs', 'r') as f:
    content = f.read()

# Insert list_messages_before after list_messages
old = '        Ok(messages)\n    }\n\n    /// Return up to `limit` messages centered around the message with ID `around_message_id`.'

new = '''        Ok(messages)
    }

    pub fn list_messages_before(&self, channel_id: &str, before_timestamp: &str, limit: i64) -> Result<Vec<Message>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT m.id, m.channel_id, m.sender_id, u.username, u.profile_picture_file_id,
                        m.encrypted_content, m.nonce, m.timestamp,
                        m.message_nonce, m.edited_at, m.message_signature,
                        m.encrypted_profile_key, m.profile_key_nonce, m.encrypted_banner_key, m.banner_key_nonce,
                        m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.encrypted_file_key, m.file_key_nonce,
                        m.encrypted_sender_username, m.sender_username_nonce,
                        m.sender_id_hash
                 FROM (
                     SELECT id, channel_id, sender_id, encrypted_content, nonce, timestamp,
                            message_nonce, edited_at, message_signature,
                            encrypted_profile_key, profile_key_nonce, encrypted_banner_key, banner_key_nonce,
                            key_version, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_file_key, file_key_nonce,
                            encrypted_sender_username, sender_username_nonce,
                            sender_id_hash
                     FROM messages
                     WHERE channel_id = ?1 AND timestamp < ?3
                     ORDER BY timestamp DESC
                     LIMIT ?2
                 ) m
                 INNER JOIN users u ON m.sender_id = u.id
                 ORDER BY m.timestamp ASC",
            )
            .map_err(|e| e.to_string())?;
        let messages = stmt
            .query_map(params![channel_id, limit, before_timestamp], |row| {
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
                    sender_id_hash: row.get(22).ok().flatten(),
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(messages)
    }

    /// Return up to `limit` messages centered around the message with ID `around_message_id`.\n
    /// Return up to `limit` messages centered around the message with ID `around_message_id`.\n

    /// Return up to `limit` messages centered around the message with ID `around_message_id`.'''

content = content.replace(old, new)

# Now add list_dm_messages_before after list_dm_messages
old2 = '''        Ok(rows)
    }

    pub fn save_dm_message('''

new2 = '''        Ok(rows)
    }

    pub fn list_dm_messages_before(&self, dm_channel_id: &str, before_timestamp: &str, limit: i64) -> Result<Vec<DmMessage>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT m.id, m.dm_channel_id, m.sender_id, u.username, u.profile_picture_file_id,
                    m.encrypted_content, m.nonce, m.timestamp,
                    m.message_nonce, m.edited_at, m.message_signature,
                    m.encrypted_profile_key, m.profile_key_nonce, m.encrypted_banner_key, m.banner_key_nonce,
                    m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.encrypted_file_key, m.file_key_nonce,
                    m.encrypted_sender_username, m.sender_username_nonce,
                    m.sender_id_hash
             FROM (
                  SELECT id, dm_channel_id, sender_id, encrypted_content, nonce, timestamp,
                         message_nonce, edited_at, message_signature,
                         encrypted_profile_key, profile_key_nonce, encrypted_banner_key, banner_key_nonce,
                         key_version, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_file_key, file_key_nonce,
                         encrypted_sender_username, sender_username_nonce,
                         sender_id_hash
                  FROM dm_messages
                  WHERE dm_channel_id = ?1 AND timestamp < ?3
                  ORDER BY timestamp DESC
                  LIMIT ?2
              ) m
              INNER JOIN users u ON m.sender_id = u.id
              ORDER BY m.timestamp ASC",
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![dm_channel_id, limit, before_timestamp], |row| {
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
                sender_id_hash: row.get(22).ok().flatten(),
            })
        }).map_err(|e| e.to_string())?;
        let mut output = Vec::new();
        for r in rows {
            output.push(r.map_err(|e| e.to_string())?);
        }
        Ok(output)
    }

    pub fn save_dm_message('''

content = content.replace(old2, new2)

with open('server/src/db.rs', 'w') as f:
    f.write(content)

print('Done: added list_messages_before and list_dm_messages_before')
