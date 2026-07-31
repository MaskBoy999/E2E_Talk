#!/usr/bin/env python3
"""Fix remaining message_signature references after migration 044 dropped the column."""

import re

# Fix db.rs
with open('server/src/db.rs', 'r') as f:
    content = f.read()

# Fix 1: list_messages_around SELECT queries - remove message_signature
content = content.replace(
    'm.message_nonce, m.edited_at, m.message_signature,\n                        m.encrypted_profile_key',
    'm.message_nonce, m.edited_at,\n                        m.encrypted_profile_key'
)

# Fix 2: list_dm_messages SELECT queries - remove message_signature
content = content.replace(
    'm.message_nonce, m.edited_at, m.message_signature,\n                    m.encrypted_profile_key',
    'm.message_nonce, m.edited_at,\n                    m.encrypted_profile_key'
)
content = content.replace(
    'message_nonce, edited_at, message_signature,\n                         encrypted_profile_key',
    'message_nonce, edited_at,\n                         encrypted_profile_key'
)

# Fix 3: edit_encrypted_message - remove message_signature param
content = content.replace(
    'new_message_nonce: Option<&str>,\n        new_message_signature: Option<&str>,\n        new_encrypted_profile_key',
    'new_message_nonce: Option<&str>,\n        new_encrypted_profile_key'
)

# Fix 4: edit_encrypted_message UPDATE - remove message_signature = ?5
content = content.replace(
    ', message_nonce = ?3, message_signature = ?5, encrypted_profile_key = ?6',
    ', message_nonce = ?3, encrypted_profile_key = ?6'
)
content = content.replace(
    ', message_id, new_message_signature, new_encrypted_profile_key',
    ', message_id, new_encrypted_profile_key'
)

# Fix 5: edit_encrypted_message SELECT - remove message_signature
content = content.replace(
    'm.message_nonce, m.edited_at, m.message_signature, m.encrypted_profile_key',
    'm.message_nonce, m.edited_at, m.encrypted_profile_key'
)

# Fix 6: edit_dm_message - remove message_signature param
content = content.replace(
    'new_message_nonce: Option<&str>,\n        new_message_signature: Option<&str>,\n        new_encrypted_profile_key',
    'new_message_nonce: Option<&str>,\n        new_encrypted_profile_key',
    1  # Only first occurrence
)
# Second occurrence
content = content.replace(
    'new_message_nonce: Option<&str>,\n        new_message_signature: Option<&str>,\n        new_encrypted_profile_key',
    'new_message_nonce: Option<&str>,\n        new_encrypted_profile_key',
    1
)

# Fix 7: edit_dm_message UPDATE - remove message_signature
content = content.replace(
    'UPDATE dm_messages SET encrypted_content = ?1, nonce = ?2, message_nonce = ?3, message_signature = ?5, encrypted_profile_key = ?6',
    'UPDATE dm_messages SET encrypted_content = ?1, nonce = ?2, message_nonce = ?3, encrypted_profile_key = ?6'
)

# Fix 8: admin list_all_messages
content = content.replace(
    "COALESCE(m.edited_at, ''), COALESCE(m.message_signature, ''), COALESCE(m.encrypted_profile_key",
    "COALESCE(m.edited_at, ''), COALESCE(m.encrypted_profile_key"
)

with open('server/src/db.rs', 'w') as f:
    f.write(content)
print('Fixed db.rs')

# Fix ws.rs - remove None message_signature arguments
with open('server/src/ws.rs', 'r') as f:
    content = f.read()

# The callers pass None for message_signature - remove these
# Pattern: message_nonce.as_deref(), None, encrypted_profile_key
content = content.replace(
    'message_nonce.as_deref(), None, encrypted_profile_key.as_deref()',
    'message_nonce.as_deref(), encrypted_profile_key.as_deref()'
)

with open('server/src/ws.rs', 'w') as f:
    f.write(content)
print('Fixed ws.rs')

print('All fixes applied successfully')
