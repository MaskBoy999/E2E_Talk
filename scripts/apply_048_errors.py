#!/usr/bin/env python3
"""Fix the 5 build errors left by the migration-048 cleanup.

1. db.rs admin users dump: tuple annotation still 23 elements, row.get() still reads
   old indices (i32 at 8, two trailing bogus reads). Collapse to 21 (drop
   profile_picture_file_key + profile_banner_file_key).
2. db.rs list_all_friend_requests_admin: generic row pattern from the fix script
   accidentally removed row index 7 (8-tuple now reads 7). Restore it.
3. db.rs list_all_notification_sounds_admin: same accidental removal. Restore index 7.
4. handlers.rs admin_list_dm_messages: still destructures 13 elements (fkey/fkey_nonce
   no longer in the 11-tuple). Drop them.

Run from project root.
"""
import sys

def apply_file(path, style, replacements, label):
    with open(path, "rb") as f:
        data = f.read()
    if style == "CRLF":
        data = data.replace(b"\r\n", b"\n")
    src = data.decode("utf-8")
    misses = []
    for old, new, tag, count in replacements:
        n = src.count(old)
        if n < count:
            misses.append(f"{tag}: want>={count} found={n} :: {old[:60]!r}")
        else:
            src = src.replace(old, new)
    out = src.encode("utf-8")
    if style == "CRLF":
        out = out.replace(b"\n", b"\r\n")
    with open(path, "wb") as f:
        f.write(out)
    if misses:
        print(f"!! {label}: {len(misses)} MISSED")
        for m in misses:
            print(f"   - {m}")
        return False
    print(f"OK  {label}")
    return True

ok = True

# ---- 1) admin users dump tuple annotation (db.rs, CRLF) ----
tup_old = (
    "        Vec<(\n"
    "            String,  // 0: id\n"
    "            String,  // 1: username\n"
    "            String,  // 2: password_hash\n"
    "            String,  // 3: created_at\n"
    "            String,  // 4: display_name (legacy)\n"
    "            String,  // 5: identity_public_key\n"
    "            String,  // 6: profile_picture_file_id\n"
    "            String,  // 7: profile_picture_file_key\n"
    "            i32,     // 8: friend_requests_disabled\n"
    "            String,  // 9: encrypted_friend_code\n"
    "            String,  // 10: friend_code_salt\n"
    "            String,  // 11: friend_code_nonce\n"
    "            String,  // 12: encrypted_profile_data\n"
    "            String,  // 13: encrypted_profile_salt\n"
    "            String,  // 14: encrypted_profile_nonce\n"
    "            String,  // 15: profile_banner_file_id\n"
    "            String,  // 16: profile_banner_file_key\n"
    "            String,  // 17: description (legacy)\n"
    "            String,  // 18: nickname (legacy)\n"
    "            String,  // 19: friend_code_hash\n"
    "            String,  // 20: encrypted_hash_key\n"
    "            String,  // 21: hash_key_salt\n"
    "            String,  // 22: hash_key_nonce\n"
    "        )>,\n"
)
tup_new = (
    "        Vec<(\n"
    "            String,  // 0: id\n"
    "            String,  // 1: username\n"
    "            String,  // 2: password_hash\n"
    "            String,  // 3: created_at\n"
    "            String,  // 4: display_name (legacy)\n"
    "            String,  // 5: identity_public_key\n"
    "            String,  // 6: profile_picture_file_id\n"
    "            i32,     // 7: friend_requests_disabled\n"
    "            String,  // 8: encrypted_friend_code\n"
    "            String,  // 9: friend_code_salt\n"
    "            String,  // 10: friend_code_nonce\n"
    "            String,  // 11: encrypted_profile_data\n"
    "            String,  // 12: encrypted_profile_salt\n"
    "            String,  // 13: encrypted_profile_nonce\n"
    "            String,  // 14: profile_banner_file_id\n"
    "            String,  // 15: description (legacy)\n"
    "            String,  // 16: nickname (legacy)\n"
    "            String,  // 17: friend_code_hash\n"
    "            String,  // 18: encrypted_hash_key\n"
    "            String,  // 19: hash_key_salt\n"
    "            String,  // 20: hash_key_nonce\n"
    "        )>,\n"
)
# ---- 1b) admin users dump row.get (db.rs) ----
rows_old = (
    "                    row.get::<_, String>(6)?,\n"
    "                    row.get::<_, i32>(8)?,\n"
    "                    row.get::<_, String>(9)?,\n"
    "                    row.get::<_, String>(10)?,\n"
    "                    row.get::<_, String>(11)?,\n"
    "                    row.get::<_, String>(12)?,\n"
    "                    row.get::<_, String>(13)?,\n"
    "                    row.get::<_, String>(14)?,\n"
    "                    row.get::<_, String>(15)?,\n"
    "                    row.get::<_, String>(16)?,\n"
    "                    row.get::<_, String>(17)?,\n"
    "                    row.get::<_, String>(18)?,\n"
    "                    row.get::<_, String>(19)?,\n"
    "                    row.get::<_, String>(20)?,\n"
    "                    row.get::<_, String>(21)?,\n"
    "                    row.get::<_, String>(22)?,\n"
)
rows_new = (
    "                    row.get::<_, String>(6)?,\n"
    "                    row.get::<_, i32>(7)?,\n"
    "                    row.get::<_, String>(8)?,\n"
    "                    row.get::<_, String>(9)?,\n"
    "                    row.get::<_, String>(10)?,\n"
    "                    row.get::<_, String>(11)?,\n"
    "                    row.get::<_, String>(12)?,\n"
    "                    row.get::<_, String>(13)?,\n"
    "                    row.get::<_, String>(14)?,\n"
    "                    row.get::<_, String>(15)?,\n"
    "                    row.get::<_, String>(16)?,\n"
    "                    row.get::<_, String>(17)?,\n"
    "                    row.get::<_, String>(18)?,\n"
    "                    row.get::<_, String>(19)?,\n"
    "                    row.get::<_, String>(20)?,\n"
)
ok &= apply_file("server/src/db.rs", "CRLF",
                 [(tup_old, tup_new, "admin users tuple", 1),
                  (rows_old, rows_new, "admin users rows", 1)],
                 "db.rs admin users")

# ---- 2) restore friend_requests index 7 (db.rs) ----
# Anchor on the friend_requests SELECT (unique) then fix the row block after it.
fr_old = (
    "                 SELECT fr.id, fr.from_user_id, COALESCE(u1.username, '?'), fr.to_user_id, COALESCE(u2.username, '?'), fr.status, fr.created_at, COALESCE(fr.responded_at, '')\n"
    "                 FROM friend_requests fr\n"
    "                 LEFT JOIN users u1 ON fr.from_user_id = u1.id\n"
    "                 LEFT JOIN users u2 ON fr.to_user_id = u2.id\n"
    "                 ORDER BY fr.created_at\",\n"
    "            )\n"
    "            .map_err(|e| e.to_string())?;\n"
    "        let rows = stmt\n"
    "            .query_map([], |row| {\n"
    "                Ok((\n"
    "                    row.get::<_, String>(0)?,\n"
    "                    row.get::<_, String>(1)?,\n"
    "                    row.get::<_, String>(2)?,\n"
    "                    row.get::<_, String>(3)?,\n"
    "                    row.get::<_, String>(4)?,\n"
    "                    row.get::<_, String>(5)?,\n"
    "                    row.get::<_, String>(6)?,\n"
    "                ))\n"
)
fr_new = (
    "                 SELECT fr.id, fr.from_user_id, COALESCE(u1.username, '?'), fr.to_user_id, COALESCE(u2.username, '?'), fr.status, fr.created_at, COALESCE(fr.responded_at, '')\n"
    "                 FROM friend_requests fr\n"
    "                 LEFT JOIN users u1 ON fr.from_user_id = u1.id\n"
    "                 LEFT JOIN users u2 ON fr.to_user_id = u2.id\n"
    "                 ORDER BY fr.created_at\",\n"
    "            )\n"
    "            .map_err(|e| e.to_string())?;\n"
    "        let rows = stmt\n"
    "            .query_map([], |row| {\n"
    "                Ok((\n"
    "                    row.get::<_, String>(0)?,\n"
    "                    row.get::<_, String>(1)?,\n"
    "                    row.get::<_, String>(2)?,\n"
    "                    row.get::<_, String>(3)?,\n"
    "                    row.get::<_, String>(4)?,\n"
    "                    row.get::<_, String>(5)?,\n"
    "                    row.get::<_, String>(6)?,\n"
    "                    row.get::<_, String>(7)?,\n"
    "                ))\n"
)
ok &= apply_file("server/src/db.rs", "CRLF", [(fr_old, fr_new, "friend_requests rows", 1)],
                 "db.rs friend_requests")

# ---- 3) restore notification_sounds index 7 (db.rs) ----
ns_old = (
    "                 SELECT ns.user_id, COALESCE(u.username, '?'), ns.file_name, ns.encrypted_sound, ns.nonce, ns.sender_public_key, ns.created_at, COALESCE(ns.updated_at, '')\n"
    "                 FROM notification_sounds ns LEFT JOIN users u ON ns.user_id = u.id ORDER BY ns.created_at\",\n"
    "            )\n"
    "            .map_err(|e| e.to_string())?;\n"
    "        let rows = stmt\n"
    "            .query_map([], |row| {\n"
    "                Ok((\n"
    "                    row.get::<_, String>(0)?,\n"
    "                    row.get::<_, String>(1)?,\n"
    "                    row.get::<_, String>(2)?,\n"
    "                    row.get::<_, Vec<u8>>(3)?,\n"
    "                    row.get::<_, Vec<u8>>(4)?,\n"
    "                    row.get::<_, Vec<u8>>(5)?,\n"
    "                    row.get::<_, String>(6)?,\n"
    "                ))\n"
)
ns_new = (
    "                 SELECT ns.user_id, COALESCE(u.username, '?'), ns.file_name, ns.encrypted_sound, ns.nonce, ns.sender_public_key, ns.created_at, COALESCE(ns.updated_at, '')\n"
    "                 FROM notification_sounds ns LEFT JOIN users u ON ns.user_id = u.id ORDER BY ns.created_at\",\n"
    "            )\n"
    "            .map_err(|e| e.to_string())?;\n"
    "        let rows = stmt\n"
    "            .query_map([], |row| {\n"
    "                Ok((\n"
    "                    row.get::<_, String>(0)?,\n"
    "                    row.get::<_, String>(1)?,\n"
    "                    row.get::<_, String>(2)?,\n"
    "                    row.get::<_, Vec<u8>>(3)?,\n"
    "                    row.get::<_, Vec<u8>>(4)?,\n"
    "                    row.get::<_, Vec<u8>>(5)?,\n"
    "                    row.get::<_, String>(6)?,\n"
    "                    row.get::<_, String>(7)?,\n"
    "                ))\n"
)
ok &= apply_file("server/src/db.rs", "CRLF", [(ns_old, ns_new, "notification_sounds rows", 1)],
                 "db.rs notification_sounds")

# ---- 4) handlers.rs admin_list_dm_messages: drop fkey/fkey_nonce (LF) ----
h_old = (
    "    let result: Vec<serde_json::Value> = rows.iter().map(|(id, dm_id, sid, sname, enc, nonce, ts, kv, snap, snap_nonce, fkey, fkey_nonce, sender_id_hash)| {\n"
    "        serde_json::json!({\n"
    "            \"id\": id, \"dm_channel_id\": dm_id,\n"
    "            \"sender_id\": sid, \"sender_username\": sname,\n"
    "            \"encrypted_content\": base64::engine::general_purpose::STANDARD.encode(enc),\n"
    "            \"nonce\": base64::engine::general_purpose::STANDARD.encode(nonce),\n"
    "            \"timestamp\": ts,\n"
    "            \"key_version\": kv,\n"
    "            \"sender_id_hash\": sender_id_hash,\n"
    "            \"encrypted_profile_snapshot\": snap.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),\n"
    "            \"profile_snapshot_nonce\": snap_nonce.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),\n"
    "            \"encrypted_file_key\": fkey.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),\n"
    "            \"file_key_nonce\": fkey_nonce.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),\n"
    "        })\n"
    "    }).collect();\n"
)
h_new = (
    "    let result: Vec<serde_json::Value> = rows.iter().map(|(id, dm_id, sid, sname, enc, nonce, ts, kv, snap, snap_nonce, sender_id_hash)| {\n"
    "        serde_json::json!({\n"
    "            \"id\": id, \"dm_channel_id\": dm_id,\n"
    "            \"sender_id\": sid, \"sender_username\": sname,\n"
    "            \"encrypted_content\": base64::engine::general_purpose::STANDARD.encode(enc),\n"
    "            \"nonce\": base64::engine::general_purpose::STANDARD.encode(nonce),\n"
    "            \"timestamp\": ts,\n"
    "            \"key_version\": kv,\n"
    "            \"sender_id_hash\": sender_id_hash,\n"
    "            \"encrypted_profile_snapshot\": snap.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),\n"
    "            \"profile_snapshot_nonce\": snap_nonce.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),\n"
    "        })\n"
    "    }).collect();\n"
)
ok &= apply_file("server/src/handlers.rs", "LF", [(h_old, h_new, "admin dm msgs handler", 1)],
                 "handlers.rs admin dm msgs")

print()
print("ALL DONE" if ok else "MISSED - fix before building")
sys.exit(0 if ok else 1)
