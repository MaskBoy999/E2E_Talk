# -*- coding: utf-8 -*-
"""
P3: Encrypt message sender_username with channel/server key.

Server-side only changes in this script.
"""

import sys, os

# Fix Windows console encoding
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CHECK = "OK"
CROSS = "XX"

def apply(fpath, old, new, max_replace=1):
    path = os.path.join(BASE, fpath)
    with open(path, 'r', encoding='utf-8', newline='\n') as f:
        content = f.read()
    if old in content:
        content = content.replace(old, new, max_replace)
        with open(path, 'w', encoding='utf-8', newline='\n') as f:
            f.write(content)
        return True
    return False

def report(label, ok):
    print(f"  [{CHECK if ok else CROSS}] {label}")

print("=" * 60)
print("P3: Encrypt sender_username with channel/server key")
print("=" * 60)

# =========================================================================
# 1. db.rs - Migration
# =========================================================================
print("\n--- server/src/db.rs ---")

MIGRATION_OLD = (
    '        // Migration: Drop plaintext server.name and channels.name columns\n'
    '        for tbl_col in [("servers", "name"), ("channels", "name")] {'
)

MIGRATION_NEW = (
    '        // Migration P3: encrypted_sender_username on messages and dm_messages\n'
    '        for tbl in ["messages", "dm_messages"] {\n'
    '            for col in ["encrypted_sender_username", "sender_username_nonce"] {\n'
    "                let c_exists: bool = conn\n"
    '                    .query_row(&format!("SELECT COUNT(*) > 0 FROM pragma_table_info(\'{}\') WHERE name = \'{}\'", tbl, col), [], |row| row.get::<_, i32>(0))\n'
    '                    .map(|c| c > 0).unwrap_or(false);\n'
    '                if !c_exists {\n'
    '                    let _ = conn.execute(&format!("ALTER TABLE {} ADD COLUMN {} TEXT", tbl, col), []);\n'
    '                }\n'
    '            }\n'
    '        }\n'
    '\n'
    '        // Migration: Drop plaintext server.name and channels.name columns\n'
    '        for tbl_col in [("servers", "name"), ("channels", "name")] {'
)

r = apply("server/src/db.rs", MIGRATION_OLD, MIGRATION_NEW)
report("Migration: add encrypted_sender_username + sender_username_nonce columns", r)

# Message struct
r = apply("server/src/db.rs",
    '    pub file_key_nonce: Option<Vec<u8>>,\n}\n\n#[derive(Debug, Clone)]\npub struct DmMessage {',
    '    pub file_key_nonce: Option<Vec<u8>>,\n    pub encrypted_sender_username: Option<String>,\n    pub sender_username_nonce: Option<String>,\n}\n\n#[derive(Debug, Clone)]\npub struct DmMessage {')
report("Message struct: add fields", r)

# DmMessage struct
r = apply("server/src/db.rs",
    '    pub file_key_nonce: Option<Vec<u8>>,\n}\n\n#[derive(Debug, Clone)]\npub struct FriendRequestRow',
    '    pub file_key_nonce: Option<Vec<u8>>,\n    pub encrypted_sender_username: Option<String>,\n    pub sender_username_nonce: Option<String>,\n}\n\n#[derive(Debug, Clone)]\npub struct FriendRequestRow')
report("DmMessage struct: add fields", r)

# list_messages SELECT outer
r = apply("server/src/db.rs",
    'm.encrypted_file_key, m.file_key_nonce\n                 FROM (',
    'm.encrypted_file_key, m.file_key_nonce, m.encrypted_sender_username, m.sender_username_nonce\n                 FROM (')
report("list_messages SELECT outer", r)

# list_messages SELECT inner
r = apply("server/src/db.rs",
    'encrypted_file_key, file_key_nonce\n                     FROM messages',
    'encrypted_file_key, file_key_nonce, encrypted_sender_username, sender_username_nonce\n                     FROM messages')
report("list_messages SELECT inner", r)

# list_messages row mapping
r = apply("server/src/db.rs",
    "file_key_nonce: row.get(19)?,\n                })",
    "file_key_nonce: row.get(19)?,\n                    encrypted_sender_username: row.get(20)?,\n                    sender_username_nonce: row.get(21)?,\n                })")
report("list_messages row mapping", r)

# list_messages_around SELECT outer
r = apply("server/src/db.rs",
    'm.encrypted_file_key, m.file_key_nonce\n                 FROM (',
    'm.encrypted_file_key, m.file_key_nonce, m.encrypted_sender_username, m.sender_username_nonce\n                 FROM (')
report("list_messages_around SELECT outer", r)

# save_encrypted_message: add params
r = apply("server/src/db.rs",
    'encrypted_file_key: Option<&[u8]>,\n        file_key_nonce: Option<&[u8]>,\n    ) -> Result<Message, String> {',
    'encrypted_file_key: Option<&[u8]>,\n        file_key_nonce: Option<&[u8]>,\n        encrypted_sender_username: Option<&str>,\n        sender_username_nonce: Option<&str>,\n    ) -> Result<Message, String> {')
report("save_encrypted_message: add params", r)

# save_encrypted_message INSERT
r = apply("server/src/db.rs",
    'encrypted_file_key, file_key_nonce) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)',
    'encrypted_file_key, file_key_nonce, encrypted_sender_username, sender_username_nonce) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)')
report("save_encrypted_message INSERT", r)

# save_encrypted_message params!
r = apply("server/src/db.rs",
    'params![id, channel_id, sender_id, encrypted_content, nonce, message_nonce, message_signature, encrypted_profile_key, profile_key_nonce, encrypted_banner_key, banner_key_nonce, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_file_key, file_key_nonce],',
    'params![id, channel_id, sender_id, encrypted_content, nonce, message_nonce, message_signature, encrypted_profile_key, profile_key_nonce, encrypted_banner_key, banner_key_nonce, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_file_key, file_key_nonce, encrypted_sender_username, sender_username_nonce],')
report("save_encrypted_message params!", r)

# save_encrypted_message return
r = apply("server/src/db.rs",
    "file_key_nonce: file_key_nonce.map(|v| v.to_vec()),\n        })",
    "file_key_nonce: file_key_nonce.map(|v| v.to_vec()),\n            encrypted_sender_username: encrypted_sender_username.map(|s| s.to_string()),\n            sender_username_nonce: sender_username_nonce.map(|s| s.to_string()),\n        })")
report("save_encrypted_message return", r)

# =========================================================================
# 2. handlers.rs
# =========================================================================
print("\n--- server/src/handlers.rs ---")

# Add fields to list_messages JSON response
r = apply("server/src/handlers.rs",
    '"sender_username": m.sender_username,\n                "sender_profile_pic":',
    '"sender_username": m.sender_username,\n                "encrypted_sender_username": m.encrypted_sender_username,\n                "sender_username_nonce": m.sender_username_nonce,\n                "sender_profile_pic":')
report("list_messages JSON: add encrypted_sender_username", r)

# =========================================================================
# 3. ws.rs
# =========================================================================
print("\n--- server/src/ws.rs ---")

# OutgoingChatMessage struct
r = apply("server/src/ws.rs",
    '    sender_profile_pic: Option<String>,',
    '    sender_profile_pic: Option<String>,\n    encrypted_sender_username: Option<String>,\n    sender_username_nonce: Option<String>,')
report("OutgoingChatMessage struct: add fields", r)

# WS broadcasts (multiple occurrences)
r = apply("server/src/ws.rs",
    '"sender_username": msg_sender_username,\n                        "sender_profile_pic":',
    '"sender_username": msg_sender_username,\n                        "encrypted_sender_username": message.encrypted_sender_username,\n                        "sender_username_nonce": message.sender_username_nonce,\n                        "sender_profile_pic":')
report("WS broadcasts: add encrypted_sender_username (server)", r)

# DM broadcasts
r = apply("server/src/ws.rs",
    '"sender_username": msg_sender_username,\n                        "sender_profile_pic":',
    '"sender_username": msg_sender_username,\n                        "encrypted_sender_username": message.encrypted_sender_username,\n                        "sender_username_nonce": message.sender_username_nonce,\n                        "sender_profile_pic":')
report("WS broadcasts: add encrypted_sender_username (DM)", r)

# =========================================================================
# Now do the dm_messages queries in db.rs
# =========================================================================
print("\n--- server/src/db.rs (DM queries) ---")

path = os.path.join(BASE, "server", "src", "db.rs")
with open(path, 'r', encoding='utf-8', newline='\n') as f:
    content = f.read()

changes = 0

# dm_messages SELECT outer
old = 'm.encrypted_file_key, m.file_key_nonce\n                 FROM (\n                     SELECT'
new = 'm.encrypted_file_key, m.file_key_nonce, m.encrypted_sender_username, m.sender_username_nonce\n                 FROM (\n                     SELECT'
if old in content:
    content = content.replace(old, new)
    changes += 1
    report("dm_messages SELECT outer", True)

# dm_messages inner SELECT
old = 'key_version, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_file_key, file_key_nonce\n                     FROM dm_messages'
new = 'key_version, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_file_key, file_key_nonce, encrypted_sender_username, sender_username_nonce\n                     FROM dm_messages'
count = content.count(old)
if count > 0:
    content = content.replace(old, new)
    changes += 1
    report(f"dm_messages SELECT inner ({count}x)", True)

# dm_messages row.get(19) -> row.get(20) and row.get(21)
old = "file_key_nonce: row.get(19)?,\n                })\n            })\n            .map_err(|e| e.to_string())?"
new = "file_key_nonce: row.get(19)?,\n                    encrypted_sender_username: row.get(20)?,\n                    sender_username_nonce: row.get(21)?,\n                })\n            })\n            .map_err(|e| e.to_string())?"
count = content.count(old)
if count > 0:
    content = content.replace(old, new, count)
    changes += count
    report(f"dm_messages row mapping ({count}x)", True)

# save_dm_message: add params
old = 'encrypted_file_key: Option<&[u8]>,\n        file_key_nonce: Option<&[u8]>,\n    ) -> Result<DmMessage, String> {'
new = 'encrypted_file_key: Option<&[u8]>,\n        file_key_nonce: Option<&[u8]>,\n        encrypted_sender_username: Option<&str>,\n        sender_username_nonce: Option<&str>,\n    ) -> Result<DmMessage, String> {'
if old in content:
    content = content.replace(old, new, 1)
    changes += 1
    report("save_dm_message: add params", True)

# save_dm_message INSERT column list
old = 'encrypted_file_key, file_key_nonce) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)'
new = 'encrypted_file_key, file_key_nonce, encrypted_sender_username, sender_username_nonce) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)'
if old in content:
    content = content.replace(old, new, 1)
    changes += 1
    report("save_dm_message INSERT", True)

# save_dm_message params! macro
old = 'params![id, dm_channel_id, sender_id, encrypted_content, nonce, message_nonce, message_signature, encrypted_profile_key, profile_key_nonce, encrypted_banner_key, banner_key_nonce, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_file_key, file_key_nonce],'
new = 'params![id, dm_channel_id, sender_id, encrypted_content, nonce, message_nonce, message_signature, encrypted_profile_key, profile_key_nonce, encrypted_banner_key, banner_key_nonce, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_file_key, file_key_nonce, encrypted_sender_username, sender_username_nonce],'
if old in content:
    content = content.replace(old, new, 1)
    changes += 1
    report("save_dm_message params!", True)

# save_encrypted_message: also need to handle the case where the INSERT is for second occurrence
# Actually, let me also handle the message INSERT containing encrypted_sender_username_key_nonce
# We already patched this above

# save_dm_message return
old = "file_key_nonce: file_key_nonce.map(|v| v.to_vec()),\n        })"
# Find the last occurrence (save_dm_message, not save_encrypted_message)
idx = content.rfind("file_key_nonce: file_key_nonce.map(|v| v.to_vec()),\n        })")
if idx > 0:
    before = content[:idx]
    after = content[idx:]
    after = after.replace(
        "file_key_nonce: file_key_nonce.map(|v| v.to_vec()),\n        })",
        "file_key_nonce: file_key_nonce.map(|v| v.to_vec()),\n            encrypted_sender_username: encrypted_sender_username.map(|s| s.to_string()),\n            sender_username_nonce: sender_username_nonce.map(|s| s.to_string()),\n        })",
        1
    )
    content = before + after
    changes += 1
    report("save_dm_message return", True)

if changes > 0:
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(content)
    print(f"\n  Total DM patches applied: {changes}")

print("\n=== Server-side patching complete ===")
print("\nRun `cargo build` to verify compilation.")
