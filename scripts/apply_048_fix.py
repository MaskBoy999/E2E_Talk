#!/usr/bin/env python3
"""Complete the migration-048 code cleanup (drop dead legacy columns).

The earlier apply_048_cleanup.py used LF patterns but db.rs/ws.rs are CRLF, so
multi-line replacements missed. This version normalizes each file's line endings
for matching and restores the original endings when writing back.

Run from the project root:  python scripts/apply_048_fix.py
"""
import sys

FILES = {
    "server/src/db.rs": "CRLF",
    "server/src/ws.rs": "CRLF",
    "server/src/handlers.rs": "LF",
}

def load(path):
    with open(path, "rb") as f:
        data = f.read()
    return data

def save(path, data):
    with open(path, "wb") as f:
        f.write(data)

def to_lf(data, style):
    if style == "CRLF":
        return data.replace(b"\r\n", b"\n").decode("utf-8")
    return data.decode("utf-8")

def from_lf(text, style):
    if style == "LF":
        return text.encode("utf-8")
    return text.replace("\n", "\r\n").encode("utf-8")

def apply_file(path, style, replacements, label):
    raw = load(path)
    src = to_lf(raw, style)
    misses = []
    for old, new, tag, count in replacements:
        n = src.count(old)
        if n < count:
            misses.append(f"{tag}: want>={count} found={n} :: {old[:60]!r}")
        else:
            src = src.replace(old, new)
    save(path, from_lf(src, style))
    if misses:
        print(f"!! {label}: {len(misses)} MISSED")
        for m in misses:
            print(f"   - {m}")
        return False
    print(f"OK  {label}")
    return True

ok = True

# ============ db.rs ============
db = []

# 1) Register migration 048
db.append((
    "        // Migration 047: Drop plaintext mime_type from files (encrypted_mime_type + mime_nonce exist)\n"
    "        let _ = conn.execute_batch(include_str!(\"../migrations/047_drop_files_mime_type.sql\"));\n",
    "        // Migration 047: Drop plaintext mime_type from files (encrypted_mime_type + mime_nonce exist)\n"
    "        let _ = conn.execute_batch(include_str!(\"../migrations/047_drop_files_mime_type.sql\"));\n"
    "\n"
    "        // Migration 048: Drop dead legacy columns (message_nonce, per-message profile/banner/file keys,\n"
    "        // users escrow/eph BLOBs, plaintext pic keys, servers.invite_code, key device_id/eph_pub)\n"
    "        let _ = conn.execute_batch(include_str!(\"../migrations/048_drop_legacy_message_and_key_columns.sql\"));\n",
    "register-048", 1,
))

# 2) Message + DmMessage struct: remove 7 dead fields (identical inner block in both)
struct_old = (
    "    pub timestamp: String,\n"
    "    pub message_nonce: Option<String>,\n"
    "    pub edited_at: Option<String>,\n"
    "    pub encrypted_profile_key: Option<String>,\n"
    "    pub profile_key_nonce: Option<String>,\n"
    "    pub encrypted_banner_key: Option<String>,\n"
    "    pub banner_key_nonce: Option<String>,\n"
    "    // Streamlined E2E fields (migration 022)\n"
    "    pub key_version: Option<i32>,\n"
    "    pub encrypted_profile_snapshot: Option<Vec<u8>>,\n"
    "    pub profile_snapshot_nonce: Option<Vec<u8>>,\n"
    "    pub encrypted_file_key: Option<Vec<u8>>,\n"
    "    pub file_key_nonce: Option<Vec<u8>>,\n"
    "    pub encrypted_sender_username: Option<String>,\n"
)
struct_new = (
    "    pub timestamp: String,\n"
    "    pub edited_at: Option<String>,\n"
    "    // Streamlined E2E fields (migration 022)\n"
    "    pub key_version: Option<i32>,\n"
    "    pub encrypted_profile_snapshot: Option<Vec<u8>>,\n"
    "    pub profile_snapshot_nonce: Option<Vec<u8>>,\n"
    "    pub encrypted_sender_username: Option<String>,\n"
)
db.append((struct_old, struct_new, "Message/DmMessage struct", 2))

# 3) list_messages + list_messages_before outer + inner SELECT column fragments (4x outer, 4x inner incl around)
outer_old = (
    "                        m.message_nonce, m.edited_at,\n"
    "                        m.encrypted_profile_key, m.profile_key_nonce, m.encrypted_banner_key, m.banner_key_nonce,\n"
    "                        m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.encrypted_file_key, m.file_key_nonce,\n"
)
outer_new = (
    "                        m.edited_at,\n"
    "                        m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce,\n"
)
db.append((outer_old, outer_new, "list outer SELECT cols", 4))

inner_old = (
    "                            message_nonce, edited_at,\n"
    "                            encrypted_profile_key, profile_key_nonce, encrypted_banner_key, banner_key_nonce,\n"
    "                            key_version, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_file_key, file_key_nonce,\n"
)
inner_new = (
    "                            edited_at,\n"
    "                            key_version, encrypted_profile_snapshot, profile_snapshot_nonce,\n"
)
db.append((inner_old, inner_new, "list inner SELECT cols", 2))

# 4) list_messages/list_messages_before row closure (2x, identical)
lm_row_old = (
    "                    timestamp: row.get(7)?,\n"
    "                    message_nonce: row.get(8)?,\n"
    "                    edited_at: row.get(9)?,\n"
    "                    encrypted_profile_key: row.get(10)?,\n"
    "                    profile_key_nonce: row.get(11)?,\n"
    "                    encrypted_banner_key: row.get(12)?,\n"
    "                    banner_key_nonce: row.get(13)?,\n"
    "                    key_version: row.get(14)?,\n"
    "                    encrypted_profile_snapshot: row.get(15)?,\n"
    "                    profile_snapshot_nonce: row.get(16)?,\n"
    "                    encrypted_file_key: row.get(17)?,\n"
    "                    file_key_nonce: row.get(18)?,\n"
    "                    encrypted_sender_username: row.get(19)?,\n"
    "                    sender_username_nonce: row.get(20)?,\n"
    "                    sender_id_hash: row.get(21).ok().flatten(),\n"
)
lm_row_new = (
    "                    timestamp: row.get(7)?,\n"
    "                    edited_at: row.get(8)?,\n"
    "                    key_version: row.get(9)?,\n"
    "                    encrypted_profile_snapshot: row.get(10)?,\n"
    "                    profile_snapshot_nonce: row.get(11)?,\n"
    "                    encrypted_sender_username: row.get(12)?,\n"
    "                    sender_username_nonce: row.get(13)?,\n"
    "                    sender_id_hash: row.get(14).ok().flatten(),\n"
)
db.append((lm_row_old, lm_row_new, "list_messages/before rows", 2))

# 5) list_messages_around row closure (2x)
ar_row_old = (
    "                    timestamp: row.get(5)?,\n"
    "                    message_nonce: row.get(6)?,\n"
    "                    edited_at: row.get(7)?,\n"
    "                    encrypted_profile_key: row.get(8)?,\n"
    "                    profile_key_nonce: row.get(9)?,\n"
    "                    encrypted_banner_key: row.get(10)?,\n"
    "                    banner_key_nonce: row.get(11)?,\n"
    "                    key_version: row.get(12)?,\n"
    "                    encrypted_profile_snapshot: row.get(13)?,\n"
    "                    profile_snapshot_nonce: row.get(14)?,\n"
    "                    encrypted_file_key: row.get(15)?,\n"
    "                    file_key_nonce: row.get(16)?,\n"
    "                    encrypted_sender_username: row.get(17)?,\n"
    "                    sender_username_nonce: row.get(18)?,\n"
    "                    sender_id_hash: row.get(19).ok().flatten(),\n"
)
ar_row_new = (
    "                    timestamp: row.get(5)?,\n"
    "                    edited_at: row.get(6)?,\n"
    "                    key_version: row.get(7)?,\n"
    "                    encrypted_profile_snapshot: row.get(8)?,\n"
    "                    profile_snapshot_nonce: row.get(9)?,\n"
    "                    encrypted_sender_username: row.get(10)?,\n"
    "                    sender_username_nonce: row.get(11)?,\n"
    "                    sender_id_hash: row.get(12).ok().flatten(),\n"
)
db.append((ar_row_old, ar_row_new, "list_messages_around rows", 2))

# 6) list_dm_messages + before: outer/inner fragments (dm variant has 20-space indent, matches channel ones)
# dm outer fragment
dm_outer_old = (
    "                    m.message_nonce, m.edited_at,\n"
    "                    m.encrypted_profile_key, m.profile_key_nonce, m.encrypted_banner_key, m.banner_key_nonce,\n"
    "                    m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.encrypted_file_key, m.file_key_nonce,\n"
)
dm_outer_new = (
    "                    m.edited_at,\n"
    "                    m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce,\n"
)
db.append((dm_outer_old, dm_outer_new, "dm list outer SELECT cols", 2))

dm_inner_old = (
    "                         message_nonce, edited_at,\n"
    "                         encrypted_profile_key, profile_key_nonce, encrypted_banner_key, banner_key_nonce,\n"
    "                         key_version, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_file_key, file_key_nonce,\n"
)
dm_inner_new = (
    "                         edited_at,\n"
    "                         key_version, encrypted_profile_snapshot, profile_snapshot_nonce,\n"
)
db.append((dm_inner_old, dm_inner_new, "dm list inner SELECT cols", 2))

dm_row_old = (
    "                message_nonce: row.get(8)?,\n"
    "                edited_at: row.get(9)?,\n"
    "                encrypted_profile_key: row.get(10)?,\n"
    "                profile_key_nonce: row.get(11)?,\n"
    "                encrypted_banner_key: row.get(12)?,\n"
    "                banner_key_nonce: row.get(13)?,\n"
    "                key_version: row.get(14)?,\n"
    "                encrypted_profile_snapshot: row.get(15)?,\n"
    "                profile_snapshot_nonce: row.get(16)?,\n"
    "                encrypted_file_key: row.get(17)?,\n"
    "                file_key_nonce: row.get(18)?,\n"
    "                encrypted_sender_username: row.get(19)?,\n"
    "                sender_username_nonce: row.get(20)?,\n"
    "                sender_id_hash: row.get(21).ok().flatten(),\n"
)
dm_row_new = (
    "                edited_at: row.get(8)?,\n"
    "                key_version: row.get(9)?,\n"
    "                encrypted_profile_snapshot: row.get(10)?,\n"
    "                profile_snapshot_nonce: row.get(11)?,\n"
    "                encrypted_sender_username: row.get(12)?,\n"
    "                sender_username_nonce: row.get(13)?,\n"
    "                sender_id_hash: row.get(14).ok().flatten(),\n"
)
db.append((dm_row_old, dm_row_new, "list_dm_messages/before rows", 2))

# 7) save_encrypted_message: sig + INSERT + struct
sav_sig_old = (
    "    pub fn save_encrypted_message(\n"
    "        &self,\n"
    "        channel_id: &str,\n"
    "        sender_id: &str,\n"
    "        encrypted_content: &[u8],\n"
    "        nonce: &[u8],\n"
    "        message_nonce: Option<&str>,\n"
    "        encrypted_profile_key: Option<&str>,\n"
    "        profile_key_nonce: Option<&str>,\n"
    "        encrypted_banner_key: Option<&str>,\n"
    "        banner_key_nonce: Option<&str>,\n"
    "        // Streamlined E2E fields\n"
    "        encrypted_profile_snapshot: Option<&[u8]>,\n"
    "        profile_snapshot_nonce: Option<&[u8]>,\n"
    "        encrypted_file_key: Option<&[u8]>,\n"
    "        file_key_nonce: Option<&[u8]>,\n"
    "        encrypted_sender_username: Option<&str>,\n"
    "        sender_username_nonce: Option<&str>,\n"
    "        file_id: Option<&str>,\n"
    "    ) -> Result<Message, String> {\n"
)
sav_sig_new = (
    "    pub fn save_encrypted_message(\n"
    "        &self,\n"
    "        channel_id: &str,\n"
    "        sender_id: &str,\n"
    "        encrypted_content: &[u8],\n"
    "        nonce: &[u8],\n"
    "        // Streamlined E2E fields\n"
    "        encrypted_profile_snapshot: Option<&[u8]>,\n"
    "        profile_snapshot_nonce: Option<&[u8]>,\n"
    "        encrypted_sender_username: Option<&str>,\n"
    "        sender_username_nonce: Option<&str>,\n"
    "        file_id: Option<&str>,\n"
    "    ) -> Result<Message, String> {\n"
)
db.append((sav_sig_old, sav_sig_new, "save_encrypted_message sig", 1))

sav_ins_old = (
    "            \"INSERT INTO messages (id, channel_id, sender_id, encrypted_content, nonce, timestamp, message_nonce, encrypted_profile_key, profile_key_nonce, encrypted_banner_key, banner_key_nonce, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_file_key, file_key_nonce, encrypted_sender_username, sender_username_nonce, sender_id_hash, file_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)\",\n"
    "            params![id, channel_id, sender_id, encrypted_content, nonce, ts, message_nonce, encrypted_profile_key, profile_key_nonce, encrypted_banner_key, banner_key_nonce, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_file_key, file_key_nonce, encrypted_sender_username, sender_username_nonce, h, file_id],\n"
)
sav_ins_new = (
    "            \"INSERT INTO messages (id, channel_id, sender_id, encrypted_content, nonce, timestamp, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_sender_username, sender_username_nonce, sender_id_hash, file_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)\",\n"
    "            params![id, channel_id, sender_id, encrypted_content, nonce, ts, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_sender_username, sender_username_nonce, h, file_id],\n"
)
db.append((sav_ins_old, sav_ins_new, "save_encrypted_message INSERT", 1))

sav_con_old = (
    "            message_nonce: message_nonce.map(|s| s.to_string()),\n"
    "            edited_at: None,\n"
    "            encrypted_profile_key: encrypted_profile_key.map(|s| s.to_string()),\n"
    "            profile_key_nonce: profile_key_nonce.map(|s| s.to_string()),\n"
    "            encrypted_banner_key: encrypted_banner_key.map(|s| s.to_string()),\n"
    "            banner_key_nonce: banner_key_nonce.map(|s| s.to_string()),\n"
    "            key_version: Some(1),\n"
    "            encrypted_profile_snapshot: encrypted_profile_snapshot.map(|v| v.to_vec()),\n"
    "            profile_snapshot_nonce: profile_snapshot_nonce.map(|v| v.to_vec()),\n"
    "            encrypted_file_key: encrypted_file_key.map(|v| v.to_vec()),\n"
    "            file_key_nonce: file_key_nonce.map(|v| v.to_vec()),\n"
    "            encrypted_sender_username: encrypted_sender_username.map(|s| s.to_string()),\n"
)
sav_con_new = (
    "            edited_at: None,\n"
    "            key_version: Some(1),\n"
    "            encrypted_profile_snapshot: encrypted_profile_snapshot.map(|v| v.to_vec()),\n"
    "            profile_snapshot_nonce: profile_snapshot_nonce.map(|v| v.to_vec()),\n"
    "            encrypted_sender_username: encrypted_sender_username.map(|s| s.to_string()),\n"
)
db.append((sav_con_old, sav_con_new, "save_encrypted_message struct", 1))

# 8) save_dm_message: sig + INSERT + struct (dm variant)
dmsv_sig_old = sav_sig_old.replace("channel_id", "dm_channel_id").replace("Result<Message", "Result<DmMessage")
dmsv_sig_new = sav_sig_new.replace("channel_id", "dm_channel_id").replace("Result<Message", "Result<DmMessage")
db.append((dmsv_sig_old, dmsv_sig_new, "save_dm_message sig", 1))

dmsv_ins_old = sav_ins_old.replace("INSERT INTO messages", "INSERT INTO dm_messages").replace(
    "id, channel_id, sender_id", "id, dm_channel_id, sender_id")
dmsv_ins_new = sav_ins_new.replace("INSERT INTO messages", "INSERT INTO dm_messages").replace(
    "id, channel_id, sender_id", "id, dm_channel_id, sender_id")
db.append((dmsv_ins_old, dmsv_ins_new, "save_dm_message INSERT", 1))

dmsv_con_old = sav_con_old.replace("key_version: Some(1),", "key_version: None,")
dmsv_con_new = sav_con_new.replace("key_version: Some(1),", "key_version: None,")
db.append((dmsv_con_old, dmsv_con_new, "save_dm_message struct", 1))

# 9) edit_encrypted_message: sig + UPDATE + re-SELECT rows
edit_sig_old = (
    "    pub fn edit_encrypted_message(\n"
    "        &self,\n"
    "        message_id: &str,\n"
    "        sender_id: &str,\n"
    "        new_encrypted_content: &[u8],\n"
    "        new_nonce: &[u8],\n"
    "        new_message_nonce: Option<&str>,\n"
    "        new_encrypted_profile_key: Option<&str>,\n"
    "        new_profile_key_nonce: Option<&str>,\n"
    "        new_encrypted_banner_key: Option<&str>,\n"
    "        new_banner_key_nonce: Option<&str>,\n"
    "    ) -> Result<Message, String> {\n"
)
edit_sig_new = (
    "    pub fn edit_encrypted_message(\n"
    "        &self,\n"
    "        message_id: &str,\n"
    "        sender_id: &str,\n"
    "        new_encrypted_content: &[u8],\n"
    "        new_nonce: &[u8],\n"
    "    ) -> Result<Message, String> {\n"
)
db.append((edit_sig_old, edit_sig_new, "edit_encrypted_message sig", 1))

edit_upd_old = (
    "            \"UPDATE messages SET encrypted_content = ?, nonce = ?, message_nonce = ?, encrypted_profile_key = COALESCE(?, encrypted_profile_key), profile_key_nonce = COALESCE(?, profile_key_nonce), encrypted_banner_key = COALESCE(?, encrypted_banner_key), banner_key_nonce = COALESCE(?, banner_key_nonce), edited_at = CURRENT_TIMESTAMP WHERE id = ?\",\n"
    "            params![new_encrypted_content, new_nonce, new_message_nonce, new_encrypted_profile_key, new_profile_key_nonce, new_encrypted_banner_key, new_banner_key_nonce, message_id],\n"
)
edit_upd_new = (
    "            \"UPDATE messages SET encrypted_content = ?, nonce = ?, edited_at = CURRENT_TIMESTAMP WHERE id = ?\",\n"
    "            params![new_encrypted_content, new_nonce, message_id],\n"
)
db.append((edit_upd_old, edit_upd_new, "edit_encrypted_message UPDATE", 1))

edit_row_old = (
    "                        encrypted_content: row.get(3)?,\n"
    "                        nonce: row.get(4)?,\n"
    "                        timestamp: row.get(5)?,\n"
    "                        message_nonce: row.get(6)?,\n"
    "                        edited_at: row.get(7)?,\n"
    "                        encrypted_profile_key: row.get(8)?,\n"
    "                        profile_key_nonce: row.get(9)?,\n"
    "                        encrypted_banner_key: row.get(10)?,\n"
    "                        banner_key_nonce: row.get(11)?,\n"
    "                        key_version: row.get(12)?,\n"
    "                        encrypted_profile_snapshot: row.get(13)?,\n"
    "                        profile_snapshot_nonce: row.get(14)?,\n"
    "                        encrypted_file_key: row.get(15)?,\n"
    "                        file_key_nonce: row.get(16)?,\n"
    "                    encrypted_sender_username: None,\n"
    "                    sender_username_nonce: None,\n"
    "                    sender_id_hash: None,\n"
    "                    file_id: None,\n"
)
edit_row_new = (
    "                        encrypted_content: row.get(3)?,\n"
    "                        nonce: row.get(4)?,\n"
    "                        timestamp: row.get(5)?,\n"
    "                        edited_at: row.get(6)?,\n"
    "                        key_version: row.get(7)?,\n"
    "                        encrypted_profile_snapshot: row.get(8)?,\n"
    "                        profile_snapshot_nonce: row.get(9)?,\n"
    "                        encrypted_sender_username: row.get(10)?,\n"
    "                        sender_username_nonce: row.get(11)?,\n"
    "                        sender_id_hash: row.get(12)?,\n"
    "                        file_id: row.get(13)?,\n"
)
db.append((edit_row_old, edit_row_new, "edit_encrypted_message rows", 1))

# 10) edit_dm_message: sig + UPDATE + rows
dedit_sig_old = edit_sig_old.replace("edit_encrypted_message", "edit_dm_message").replace("Result<Message", "Result<DmMessage")
dedit_sig_new = edit_sig_new.replace("edit_encrypted_message", "edit_dm_message").replace("Result<Message", "Result<DmMessage")
db.append((dedit_sig_old, dedit_sig_new, "edit_dm_message sig", 1))

dedit_upd_old = edit_upd_old.replace("UPDATE messages", "UPDATE dm_messages")
dedit_upd_new = edit_upd_new.replace("UPDATE messages", "UPDATE dm_messages")
db.append((dedit_upd_old, dedit_upd_new, "edit_dm_message UPDATE", 1))

dedit_row_old = edit_row_old.replace(
    "                    encrypted_sender_username: None,\n"
    "                    sender_username_nonce: None,\n",
    "                    encrypted_sender_username: None,\n"
    "                    sender_id_hash: None,\n"
    "                    sender_username_nonce: None,\n")
# actual dm row block order is: encrypted_sender_username None, sender_id_hash None, sender_username_nonce None, file_id None
dedit_row_old = (
    "                        encrypted_content: row.get(3)?,\n"
    "                        nonce: row.get(4)?,\n"
    "                        timestamp: row.get(5)?,\n"
    "                        message_nonce: row.get(6)?,\n"
    "                        edited_at: row.get(7)?,\n"
    "                        encrypted_profile_key: row.get(8)?,\n"
    "                        profile_key_nonce: row.get(9)?,\n"
    "                        encrypted_banner_key: row.get(10)?,\n"
    "                        banner_key_nonce: row.get(11)?,\n"
    "                        key_version: row.get(12)?,\n"
    "                        encrypted_profile_snapshot: row.get(13)?,\n"
    "                        profile_snapshot_nonce: row.get(14)?,\n"
    "                        encrypted_file_key: row.get(15)?,\n"
    "                        file_key_nonce: row.get(16)?,\n"
    "                    encrypted_sender_username: None,\n"
    "                    sender_id_hash: None,\n"
    "                    sender_username_nonce: None,\n"
    "                    file_id: None,\n"
)
dedit_row_new = (
    "                        encrypted_content: row.get(3)?,\n"
    "                        nonce: row.get(4)?,\n"
    "                        timestamp: row.get(5)?,\n"
    "                        edited_at: row.get(6)?,\n"
    "                        key_version: row.get(7)?,\n"
    "                        encrypted_profile_snapshot: row.get(8)?,\n"
    "                        profile_snapshot_nonce: row.get(9)?,\n"
    "                        encrypted_sender_username: row.get(10)?,\n"
    "                        sender_username_nonce: row.get(11)?,\n"
    "                        sender_id_hash: row.get(12)?,\n"
    "                        file_id: row.get(13)?,\n"
)
db.append((dedit_row_old, dedit_row_new, "edit_dm_message rows", 1))

# 11) get_dm_last_message SQL + struct
gdm_sql_old = (
    "            \"SELECT m.id, m.dm_channel_id, m.sender_id, u.username, u.profile_picture_file_id,\n"
    "                        m.encrypted_content, m.nonce, m.timestamp, m.message_nonce, m.edited_at\n"
)
gdm_sql_new = (
    "            \"SELECT m.id, m.dm_channel_id, m.sender_id, u.username, u.profile_picture_file_id,\n"
    "                        m.encrypted_content, m.nonce, m.timestamp, m.edited_at\n"
)
db.append((gdm_sql_old, gdm_sql_new, "get_dm_last_message SQL", 1))

gdm_con_old = (
    "                    message_nonce: row.get(8)?,\n"
    "                    edited_at: row.get(9)?,\n"
    "                    encrypted_profile_key: None,\n"
    "                    profile_key_nonce: None,\n"
    "                    encrypted_banner_key: None,\n"
    "                    banner_key_nonce: None,\n"
    "                    key_version: None,\n"
    "                    encrypted_profile_snapshot: None,\n"
    "                    profile_snapshot_nonce: None,\n"
    "                    encrypted_file_key: None,\n"
    "                    file_key_nonce: None,\n"
    "                    sender_id_hash: None,\n"
    "                    file_id: None,\n"
    "                    encrypted_sender_username: None,\n"
    "                    sender_username_nonce: None,\n"
)
gdm_con_new = (
    "                    edited_at: row.get(8)?,\n"
    "                    key_version: None,\n"
    "                    encrypted_profile_snapshot: None,\n"
    "                    profile_snapshot_nonce: None,\n"
    "                    sender_id_hash: None,\n"
    "                    file_id: None,\n"
    "                    encrypted_sender_username: None,\n"
    "                    sender_username_nonce: None,\n"
)
db.append((gdm_con_old, gdm_con_new, "get_dm_last_message struct", 1))

# 12) list_all_messages_admin SQL + rows
adm_sql_old = (
    "                \"SELECT m.id, m.channel_id, m.sender_id, COALESCE(u.username, '?'), u.profile_picture_file_id,\n"
    "                        m.encrypted_content, m.nonce, m.timestamp, COALESCE(m.message_nonce, ''), COALESCE(m.edited_at, ''), COALESCE(m.encrypted_profile_key, ''), COALESCE(m.profile_key_nonce, ''), COALESCE(m.encrypted_banner_key, ''), COALESCE(m.banner_key_nonce, ''), m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.encrypted_file_key, m.file_key_nonce, COALESCE(m.sender_id_hash, '')\n"
    "                 FROM messages m LEFT JOIN users u ON m.sender_id = u.id ORDER BY m.timestamp DESC LIMIT 500\",\n"
)
adm_sql_new = (
    "                \"SELECT m.id, m.channel_id, m.sender_id, COALESCE(u.username, '?'), u.profile_picture_file_id,\n"
    "                        m.encrypted_content, m.nonce, m.timestamp, COALESCE(m.edited_at, ''), m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, COALESCE(m.sender_id_hash, '')\n"
    "                 FROM messages m LEFT JOIN users u ON m.sender_id = u.id ORDER BY m.timestamp DESC LIMIT 500\",\n"
)
db.append((adm_sql_old, adm_sql_new, "admin messages SQL", 1))

adm_row_old = (
    "                    encrypted_content: row.get(5)?,\n"
    "                    nonce: row.get(6)?,\n"
    "                    timestamp: row.get(7)?,\n"
    "                    message_nonce: row.get(8)?,\n"
    "                    edited_at: row.get(9)?,\n"
    "                    encrypted_profile_key: Some(row.get(10)?),\n"
    "                    profile_key_nonce: Some(row.get(11)?),\n"
    "                    encrypted_banner_key: Some(row.get(12)?),\n"
    "                    banner_key_nonce: Some(row.get(13)?),\n"
    "                    key_version: row.get(14)?,\n"
    "                    encrypted_profile_snapshot: row.get(15)?,\n"
    "                    profile_snapshot_nonce: row.get(16)?,\n"
    "                    encrypted_file_key: row.get(17)?,\n"
    "                    file_key_nonce: row.get(18)?,\n"
    "                    encrypted_sender_username: None,\n"
    "                    sender_username_nonce: None,\n"
    "                    sender_id_hash: Some(row.get(19)?),\n"
    "                    file_id: None,\n"
)
adm_row_new = (
    "                    encrypted_content: row.get(5)?,\n"
    "                    nonce: row.get(6)?,\n"
    "                    timestamp: row.get(7)?,\n"
    "                    edited_at: row.get(8)?,\n"
    "                    key_version: row.get(9)?,\n"
    "                    encrypted_profile_snapshot: row.get(10)?,\n"
    "                    profile_snapshot_nonce: row.get(11)?,\n"
    "                    encrypted_sender_username: None,\n"
    "                    sender_username_nonce: None,\n"
    "                    sender_id_hash: Some(row.get(12)?),\n"
    "                    file_id: None,\n"
)
db.append((adm_row_old, adm_row_new, "admin messages rows", 1))

# 13) list_all_dm_messages_admin: tuple + SQL + rows
adm_dm_tup_old = (
    "    ) -> Result<Vec<(String, String, String, String, Vec<u8>, Vec<u8>, String, Option<i32>, Option<Vec<u8>>, Option<Vec<u8>>, Option<Vec<u8>>, Option<Vec<u8>>, Option<String>)>, String> {\n"
)
adm_dm_tup_new = (
    "    ) -> Result<Vec<(String, String, String, String, Vec<u8>, Vec<u8>, String, Option<i32>, Option<Vec<u8>>, Option<Vec<u8>>, Option<String>)>, String> {\n"
)
db.append((adm_dm_tup_old, adm_dm_tup_new, "admin dm tuple", 1))

adm_dm_sql_old = (
    "                \"SELECT m.id, m.dm_channel_id, m.sender_id, COALESCE(u.username, '?'), m.encrypted_content, m.nonce, m.timestamp, m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.encrypted_file_key, m.file_key_nonce, m.sender_id_hash\n"
    "                 FROM dm_messages m LEFT JOIN users u ON m.sender_id = u.id ORDER BY m.timestamp DESC LIMIT 500\",\n"
)
adm_dm_sql_new = (
    "                \"SELECT m.id, m.dm_channel_id, m.sender_id, COALESCE(u.username, '?'), m.encrypted_content, m.nonce, m.timestamp, m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.sender_id_hash\n"
    "                 FROM dm_messages m LEFT JOIN users u ON m.sender_id = u.id ORDER BY m.timestamp DESC LIMIT 500\",\n"
)
db.append((adm_dm_sql_old, adm_dm_sql_new, "admin dm SQL", 1))

adm_dm_row_old = (
    "                    row.get::<_, Option<Vec<u8>>>(8)?,\n"
    "                    row.get::<_, Option<Vec<u8>>>(9)?,\n"
    "                    row.get::<_, Option<Vec<u8>>>(10)?,\n"
    "                    row.get::<_, Option<Vec<u8>>>(11)?,\n"
    "                    row.get::<_, Option<String>>(12)?,\n"
)
adm_dm_row_new = (
    "                    row.get::<_, Option<Vec<u8>>>(8)?,\n"
    "                    row.get::<_, Option<Vec<u8>>>(9)?,\n"
    "                    row.get::<_, Option<String>>(10)?,\n"
)
db.append((adm_dm_row_old, adm_dm_row_new, "admin dm rows", 1))

# 14) save_server_key: sig + INSERT (drop device_id)
ssk_old = (
    "    pub fn save_server_key(\n"
    "        &self,\n"
    "        server_id: &str,\n"
    "        user_id: &str,\n"
    "        encrypted_key: &[u8],\n"
    "        sender_public_key: &[u8],\n"
    "        nonce: &[u8],\n"
    "        device_id: Option<&str>,\n"
    "    ) -> Result<(), String> {\n"
    "        let conn = self.conn.lock().map_err(|e| e.to_string())?;\n"
    "        conn.execute(\n"
    "            \"INSERT INTO server_keys (server_id, user_id, encrypted_key, sender_public_key, nonce, version, device_id)\n"
    "             VALUES (?1, ?2, ?3, ?4, ?5, COALESCE((SELECT MAX(version) FROM server_keys WHERE server_id = ?1), 0) + 1, ?6)\",\n"
    "            params![server_id, user_id, encrypted_key, sender_public_key, nonce, device_id.unwrap_or(\"\")],\n"
    "        )\n"
)
ssk_new = (
    "    pub fn save_server_key(\n"
    "        &self,\n"
    "        server_id: &str,\n"
    "        user_id: &str,\n"
    "        encrypted_key: &[u8],\n"
    "        sender_public_key: &[u8],\n"
    "        nonce: &[u8],\n"
    "    ) -> Result<(), String> {\n"
    "        let conn = self.conn.lock().map_err(|e| e.to_string())?;\n"
    "        conn.execute(\n"
    "            \"INSERT INTO server_keys (server_id, user_id, encrypted_key, sender_public_key, nonce, version)\n"
    "             VALUES (?1, ?2, ?3, ?4, ?5, COALESCE((SELECT MAX(version) FROM server_keys WHERE server_id = ?1), 0) + 1)\",\n"
    "            params![server_id, user_id, encrypted_key, sender_public_key, nonce],\n"
    "        )\n"
)
db.append((ssk_old, ssk_new, "save_server_key", 1))

# 15) save_dm_key: sig + INSERT (drop device_id)
sdk_old = (
    "    pub fn save_dm_key(\n"
    "        &self,\n"
    "        dm_channel_id: &str,\n"
    "        user_id: &str,\n"
    "        encrypted_key: &[u8],\n"
    "        sender_public_key: &[u8],\n"
    "        nonce: &[u8],\n"
    "        device_id: Option<&str>,\n"
    "    ) -> Result<(), String> {\n"
    "        let conn = self.conn.lock().map_err(|e| e.to_string())?;\n"
    "        conn.execute(\n"
    "            \"INSERT INTO dm_keys (dm_channel_id, user_id, encrypted_key, sender_public_key, nonce, device_id)\n"
    "             VALUES (?1, ?2, ?3, ?4, ?5, ?6)\",\n"
    "            params![dm_channel_id, user_id, encrypted_key, sender_public_key, nonce, device_id.unwrap_or(\"\")],\n"
    "        )\n"
)
sdk_new = (
    "    pub fn save_dm_key(\n"
    "        &self,\n"
    "        dm_channel_id: &str,\n"
    "        user_id: &str,\n"
    "        encrypted_key: &[u8],\n"
    "        sender_public_key: &[u8],\n"
    "        nonce: &[u8],\n"
    "    ) -> Result<(), String> {\n"
    "        let conn = self.conn.lock().map_err(|e| e.to_string())?;\n"
    "        conn.execute(\n"
    "            \"INSERT INTO dm_keys (dm_channel_id, user_id, encrypted_key, sender_public_key, nonce)\n"
    "             VALUES (?1, ?2, ?3, ?4, ?5)\",\n"
    "            params![dm_channel_id, user_id, encrypted_key, sender_public_key, nonce],\n"
    "        )\n"
)
db.append((sdk_old, sdk_new, "save_dm_key", 1))

# 16) list_all_server_keys_admin: tuple + SQL + rows (drop device_id)
ask_tup_old = (
    "    ) -> Result<Vec<(String, String, String, Vec<u8>, Vec<u8>, Vec<u8>, i32, String, String)>, String> {\n"
)
ask_tup_new = (
    "    ) -> Result<Vec<(String, String, String, Vec<u8>, Vec<u8>, Vec<u8>, i32, String)>, String> {\n"
)
db.append((ask_tup_old, ask_tup_new, "admin server keys tuple", 1))

ask_sql_old = (
    "                \"SELECT sk.server_id, s.id, sk.user_id, sk.encrypted_key, sk.sender_public_key, sk.nonce, sk.version, COALESCE(sk.device_id, ''), sk.created_at\n"
)
ask_sql_new = (
    "                \"SELECT sk.server_id, s.id, sk.user_id, sk.encrypted_key, sk.sender_public_key, sk.nonce, sk.version, sk.created_at\n"
)
db.append((ask_sql_old, ask_sql_new, "admin server keys SQL", 1))

ask_row_old = (
    "                    row.get::<_, String>(7)?,\n"
    "                    row.get::<_, String>(8)?,\n"
)
ask_row_new = (
    "                    row.get::<_, String>(7)?,\n"
)
db.append((ask_row_old, ask_row_new, "admin server keys rows", 1))

# 17) list_all_dm_keys_admin: tuple + SQL + rows (drop device_id)
adk_tup_old = (
    "    ) -> Result<Vec<(String, String, String, Vec<u8>, Vec<u8>, Vec<u8>, String, String)>, String> {\n"
)
adk_tup_new = (
    "    ) -> Result<Vec<(String, String, String, Vec<u8>, Vec<u8>, Vec<u8>, String)>, String> {\n"
)
db.append((adk_tup_old, adk_tup_new, "admin dm keys tuple", 1))

adk_sql_old = (
    "        let sql = \"SELECT dk.dm_channel_id, dk.user_id, COALESCE(u.username, '?'), dk.encrypted_key, dk.sender_public_key, dk.nonce, COALESCE(dk.device_id, ''), dk.created_at\n"
)
adk_sql_new = (
    "        let sql = \"SELECT dk.dm_channel_id, dk.user_id, COALESCE(u.username, '?'), dk.encrypted_key, dk.sender_public_key, dk.nonce, dk.created_at\n"
)
db.append((adk_sql_old, adk_sql_new, "admin dm keys SQL", 1))

adk_row_old = (
    "                    row.get::<_, String>(6)?,\n"
    "                    row.get::<_, String>(7)?,\n"
)
adk_row_new = (
    "                    row.get::<_, String>(6)?,\n"
)
db.append((adk_row_old, adk_row_new, "admin dm keys rows", 1))

ok &= apply_file("server/src/db.rs", "CRLF", db, "db.rs")

# ============ ws.rs ============
ws = []

# OutgoingChatMessage struct: remove message_nonce + file-key fields
wsc_old = (
    "    #[serde(skip_serializing_if = \"Option::is_none\")]\n"
    "    message_nonce: Option<String>,\n"
    "    #[serde(skip_serializing_if = \"Option::is_none\")]\n"
    "    edited_at: Option<String>,\n"
    "    // Streamlined E2E fields\n"
    "    #[serde(skip_serializing_if = \"Option::is_none\")]\n"
    "    key_version: Option<i32>,\n"
    "    #[serde(skip_serializing_if = \"Option::is_none\")]\n"
    "    encrypted_profile_snapshot: Option<String>,\n"
    "    #[serde(skip_serializing_if = \"Option::is_none\")]\n"
    "    profile_snapshot_nonce: Option<String>,\n"
    "    #[serde(skip_serializing_if = \"Option::is_none\")]\n"
    "    encrypted_file_key: Option<String>,\n"
    "    #[serde(skip_serializing_if = \"Option::is_none\")]\n"
    "    file_key_nonce: Option<String>,\n"
    "}\n"
)
wsc_new = (
    "    #[serde(skip_serializing_if = \"Option::is_none\")]\n"
    "    edited_at: Option<String>,\n"
    "    // Streamlined E2E fields\n"
    "    #[serde(skip_serializing_if = \"Option::is_none\")]\n"
    "    key_version: Option<i32>,\n"
    "    #[serde(skip_serializing_if = \"Option::is_none\")]\n"
    "    encrypted_profile_snapshot: Option<String>,\n"
    "    #[serde(skip_serializing_if = \"Option::is_none\")]\n"
    "    profile_snapshot_nonce: Option<String>,\n"
    "}\n"
)
ws.append((wsc_old, wsc_new, "OutgoingChatMessage struct", 1))

# Parse blocks: message_nonce (4x), profile/banner 4-line (4x), file-key 2-line (2x)
mn_parse = (
    "            let message_nonce = parsed.get(\"message_nonce\").and_then(|c| c.as_str()).map(|s| s.to_string());\n"
)
ws.append((mn_parse, "", "message_nonce parse", 4))

pb_parse = (
    "            let encrypted_profile_key = parsed.get(\"encrypted_profile_key\").and_then(|c| c.as_str()).map(|s| s.to_string());\n"
    "            let profile_key_nonce = parsed.get(\"profile_key_nonce\").and_then(|c| c.as_str()).map(|s| s.to_string());\n"
    "            let encrypted_banner_key = parsed.get(\"encrypted_banner_key\").and_then(|c| c.as_str()).map(|s| s.to_string());\n"
    "            let banner_key_nonce = parsed.get(\"banner_key_nonce\").and_then(|c| c.as_str()).map(|s| s.to_string());\n"
)
ws.append((pb_parse, "", "profile/banner parse", 4))

fk_parse = (
    "            let encrypted_file_key_parsed = parsed.get(\"encrypted_file_key\").and_then(|c| c.as_str()).and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());\n"
    "            let file_key_nonce_parsed = parsed.get(\"file_key_nonce\").and_then(|c| c.as_str()).and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());\n"
)
ws.append((fk_parse, "", "file-key parse", 2))

# Broadcast blocks: message_nonce line (4x)
bc_mn = "                    message_nonce: message.message_nonce,\n"
ws.append((bc_mn, "", "broadcast message_nonce", 4))

# send broadcasts file-key lines (2x)
bc_fk_send = (
    "                    encrypted_file_key: encrypted_file_key_parsed.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),\n"
    "                    file_key_nonce: file_key_nonce_parsed.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),\n"
)
ws.append((bc_fk_send, "", "broadcast file-key send", 2))

# edit broadcasts file-key None lines (2x)
bc_fk_edit = (
    "                    encrypted_file_key: None,\n"
    "                    file_key_nonce: None,\n"
)
ws.append((bc_fk_edit, "", "broadcast file-key edit", 2))

ok &= apply_file("server/src/ws.rs", "CRLF", ws, "ws.rs")

# ============ handlers.rs ============
hd = []

# REST list_messages JSON (region 2570): remove dead fields
h_msg_old = (
    "                \"message_nonce\": m.message_nonce,\n"
    "                \"encrypted_profile_key\": m.encrypted_profile_key,\n"
    "                \"profile_key_nonce\": m.profile_key_nonce,\n"
    "                \"encrypted_banner_key\": m.encrypted_banner_key,\n"
    "                \"banner_key_nonce\": m.banner_key_nonce,\n"
)
h_msg_new = ""
hd.append((h_msg_old, h_msg_new, "REST list_messages msg json (b-keys)", 1))

h_msg_fk_old = (
    "                \"encrypted_file_key\": m.encrypted_file_key.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),\n"
    "                \"file_key_nonce\": m.file_key_nonce.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),\n"
)
h_msg_fk_new = ""
hd.append((h_msg_fk_old, h_msg_fk_new, "REST list_messages msg json (file-keys)", 1))

# DM last-message JSON (4673)
h_dm_last_old = "                        \"message_nonce\": m.message_nonce,\n"
h_dm_last_new = ""
hd.append((h_dm_last_old, h_dm_last_new, "REST dm last_message json", 1))

# list_dm_messages JSON (4754)
h_dm_old = (
    "                        \"message_nonce\": m.message_nonce,\n"
    "                        \"edited_at\": m.edited_at,\n"
    "                        \"encrypted_profile_key\": m.encrypted_profile_key,\n"
    "                        \"profile_key_nonce\": m.profile_key_nonce,\n"
    "                        \"encrypted_banner_key\": m.encrypted_banner_key,\n"
    "                        \"banner_key_nonce\": m.banner_key_nonce,\n"
)
h_dm_new = (
    "                        \"edited_at\": m.edited_at,\n"
)
hd.append((h_dm_old, h_dm_new, "REST list_dm_messages json (b-keys)", 1))

h_dm_fk_old = (
    "                        \"encrypted_file_key\": m.encrypted_file_key.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),\n"
    "                        \"file_key_nonce\": m.file_key_nonce.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),\n"
)
h_dm_fk_new = ""
hd.append((h_dm_fk_old, h_dm_fk_new, "REST list_dm_messages json (file-keys)", 1))

# admin_list_server_keys: destructure + device_id line
h_ask_old = (
    "        .map(|(sid, sname, uid, ek, spk, nonce, ver, did, ts)| {\n"
)
h_ask_new = (
    "        .map(|(sid, sname, uid, ek, spk, nonce, ver, ts)| {\n"
)
hd.append((h_ask_old, h_ask_new, "admin server keys destructure", 1))

h_ask_dev_old = "                \"device_id\": did,\n"
h_ask_dev_new = ""
hd.append((h_ask_dev_old, h_ask_dev_new, "admin server keys device_id json", 1))

# admin_list_dm_keys: destructure + device_id line
h_adk_old = (
    "    let result: Vec<serde_json::Value> = rows.iter().map(|(dm_id, uid, uname, ek, spk, nonce, device_id, created_at)| {\n"
)
h_adk_new = (
    "    let result: Vec<serde_json::Value> = rows.iter().map(|(dm_id, uid, uname, ek, spk, nonce, created_at)| {\n"
)
hd.append((h_adk_old, h_adk_new, "admin dm keys destructure", 1))

h_adk_dev_old = "            \"device_id\": device_id,\n"
h_adk_dev_new = ""
hd.append((h_adk_dev_old, h_adk_dev_new, "admin dm keys device_id json", 1))

# save_dm_key caller
h_sdk_old = "    match state.db.save_dm_key(&dm_channel_id, &req.user_id, &encrypted_key, &sender_pub, &nonce, None) {\n"
h_sdk_new = "    match state.db.save_dm_key(&dm_channel_id, &req.user_id, &encrypted_key, &sender_pub, &nonce) {\n"
hd.append((h_sdk_old, h_sdk_new, "save_dm_key caller", 1))

# save_server_key callers (drop trailing None)
h_ssk_old = "    match state.db.save_server_key(&server_id, &req.user_id, &encrypted_key, &sender_pub, &nonce, None) {\n"
h_ssk_new = "    match state.db.save_server_key(&server_id, &req.user_id, &encrypted_key, &sender_pub, &nonce) {\n"
hd.append((h_ssk_old, h_ssk_new, "save_server_key caller 1", 1))
h_ssk2_old = "        let _ = state.db.save_server_key(&server_id, &entry.user_id, &encrypted_key, &sender_pub, &nonce, None);\n"
h_ssk2_new = "        let _ = state.db.save_server_key(&server_id, &entry.user_id, &encrypted_key, &sender_pub, &nonce);\n"
hd.append((h_ssk2_old, h_ssk2_new, "save_server_key caller 2", 1))

ok &= apply_file("server/src/handlers.rs", "LF", hd, "handlers.rs")

print()
print("ALL DONE" if ok else "SOME REPLACEMENTS MISSED - fix before building")
sys.exit(0 if ok else 1)
