# -*- coding: utf-8 -*-
"""Fix ALL remaining P3 compilation errors."""

import sys, os
sys.stdout.reconfigure(encoding='utf-8')

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def load(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()

def save(path, content):
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(content)

def fix(path, old, new, label):
    """Replace old with new (handling CRLF)."""
    c = load(path)
    c2 = c.replace('\r\n', '\n')
    old2 = old.replace('\r\n', '\n')
    new2 = new.replace('\r\n', '\n')
    if old2 in c2:
        c2 = c2.replace(old2, new2, 1)
        save(path, c2)
        print(f'  OK: {label}')
        return True
    else:
        print(f'  XX: {label} - NOT FOUND')
        return False

print('=' * 60)
print('Fix ALL remaining P3 compilation errors')
print('=' * 60)

# ==========================================================================
# 1. ws.rs - Fix OutgoingChatMessage constructors (4 places)
# ==========================================================================
print('\n--- server/src/ws.rs ---')

# Patch 1: First occurrence (server message handler)
# The 4 patterns vary slightly. Let me use the most common one.
# All have "sender_profile_pic: ..." line before encrypted_content
# We need to add encrypted_sender_username after sender_username

# There are 4 constructors with the pattern "sender_username: message.sender_username,"
# followed by "sender_profile_pic:" on the next line
# We need to add the new fields between them

c = load(os.path.join(BASE_DIR, 'server', 'src', 'ws.rs'))
c2 = c.replace('\r\n', '\n')

# Add new fields after each sender_username line
# Pattern: "sender_username: message.sender_username,\n                    sender_profile_pic:"
old_w = 'sender_username: message.sender_username,\n                    sender_profile_pic:'
new_w = 'sender_username: message.sender_username,\n                    encrypted_sender_username: message.encrypted_sender_username.clone(),\n                    sender_username_nonce: message.sender_username_nonce.clone(),\n                    sender_profile_pic:'

count = c2.count(old_w)
if count > 0:
    c2 = c2.replace(old_w, new_w, count)
    print(f'  OK: Fixed {count} OutgoingChatMessage constructors')
else:
    print(f'  XX: OutgoingChatMessage pattern not found')

save(os.path.join(BASE_DIR, 'server', 'src', 'ws.rs'), c2)

# ==========================================================================
# 2. db.rs - Fix all remaining struct initializers
# ==========================================================================
print('\n--- server/src/db.rs ---')

c = load(os.path.join(BASE_DIR, 'server', 'src', 'db.rs'))
c2 = c.replace('\r\n', '\n')

# Fix 1: Add None defaults to Message/DmMessage initializers that don't have the fields
# These are the internal/admin queries that construct Message without going through save_encrypted_message
# Pattern: file_key_nonce: ... followed by })
old_d = 'file_key_nonce: row.get(19)?,\n                })'
new_d = 'file_key_nonce: row.get(19)?,\n                    encrypted_sender_username: None,\n                    sender_username_nonce: None,\n                })'

count = c2.count(old_d)
if count > 0:
    c2 = c2.replace(old_d, new_d, count)
    print(f'  OK: Fixed {count} query-based Message initializers (row.get)')
else:
    print(f'  XX: row.get(19) pattern not found')

# Fix 2: For functions that return Message/DmMessage with params (next().unwrap() pattern)
old_d2 = 'encrypted_sender_username: encrypted_sender_username.map(|s| s.to_string()),\n            sender_username_nonce: sender_username_nonce.map(|s| s.to_string()),\n        })'
# These are already fixed, skip

# Fix 3: For get_message() and get_dm_message() functions that construct from row.get()
# Look for patterns like: file_key_nonce: row.get(...)? followed by })
# For shorter column lists (fewer columns - different queries)
old_d3 = 'file_key_nonce: row.get(9)?,\n                })'
new_d3 = 'file_key_nonce: row.get(9)?,\n                    encrypted_sender_username: None,\n                    sender_username_nonce: None,\n                })'
count3 = c2.count(old_d3)
if count3 > 0:
    c2 = c2.replace(old_d3, new_d3, count3)
    print(f'  OK: Fixed {count3} query-based DM initializers (row.get(9))')

save(os.path.join(BASE_DIR, 'server', 'src', 'db.rs'), c2)

# ==========================================================================
# 3. handlers.rs - Add encrypted_sender_username to JSON responses
# ==========================================================================
print('\n--- server/src/handlers.rs ---')

c = load(os.path.join(BASE_DIR, 'server', 'src', 'handlers.rs'))
c2 = c.replace('\r\n', '\n')

# The JSON response for list_messages includes "sender_username": m.sender_username
# We need to add encrypted_sender_username right after
old_h = '"sender_username": m.sender_username,\n                "sender_profile_pic":'
new_h = '"sender_username": m.sender_username,\n                "encrypted_sender_username": m.encrypted_sender_username,\n                "sender_username_nonce": m.sender_username_nonce,\n                "sender_profile_pic":'

count = c2.count(old_h)
if count > 0:
    c2 = c2.replace(old_h, new_h, count)
    print(f'  OK: Fixed {count} JSON responses')
else:
    print(f'  XX: JSON response pattern not found')

save(os.path.join(BASE_DIR, 'server', 'src', 'handlers.rs'), c2)

print('\nDone! Build to verify.')
