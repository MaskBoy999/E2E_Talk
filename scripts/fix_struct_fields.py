# -*- coding: utf-8 -*-
"""Fix missing struct fields in db.rs initializers."""

import sys, os
sys.stdout.reconfigure(encoding='utf-8')

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
path = os.path.join(BASE, 'server', 'src', 'db.rs')

with open(path, 'r', encoding='utf-8', newline='\n') as f:
    content = f.read()

# Replace all occurrences of the struct initializer ending
old = "file_key_nonce: file_key_nonce.map(|v| v.to_vec()),\n        })"
new = "file_key_nonce: file_key_nonce.map(|v| v.to_vec()),\n            encrypted_sender_username: encrypted_sender_username.map(|s| s.to_string()),\n            sender_username_nonce: sender_username_nonce.map(|s| s.to_string()),\n        })"

count = content.count(old)
if count > 0:
    content = content.replace(old, new)
    print(f"Fixed {count} struct initializers")
else:
    print("Pattern not found!")
    idx = content.find("file_key_nonce: file_key_nonce.map(|v| v.to_vec())")
    if idx >= 0:
        print(f"Found at {idx}: {repr(content[idx:idx+250])}")

with open(path, 'w', encoding='utf-8', newline='\n') as f:
    f.write(content)

# Now fix the method params that were added
# Check for save_encrypted_message params
if "encrypted_sender_username: Option<&str>,\n        sender_username_nonce: Option<&str>,\n    ) -> Result<Message, String> {" in content:
    print("save_encrypted_message params already fixed")
else:
    print("Need to fix save_encrypted_message params")

print("Done!")
