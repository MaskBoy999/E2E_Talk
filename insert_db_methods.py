"""Insert 5 new admin list DB methods after list_all_config_admin in server/src/db.rs"""
with open('server/src/db.rs', 'rb') as f:
    content = f.read()

# Use a very unique anchor: the end of list_all_config_admin followed by is_fresh_db
# This avoids any UTF-8 em-dash issues by only matching ASCII text
anchor = b"list_all_config_admin(&self) -> Result<Vec<(String, String)>, String>"

idx = content.find(anchor)
if idx == -1:
    print("ERROR: anchor not found!")
    exit(1)

# Find the closing brace of list_all_config_admin
# The method is a short one-liner, so it ends with:
#   rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
#   }
close_brace_marker = b"rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())"
idx2 = content.find(close_brace_marker, idx)
if idx2 == -1:
    print("ERROR: close brace marker not found!")
    exit(1)

# Find the end of the line with the close_brace_marker, then the next line's '}'
line_end = content.find(b'\n', idx2)
next_line_start = line_end + 1
# The next line should contain just '    }'
if content[next_line_start:next_line_start+5] == b'    }':
    closing_brace_end = content.find(b'\n', next_line_start) + 1
elif content[next_line_start:next_line_start+6] == b'    }\r':
    closing_brace_end = content.find(b'\n', next_line_start) + 1
else:
    print(f"ERROR: expected '    }}' but found: {content[next_line_start:next_line_start+10]}")
    # Try to find '    }' nearby
    alt_close = content.find(b'    }\r\n', idx2)
    if alt_close == -1:
        alt_close = content.find(b'    }\n', idx2)
    if alt_close == -1:
        exit(1)
    closing_brace_end = alt_close + 6  # len('    }\r\n') or 5 for '    }\n'

new_methods = b"""    pub fn list_all_prekey_bundles_admin(&self) -> Result<Vec<(String, String, String, String, Option<String>, Option<i32>, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT COALESCE(u.username, p.user_id), p.identity_key_public, p.signed_prekey_public, p.signed_prekey_signature, p.one_time_prekey_public, p.one_time_prekey_id, COALESCE(p.created_at, '')
             FROM prekey_bundles p
             LEFT JOIN users u ON p.user_id = u.id
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

"""

# Build new content = everything up to closing brace + new methods + everything after
new_content = content[:closing_brace_end] + new_methods + content[closing_brace_end:]
with open('server/src/db.rs', 'wb') as f:
    f.write(new_content)
print("Done! Inserted 5 new admin DB methods.")
