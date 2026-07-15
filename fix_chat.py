# -*- coding: utf-8 -*-
import sys

# Force UTF-8
sys.stdin.reconfigure(encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')

with open('static/chat.js', 'r', encoding='utf-8', errors='replace') as f:
    content = f.read()

# 1. Add favorite button to GIF files in buildFileCardHtml
old_dl = '<button class="file-download-btn" title="Download">\\u2B07</button>'
if old_dl in content and 'favorite-gif-btn' not in content:
    new_dl = old_dl + "\n        (fileData.mime_type && fileData.mime_type.includes('image/gif') ? '<button class=\"favorite-gif-btn\" title=\"Favorite GIF\" style=\"width:36px;height:36px;background:var(--bg-primary);border:1px solid var(--bg-border);border-radius:8px;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:#aaa;\">\\u2606</button>' : '') +"
    content = content.replace(old_dl, new_dl, 1)
    print("Added favorite button to GIF files")
else:
    print("Skip: favorite-gif-btn already exists or download button not found")

# 2. Remove old gifSearchTimeout variable (dead code)
if 'let gifSearchTimeout = null;' in content:
    content = content.replace('let gifSearchTimeout = null;\n', '')
    print("Removed dead gifSearchTimeout variable")
else:
    print("Skip: gifSearchTimeout already removed")

with open('static/chat.js', 'w', encoding='utf-8', errors='replace') as f:
    f.write(content)

print("Done - chat.js updated")
