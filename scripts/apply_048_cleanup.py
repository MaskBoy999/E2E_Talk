#!/usr/bin/env python3
"""Apply migration-048 code cleanup (drop dead legacy columns).

Every replacement must match exactly; the script reports any that don't so the
caller can fix them before building. Run from the project root.
"""
import sys

DB_RS = "server/src/db.rs"
WS_RS = "server/src/ws.rs"
HANDLERS_RS = "server/src/handlers.rs"

# ---- helpers ----
def apply(path, replacements, label):
    with open(path, "r", encoding="utf-8", newline="") as f:
        src = f.read()
    misses = []
    for old, new, tag in replacements:
        if old not in src:
            misses.append((tag, old[:80]))
            continue
        src = src.replace(old, new, 1)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(src)
    if misses:
        print(f"!! {label}: {len(misses)} replacement(s) MISSED:")
        for tag, head in misses:
            print(f"   - {tag}: {head!r}")
        return False
    print(f"OK  {label}: {len(replacements)} replacements applied")
    return True

ok = True

# ============ db.rs ============
# 1) Register migration 048
db_reg = [
    (
        "        // Migration 047: Drop plaintext mime_type from files (encrypted_mime_type + mime_nonce exist)\n        let _ = conn.execute_batch(include_str!(\"../migrations/047_drop_files_mime_type.sql\"));",
        "        // Migration 047: Drop plaintext mime_type from files (encrypted_mime_type + mime_nonce exist)\n        let _ = conn.execute_batch(include_str!(\"../migrations/047_drop_files_mime_type.sql\"));\n\n        // Migration 048: Drop dead legacy columns (message_nonce, per-message profile/banner/file keys,\n        // users escrow/eph BLOBs, plaintext pic keys, servers.invite_code, key device_id/eph_pub)\n        let _ = conn.execute_batch(include_str!(\"../migrations/048_drop_legacy_message_and_key_columns.sql\"));",
        "register-048",
    ),
]
ok &= apply(DB_RS, db_reg, "db.rs register 048")

# 2) Message struct — remove 7 dead fields
msg_struct_old = """pub struct Message {
    pub id: String,
    pub channel_id: String,
    pub sender_id: String,
    pub encrypted_content: Vec<u8>,
    pub nonce: Vec<u8>,
    pub timestamp: String,
    pub message_nonce: Option<String>,
    pub edited_at: Option<String>,
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
    pub sender_id_hash: Option<String>,
    pub file_id: Option<String>,
}"""
msg_struct_new = """pub struct Message {
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
}"""
db_msg_struct = [(msg_struct_old, msg_struct_new, "Message struct")]
ok &= apply(DB_RS, db_msg_struct, "db.rs Message struct")

# 3) DmMessage struct — same
dm_struct_old = msg_struct_old.replace("pub struct Message", "pub struct DmMessage").replace(
    "pub channel_id", "pub dm_channel_id"
)
dm_struct_new = msg_struct_new.replace("pub struct Message", "pub struct DmMessage").replace(
    "pub channel_id", "pub dm_channel_id"
)
db_dm_struct = [(dm_struct_old, dm_struct_new, "DmMessage struct")]
ok &= apply(DB_RS, db_dm_struct, "db.rs DmMessage struct")

# 4) list_messages SELECT + closure (channel, joined)
lm_sql_old = """                "SELECT m.id, m.channel_id, m.sender_id, u.username, u.profile_picture_file_id,
                        m.encrypted_content, m.nonce, m.timestamp,
                        m.message_nonce, m.edited_at,
                        m.encrypted_profile_key, m.profile_key_nonce, m.encrypted_banner_key, m.banner_key_nonce,
                        m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.encrypted_file_key, m.file_key_nonce,
                        m.encrypted_sender_username, m.sender_username_nonce,
                        m.sender_id_hash
                 FROM (
                     SELECT id, channel_id, sender_id, encrypted_content, nonce, timestamp,
                            message_nonce, edited_at,
                            encrypted_profile_key, profile_key_nonce, encrypted_banner_key, banner_key_nonce,
                            key_version, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_file_key, file_key_nonce,
                            encrypted_sender_username, sender_username_nonce,
                            sender_id_hash
                     FROM messages
                     WHERE channel_id = ?1
                     ORDER BY timestamp DESC, id DESC
                     LIMIT ?2
                 ) m
                 INNER JOIN users u ON m.sender_id = u.id
                 ORDER BY m.timestamp ASC, m.id ASC","""
lm_sql_new = """                "SELECT m.id, m.channel_id, m.sender_id, u.username, u.profile_picture_file_id,
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
                 ORDER BY m.timestamp ASC, m.id ASC","""
lm_row_old = """                    timestamp: row.get(7)?,
                    message_nonce: row.get(8)?,
                    edited_at: row.get(9)?,
                    encrypted_profile_key: row.get(10)?,
                    profile_key_nonce: row.get(11)?,
                    encrypted_banner_key: row.get(12)?,
                    banner_key_nonce: row.get(13)?,
                    key_version: row.get(14)?,
                    encrypted_profile_snapshot: row.get(15)?,
                    profile_snapshot_nonce: row.get(16)?,
                    encrypted_file_key: row.get(17)?,
                    file_key_nonce: row.get(18)?,
                    encrypted_sender_username: row.get(19)?,
                    sender_username_nonce: row.get(20)?,
                    sender_id_hash: row.get(21).ok().flatten(),"""
lm_row_new = """                    timestamp: row.get(7)?,
                    edited_at: row.get(8)?,
                    key_version: row.get(9)?,
                    encrypted_profile_snapshot: row.get(10)?,
                    profile_snapshot_nonce: row.get(11)?,
                    encrypted_sender_username: row.get(12)?,
                    sender_username_nonce: row.get(13)?,
                    sender_id_hash: row.get(14).ok().flatten(),"""
db_lm = [(lm_sql_old, lm_sql_new, "list_messages sql"), (lm_row_old, lm_row_new, "list_messages rows")]
ok &= apply(DB_RS, db_lm, "db.rs list_messages")

# 5) list_messages_before (same shape, different WHERE/LIMIT)
lmb_sql_old = lm_sql_old.replace(
    "WHERE channel_id = ?1\n                     ORDER BY timestamp DESC, id DESC\n                     LIMIT ?2",
    "WHERE channel_id = ?1 AND (timestamp < ?3 OR (timestamp = ?3 AND id < ?4))\n                     ORDER BY timestamp DESC, id DESC\n                     LIMIT ?2",
)
lmb_sql_new = lmb_sql_old.replace(
    "message_nonce, edited_at,\n                            encrypted_profile_key, profile_key_nonce, encrypted_banner_key, banner_key_nonce,\n                            key_version, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_file_key, file_key_nonce,",
    "edited_at,\n                            key_version, encrypted_profile_snapshot, profile_snapshot_nonce,",
).replace(
    "m.message_nonce, m.edited_at,\n                        m.encrypted_profile_key, m.profile_key_nonce, m.encrypted_banner_key, m.banner_key_nonce,\n                        m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.encrypted_file_key, m.file_key_nonce,",
    "m.edited_at,\n                        m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce,",
)
db_lmb = [(lmb_sql_old, lmb_sql_new, "list_messages_before sql"), (lm_row_old, lm_row_new, "list_messages_before rows")]
ok &= apply(DB_RS, db_lmb, "db.rs list_messages_before")

# 6) list_messages_around (no username join) — before + after stmts share shape
around_sql_old = """                "SELECT m.id, m.channel_id, m.sender_id,
                        m.encrypted_content, m.nonce, m.timestamp,
                        m.message_nonce, m.edited_at,
                        m.encrypted_profile_key, m.profile_key_nonce, m.encrypted_banner_key, m.banner_key_nonce,
                        m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.encrypted_file_key, m.file_key_nonce,
                        m.encrypted_sender_username, m.sender_username_nonce,
                        m.sender_id_hash
                 FROM messages m"""
around_sql_new = """                "SELECT m.id, m.channel_id, m.sender_id,
                        m.encrypted_content, m.nonce, m.timestamp,
                        m.edited_at,
                        m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce,
                        m.encrypted_sender_username, m.sender_username_nonce,
                        m.sender_id_hash
                 FROM messages m"""
around_row_old = """                    timestamp: row.get(5)?,
                    message_nonce: row.get(6)?,
                    edited_at: row.get(7)?,
                    encrypted_profile_key: row.get(8)?,
                    profile_key_nonce: row.get(9)?,
                    encrypted_banner_key: row.get(10)?,
                    banner_key_nonce: row.get(11)?,
                    key_version: row.get(12)?,
                    encrypted_profile_snapshot: row.get(13)?,
                    profile_snapshot_nonce: row.get(14)?,
                    encrypted_file_key: row.get(15)?,
                    file_key_nonce: row.get(16)?,
                    encrypted_sender_username: row.get(17)?,
                    sender_username_nonce: row.get(18)?,
                    sender_id_hash: row.get(19).ok().flatten(),"""
around_row_new = """                    timestamp: row.get(5)?,
                    edited_at: row.get(6)?,
                    key_version: row.get(7)?,
                    encrypted_profile_snapshot: row.get(8)?,
                    profile_snapshot_nonce: row.get(9)?,
                    encrypted_sender_username: row.get(10)?,
                    sender_username_nonce: row.get(11)?,
                    sender_id_hash: row.get(12).ok().flatten(),"""
# around appears twice (before+after); replace all occurrences
db_around = [
    (around_sql_old, around_sql_new, "list_messages_around sql (x2)"),
    (around_row_old, around_row_new, "list_messages_around rows (x2)"),
]
for old, new, tag in db_around:
    with open(DB_RS, "r", encoding="utf-8", newline="") as f:
        src = f.read()
    cnt = src.count(old)
    if cnt < 2:
        print(f"!! db.rs {tag}: expected 2 occurrences, found {cnt}")
        ok = False
    src = src.replace(old, new)
    with open(DB_RS, "w", encoding="utf-8", newline="") as f:
        f.write(src)
    print(f"OK  db.rs {tag}: {cnt} replaced")

# 7) save_encrypted_message signature + INSERT + struct construction
sav_old_sig = """    pub fn save_encrypted_message(
        &self,
        channel_id: &str,
        sender_id: &str,
        encrypted_content: &[u8],
        nonce: &[u8],
        message_nonce: Option<&str>,
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
        file_id: Option<&str>,
    ) -> Result<Message, String> {"""
sav_new_sig = """    pub fn save_encrypted_message(
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
    ) -> Result<Message, String> {"""
sav_old_ins = """            "INSERT INTO messages (id, channel_id, sender_id, encrypted_content, nonce, timestamp, message_nonce, encrypted_profile_key, profile_key_nonce, encrypted_banner_key, banner_key_nonce, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_file_key, file_key_nonce, encrypted_sender_username, sender_username_nonce, sender_id_hash, file_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
            params![id, channel_id, sender_id, encrypted_content, nonce, ts, message_nonce, encrypted_profile_key, profile_key_nonce, encrypted_banner_key, banner_key_nonce, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_file_key, file_key_nonce, encrypted_sender_username, sender_username_nonce, h, file_id],"""
sav_new_ins = """            "INSERT INTO messages (id, channel_id, sender_id, encrypted_content, nonce, timestamp, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_sender_username, sender_username_nonce, sender_id_hash, file_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![id, channel_id, sender_id, encrypted_content, nonce, ts, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_sender_username, sender_username_nonce, h, file_id],"""
sav_old_con = """            message_nonce: message_nonce.map(|s| s.to_string()),
            edited_at: None,
            encrypted_profile_key: encrypted_profile_key.map(|s| s.to_string()),
            profile_key_nonce: profile_key_nonce.map(|s| s.to_string()),
            encrypted_banner_key: encrypted_banner_key.map(|s| s.to_string()),
            banner_key_nonce: banner_key_nonce.map(|s| s.to_string()),
            key_version: Some(1),
            encrypted_profile_snapshot: encrypted_profile_snapshot.map(|v| v.to_vec()),
            profile_snapshot_nonce: profile_snapshot_nonce.map(|v| v.to_vec()),
            encrypted_file_key: encrypted_file_key.map(|v| v.to_vec()),
            file_key_nonce: file_key_nonce.map(|v| v.to_vec()),"""
sav_new_con = """            edited_at: None,
            key_version: Some(1),
            encrypted_profile_snapshot: encrypted_profile_snapshot.map(|v| v.to_vec()),
            profile_snapshot_nonce: profile_snapshot_nonce.map(|v| v.to_vec()),"""
db_sav = [(sav_old_sig, sav_new_sig, "save_encrypted_message sig"), (sav_old_ins, sav_new_ins, "save_encrypted_message insert"), (sav_old_con, sav_new_con, "save_encrypted_message struct")]
ok &= apply(DB_RS, db_sav, "db.rs save_encrypted_message")

# 8) save_dm_message signature + INSERT + struct
dmsv_old_sig = """    pub fn save_dm_message(
        &self,
        dm_channel_id: &str,
        sender_id: &str,
        encrypted_content: &[u8],
        nonce: &[u8],
        message_nonce: Option<&str>,
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
        file_id: Option<&str>,
    ) -> Result<DmMessage, String> {"""
dmsv_new_sig = """    pub fn save_dm_message(
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
    ) -> Result<DmMessage, String> {"""
dmsv_old_ins = sav_old_ins.replace("INSERT INTO messages", "INSERT INTO dm_messages")
dmsv_new_ins = sav_new_ins.replace("INSERT INTO messages", "INSERT INTO dm_messages")
dmsv_old_con = """            message_nonce: message_nonce.map(|s| s.to_string()),
            edited_at: None,
            encrypted_profile_key: encrypted_profile_key.map(|s| s.to_string()),
            profile_key_nonce: profile_key_nonce.map(|s| s.to_string()),
            encrypted_banner_key: encrypted_banner_key.map(|s| s.to_string()),
            banner_key_nonce: banner_key_nonce.map(|s| s.to_string()),
            key_version: None,
            encrypted_profile_snapshot: encrypted_profile_snapshot.map(|v| v.to_vec()),
            profile_snapshot_nonce: profile_snapshot_nonce.map(|v| v.to_vec()),
            encrypted_file_key: encrypted_file_key.map(|v| v.to_vec()),
            file_key_nonce: file_key_nonce.map(|v| v.to_vec()),"""
dmsv_new_con = """            edited_at: None,
            key_version: None,
            encrypted_profile_snapshot: encrypted_profile_snapshot.map(|v| v.to_vec()),
            profile_snapshot_nonce: profile_snapshot_nonce.map(|v| v.to_vec()),"""
db_dmsv = [(dmsv_old_sig, dmsv_new_sig, "save_dm_message sig"), (dmsv_old_ins, dmsv_new_ins, "save_dm_message insert"), (dmsv_old_con, dmsv_new_con, "save_dm_message struct")]
ok &= apply(DB_RS, db_dmsv, "db.rs save_dm_message")

# 9) edit_encrypted_message signature + UPDATE + re-SELECT + struct
edit_old_sig = """    pub fn edit_encrypted_message(
        &self,
        message_id: &str,
        sender_id: &str,
        new_encrypted_content: &[u8],
        new_nonce: &[u8],
        new_message_nonce: Option<&str>,
        new_encrypted_profile_key: Option<&str>,
        new_profile_key_nonce: Option<&str>,
        new_encrypted_banner_key: Option<&str>,
        new_banner_key_nonce: Option<&str>,
    ) -> Result<Message, String> {"""
edit_new_sig = """    pub fn edit_encrypted_message(
        &self,
        message_id: &str,
        sender_id: &str,
        new_encrypted_content: &[u8],
        new_nonce: &[u8],
    ) -> Result<Message, String> {"""
edit_old_upd = """            "UPDATE messages SET encrypted_content = ?, nonce = ?, message_nonce = ?, encrypted_profile_key = COALESCE(?, encrypted_profile_key), profile_key_nonce = COALESCE(?, profile_key_nonce), encrypted_banner_key = COALESCE(?, encrypted_banner_key), banner_key_nonce = COALESCE(?, banner_key_nonce), edited_at = CURRENT_TIMESTAMP WHERE id = ?",
            params![new_encrypted_content, new_nonce, new_message_nonce, new_encrypted_profile_key, new_profile_key_nonce, new_encrypted_banner_key, new_banner_key_nonce, message_id],"""
edit_new_upd = """            "UPDATE messages SET encrypted_content = ?, nonce = ?, edited_at = CURRENT_TIMESTAMP WHERE id = ?",
            params![new_encrypted_content, new_nonce, message_id],"""
edit_old_sel = """                "SELECT m.id, m.channel_id, m.sender_id, m.encrypted_content, m.nonce, m.timestamp, m.message_nonce, m.edited_at, m.encrypted_profile_key, m.profile_key_nonce, m.encrypted_banner_key, m.banner_key_nonce, m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.encrypted_file_key, m.file_key_nonce                         FROM messages m WHERE m.id = ?1","""
edit_new_sel = """                "SELECT m.id, m.channel_id, m.sender_id, m.encrypted_content, m.nonce, m.timestamp, m.edited_at, m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.encrypted_sender_username, m.sender_username_nonce, m.sender_id_hash, m.file_id                         FROM messages m WHERE m.id = ?1","""
edit_old_row = """                        encrypted_content: row.get(3)?,
                        nonce: row.get(4)?,
                        timestamp: row.get(5)?,
                        message_nonce: row.get(6)?,
                        edited_at: row.get(7)?,
                        encrypted_profile_key: row.get(8)?,
                        profile_key_nonce: row.get(9)?,
                        encrypted_banner_key: row.get(10)?,
                        banner_key_nonce: row.get(11)?,
                        key_version: row.get(12)?,
                        encrypted_profile_snapshot: row.get(13)?,
                        profile_snapshot_nonce: row.get(14)?,
                        encrypted_file_key: row.get(15)?,
                        file_key_nonce: row.get(16)?,
                    encrypted_sender_username: None,
                    sender_username_nonce: None,
                    sender_id_hash: None,
                    file_id: None,
                    })"""
edit_new_row = """                        encrypted_content: row.get(3)?,
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
                    })"""
db_edit = [(edit_old_sig, edit_new_sig, "edit_encrypted_message sig"), (edit_old_upd, edit_new_upd, "edit_encrypted_message update"), (edit_old_sel, edit_new_sel, "edit_encrypted_message select"), (edit_old_row, edit_new_row, "edit_encrypted_message rows")]
ok &= apply(DB_RS, db_edit, "db.rs edit_encrypted_message")

# 10) edit_dm_message — same pattern
dedit_old_sig = """    pub fn edit_dm_message(
        &self,
        message_id: &str,
        sender_id: &str,
        new_encrypted_content: &[u8],
        new_nonce: &[u8],
        new_message_nonce: Option<&str>,
        new_encrypted_profile_key: Option<&str>,
        new_profile_key_nonce: Option<&str>,
        new_encrypted_banner_key: Option<&str>,
        new_banner_key_nonce: Option<&str>,
    ) -> Result<DmMessage, String> {"""
dedit_new_sig = """    pub fn edit_dm_message(
        &self,
        message_id: &str,
        sender_id: &str,
        new_encrypted_content: &[u8],
        new_nonce: &[u8],
    ) -> Result<DmMessage, String> {"""
dedit_old_upd = edit_old_upd.replace("UPDATE messages", "UPDATE dm_messages")
dedit_new_upd = edit_new_upd.replace("UPDATE messages", "UPDATE dm_messages")
dedit_old_sel = edit_old_sel.replace("FROM messages m", "FROM dm_messages m").replace(
    "m.channel_id", "m.dm_channel_id"
)
dedit_new_sel = edit_new_sel.replace("FROM messages m", "FROM dm_messages m").replace(
    "m.channel_id", "m.dm_channel_id"
)
dedit_old_row = edit_old_row.replace("channel_id:", "dm_channel_id:")
dedit_new_row = edit_new_row.replace("channel_id:", "dm_channel_id:")
db_dedit = [(dedit_old_sig, dedit_new_sig, "edit_dm_message sig"), (dedit_old_upd, dedit_new_upd, "edit_dm_message update"), (dedit_old_sel, dedit_new_sel, "edit_dm_message select"), (dedit_old_row, dedit_new_row, "edit_dm_message rows")]
ok &= apply(DB_RS, db_dedit, "db.rs edit_dm_message")

# 11) admin list_all_messages_admin + list_all_dm_messages_admin (channel + dm share shape)
adm_old = """                "SELECT m.id, m.channel_id, m.sender_id, COALESCE(u.username, '?'), m.encrypted_content, m.nonce, m.timestamp, m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.encrypted_file_key, m.file_key_nonce, m.sender_id_hash
                 FROM messages m LEFT JOIN users u ON m.sender_id = u.id ORDER BY m.timestamp DESC LIMIT 500","""
adm_new = """                "SELECT m.id, m.channel_id, m.sender_id, COALESCE(u.username, '?'), m.encrypted_content, m.nonce, m.timestamp, m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.sender_id_hash
                 FROM messages m LEFT JOIN users u ON m.sender_id = u.id ORDER BY m.timestamp DESC LIMIT 500","""
dms_admin_old = adm_old.replace("m.channel_id", "m.dm_channel_id").replace("FROM messages m", "FROM dm_messages m")
dms_admin_new = adm_new.replace("m.channel_id", "m.dm_channel_id").replace("FROM messages m", "FROM dm_messages m")
# admin row tuples: channel (13 elems incl 2 file-key) → 11; dm (13) → 11
adm_row_old = """                    row.get::<_, Option<Vec<u8>>>(8)?,
                    row.get::<_, Option<Vec<u8>>>(9)?,
                    row.get::<_, Option<Vec<u8>>>(10)?,
                    row.get::<_, Option<Vec<u8>>>(11)?,
                    row.get::<_, Option<String>>(12)?,"""
adm_row_new = """                    row.get::<_, Option<Vec<u8>>>(8)?,
                    row.get::<_, Option<Vec<u8>>>(9)?,
                    row.get::<_, Option<String>>(10)?,"""
db_adm = [
    (adm_old, adm_new, "admin messages sql"),
    (dms_admin_old, dms_admin_new, "admin dm messages sql"),
    (adm_row_old, adm_row_new, "admin messages rows (x2)"),
]
for old, new, tag in db_adm:
    with open(DB_RS, "r", encoding="utf-8", newline="") as f:
        src = f.read()
    cnt = src.count(old)
    src = src.replace(old, new)
    with open(DB_RS, "w", encoding="utf-8", newline="") as f:
        f.write(src)
    print(f"{'OK ' if cnt >= 1 else '!!'} db.rs {tag}: {cnt} replaced")
    if cnt < 1:
        ok = False

# 12) admin users dump — drop profile_picture_file_key + profile_banner_file_key
adm_u_old = """                "SELECT id, username, password_hash, created_at, '' as display_name, COALESCE(hex(identity_public_key), ''), COALESCE(profile_picture_file_id, ''), COALESCE(profile_picture_file_key, ''), COALESCE(friend_requests_disabled, 0), COALESCE(encrypted_friend_code, ''), COALESCE(friend_code_salt, ''), COALESCE(friend_code_nonce, ''), COALESCE(encrypted_profile_data, ''), COALESCE(encrypted_profile_salt, ''), COALESCE(encrypted_profile_nonce, ''), COALESCE(profile_banner_file_id, ''), COALESCE(profile_banner_file_key, ''), '' as description, '' as nickname, COALESCE(friend_code_hash, ''), COALESCE(encrypted_hash_key, ''), COALESCE(hash_key_salt, ''), COALESCE(hash_key_nonce, '') FROM users ORDER BY created_at","""
adm_u_new = """                "SELECT id, username, password_hash, created_at, '' as display_name, COALESCE(hex(identity_public_key), ''), COALESCE(profile_picture_file_id, ''), COALESCE(friend_requests_disabled, 0), COALESCE(encrypted_friend_code, ''), COALESCE(friend_code_salt, ''), COALESCE(friend_code_nonce, ''), COALESCE(encrypted_profile_data, ''), COALESCE(encrypted_profile_salt, ''), COALESCE(encrypted_profile_nonce, ''), COALESCE(profile_banner_file_id, ''), '' as description, '' as nickname, COALESCE(friend_code_hash, ''), COALESCE(encrypted_hash_key, ''), COALESCE(hash_key_salt, ''), COALESCE(hash_key_nonce, '') FROM users ORDER BY created_at","""
db_adm_u = [(adm_u_old, adm_u_new, "admin users sql")]
ok &= apply(DB_RS, db_adm_u, "db.rs admin users dump")

# 13) save_server_key — drop device_id
ssk_old = """    pub fn save_server_key(
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
             VALUES (?1, ?2, ?3, ?4, ?5, COALESCE((SELECT MAX(version) FROM server_keys WHERE server_id = ?1), 0) + 1, ?6)",
            params![server_id, user_id, encrypted_key, sender_public_key, nonce, device_id.unwrap_or("")],
        )"""
ssk_new = """    pub fn save_server_key(
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
        )"""
db_ssk = [(ssk_old, ssk_new, "save_server_key")]
ok &= apply(DB_RS, db_ssk, "db.rs save_server_key")

# 14) save_dm_key — drop device_id
sdk_old = """        device_id: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO dm_keys (dm_channel_id, user_id, encrypted_key, sender_public_key, nonce, device_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![dm_channel_id, user_id, encrypted_key, sender_public_key, nonce, device_id.unwrap_or("")],
        )"""
sdk_new = """    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO dm_keys (dm_channel_id, user_id, encrypted_key, sender_public_key, nonce)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![dm_channel_id, user_id, encrypted_key, sender_public_key, nonce],
        )"""
db_sdk = [(sdk_old, sdk_new, "save_dm_key")]
ok &= apply(DB_RS, db_sdk, "db.rs save_dm_key")

# ============ ws.rs ============
# OutgoingChatMessage struct fields
wsc_struct_old = """    message_nonce: Option<String>,
    edited_at: Option<String>,
    key_version: Option<i32>,
    encrypted_profile_snapshot: Option<String>,
    profile_snapshot_nonce: Option<String>,
    encrypted_file_key: Option<String>,
    file_key_nonce: Option<String>,
    encrypted_sender_username: Option<String>,
    sender_username_nonce: Option<String>,
    sender_id_hash: Option<String>,"""
wsc_struct_new = """    edited_at: Option<String>,
    key_version: Option<i32>,
    encrypted_profile_snapshot: Option<String>,
    profile_snapshot_nonce: Option<String>,
    encrypted_sender_username: Option<String>,
    sender_username_nonce: Option<String>,
    sender_id_hash: Option<String>,"""
ws_struct = [(wsc_struct_old, wsc_struct_new, "OutgoingChatMessage struct")]
ok &= apply(WS_RS, ws_struct, "ws.rs OutgoingChatMessage struct")

# parse blocks — remove dead field parses (each occurs twice: channel + dm)
ws_parse_old_1 = """            let message_nonce = parsed.get("message_nonce").and_then(|c| c.as_str()).map(|s| s.to_string());
            let encrypted_profile_key = parsed.get("encrypted_profile_key").and_then(|c| c.as_str()).map(|s| s.to_string());
            let profile_key_nonce = parsed.get("profile_key_nonce").and_then(|c| c.as_str()).map(|s| s.to_string());
            let encrypted_banner_key = parsed.get("encrypted_banner_key").and_then(|c| c.as_str()).map(|s| s.to_string());
            let banner_key_nonce = parsed.get("banner_key_nonce").and_then(|c| c.as_str()).map(|s| s.to_string());
"""
ws_parse_new_1 = ""
# second parse block (dm variant, same lines but let me try generic)
ws_parse_old_2 = ws_parse_old_1
for old, new, tag in [(ws_parse_old_1, ws_parse_new_1, "parse profile/banner/message_nonce (channel)")]:
    with open(WS_RS, "r", encoding="utf-8", newline="") as f:
        src = f.read()
    cnt = src.count(old)
    src = src.replace(old, new)
    with open(WS_RS, "w", encoding="utf-8", newline="") as f:
        f.write(src)
    print(f"{'OK ' if cnt >= 2 else '!!'} ws.rs {tag}: {cnt} replaced")
    if cnt < 2:
        ok = False

# encrypted_file_key / file_key_nonce parses (channel + dm)
ws_parse_fk_old = """            let encrypted_file_key_parsed = parsed.get("encrypted_file_key").and_then(|c| c.as_str()).and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
            let file_key_nonce_parsed = parsed.get("file_key_nonce").and_then(|c| c.as_str()).and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
"""
ws_parse_fk_new = ""
with open(WS_RS, "r", encoding="utf-8", newline="") as f:
    src = f.read()
cnt = src.count(ws_parse_fk_old)
src = src.replace(ws_parse_fk_old, ws_parse_fk_new)
with open(WS_RS, "w", encoding="utf-8", newline="") as f:
    f.write(src)
print(f"{'OK ' if cnt >= 2 else '!!'} ws.rs file_key parses: {cnt} replaced")
if cnt < 2:
    ok = False

# save_encrypted_message call (channel)
wsc_sav_old = """            let message = match state.db.save_encrypted_message(channel_id, user_id, &encrypted_content, &nonce, message_nonce.as_deref(), encrypted_profile_key.as_deref(), profile_key_nonce.as_deref(), encrypted_banner_key.as_deref(), banner_key_nonce.as_deref(), encrypted_profile_snapshot.as_deref(), profile_snapshot_nonce.as_deref(), encrypted_file_key_parsed.as_deref(), file_key_nonce_parsed.as_deref(), encrypted_sender_username.as_deref(), sender_username_nonce.as_deref(), file_id_hash.as_deref()) {"""
wsc_sav_new = """            let message = match state.db.save_encrypted_message(channel_id, user_id, &encrypted_content, &nonce, encrypted_profile_snapshot.as_deref(), profile_snapshot_nonce.as_deref(), encrypted_sender_username.as_deref(), sender_username_nonce.as_deref(), file_id_hash.as_deref()) {"""
# save_dm_message call (dm)
wsd_sav_old = """            let message = match state.db.save_dm_message(dm_channel_id, user_id, &encrypted_content, &nonce, message_nonce.as_deref(), encrypted_profile_key.as_deref(), profile_key_nonce.as_deref(), encrypted_banner_key.as_deref(), banner_key_nonce.as_deref(), encrypted_profile_snapshot.as_deref(), profile_snapshot_nonce.as_deref(), encrypted_file_key_parsed.as_deref(),file_key_nonce_parsed.as_deref(), encrypted_sender_username.as_deref(), sender_username_nonce.as_deref(), file_id_hash.as_deref()) {"""
wsd_sav_new = """            let message = match state.db.save_dm_message(dm_channel_id, user_id, &encrypted_content, &nonce, encrypted_profile_snapshot.as_deref(), profile_snapshot_nonce.as_deref(), encrypted_sender_username.as_deref(), sender_username_nonce.as_deref(), file_id_hash.as_deref()) {"""
# edit calls (channel + dm)
wse_old = """            let message = match state.db.edit_encrypted_message(message_id, user_id, &encrypted_content, &nonce, message_nonce.as_deref(), encrypted_profile_key.as_deref(), profile_key_nonce.as_deref(), encrypted_banner_key.as_deref(), banner_key_nonce.as_deref()) {"""
wse_new = """            let message = match state.db.edit_encrypted_message(message_id, user_id, &encrypted_content, &nonce) {"""
wsde_old = """            let message = match state.db.edit_dm_message(message_id, user_id, &encrypted_content, &nonce, message_nonce.as_deref(), encrypted_profile_key.as_deref(), profile_key_nonce.as_deref(), encrypted_banner_key.as_deref(), banner_key_nonce.as_deref()) {"""
wsde_new = """            let message = match state.db.edit_dm_message(message_id, user_id, &encrypted_content, &nonce) {"""
ws_calls = [
    (wsc_sav_old, wsc_sav_new, "save_encrypted_message call"),
    (wsd_sav_old, wsd_sav_new, "save_dm_message call"),
    (wse_old, wse_new, "edit_encrypted_message call"),
    (wsde_old, wsde_new, "edit_dm_message call"),
]
ok &= apply(WS_RS, ws_calls, "ws.rs save/edit calls")

# broadcast message:new — remove message_nonce + file-key fields (channel + dm variants)
bc1_old = """                    message_nonce: message.message_nonce,
                    edited_at: None,
                    key_version: None,
                    encrypted_profile_snapshot: encrypted_profile_snapshot.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                    profile_snapshot_nonce: profile_snapshot_nonce.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                    encrypted_file_key: encrypted_file_key_parsed.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                    file_key_nonce: file_key_nonce_parsed.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),"""
bc1_new = """                    edited_at: None,
                    key_version: None,
                    encrypted_profile_snapshot: encrypted_profile_snapshot.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                    profile_snapshot_nonce: profile_snapshot_nonce.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),"""
bc2_old = """                    message_nonce: message.message_nonce,
                    edited_at: message.edited_at,
                    key_version: None,
                    encrypted_profile_snapshot: None,
                    profile_snapshot_nonce: None,
                    encrypted_file_key: None,
                    file_key_nonce: None,"""
bc2_new = """                    edited_at: message.edited_at,
                    key_version: None,
                    encrypted_profile_snapshot: None,
                    profile_snapshot_nonce: None,"""
ws_bc = [(bc1_old, bc1_new, "broadcast msg:new (x2)"), (bc2_old, bc2_new, "broadcast edit (x2)")]
for old, new, tag in ws_bc:
    with open(WS_RS, "r", encoding="utf-8", newline="") as f:
        src = f.read()
    cnt = src.count(old)
    src = src.replace(old, new)
    with open(WS_RS, "w", encoding="utf-8", newline="") as f:
        f.write(src)
    print(f"{'OK ' if cnt >= 2 else '!!'} ws.rs {tag}: {cnt} replaced")
    if cnt < 2:
        ok = False

# ============ handlers.rs ============
# REST message JSON (3 spots: 1842, 1922, 2584 regions)
h_msg_old = """                "message_nonce": m.message_nonce,
                "edited_at": m.edited_at,
                "key_version": m.key_version,
                "encrypted_profile_key": m.encrypted_profile_key,
                "profile_key_nonce": m.profile_key_nonce,
                "encrypted_banner_key": m.encrypted_banner_key,
                "banner_key_nonce": m.banner_key_nonce,"""
h_msg_new = """                "edited_at": m.edited_at,
                "key_version": m.key_version,"""
# another variant at 2584 (dm maybe with different order)
h_msg2_old = """                "message_nonce": m.message_nonce,
                "edited_at": m.edited_at,
                "encrypted_profile_key": m.encrypted_profile_key,
                "profile_key_nonce": m.profile_key_nonce,
                "encrypted_banner_key": m.encrypted_banner_key,
                "banner_key_nonce": m.banner_key_nonce,
                "key_version": m.key_version,"""
h_msg2_new = """                "edited_at": m.edited_at,
                "key_version": m.key_version,"""
h_msg_file_old = """                "encrypted_file_key": m.encrypted_file_key.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                "file_key_nonce": m.file_key_nonce.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),"""
h_msg_file_new = ""
hand_msg = [
    (h_msg_old, h_msg_new, "REST msg json v1"),
    (h_msg2_old, h_msg2_new, "REST msg json v2"),
    (h_msg_file_old, h_msg_file_new, "REST msg file-key json (x2+)"),
]
for old, new, tag in hand_msg:
    with open(HANDLERS_RS, "r", encoding="utf-8", newline="") as f:
        src = f.read()
    cnt = src.count(old)
    src = src.replace(old, new)
    with open(HANDLERS_RS, "w", encoding="utf-8", newline="") as f:
        f.write(src)
    print(f"{'OK ' if cnt >= 1 else '!!'} handlers.rs {tag}: {cnt} replaced")
    if cnt < 1:
        ok = False

# admin users dump tuple + JSON (handlers.rs 2437-2453)
h_adm_old = """        .map(|(id, username, _pw_hash, created_at, _display_name, identity_public_key, profile_picture_file_id, profile_picture_file_key, friend_requests_disabled, encrypted_friend_code, friend_code_salt, friend_code_nonce, encrypted_profile_data, encrypted_profile_salt, encrypted_profile_nonce, profile_banner_file_id, profile_banner_file_key, _description, _nickname, friend_code_hash, encrypted_hash_key, hash_key_salt, hash_key_nonce)| {
            serde_json::json!({
                "id": id,
                "username": username,
                "created_at": created_at,
                "identity_public_key": if identity_public_key.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(identity_public_key.clone()) },
                "profile_picture_file_id": profile_picture_file_id,
                "profile_picture_file_key": profile_picture_file_key,
                "friend_requests_disabled": *friend_requests_disabled != 0,
                "encrypted_friend_code": encrypted_friend_code,
                "friend_code_salt": friend_code_salt,
                "friend_code_nonce": friend_code_nonce,
                "encrypted_profile_data": encrypted_profile_data,
                "encrypted_profile_salt": encrypted_profile_salt,
                "encrypted_profile_nonce": encrypted_profile_nonce,
                "profile_banner_file_id": profile_banner_file_id,
                "profile_banner_file_key": profile_banner_file_key,
                "friend_code_hash": friend_code_hash,
                "encrypted_hash_key": encrypted_hash_key,
                "hash_key_salt": hash_key_salt,
                "hash_key_nonce": hash_key_nonce,
            })
        })"""
h_adm_new = """        .map(|(id, username, _pw_hash, created_at, _display_name, identity_public_key, profile_picture_file_id, friend_requests_disabled, encrypted_friend_code, friend_code_salt, friend_code_nonce, encrypted_profile_data, encrypted_profile_salt, encrypted_profile_nonce, profile_banner_file_id, _description, _nickname, friend_code_hash, encrypted_hash_key, hash_key_salt, hash_key_nonce)| {
            serde_json::json!({
                "id": id,
                "username": username,
                "created_at": created_at,
                "identity_public_key": if identity_public_key.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(identity_public_key.clone()) },
                "profile_picture_file_id": profile_picture_file_id,
                "friend_requests_disabled": *friend_requests_disabled != 0,
                "encrypted_friend_code": encrypted_friend_code,
                "friend_code_salt": friend_code_salt,
                "friend_code_nonce": friend_code_nonce,
                "encrypted_profile_data": encrypted_profile_data,
                "encrypted_profile_salt": encrypted_profile_salt,
                "encrypted_profile_nonce": encrypted_profile_nonce,
                "profile_banner_file_id": profile_banner_file_id,
                "friend_code_hash": friend_code_hash,
                "encrypted_hash_key": encrypted_hash_key,
                "hash_key_salt": hash_key_salt,
                "hash_key_nonce": hash_key_nonce,
            })
        })"""
hand_adm = [(h_adm_old, h_adm_new, "admin users dump tuple/json")]
ok &= apply(HANDLERS_RS, hand_adm, "handlers.rs admin users dump")

# save_server_key callers (2056, 2178): drop trailing None
h_ssk_old = "state.db.save_server_key(&server_id, &req.user_id, &encrypted_key, &sender_pub, &nonce, None)"
h_ssk_new = "state.db.save_server_key(&server_id, &req.user_id, &encrypted_key, &sender_pub, &nonce)"
h_ssk2_old = "state.db.save_server_key(&server_id, &entry.user_id, &encrypted_key, &sender_pub, &nonce, None)"
h_ssk2_new = "state.db.save_server_key(&server_id, &entry.user_id, &encrypted_key, &sender_pub, &nonce)"
hand_ssk = [(h_ssk_old, h_ssk_new, "save_server_key call 1"), (h_ssk2_old, h_ssk2_new, "save_server_key call 2")]
ok &= apply(HANDLERS_RS, hand_ssk, "handlers.rs save_server_key callers")

print()
print("ALL DONE" if ok else "SOME REPLACEMENTS MISSED — fix before building")
sys.exit(0 if ok else 1)
