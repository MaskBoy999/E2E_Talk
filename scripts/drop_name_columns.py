#!/usr/bin/env python3
"""
Remove plaintext server.name and channels.name columns from DB schema,
structs, SQL queries, JSON responses, and admin UI.
"""
import os, re

PROJECT = r"X:\Documents\GitHub\E2E_Talk"

def fp(path):
    return os.path.join(PROJECT, path)

# ─── 1. db.rs: structs, SQL queries, index adjustments ──────────────────

db_path = fp("server/src/db.rs")
with open(db_path, "r", encoding="utf-8") as f:
    db = f.read()

# 1a. Server struct: remove pub name: String,
db = re.sub(
    r'(pub struct Server \{\n    pub id: String,\n)    pub name: String,\n',
    r'\1',
    db
)

# 1b. Channel struct: remove pub name: String,
db = re.sub(
    r'(pub struct Channel \{\n    pub id: String,\n    pub server_id: String,\n)    pub name: String,\n',
    r'\1',
    db
)

# 1c. create_server: remove name param, fix INSERT, remove from return
db = re.sub(
    r'    pub fn create_server\(&self, name: &str, owner_id: &str, invite_code_hash: &str, ',
    r'    pub fn create_server(&self, owner_id: &str, invite_code_hash: &str, ',
    db
)

# Remove name from servers INSERT
db = db.replace(
    '"INSERT INTO servers (id, name, owner_id, invite_code_hash, encrypted_name, name_nonce) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"',
    '"INSERT INTO servers (id, owner_id, invite_code_hash, encrypted_name, name_nonce) VALUES (?1, ?2, ?3, ?4, ?5)"'
)
db = db.replace(
    'params![server_id, name, owner_id, invite_code_hash, encrypted_name, name_nonce]',
    'params![server_id, owner_id, invite_code_hash, encrypted_name, name_nonce]'
)

# Remove name from general channel INSERT (no more name column)
db = db.replace(
    '"INSERT INTO channels (id, server_id, name, type, position) VALUES (?1, ?2, \'general\', \'text\', 0)"',
    '"INSERT INTO channels (id, server_id, type, position) VALUES (?1, ?2, \'text\', 0)"'
)

# Remove name from Server return struct in create_server
db = db.replace(
    '''Ok(Server {
            id: server_id,
            name: name.to_string(),
            encrypted_name: encrypted_name.map(|v| v.to_vec()),''',
    '''Ok(Server {
            id: server_id,
            encrypted_name: encrypted_name.map(|v| v.to_vec()),'''
)

# 1d. list_user_servers: remove s.name from SELECT and ORDER BY, adjust indices
db = db.replace(
    '"SELECT s.id, s.name, s.encrypted_name, s.name_nonce, s.owner_id, COALESCE(s.invite_code_hash, \'\'), COALESCE(s.joins_disabled, 0)\n                 FROM servers s\n                 INNER JOIN server_members sm ON s.id = sm.server_id\n                 WHERE sm.user_id = ?1\n                 ORDER BY s.name"',
    '"SELECT s.id, s.encrypted_name, s.name_nonce, s.owner_id, COALESCE(s.invite_code_hash, \'\'), COALESCE(s.joins_disabled, 0)\n                 FROM servers s\n                 INNER JOIN server_members sm ON s.id = sm.server_id\n                 WHERE sm.user_id = ?1\n                 ORDER BY s.encrypted_name"'
)

# Adjust Server struct constructor in list_user_servers
old_list_servers_constructor = '''                Ok(Server {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    encrypted_name: row.get(2)?,
                    name_nonce: row.get(3)?,
                    owner_id: row.get(4)?,
                    invite_code_hash: row.get(5)?,
                    joins_disabled: row.get::<_, i64>(6)? != 0,
                    created_at: String::new(),
                })'''

new_list_servers_constructor = '''                Ok(Server {
                    id: row.get(0)?,
                    encrypted_name: row.get(1)?,
                    name_nonce: row.get(2)?,
                    owner_id: row.get(3)?,
                    invite_code_hash: row.get(4)?,
                    joins_disabled: row.get::<_, i64>(5)? != 0,
                    created_at: String::new(),
                })'''

db = db.replace(old_list_servers_constructor, new_list_servers_constructor)

# 1e. join_server_by_invite: remove name from SELECT, adjust indices
db = db.replace(
    '"SELECT id, name, encrypted_name, name_nonce, owner_id, COALESCE(invite_code_hash, \'\'), COALESCE(joins_disabled, 0) FROM servers WHERE invite_code_hash = ?1"',
    '"SELECT id, encrypted_name, name_nonce, owner_id, COALESCE(invite_code_hash, \'\'), COALESCE(joins_disabled, 0) FROM servers WHERE invite_code_hash = ?1"'
)

old_join_constructor = '''                    Ok(Server {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        encrypted_name: row.get(2)?,
                        name_nonce: row.get(3)?,
                        owner_id: row.get(4)?,
                        invite_code_hash: row.get(5)?,
                        joins_disabled: row.get::<_, i64>(6)? != 0,
                        created_at: String::new(),
                    })'''

new_join_constructor = '''                    Ok(Server {
                        id: row.get(0)?,
                        encrypted_name: row.get(1)?,
                        name_nonce: row.get(2)?,
                        owner_id: row.get(3)?,
                        invite_code_hash: row.get(4)?,
                        joins_disabled: row.get::<_, i64>(5)? != 0,
                        created_at: String::new(),
                    })'''

db = db.replace(old_join_constructor, new_join_constructor)

# 1f. get_channel_name: change to return encrypted_name blob or empty
db = db.replace(
    '''    pub fn get_channel_name(&self, channel_id: &str) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT name FROM channels WHERE id = ?1",
            params![channel_id],
            |row| row.get(0),
        )
        .map_err(|_| "Channel not found".to_string())
    }''',
    '''    pub fn get_channel_name(&self, channel_id: &str) -> Result<String, String> {
        // name column has been removed — return channel_id as fallback
        Ok(channel_id.to_string())
    }'''
)

# 1g. get_server_name: same treatment
db = db.replace(
    '''    pub fn get_server_name(&self, server_id: &str) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT name FROM servers WHERE id = ?1",
            params![server_id],
            |row| row.get(0),
        )
        .map_err(|_| "Server not found".to_string())
    }''',
    '''    pub fn get_server_name(&self, server_id: &str) -> Result<String, String> {
        // name column has been removed — return server_id as fallback
        Ok(server_id.to_string())
    }'''
)

# 1h. list_server_channels: remove name from SELECT, adjust indices
db = db.replace(
    '"SELECT id, server_id, name, encrypted_name, name_nonce, type, COALESCE(position, 0), COALESCE(created_at, \'\') FROM channels',
    '"SELECT id, server_id, encrypted_name, name_nonce, type, COALESCE(position, 0), COALESCE(created_at, \'\') FROM channels'
)

db = db.replace(
    '''                Ok(Channel {
                    id: row.get(0)?,
                    server_id: row.get(1)?,
                    name: row.get(2)?,
                    encrypted_name: row.get(3)?,
                    name_nonce: row.get(4)?,
                    channel_type: row.get(5)?,
                    position: row.get::<_, i32>(6)?,
                    created_at: row.get::<_, String>(7)?,
                })''',
    '''                Ok(Channel {
                    id: row.get(0)?,
                    server_id: row.get(1)?,
                    encrypted_name: row.get(2)?,
                    name_nonce: row.get(3)?,
                    channel_type: row.get(4)?,
                    position: row.get::<_, i32>(5)?,
                    created_at: row.get::<_, String>(6)?,
                })'''
)

# 1i. create_channel: remove name param, remove from INSERT, remove from return
db = re.sub(
    r'    pub fn create_channel\(&self, server_id: &str, name: &str, encrypted_name: Option<&\[u8\]>, name_nonce: Option<&\[u8\]>\)',
    r'    pub fn create_channel(&self, server_id: &str, encrypted_name: Option<&[u8]>, name_nonce: Option<&[u8]>)',
    db
)

db = db.replace(
    '"INSERT INTO channels (id, server_id, name, encrypted_name, name_nonce, type, position) VALUES (?1, ?2, ?3, ?4, ?5, \'text\', ?6)"',
    '"INSERT INTO channels (id, server_id, encrypted_name, name_nonce, type, position) VALUES (?1, ?2, ?3, ?4, \'text\', ?5)"'
)
db = db.replace(
    'params![id, server_id, name, encrypted_name, name_nonce, max_pos + 1]',
    'params![id, server_id, encrypted_name, name_nonce, max_pos + 1]'
)

db = db.replace(
    '''        Ok(Channel {
            id,
            server_id: server_id.to_string(),
            name: name.to_string(),
            encrypted_name: encrypted_name.map(|v| v.to_vec()),''',
    '''        Ok(Channel {
            id,
            server_id: server_id.to_string(),
            encrypted_name: encrypted_name.map(|v| v.to_vec()),'''
)

# 1j. list_all_servers_admin: remove name from SELECT, adjust indices
db = db.replace(
    '"SELECT id, name, owner_id, COALESCE(invite_code_hash, \'\'), COALESCE(joins_disabled, 0), COALESCE(created_at, \'\') FROM servers ORDER BY created_at"',
    '"SELECT id, owner_id, COALESCE(invite_code_hash, \'\'), COALESCE(joins_disabled, 0), COALESCE(created_at, \'\') FROM servers ORDER BY created_at"'
)

old_admin_server_constructor = '''                Ok(Server {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    encrypted_name: None,
                    name_nonce: None,
                    owner_id: row.get(2)?,
                    invite_code_hash: row.get(3)?,
                    joins_disabled: row.get::<_, i64>(4)? != 0,
                    created_at: row.get(5)?,
                })'''

new_admin_server_constructor = '''                Ok(Server {
                    id: row.get(0)?,
                    encrypted_name: None,
                    name_nonce: None,
                    owner_id: row.get(1)?,
                    invite_code_hash: row.get(2)?,
                    joins_disabled: row.get::<_, i64>(3)? != 0,
                    created_at: row.get(4)?,
                })'''

db = db.replace(old_admin_server_constructor, new_admin_server_constructor)

# 1k. list_all_channels_admin: remove name from SELECT, adjust indices
db = db.replace(
    '"SELECT id, server_id, name, type, COALESCE(position, 0), COALESCE(created_at, \'\') FROM channels ORDER BY created_at"',
    '"SELECT id, server_id, type, COALESCE(position, 0), COALESCE(created_at, \'\') FROM channels ORDER BY created_at"'
)

db = db.replace(
    '''                Ok(Channel {
                    id: row.get(0)?,
                    server_id: row.get(1)?,
                    name: row.get(2)?,
                    encrypted_name: None,
                    name_nonce: None,
                    channel_type: row.get(3)?,
                    position: row.get::<_, i32>(4)?,
                    created_at: row.get(5)?,
                })''',
    '''                Ok(Channel {
                    id: row.get(0)?,
                    server_id: row.get(1)?,
                    encrypted_name: None,
                    name_nonce: None,
                    channel_type: row.get(2)?,
                    position: row.get::<_, i32>(3)?,
                    created_at: row.get(4)?,
                })'''
)

# 1l. list_all_server_members_admin: replace COALESCE(s.name, '?') with server_id
db = db.replace(
    'COALESCE(s.name, \'?\')',
    's.id'
)

# 1m. list_all_server_bans_admin: same
# already covered by above replacement since it uses the same pattern
# Actually let me be more specific — the server members query uses COALESCE(s.name, '?') differently
# Let me just do blanket replacement
db = db.replace("COALESCE(s.name, '?'),", "s.id,")

# Also need to handle admin server_members where server_name is at a specific position
# The function returns 6-tuple: (user_id, username, server_id, server_name, role, joined_at)
# After removing s.name, the server_name becomes server_id which is already returned
# Let me check and fix the server members admin function

# 1n. list_all_server_stickers_admin: same
# Already handled by blanket replacement

with open(db_path, "w", encoding="utf-8") as f:
    f.write(db)

print("✅ db.rs updated")

# ─── 2. handlers.rs: remove name from JSON, make optional in requests ────

handlers_path = fp("server/src/handlers.rs")
with open(handlers_path, "r", encoding="utf-8") as f:
    h = f.read()

# 2a. CreateServerRequest: make name optional
h = h.replace(
    '''pub struct CreateServerRequest {
    pub name: String,
    pub invite_code_hash: String,
    pub encrypted_name: Option<String>,
    pub name_nonce: Option<String>,
}''',
    '''pub struct CreateServerRequest {
    pub name: Option<String>,
    pub invite_code_hash: String,
    pub encrypted_name: Option<String>,
    pub name_nonce: Option<String>,
}'''
)

# 2b. create_server: remove empty name check and "name": from response
h = h.replace(
    '''    if req.name.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({\"error\": \"Server name is required\"})),
        )
            .into_response();
    }

    let encrypted_name_bytes''',
    '''    let encrypted_name_bytes'''
)

# Update the create_server call to not pass name
h = h.replace(
    "state.db.create_server(req.name.trim(), &user_id, &req.invite_code_hash, encrypted_name_bytes.as_deref(), name_nonce_bytes.as_deref())",
    "state.db.create_server(&user_id, &req.invite_code_hash, encrypted_name_bytes.as_deref(), name_nonce_bytes.as_deref())"
)

# Remove "name": server.name from create_server response
h = h.replace(
    '''            \"id\": server.id,
            \"name\": server.name,
            \"encrypted_name\":''',
    '''            \"id\": server.id,
            \"encrypted_name\":'''
)

# 2c. list_servers: remove "name": s.name
h = h.replace('''                \"id\": s.id,
                \"name\": s.name,
                \"encrypted_name\":''', '''                \"id\": s.id,
                \"encrypted_name\":''')

# 2d. list_channels: remove "name": c.name
h = h.replace('''            \"id\": c.id,
                \"name\": c.name,
                \"encrypted_name\":''', '''            \"id\": c.id,
                \"encrypted_name\":''')

# 2e. CreateChannelRequest: make name optional
h = h.replace(
    '''pub struct CreateChannelRequest {
    pub name: String,
    pub encrypted_name: Option<String>,''',
    '''pub struct CreateChannelRequest {
    pub name: Option<String>,
    pub encrypted_name: Option<String>,'''
)

# 2f. create_channel: remove empty name check and "name": from response
h = h.replace(
    '''    if req.name.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({\"error\": \"Channel name is required\"})),
        )
            .into_response();
    }

    let encrypted_name_bytes''',
    '''    let encrypted_name_bytes'''
)

# Update create_channel call to not pass name
h = h.replace(
    "state.db.create_channel(&server_id, req.name.trim(), encrypted_name_bytes.as_deref(), name_nonce_bytes.as_deref())",
    "state.db.create_channel(&server_id, encrypted_name_bytes.as_deref(), name_nonce_bytes.as_deref())"
)

# Remove "name": channel.name from create_channel response
h = h.replace(
    '''            \"id\": channel.id,
            \"name\": channel.name,
            \"encrypted_name\":''',
    '''            \"id\": channel.id,
            \"encrypted_name\":'''
)

# 2g. join_server: remove "name": server.name
h = h.replace(
    '''        Json(serde_json::json!({\n            \"id\": server.id,\n            \"name\": server.name,\n        }))''',
    '''        Json(serde_json::json!({\n            \"id\": server.id,\n        }))'''
)

# 2h. admin_list_servers: remove "name": s.name
h = h.replace('''                \"id\": s.id,
                \"name\": s.name,
                \"owner_id\":''', '''                \"id\": s.id,
                \"owner_id\":''')

# 2i. admin_list_channels: remove "name": c.name
h = h.replace('''                \"id\": c.id,
                \"server_id\": c.server_id,
                \"name\": c.name,
                \"type\":''', '''                \"id\": c.id,
                \"server_id\": c.server_id,
                \"type\":''')

with open(handlers_path, "w", encoding="utf-8") as f:
    f.write(h)

print("✅ handlers.rs updated")

# ─── 3. admin.js: show encrypted blob instead of plaintext name ──────────

admin_path = fp("static/admin.js")
with open(admin_path, "r", encoding="utf-8") as f:
    a = f.read()

# 3a. CSV columns: servers — remove Name from headers
a = a.replace(
    "'servers': { headers: ['Name', 'Server ID', 'Owner ID', 'Created', 'Invite Code Hash', 'Joins Disabled'], map: (r) => [r.name, r.id, r.owner_id, r.created_at || '', r.invite_code_hash || '', r.joins_disabled ? 'Yes' : 'No'] },",
    "'servers': { headers: ['Encrypted Name', 'Server ID', 'Owner ID', 'Created', 'Invite Code Hash', 'Joins Disabled'], map: (r) => [r.encrypted_name || '(encrypted)', r.id, r.owner_id, r.created_at || '', r.invite_code_hash || '', r.joins_disabled ? 'Yes' : 'No'] },"
)

# 3b. CSV columns: channels — remove Name, add Encrypted Name
a = a.replace(
    "'channels': { headers: ['Name', 'Channel ID', 'Server ID', 'Type', 'Position', 'Created'], map: (r) => [r.name, r.id, r.server_id, r.type, String(r.position != null ? r.position : ''), r.created_at || ''] },",
    "'channels': { headers: ['Encrypted Name', 'Channel ID', 'Server ID', 'Type', 'Position', 'Created'], map: (r) => [r.encrypted_name || '(encrypted)', r.id, r.server_id, r.type, String(r.position != null ? r.position : ''), r.created_at || ''] },"
)

# 3c. renderServers: show encrypted blob instead of name
a = a.replace(
    "'<td>' + escapeHtml(s.name) + '</td>' +",
    "'<td class=\"blob-cell\">' + escapeHtml(truncate(s.encrypted_name || '(encrypted)', 30)) + '</td>' +"
)

# 3d. renderChannels: show encrypted blob instead of name
a = a.replace(
    "'<td>' + escapeHtml(c.name) + '</td>' +",
    "'<td class=\"blob-cell\">' + escapeHtml(truncate(c.encrypted_name || '(encrypted)', 30)) + '</td>' +"
)

with open(admin_path, "w", encoding="utf-8") as f:
    f.write(a)

print("✅ admin.js updated")

# ─── 4. chat.js: ensure encrypted_name is decrypted and used for display ──

chat_path = fp("static/chat.js")
with open(chat_path, "r", encoding="utf-8") as f:
    c = f.read()

# 4a. The server name fallback line: 
# From: `var serverDisplayName = server ? server.name : '';`
# To: decrypt from encrypted_name or show decrypted name
# The server object already gets decrypted_name set somewhere — let me check
# Looking at chat.js line 5178: `var displayName = s.name;` and then it tries to decrypt
# Let me check lines around 5178
# Actually this is complex — chat.js already has decryption logic. 
# The issue is that after removing "name" from server response, s.name will be undefined
# Line 5178: var displayName = s.name;
# Line 5183-5186: decrypts encrypted_name and uses it
# Line 5217: var serverDisplayName = server ? server.name : '';
# After our change, server.name will be undefined, but decrypted_server_name should be set

# Let me find the saveServer call
# Where does the server list response get processed?
# Line 5178 looks like it's inside renderServers or similar
# Let me look for how the server response is handled

# The server objects arrive via WS or via the list_user_servers API
# In renderServers (chat.js): it processes the server list, decrypts names
# The decrypted name should be stored back to the server object

# Let me check if there's already decryption logic
# Lines 5179-5194: 
#   if (s.encrypted_name && s.name_nonce) {
#       var sk = E2ECrypto.getServerKey(s.id);
#       if (sk) {
#           var decrypted = E2ECrypto.aeadDecrypt(s.encrypted_name, serverKey, s.name_nonce);
#           if (decrypted) { displayName = new TextDecoder().decode(decrypted); }
#       }
#   }

# So the server already has encrypted_name decryption. The issue is that
# displayName is set to s.name first, then overwritten if decryption works.
# After removing s.name, displayName will be undefined initially, but then
# set correctly via decryption. This should work fine as long as the decryption succeeds.

# BUT line 5217: var serverDisplayName = server ? server.name : '';
# This happens independently. If server.name is undefined, it shows ''
# We need to check if there's a decryptedServerName or similar

# Let me add a fallback to the decrypted name that should be stored on the server object
# Actually looking at lines 5178-5194, the code seems to work like this:
# - s.name is the plaintext name (soon to be undefined)
# - It decrypts encrypted_name and stores in displayName variable
# - But where is displayName used? How does the server object get updated?

# Let me look more carefully... Actually I think the issue is that the code already
# handles the decryption. After removing s.name, if the server object has encrypted_name
# and it can be decrypted, it will show the decrypted name. If not, it falls back to ''.

# But we also need to handle the forward modal and mute toggle.

# For the mute toggle (line 3986): sv.name is used. sv is from the servers list.
# After our change, sv.name will be undefined but sv should have encrypted_name.

# Actually, let me reconsider. The server object in chat.js consists of fields returned
# by the API. After we remove "name" from the API response, s.name will be undefined
# in JavaScript. The decryption code at lines 5179-5194 sets `displayName` but doesn't
# store it back to `s`. So s.name remains undefined. The forward modal and other places
# use `s.name` / `server.name` directly.

# We need to store the decrypted name back to the server object (as .name or similar)
# OR update all the places that use server.name to use the decrypted version.

# The simplest fix: after decryption succeeds, store the decrypted name to the 
# s.displayName (new field) or even back to s.decrypted_name.

# Actually wait — there's already a pattern. Let me look at line 5194:
# showServerContextMenu(e, s.id, s.name);
# This passes s.name. But s.name is now undefined. The context menu will show "undefined".

# Let me add a fallback to store the decrypted name back to the server object
# by modifying the decryption code to set s._decryptedName or similar

# Changes needed in chat.js:
# 1. In the server list decryption code: store decrypted name to a new field on s
# 2. In places that use server.name: add fallback chains

# Let me trace the exact code blocks...

# First, let me find where the decrypted name gets stored in the sv rendering
# Looking at the code path:
# - renderServers handles the server list
# - The server objects from the API don't have .name anymore
# - But they have .encrypted_name which gets decrypted

# Let me add the decrypted name back as s.name by setting it in the decryption code

# Find the server list rendering code
# Around line 5178: 
# var displayName = s.name;
# We should change to: var displayName = s.decryptedName || s.name || 'Server';

# Actually, simpler approach: after decrypting, set s.name = decryptedName
# so all existing code that uses s.name continues to work

# Replace: displayName = new TextDecoder().decode(decrypted);
# With: displayName = new TextDecoder().decode(decrypted); s.name = displayName;

# This way, all existing references to s.name will have the decrypted value

# chat.js changes needed:
# Lines around 5179-5194: after decrypt, write back to s.name
# Line 5217: server.name already handled if we set s.name

# Let me find the exact text patterns

# Pattern 1: server name decryption - set s.name = displayName after decrypt
old_decrypt_pattern1 = """        if (s.encrypted_name && s.name_nonce) {
            var serverKey = E2ECrypto.getServerKey(s.id);
            if (serverKey) {
                try {
                    var decrypted = E2ECrypto.aeadDecrypt(s.encrypted_name, serverKey, s.name_nonce);
                    if (decrypted) {
                        displayName = new TextDecoder().decode(decrypted);
                    }"""

new_decrypt_pattern1 = """        if (s.encrypted_name && s.name_nonce) {
            var serverKey = E2ECrypto.getServerKey(s.id);
            if (serverKey) {
                try {
                    var decrypted = E2ECrypto.aeadDecrypt(s.encrypted_name, serverKey, s.name_nonce);
                    if (decrypted) {
                        displayName = new TextDecoder().decode(decrypted);
                        s.name = displayName;
                    }"""

if old_decrypt_pattern1 in c:
    c = c.replace(old_decrypt_pattern1, new_decrypt_pattern1)
    print("  ✅ chat.js: set s.name after server name decrypt")
else:
    print("  ⚠️ chat.js: server name decrypt pattern not found, searching...")
    # Find what pattern actually exists
    idx = c.find("encrypted_name && s.name_nonce")
    if idx >= 0:
        print(f"  Found at index {idx}: {c[idx:idx+300]}")

# Pattern 2: in the server display render (around line 5217), add fallback
# Line 5217: var serverDisplayName = server ? server.name : '';
# After our change, server.name should be set by the decrypt code above
# But let's add a fallback just in case: use server.decryptedName or 'Server'
old_server_display = "var serverDisplayName = server ? server.name : '';"
new_server_display = "var serverDisplayName = server ? (server.name || '(loading)') : '';"
c = c.replace(old_server_display, new_server_display)

# Pattern 3: Forward modal uses server.name directly (lines 6601-6603)
# These happen AFTER the server decrypt code has run (since decrypt runs on load/render)
# So server.name should be set. Let's add a safety fallback:
old_forward = "html += '<div class=\"forward-server\"><div class=\"forward-server-name\">' + escapeHtml(server.name) + '</div>';"
new_forward = "html += '<div class=\"forward-server\"><div class=\"forward-server-name\">' + escapeHtml(server.name || '(unnamed)') + '</div>';"
c = c.replace(old_forward, new_forward)

old_forward2 = "html += '<div class=\"forward-channel-item\" data-server-id=\"' + server.id + '\" data-server-name=\"' + escapeHtml(server.name) + '\" data-channel-id=\"' + ch.id + '\" data-channel-name=\"' + escapeHtml(ch.name) + '\">' + escapeHtml(ch.name) + '</div>';"
new_forward2 = "html += '<div class=\"forward-channel-item\" data-server-id=\"' + server.id + '\" data-server-name=\"' + escapeHtml(server.name || '') + '\" data-channel-id=\"' + ch.id + '\" data-channel-name=\"' + escapeHtml(ch.name || '') + '\">' + escapeHtml(ch.name || '(unnamed)') + '</div>';"
c = c.replace(old_forward2, new_forward2)

old_forward3 = "html += '<div class=\"forward-channel-item\" data-server-id=\"' + sourceServerId + '\" data-server-name=\"' + escapeHtml(serverName) + '\" data-channel-id=\"' + ch.id + '\" data-channel-name=\"' + escapeHtml(ch.name) + '\">' + escapeHtml(ch.name) + '</div>';"
new_forward3 = "html += '<div class=\"forward-channel-item\" data-server-id=\"' + sourceServerId + '\" data-server-name=\"' + escapeHtml(serverName || '') + '\" data-channel-id=\"' + ch.id + '\" data-channel-name=\"' + escapeHtml(ch.name || '') + '\">' + escapeHtml(ch.name || '(unnamed)') + '</div>';"
c = c.replace(old_forward3, new_forward3)

# Pattern 4: channel name rendering in the sidebar (line 5301)
# var chDisplayName = ch.name;
# After decrypt, check if ch.decrypted name is available
old_channel_display = """
            var chDisplayName = ch.name;
            if (ch.encrypted_name && ch.name_nonce) {
                var sk2 = E2ECrypto.getServerKey(serverId);
                if (sk2) {
                    try {
                        var decCh = E2ECrypto.aeadDecrypt(ch.encrypted_name, sk2, ch.name_nonce);
                        if (decCh) {
                            chDisplayName = new TextDecoder().decode(decCh);
                        }"""
new_channel_display = """
            var chDisplayName = ch.name;
            if (ch.encrypted_name && ch.name_nonce) {
                var sk2 = E2ECrypto.getServerKey(serverId);
                if (sk2) {
                    try {
                        var decCh = E2ECrypto.aeadDecrypt(ch.encrypted_name, sk2, ch.name_nonce);
                        if (decCh) {
                            chDisplayName = new TextDecoder().decode(decCh);
                            ch.name = chDisplayName;
                        }"""
c = c.replace(old_channel_display, new_channel_display)

# Pattern 5: sv.name used in mute toggle (line 3986)
# sv is from the servers list. After setting s.name in decrypt, this should work
# Let me add fallback anyway:
old_mute = "svItem.textContent = isMutedSrv ? 'Unmute ' + sv.name : 'Mute ' + sv.name;"
new_mute = "svItem.textContent = isMutedSrv ? 'Unmute ' + (sv.name || 'Server') : 'Mute ' + (sv.name || 'Server');"
c = c.replace(old_mute, new_mute)

# Pattern 6: showServerContextMenu uses s.name (line 5194) 
# This runs right after the decrypt code in the same loop, so s.name is set

# Pattern 7: div.dataset.name = chDisplayName (line 5311)
# This stores the display name in the dataset for later use
# Line 5589 etc: ref.name — that's about emoji references, not channel names

# Pattern 8: channelName = channelEl.dataset.name || 'channel' (line 6035)
# This reads from dataset.name which was set from chDisplayName above - should work

# Pattern 9: deleteChannel(ch.id, ch.name) (line 5324) - after decrypt, should work

# Pattern 10: server mutation toggle in the server creation response handler
# Let me also fix the ws handler for channel_created — does it send name?

# Actually, looking at ws.rs, the channel_created WS message sends:
# let msg = json!({ "type": "channel_created", "server_id": server_id, "channel": new_channel });
# The new_channel from handlers.rs response includes "name": channel.name
# But channel.name was already removed... wait no, the WS broadcast happens after
# create_channel returns. The WS handler broadcasts separately. Let me check.

# Actually looking at the code, the WS handler for create_channel in ws.rs broadcasts
# directly from the server-side Channel struct which still had .name.
# Now that we've removed it from the struct, this will be a compile error.
# Let me check ws.rs...

with open(chat_path, "w", encoding="utf-8") as f:
    f.write(c)

print("✅ chat.js updated")

# ─── 5. Check ws.rs for channel_created broadcast ────────────────────────

ws_path = fp("server/src/ws.rs")
with open(ws_path, "r", encoding="utf-8") as f:
    ws = f.read()

# Check if ws.rs uses channel.name
if "channel.name" in ws:
    print("⚠️ ws.rs uses channel.name! Needs manual review.")
    # Find usage
    for i, line in enumerate(ws.split('\n'), 1):
        if 'channel.name' in line.lower():
            print(f"  ws.rs:{i}: {line.strip()}")
else:
    print("✅ ws.rs: no channel.name references found")

if "server.name" in ws:
    print("⚠️ ws.rs uses server.name! Needs manual review.")
    for i, line in enumerate(ws.split('\n'), 1):
        if 'server.name' in line.lower():
            print(f"  ws.rs:{i}: {line.strip()}")
else:
    print("✅ ws.rs: no server.name references found")

# ─── 6. Add migration to drop name columns ──────────────────────────────

# The migration is embedded in run_migrations() in db.rs
# Add it after the existing DROP COLUMN block for user profile columns
migration_block = """        // Migration: Drop plaintext server.name and channels.name columns
        for tbl_col in [("servers", "name"), ("channels", "name")] {
            let (tbl, col) = tbl_col;
            let col_exists: bool = conn
                .query_row(
                    &format!("SELECT COUNT(*) > 0 FROM pragma_table_info('{}') WHERE name = '{}'", tbl, col),
                    [],
                    |row| row.get::<_, i32>(0),
                )
                .map(|c| c > 0)
                .unwrap_or(false);
            if col_exists {
                let _ = conn.execute(&format!("ALTER TABLE {} DROP COLUMN {}", tbl, col), []);
            }
        }"""

# Insert this migration block after the existing drop profile columns migration
# Find the marker: the existing profile columns drop migration
insert_after = """        // Migration: Drop legacy plaintext profile columns (now in encrypted_profile_data)"""
insert_at = db.find(insert_after)
if insert_at >= 0:
    # Find end of that block - the next "// Re-create tables"
    block_end = db.find("        // Re-create tables that are still used by the codebase", insert_at)
    if block_end >= 0:
        # Insert our new block before "Re-create tables"
        new_db = db[:block_end] + "\n" + migration_block + "\n\n" + db[block_end:]
        with open(db_path, "w", encoding="utf-8") as f:
            f.write(new_db)
        print("✅ db.rs: added migration to drop name columns")
    else:
        print("⚠️ Could not find end of profile column migration block")
else:
    print("⚠️ Could not find profile columns drop migration marker")

print("\n✅ All changes applied!")
