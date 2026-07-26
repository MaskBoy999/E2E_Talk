import re

with open('server/src/db.rs', 'r', encoding='utf-8') as f:
    content = f.read()

# Find the function
func_start = content.find('    pub fn list_messages_around(')
assert func_start != -1, "Function not found"

# Find the end of the function (next pub fn or end of file)
remaining = content[func_start + 200:]
next_fn = remaining.find('\n    pub fn ')
if next_fn == -1:
    func_end = len(content)
else:
    func_end = func_start + 200 + next_fn

old_func = content[func_start:func_end]

# Build new function using two separate queries instead of UNION ALL
new_func = '''    pub fn list_messages_around(&self, channel_id: &str, around_message_id: &str, limit: i64) -> Result<Vec<Message>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let half = limit / 2;

        // Query messages before the target (inclusive) — newest first, limited to half
        let mut before_stmt = conn
            .prepare(
                "SELECT m.id, m.channel_id, m.sender_id,
                        m.encrypted_content, m.nonce, m.timestamp,
                        m.message_nonce, m.edited_at, m.message_signature,
                        m.encrypted_profile_key, m.profile_key_nonce, m.encrypted_banner_key, m.banner_key_nonce,
                        m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.encrypted_file_key, m.file_key_nonce,
                        m.encrypted_sender_username, m.sender_username_nonce,
                        m.sender_id_hash
                 FROM messages m
                 WHERE m.channel_id = ?1 AND m.timestamp <= (SELECT COALESCE(timestamp, '') FROM messages WHERE id = ?2)
                 ORDER BY m.timestamp DESC
                 LIMIT ?3",
            )
            .map_err(|e| e.to_string())?;
        let mut before: Vec<Message> = before_stmt
            .query_map(params![channel_id, around_message_id, half], |row| {
                Ok(Message {
                    id: row.get(0)?,
                    channel_id: row.get(1)?,
                    sender_id: row.get(2)?,
                    sender_username: String::new(),
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
                    file_key_nonce: row.get(17)?,
                    encrypted_sender_username: row.get(18)?,
                    sender_username_nonce: row.get(19)?,
                    sender_id_hash: row.get(20).ok().flatten(),
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
                        m.message_nonce, m.edited_at, m.message_signature,
                        m.encrypted_profile_key, m.profile_key_nonce, m.encrypted_banner_key, m.banner_key_nonce,
                        m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.encrypted_file_key, m.file_key_nonce,
                        m.encrypted_sender_username, m.sender_username_nonce,
                        m.sender_id_hash
                 FROM messages m
                 WHERE m.channel_id = ?1 AND m.timestamp > (SELECT COALESCE(timestamp, '') FROM messages WHERE id = ?2)
                 ORDER BY m.timestamp ASC
                 LIMIT ?3",
            )
            .map_err(|e| e.to_string())?;
        let after: Vec<Message> = after_stmt
            .query_map(params![channel_id, around_message_id, half], |row| {
                Ok(Message {
                    id: row.get(0)?,
                    channel_id: row.get(1)?,
                    sender_id: row.get(2)?,
                    sender_username: String::new(),
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
                    file_key_nonce: row.get(17)?,
                    encrypted_sender_username: row.get(18)?,
                    sender_username_nonce: row.get(19)?,
                    sender_id_hash: row.get(20).ok().flatten(),
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        // Combine: before (oldest-first) + after (oldest-first)
        before.extend(after);
        Ok(before)
    }'''

content = content[:func_start] + new_func + content[func_end:]

with open('server/src/db.rs', 'w', encoding='utf-8') as f:
    f.write(content)

print("Function replaced successfully")
