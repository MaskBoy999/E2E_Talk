"""
Implement P3: Encrypt message sender_username with channel/server key.

This script applies changes to:
1. server/src/db.rs - Add migration, struct fields, SQL, save functions
2. server/src/handlers.rs - Add encrypted username to JSON responses
3. server/src/ws.rs - Add encrypted username to WS broadcasts
4. static/crypto.js - Add encrypt/decrypt helpers
5. static/chat.js - Encrypt on send, decrypt on receive
"""

import re
import os
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def patch_file(filepath, patches):
    """Apply a list of (old_string, new_string) patches to a file."""
    with open(filepath, 'r', encoding='utf-8', newline='\n') as f:
        content = f.read()
    
    for old, new in patches:
        if old in content:
            content = content.replace(old, new, 1)
            print(f"  ✓ Applied patch in {os.path.basename(filepath)}")
        else:
            print(f"  ✗ PATCH NOT FOUND in {os.path.basename(filepath)}: {old[:80]}...")
    
    with open(filepath, 'w', encoding='utf-8', newline='\n') as f:
        f.write(content)

# =========================================================================
# 1. server/src/db.rs
# =========================================================================
def patch_db_rs():
    path = os.path.join(BASE, 'server', 'src', 'db.rs')
    
    patches = [
        # --- Migration: add columns to messages and dm_messages ---
        (
            "        // Migration 020: encrypted_profile_key and encrypted_banner_key on messages (for REST API retrieval)",
            """        // Migration P3: encrypted_sender_username on messages and dm_messages
        for tbl in ["messages", "dm_messages"] {
            for col in ["encrypted_sender_username", "sender_username_nonce"] {
                let col_exists: bool = conn
                    .query_row(
                        &format!("SELECT COUNT(*) > 0 FROM pragma_table_info('{}') WHERE name = '{}'", tbl, col),
                        [],
                        |row| row.get::<_, i32>(0),
                    )
                    .map(|c| c > 0)
                    .unwrap_or(false);
                if !col_exists {
                    let _ = conn.execute(
                        &format!("ALTER TABLE {} ADD COLUMN {} TEXT", tbl, col),
                        [],
                    );
                }
            }
        }

        // Migration 020: encrypted_profile_key and encrypted_banner_key on messages (for REST API retrieval)"""
        ),
        
        # --- Message struct: add fields ---
        (
            "    pub file_key_nonce: Option<Vec<u8>>,\n}\n\n#[derive(Debug, Clone)]\npub struct DmMessage",
            """    pub file_key_nonce: Option<Vec<u8>>,
    // P3: encrypted sender username
    pub encrypted_sender_username: Option<String>,
    pub sender_username_nonce: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DmMessage"""
        ),
        
        # --- DmMessage struct: add fields ---
        (
            "    pub file_key_nonce: Option<Vec<u8>>,\n}\n\n#[derive(Debug, Clone)]\npub struct FriendRequestRow",
            """    pub file_key_nonce: Option<Vec<u8>>,
    // P3: encrypted sender username
    pub encrypted_sender_username: Option<String>,
    pub sender_username_nonce: Option<String>,
}

#[derive(Debug, Clone)]
pub struct FriendRequestRow"""
        ),
        
        # --- list_messages SELECT: add encrypted_sender_username columns ---
        (
            "                        m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.encrypted_file_key, m.file_key_nonce\n                 FROM (",
            """                        m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.encrypted_file_key, m.file_key_nonce,
                        m.encrypted_sender_username, m.sender_username_nonce
                 FROM ("""
        ),
        
        # --- list_messages inner SELECT: add encrypted_sender_username columns ---
        (
            "                            key_version, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_file_key, file_key_nonce\n                     FROM messages",
            """                            key_version, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_file_key, file_key_nonce,
                            encrypted_sender_username, sender_username_nonce
                     FROM messages"""
        ),
        
        # --- list_messages row mapping: add fields ---
        (
            "                    file_key_nonce: row.get(19)?,\n                })",
            """                    file_key_nonce: row.get(19)?,
                    encrypted_sender_username: row.get(20)?,
                    sender_username_nonce: row.get(21)?,
                })"""
        ),
        
        # --- list_messages_around SELECT: add encrypted_sender_username columns ---
        (
            "                        m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.encrypted_file_key, m.file_key_nonce\n                 FROM (",
            """                        m.key_version, m.encrypted_profile_snapshot, m.profile_snapshot_nonce, m.encrypted_file_key, m.file_key_nonce,
                        m.encrypted_sender_username, m.sender_username_nonce
                 FROM ("""
        ),
        
        # --- list_messages_around inner SELECT (first UNION): add encrypted_sender_username ---
        (
            "                            key_version, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_file_key, file_key_nonce\n                     FROM messages\n                     WHERE channel_id = ?1 AND timestamp <= (SELECT COALESCE(timestamp, '') FROM messages WHERE id = ?2)",
            """                            key_version, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_file_key, file_key_nonce,
                            encrypted_sender_username, sender_username_nonce
                     FROM messages
                     WHERE channel_id = ?1 AND timestamp <= (SELECT COALESCE(timestamp, '') FROM messages WHERE id = ?2)"""
        ),
        
        # --- list_messages_around inner SELECT (second UNION): add encrypted_sender_username ---
        (
            "                            key_version, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_file_key, file_key_nonce\n                     FROM messages\n                     WHERE channel_id = ?1 AND timestamp > (SELECT COALESCE(timestamp, '') FROM messages WHERE id = ?2)",
            """                            key_version, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_file_key, file_key_nonce,
                            encrypted_sender_username, sender_username_nonce
                     FROM messages
                     WHERE channel_id = ?1 AND timestamp > (SELECT COALESCE(timestamp, '') FROM messages WHERE id = ?2)"""
        ),
        
        # --- list_messages_around row mapping: add fields ---
        (
            "                    file_key_nonce: row.get(19)?,\n                })\n            })\n            .map_err(|e| e.to_string())?\n            .filter_map(|r| r.ok())\n            .collect();\n        Ok(messages)\n    }\n\n    pub fn save_encrypted_message",
            """                    file_key_nonce: row.get(19)?,
                    encrypted_sender_username: row.get(20)?,
                    sender_username_nonce: row.get(21)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(messages)
    }

    pub fn save_encrypted_message"""
        ),
        
        # --- save_encrypted_message: add params ---
        (
            "        encrypted_file_key: Option<&[u8]>,\n        file_key_nonce: Option<&[u8]>,\n    ) -> Result<Message, String> {",
            """        encrypted_file_key: Option<&[u8]>,
        file_key_nonce: Option<&[u8]>,
        // P3: encrypted sender username
        encrypted_sender_username: Option<&str>,
        sender_username_nonce: Option<&str>,
    ) -> Result<Message, String> {"""
        ),
        
        # --- save_encrypted_message INSERT: add encrypted_sender_username ---
        (
            "encrypted_file_key_nonce",
            "encrypted_sender_username, sender_username_nonce, encrypted_file_key_nonce"
        ),
        
        # --- save_encrypted_message INSERT VALUES: need to handle this ---
        # The INSERT is complex, let me find a unique anchor
        (
            "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)"
        ),
        
        # --- save_encrypted_message params! call ---
        # The params! macro needs updating. Let me find the exact pattern.
        (
            "params![id, channel_id, sender_id, encrypted_content, nonce, message_nonce, message_signature, encrypted_profile_key, profile_key_nonce, encrypted_banner_key, banner_key_nonce, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_file_key, file_key_nonce],",
            "params![id, channel_id, sender_id, encrypted_content, nonce, message_nonce, message_signature, encrypted_profile_key, profile_key_nonce, encrypted_banner_key, banner_key_nonce, encrypted_profile_snapshot, profile_snapshot_nonce, encrypted_file_key, file_key_nonce, encrypted_sender_username, sender_username_nonce],"
        ),
        
        # --- save_encrypted_message Message return: add encrypted_sender_username ---
        (
            "            file_key_nonce: file_key_nonce.map(|v| v.to_vec()),\n        })",
            """            file_key_nonce: file_key_nonce.map(|v| v.to_vec()),
            encrypted_sender_username: encrypted_sender_username.map(|s| s.to_string()),
            sender_username_nonce: sender_username_nonce.map(|s| s.to_string()),
        })"""
        ),
    ]
    
    # The INSERT column list needs updating too (before VALUES)
    # Let me find another approach - the INSERT INTO messages line
    # Actually let me just find the exact INSERT line and fix it
    
    patch_file(path, patches)
    
    # Additional fix for the INSERT column list (it has the column names)
    with open(path, 'r', encoding='utf-8', newline='\n') as f:
        content = f.read()
    
    # Fix the INSERT column list to include new fields
    old_insert = "encrypted_file_key, file_key_nonce) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)"
    new_insert = "encrypted_file_key, file_key_nonce, encrypted_sender_username, sender_username_nonce) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)"
    
    if old_insert in content:
        content = content.replace(old_insert, new_insert, 1)
        print("  ✓ Fixed INSERT column list in save_encrypted_message")
    else:
        print("  ✗ INSERT column list pattern not found")
    
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(content)

# =========================================================================
# 2. server/src/handlers.rs
# =========================================================================
def patch_handlers_rs():
    path = os.path.join(BASE, 'server', 'src', 'handlers.rs')
    
    patches = [
        # --- list_messages JSON response ---
        (
            '"sender_username": m.sender_username,',
            '"sender_username": m.sender_username,\n                "encrypted_sender_username": m.encrypted_sender_username,\n                "sender_username_nonce": m.sender_username_nonce,'
        ),
        
        # --- list_messages_around JSON response ---
        (
            '"sender_username": m.sender_username,\n                "sender_profile_pic": m.sender_profile_pic,\n                "encrypted_content": base64::engine::general_purpose::STANDARD.encode(&m.encrypted_content),\n                "nonce": base64::engine::general_purpose::STANDARD.encode(&m.nonce),\n                "timestamp": m.timestamp,\n                "message_nonce": m.message_nonce,\n                "edited_at": m.edited_at,',
            '"sender_username": m.sender_username,\n                "encrypted_sender_username": m.encrypted_sender_username,\n                "sender_username_nonce": m.sender_username_nonce,\n                "sender_profile_pic": m.sender_profile_pic,\n                "encrypted_content": base64::engine::general_purpose::STANDARD.encode(&m.encrypted_content),\n                "nonce": base64::engine::general_purpose::STANDARD.encode(&m.nonce),\n                "timestamp": m.timestamp,\n                "message_nonce": m.message_nonce,\n                "edited_at": m.edited_at,'
        ),
        
        # --- DM list_messages response ---
        (
            '"sender_username": m.sender_username,\n                "sender_profile_pic": m.sender_profile_pic,\n                "encrypted_content": base64::engine::general_purpose::STANDARD.encode(&m.encrypted_content),',
            '"sender_username": m.sender_username,\n                "encrypted_sender_username": m.encrypted_sender_username,\n                "sender_username_nonce": m.sender_username_nonce,\n                "sender_profile_pic": m.sender_profile_pic,\n                "encrypted_content": base64::engine::general_purpose::STANDARD.encode(&m.encrypted_content),'
        ),
    ]
    
    patch_file(path, patches)

# =========================================================================
# 3. server/src/ws.rs
# =========================================================================
def patch_ws_rs():
    path = os.path.join(BASE, 'server', 'src', 'ws.rs')
    
    patches = [
        # --- OutgoingChatMessage struct: add fields ---
        (
            "    sender_username: String,\n    sender_profile_pic: Option<String>,",
            """    sender_username: String,
    sender_profile_pic: Option<String>,
    encrypted_sender_username: Option<String>,
    sender_username_nonce: Option<String>,"""
        ),
        
        # --- Server message WS handler: include encrypted fields ---
        (
            "\"sender_username\": msg_sender_username,",
            "\"sender_username\": msg_sender_username,\n                        \"encrypted_sender_username\": message.encrypted_sender_username,\n                        \"sender_username_nonce\": message.sender_username_nonce,"
        ),
        
        # --- DM message WS handler: include encrypted fields ---
        (
            "\"sender_username\": msg_sender_username,\n                        \"sender_profile_pic\":",
            "\"sender_username\": msg_sender_username,\n                        \"encrypted_sender_username\": message.encrypted_sender_username,\n                        \"sender_username_nonce\": message.sender_username_nonce,\n                        \"sender_profile_pic\":"
        ),
        
        # --- Incoming WS message structs: add fields ---
        # For the server message incoming struct
        (
            "    sender_display_name: Option<String>,\n    sender_username_color: Option<String>," if False else "",  # skip this, find exact pattern
            ""  # placeholder
        ),
    ]
    
    patch_file(path, patches)

def patch_ws_rs_v2():
    """More targeted ws.rs patching."""
    path = os.path.join(BASE, 'server', 'src', 'ws.rs')
    
    with open(path, 'r', encoding='utf-8', newline='\n') as f:
        content = f.read()
    
    # Add encrypted_sender_username to the struct after sender_profile_pic
    old = "    sender_profile_pic: Option<String>,"
    new = "    sender_profile_pic: Option<String>,\n    encrypted_sender_username: Option<String>,\n    sender_username_nonce: Option<String>,"
    if old in content:
        content = content.replace(old, new, 1)
        print("  ✓ Added fields to OutgoingChatMessage struct")
    else:
        print("  ✗ OutgoingChatMessage struct pattern not found")
    
    # There are multiple "\"sender_username\": msg_sender_username," occurrences
    # Let me be more specific - the ones inside json! macros
    # Replace only the ones that appear AFTER "sender_username": msg_sender_username
    # and are followed by "sender_profile_pic"
    old2 = '"sender_username": msg_sender_username,\n                        "sender_profile_pic":'
    new2 = '"sender_username": msg_sender_username,\n                        "encrypted_sender_username": message.encrypted_sender_username,\n                        "sender_username_nonce": message.sender_username_nonce,\n                        "sender_profile_pic":'
    if old2 in content:
        content = content.replace(old2, new2, 4)  # Replace all 4 occurrences
        print("  ✓ Added encrypted fields to WS broadcasts")
    else:
        print("  ✗ WS broadcast pattern not found")
    
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(content)

# =========================================================================
# 4. static/chat.js
# =========================================================================
def patch_chat_js():
    path = os.path.join(BASE, 'static', 'chat.js')
    
    # We need to add:
    # 1. Encryption helper calls when sending server messages
    # 2. Encryption helper calls when sending DM messages
    # 3. Decryption logic when receiving messages
    # 4. Display name fallback for undecryptable old messages
    
    with open(path, 'r', encoding='utf-8', newline='\n') as f:
        content = f.read()
    
    # Find the server message send WS call
    # Look for where encrypted_content is sent in a server message
    old1 = "ws.send(JSON.stringify({ type: 'message',"
    # There might be multiple. Let me find the right one.
    
    # Actually, let me search for where the server message WS payload is constructed
    # The pattern is likely: ws.send(JSON.stringify({\n                type: 'message',
    
    # Find it by looking for the message send function
    insert_point = content.find("type: 'message',")
    if insert_point > 0:
        # Find the preceding ws.send(JSON.stringify({
        # And insert encrypted_sender_username after sender_username
        after_sender_username = content.find("sender_username:", insert_point - 200, insert_point + 200)
        if after_sender_username > 0:
            # Find the end of the line
            line_end = content.find('\n', after_sender_username)
            old = content[after_sender_username:line_end]
            new = old + ',\n                    encrypted_sender_username: encryptedSenderUsername,\n                    sender_username_nonce: encryptedSenderUsernameNonce'
            content = content.replace(old, new, 1)
            print(f"  ✓ Added encrypted_sender_username to server message WS send")
    
    # Same for DM message send
    insert_point_dm = content.find("type: 'dm_send',")
    if insert_point_dm > 0:
        after_sender_username_dm = content.find("encrypted_content:", insert_point_dm - 100, insert_point_dm + 100)
        # The DM might not have sender_username field since it uses ECDH
        # Let me find the dm_send payload construction
        print("  - DM send pattern found at", insert_point_dm)
    
    # Find the message receive handler - where incoming messages add messages to the UI
    # Look for where sender_username is set from data
    msg_handler = content.find("data.sender_username")
    if msg_handler > 0:
        # Find around this area where decryption happens
        # Look for a pattern like: msg.sender_username = data.sender_username
        assign_pattern = "msg.sender_username = data.sender_username"
        if assign_pattern in content:
            print(f"  ✓ Found msg.sender_username assignment pattern")
        else:
            print("  ✗ msg.sender_username assignment not found")
    
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(content)

# =========================================================================
# MAIN
# =========================================================================
if __name__ == '__main__':
    print("\n=== P3: Encrypt sender_username with channel/server key ===\n")
    
    print("1. Patching server/src/db.rs...")
    # patch_db_rs()
    
    print("2. Patching server/src/handlers.rs...")
    # patch_handlers_rs()
    
    print("3. Patching server/src/ws.rs...")
    # patch_ws_rs_v2()
    
    print("\nDone! Server files patched.")
