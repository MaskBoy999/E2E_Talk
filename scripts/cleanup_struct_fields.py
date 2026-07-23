import sys

def read_file(path):
    with open(path, 'rb') as f:
        content = f.read()
        # Handle CRLF -> LF
        if b'\r\n' in content:
            return content.replace(b'\r\n', b'\n').decode('utf-8'), True
        return content.decode('utf-8'), False

def write_file(path, text, had_crlf):
    if had_crlf:
        text = text.replace('\n', '\r\n')
    with open(path, 'wb') as f:
        f.write(text.encode('utf-8'))

# ============================================================
# DB.RS CLEANUP
# ============================================================
text, had_crlf = read_file('server/src/db.rs')
original = text

# --- 1. Fix Message struct: remove 3 fields ---
old_message_struct = '''    pub sender_display_name: Option<String>,
    pub sender_profile_pic: Option<String>,
    pub sender_username_color: Option<String>,
    pub sender_username_border_color: Option<String>,'''

new_message_struct = '''    pub sender_profile_pic: Option<String>,'''

assert old_message_struct in text, "Message struct pattern not found"
text = text.replace(old_message_struct, new_message_struct, 1)
print("OK: Message struct fields removed")

# --- 2. Fix DmMessage struct: remove 3 fields ---
old_dmmessage_struct = '''    pub sender_display_name: Option<String>,
    pub sender_profile_pic: Option<String>,
    pub sender_username_color: Option<String>,    pub sender_username_border_color: Option<String>,'''

new_dmmessage_struct = '''    pub sender_profile_pic: Option<String>,''' 

assert old_dmmessage_struct in text, "DmMessage struct pattern not found"
text = text.replace(old_dmmessage_struct, new_dmmessage_struct, 1)
print("OK: DmMessage struct fields removed")

# --- 3. Fix list_messages SQL and row.get() indices ---
# SQL: Remove NULL as display_name, NULL as username_color, NULL as username_border_color
# The SELECT currently has: u.username, NULL as display_name, u.profile_picture_file_id, NULL as username_color, NULL as username_border_color,
# After: u.username, u.profile_picture_file_id,

old_list_sql = '''                \"SELECT m.id, m.channel_id, m.sender_id, u.username, NULL as display_name, u.profile_picture_file_id, NULL as username_color, NULL as username_border_color,                        m.encrypted_content, m.nonce, m.timestamp,
                        m.message_nonce, m.edited_at, m.message_signature,
                        m.encrypted_profile_key, m.profile_key_nonce, m.encrypted_banner_key, m.banner_key_nonce,
                        m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.encrypted_file_key, m.file_key_nonce'''

new_list_sql = '''                \"SELECT m.id, m.channel_id, m.sender_id, u.username, u.profile_picture_file_id,
                        m.encrypted_content, m.nonce, m.timestamp,
                        m.message_nonce, m.edited_at, m.message_signature,
                        m.encrypted_profile_key, m.profile_key_nonce, m.encrypted_banner_key, m.banner_key_nonce,
                        m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.encrypted_file_key, m.file_key_nonce'''

count = text.count(old_list_sql)
assert count >= 2, f"list_messages SQL pattern should appear at least 2 times, found {count}"
text = text.replace(old_list_sql, new_list_sql, count)
print(f"OK: list_messages SQL cleaned ({count} occurrences)")

# Fix row.get() indices for list_messages queries (both list_messages and list_messages_around)
# Old indices: 0=id, 1=channel_id, 2=sender_id, 3=username, 4=display_name(removed), 5=profile_pic, 6=color(removed), 7=border(removed), 8=encrypted_content...
# New indices: 0=id, 1=channel_id, 2=sender_id, 3=username, 4=profile_pic, 5=encrypted_content...

# Pattern for the row.get() calls after removing 3 fields (all indices after 4 shift by -3)
old_row_indices = '''                    sender_display_name: row.get(4)?,
                    sender_profile_pic: row.get(5)?,
                    sender_username_color: row.get(6)?,
                    sender_username_border_color: row.get(7)?,
                    encrypted_content: row.get(8)?,
                    nonce: row.get(9)?,
                    timestamp: row.get(10)?,
                    message_nonce: row.get(11)?,
                    edited_at: row.get(12)?,
                    message_signature: row.get(13)?,
                    encrypted_profile_key: row.get(14)?,
                    profile_key_nonce: row.get(15)?,'''

new_row_indices = '''                    sender_profile_pic: row.get(4)?,
                    encrypted_content: row.get(5)?,
                    nonce: row.get(6)?,
                    timestamp: row.get(7)?,
                    message_nonce: row.get(8)?,
                    edited_at: row.get(9)?,
                    message_signature: row.get(10)?,
                    encrypted_profile_key: row.get(11)?,
                    profile_key_nonce: row.get(12)?,'''

count_indices = text.count(old_row_indices)
assert count_indices >= 2, f"Row indices pattern should appear at least 2 times, found {count_indices}"
text = text.replace(old_row_indices, new_row_indices, count_indices)
print(f"OK: list_messages row.get() indices adjusted ({count_indices} occurrences)")

# --- 4. Fix save_message None assignments ---
old_save_msg = '''            sender_display_name: None,
            sender_profile_pic: None,
            sender_username_color: None,            sender_username_border_color: None,''' 

new_save_msg = '''            sender_profile_pic: None,''' 

assert old_save_msg in text, "save_message None pattern not found"
text = text.replace(old_save_msg, new_save_msg, 1)
print("OK: save_message None assignments removed")

# --- 5. Fix list_dm_messages SQL ---
old_dm_list_sql = '''            \"SELECT m.id, m.dm_channel_id, m.sender_id, u.username, NULL as display_name, u.profile_picture_file_id, NULL as username_color, NULL as username_border_color,
                    m.encrypted_content, m.nonce, m.timestamp,
                    m.message_nonce, m.edited_at, m.message_signature,
                    m.encrypted_profile_key, m.profile_key_nonce, m.encrypted_banner_key, m.banner_key_nonce,
                    m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.encrypted_file_key, m.file_key_nonce'''

new_dm_list_sql = '''            \"SELECT m.id, m.dm_channel_id, m.sender_id, u.username, u.profile_picture_file_id,
                    m.encrypted_content, m.nonce, m.timestamp,
                    m.message_nonce, m.edited_at, m.message_signature,
                    m.encrypted_profile_key, m.profile_key_nonce, m.encrypted_banner_key, m.banner_key_nonce,
                    m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.encrypted_file_key, m.file_key_nonce'''

assert old_dm_list_sql in text, "DM list SQL pattern not found"
text = text.replace(old_dm_list_sql, new_dm_list_sql, 1)
print("OK: DM list SQL cleaned")

# Fix DM list row indices
old_dm_row_indices = '''                sender_display_name: row.get(4)?,
                sender_profile_pic: row.get(5)?,
                sender_username_color: row.get(6)?,
                sender_username_border_color: row.get(7)?,
                encrypted_content: row.get(8)?,
                nonce: row.get(9)?,
                timestamp: row.get(10)?,
                message_nonce: row.get(11)?,
                edited_at: row.get(12)?,
                message_signature: row.get(13)?,
                encrypted_profile_key: row.get(14)?,
                profile_key_nonce: row.get(15)?,
                encrypted_banner_key: row.get(16)?,
                banner_key_nonce: row.get(17)?,'''

new_dm_row_indices = '''                sender_profile_pic: row.get(4)?,
                encrypted_content: row.get(5)?,
                nonce: row.get(6)?,
                timestamp: row.get(7)?,
                message_nonce: row.get(8)?,
                edited_at: row.get(9)?,
                message_signature: row.get(10)?,
                encrypted_profile_key: row.get(11)?,
                profile_key_nonce: row.get(12)?,
                encrypted_banner_key: row.get(13)?,
                banner_key_nonce: row.get(14)?,'''

assert old_dm_row_indices in text, "DM row indices pattern not found"
text = text.replace(old_dm_row_indices, new_dm_row_indices, 1)
print("OK: DM list row.get() indices adjusted")

# --- 6. Fix save_dm_message None assignments ---
old_save_dm = '''            sender_display_name: None,
            sender_profile_pic: None,
            sender_username_color: None,            sender_username_border_color: None,''' 

assert old_save_dm in text, "save_dm_message None pattern not found (1)"
text = text.replace(old_save_dm, new_save_msg, 1)
print("OK: save_dm_message None assignments removed")

# --- 7. Fix get_message None assignments ---
# There are 2 occurrences of get_message/get_dm_message patterns
old_get_msg = '''            sender_display_name: None,
            sender_profile_pic: None,
            sender_username_color: None,            sender_username_border_color: None,''' 

count_get = text.count(old_get_msg)
if count_get >= 1:
    text = text.replace(old_get_msg, new_save_msg, count_get)
    print(f"OK: get_message/get_dm_message None assignments removed ({count_get} occurrences)")
else:
    print("FAIL: get_message pattern not found")

# --- 8. Fix get_dm_last_message SQL and row indices ---
old_last_sql = '''            \"SELECT m.id, m.dm_channel_id, m.sender_id, u.username, NULL as display_name, u.profile_picture_file_id, NULL as username_color, NULL as username_border_color,                        m.encrypted_content, m.nonce, m.timestamp, m.message_nonce, m.edited_at'''

new_last_sql = '''            \"SELECT m.id, m.dm_channel_id, m.sender_id, u.username, u.profile_picture_file_id,
                        m.encrypted_content, m.nonce, m.timestamp, m.message_nonce, m.edited_at'''

assert old_last_sql in text, "get_dm_last_message SQL pattern not found"
text = text.replace(old_last_sql, new_last_sql, 1)
print("OK: get_dm_last_message SQL cleaned")

old_last_row = '''                sender_display_name: row.get(4)?,
                sender_profile_pic: row.get(5)?,
                sender_username_color: row.get(6)?,
                sender_username_border_color: row.get(7)?,
                    encrypted_content: row.get(8)?,
                    nonce: row.get(9)?,
                    timestamp: row.get(10)?,
                    message_nonce: row.get(11)?,
                    edited_at: row.get(12)?,'''

new_last_row = '''                sender_profile_pic: row.get(4)?,
                    encrypted_content: row.get(5)?,
                    nonce: row.get(6)?,
                    timestamp: row.get(7)?,
                    message_nonce: row.get(8)?,
                    edited_at: row.get(9)?,'''

assert old_last_row in text, "get_dm_last_message row pattern not found"
text = text.replace(old_last_row, new_last_row, 1)
print("OK: get_dm_last_message row indices adjusted")

# --- 9. Fix admin list_messages SQL ---
old_admin_sql = '''                \"SELECT m.id, m.channel_id, m.sender_id, COALESCE(u.username, '?'), NULL as display_name, u.profile_picture_file_id, NULL as username_color, NULL as username_border_color,                        m.encrypted_content, m.nonce, m.timestamp, COALESCE(m.message_nonce, ''), COALESCE(m.edited_at, ''), COALESCE(m.message_signature, ''), COALESCE(m.encrypted_profile_key, ''), COALESCE(m.profile_key_nonce, ''), COALESCE(m.encrypted_banner_key, ''), COALESCE(m.banner_key_nonce, ''), m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.encrypted_file_key, m.file_key_nonce'''

new_admin_sql = '''                \"SELECT m.id, m.channel_id, m.sender_id, COALESCE(u.username, '?'), u.profile_picture_file_id,
                        m.encrypted_content, m.nonce, m.timestamp, COALESCE(m.message_nonce, ''), COALESCE(m.edited_at, ''), COALESCE(m.message_signature, ''), COALESCE(m.encrypted_profile_key, ''), COALESCE(m.profile_key_nonce, ''), COALESCE(m.encrypted_banner_key, ''), COALESCE(m.banner_key_nonce, ''), m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.encrypted_file_key, m.file_key_nonce'''

assert old_admin_sql in text, "Admin list SQL pattern not found"
text = text.replace(old_admin_sql, new_admin_sql, 1)
print("OK: Admin list messages SQL cleaned")

old_admin_row = '''                sender_display_name: row.get(4)?,
                sender_profile_pic: row.get(5)?,
                sender_username_color: row.get(6)?,
                sender_username_border_color: row.get(7)?,
                    encrypted_content: row.get(8)?,
                    nonce: row.get(9)?,
                    timestamp: row.get(10)?,
                    message_nonce: row.get(11)?,
                    edited_at: row.get(12)?,
                    message_signature: row.get(13)?,
                    encrypted_profile_key: row.get(14)?,
                    profile_key_nonce: row.get(15)?,'''

new_admin_row = '''                sender_profile_pic: row.get(4)?,
                    encrypted_content: row.get(5)?,
                    nonce: row.get(6)?,
                    timestamp: row.get(7)?,
                    message_nonce: row.get(8)?,
                    edited_at: row.get(9)?,
                    message_signature: row.get(10)?,
                    encrypted_profile_key: row.get(11)?,
                    profile_key_nonce: row.get(12)?,'''

assert old_admin_row in text, "Admin list row pattern not found"
text = text.replace(old_admin_row, new_admin_row, 1)
print("OK: Admin list messages row indices adjusted")

assert text != original, "No changes were made to db.rs"
write_file('server/src/db.rs', text, had_crlf)
print("=== db.rs cleanup complete ===")

# ============================================================
# WS.RS CLEANUP
# ============================================================
text, had_crlf = read_file('server/src/ws.rs')
original = text

# --- 10. Fix OutgoingChatMessage struct ---
old_chat_struct = '''    #[serde(skip_serializing_if = \"Option::is_none\")]
    sender_display_name: Option<String>,
    #[serde(skip_serializing_if = \"Option::is_none\")]
    sender_profile_pic: Option<String>,
    #[serde(skip_serializing_if = \"Option::is_none\")]
    sender_username_color: Option<String>,
    #[serde(skip_serializing_if = \"Option::is_none\")]
    sender_username_border_color: Option<String>,'''

new_chat_struct = '''    #[serde(skip_serializing_if = \"Option::is_none\")]
    sender_profile_pic: Option<String>,'''

assert old_chat_struct in text, "OutgoingChatMessage struct pattern not found"
text = text.replace(old_chat_struct, new_chat_struct, 1)
print("OK: OutgoingChatMessage struct fields removed")

# --- 11. Fix broadcast code (4 locations) ---
# Each location has:
#   let sender_display_name: Option<String> = None;
#   let sender_color: Option<String> = None;
#   let sender_border_color: Option<String> = None;
#   followed by: sender_display_name, and sender_username_color: sender_color, sender_username_border_color: sender_border_color

# Pattern 1: The let statements and the sender_profile_pic fetch 
old_ws_0 = '''            // Fetch sender's profile pic only (display name/colors come from encrypted snapshot/conversation_profile)
            let sender_profile_pic = match state.db.get_user_profile(user_id) {
                Ok((_, _, _, pp, _fk, _, _, _, _)) => pp,
                Err(_) => None,
            };
            let sender_display_name: Option<String> = None;
            let sender_color: Option<String> = None;
            let sender_border_color: Option<String> = None;'''

new_ws_0 = '''            // Fetch sender's profile pic only (display name/colors come from encrypted snapshot/conversation_profile)
            let sender_profile_pic = match state.db.get_user_profile(user_id) {
                Ok((_, _, _, pp, _fk, _, _, _, _)) => pp,
                Err(_) => None,
            };'''

count_ws_0 = text.count(old_ws_0)
assert count_ws_0 == 4, f"WS pattern 0 should appear 4 times, found {count_ws_0}"
text = text.replace(old_ws_0, new_ws_0, count_ws_0)
print(f"OK: WS let statements cleaned ({count_ws_0} occurrences)")

# Pattern 2: The field assignments in the OutgoingMessage construction
# Before: sender_display_name,\n                    sender_profile_pic: sender_profile_pic.clone(),\n                    sender_username_color: sender_color,\n                    sender_username_border_color: sender_border_color,
# After: sender_profile_pic: sender_profile_pic.clone(),

old_ws_fields = '''                    sender_display_name,
                    sender_profile_pic: sender_profile_pic.clone(),
                    sender_username_color: sender_color,
                    sender_username_border_color: sender_border_color,'''

new_ws_fields = '''                    sender_profile_pic: sender_profile_pic.clone(),'''

count_ws_fields = text.count(old_ws_fields)
assert count_ws_fields == 4, f"WS field pattern should appear 4 times, found {count_ws_fields}"
text = text.replace(old_ws_fields, new_ws_fields, count_ws_fields)
print(f"OK: WS field assignments cleaned ({count_ws_fields} occurrences)")

assert text != original, "No changes were made to ws.rs"
write_file('server/src/ws.rs', text, had_crlf)
print("=== ws.rs cleanup complete ===")
