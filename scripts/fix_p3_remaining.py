# -*- coding: utf-8 -*-
"""Fix all remaining P3 compilation errors."""

import sys, os
sys.stdout.reconfigure(encoding='utf-8')

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def fix_file(rel_path, patches):
    """Apply patches to a file. patches is a list of (old_substr, new_substr)."""
    path = os.path.join(BASE, rel_path)
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Normalize to LF for matching
    content_lf = content.replace('\r\n', '\n')
    
    count = 0
    for old, new in patches:
        old_lf = old.replace('\r\n', '\n')
        new_lf = new.replace('\r\n', '\n')
        if old_lf in content_lf:
            content_lf = content_lf.replace(old_lf, new_lf, 1)
            count += 1
            print(f"  OK: Applied patch")
        else:
            print(f"  XX: NOT FOUND: {old[:100]}...")
    
    # Write back with original line endings
    if count > 0:
        with open(path, 'w', encoding='utf-8', newline='\n') as f:
            f.write(content_lf)
    
    return count

print("=" * 60)
print("Fixing remaining P3 compilation errors")
print("=" * 60)

# ===========================================================================
# 1. ws.rs: Add encrypted_sender_username + sender_username_nonce
# to all OutgoingChatMessage constructors and incoming structs
# ===========================================================================
print("\n--- server/src/ws.rs ---")

fixes = [
    # Fix OutgoingChatMessage constructors - 4 places
    (
        "sender_username: message.sender_username,\n            sender_profile_pic:",
        "sender_username: message.sender_username,\n            encrypted_sender_username: message.encrypted_sender_username,\n            sender_username_nonce: message.sender_username_nonce,\n            sender_profile_pic:"
    ),
]

fix_file('server/src/ws.rs', fixes)

# Also need to check the incoming WS message struct for server messages
# It might not have the fields yet, which means the WS handler can't access them
print("\n--- Checking incoming WS structs ---")
path = os.path.join(BASE, 'server', 'src', 'ws.rs')
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()
content_lf = content.replace('\r\n', '\n')

# Check if the incoming message struct has encrypted_sender_username field
if 'encrypted_sender_username' not in content_lf:
    print("XX: Incoming struct doesn't have encrypted_sender_username")
    # The incoming struct is probably called something like IncomingMessage or is a JSON value
    # Let's find the actual struct name
    import re
    # Look for struct definitions that handle incoming messages
    for m in re.finditer(r'(pub\s+struct\s+\w+\s*\{[^}]*sender_username[^}]*\})', content_lf):
        print(f"  Found struct with sender_username: {m.group(1)[:100]}...")
else:
    print("OK: encrypted_sender_username found in ws.rs")

# ===========================================================================
# 2. db.rs: Fix remaining struct initializers
# ===========================================================================
print("\n--- server/src/db.rs ---")

# The errors show that some functions don't have encrypted_sender_username in scope
# These are functions in db.rs that construct Message/DmMessage but don't receive
# the encrypted fields as parameters. We need to add None as default values.

path = os.path.join(BASE, 'server', 'src', 'db.rs')
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()
content_lf = content.replace('\r\n', '\n')

# Find all struct initializers missing the fields
missing = []
search_start = 0
while True:
    idx = content_lf.find('encrypted_sender_username:', search_start)
    if idx < 0:
        break
    search_start = idx + 1
    # Found an existing one, skip

# Now find places where Message { or DmMessage { is constructed but missing the fields
# These are places where the struct has file_key_nonce: ... but NOT encrypted_sender_username:
for pattern in ['Ok(Message {', 'Ok(DmMessage {', 'Message {', 'DmMessage {']:
    search_start = 0
    while True:
        idx = content_lf.find(pattern, search_start)
        if idx < 0:
            break
        search_start = idx + 1
        
        # Check if this particular block has encrypted_sender_username
        block = content_lf[idx:idx+800]
        if 'encrypted_sender_username' not in block:
            # Find the file_key_nonce line in this block
            fn_idx = block.find('file_key_nonce:')
            if fn_idx >= 0:
                # Found a missing one - extract context
                line_start = block.rfind('\n', 0, fn_idx) + 1
                line_end = block.find('\n', fn_idx)
                line = block[line_start:line_end]
                context_before = block[max(0, line_start-50):line_start]
                print(f"  XX Missing at: ...{context_before[-30:]}...{line[:60]}...")

print("\nAttempting bulk fix: add None defaults to all missing initializers...")

# For all remaining struct initializers where encrypted_sender_username is not set,
# add it as None after file_key_nonce
old = "file_key_nonce: file_key_nonce.map(|v| v.to_vec()),\n        })"
new = "file_key_nonce: file_key_nonce.map(|v| v.to_vec()),\n            encrypted_sender_username: None,\n            sender_username_nonce: None,\n        })"

# Only apply where FILE_KEY_NONCE is defined as a variable (not param) - this is the admin/internal queries
# Actually, the issue is that some functions DON'T have encrypted_sender_username as a param
count = content_lf.count(old)
if count > 0:
    content_lf = content_lf.replace(old, new)
    print(f"  Applied None defaults to {count} remaining initializers")
else:
    print("  No more initializers to fix")

with open(path, 'w', encoding='utf-8', newline='\n') as f:
    f.write(content_lf)

print("\nDone! Build to verify.")
