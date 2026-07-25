"""
Extract connectWebSocket (lines 4383-5112, 730 lines) from chat.js into static/js/chat-ws.js.
Uses brace-matching to find the exact function boundaries, then removes it from chat.js.
"""
import re, os

CHAT_JS = "X:/Documents/GitHub/E2E_Talk/static/chat.js"
WS_JS   = "X:/Documents/GitHub/E2E_Talk/static/js/chat-ws.js"
INDEX   = "X:/Documents/GitHub/E2E_Talk/static/index.html"

with open(CHAT_JS, "r", encoding="utf-8") as f:
    text = f.read()

lines = text.split("\n")
print(f"chat.js: {len(lines)} lines")

# Find connectWebSocket function
pattern = re.compile(r'function\s+connectWebSocket\s*\(')
m = pattern.search(text)
if not m:
    print("ERROR: connectWebSocket not found!")
    exit(1)

start_pos = m.start()
start_line = text[:start_pos].count('\n') + 1
print(f"connectWebSocket starts at line {start_line}")

# Find opening brace
brace_pos = text.find('{', start_pos)
if brace_pos < 0:
    print("ERROR: Could not find opening brace")
    exit(1)

# Find matching close brace with string/comment awareness
def find_end(text, start):
    depth = 0
    i = start
    in_dq = in_sq = in_bt = False
    bt_interp = 0  # template literal interpolation depth
    
    while i < len(text):
        ch = text[i]
        nc = text[i+1] if i+1 < len(text) else ''
        
        if ch == '\\' and (in_dq or in_sq or in_bt):
            i += 2
            continue
        
        if not (in_bt and bt_interp > 0):
            if ch == '"' and not in_sq and not in_bt:
                in_dq = not in_dq
            elif ch == "'" and not in_dq and not in_bt:
                in_sq = not in_sq
            elif ch == '`' and not in_dq and not in_sq:
                in_bt = not in_bt if bt_interp == 0 else True
        
        if in_bt and not in_dq and not in_sq:
            if ch == '$' and nc == '{':
                bt_interp += 1
                i += 2
                continue
            elif ch == '}' and bt_interp > 0:
                bt_interp -= 1
                i += 1
                continue
        
        # Comments
        if not in_dq and not in_sq and not in_bt:
            if ch == '/' and nc == '/':
                while i < len(text) and text[i] != '\n':
                    i += 1
            elif ch == '/' and nc == '*':
                i += 2
                while i < len(text):
                    if text[i] == '*' and i+1 < len(text) and text[i+1] == '/':
                        i += 1
                        break
                    i += 1
        
        # Brace counting
        if not in_dq and not in_sq:
            if not in_bt or bt_interp > 0:
                if ch == '{': depth += 1
                elif ch == '}':
                    depth -= 1
                    if depth == 0:
                        return i
        i += 1
    return -1

end_pos = find_end(text, brace_pos)
if end_pos < 0:
    print("ERROR: Could not find matching close brace")
    exit(1)

end_line = text[:end_pos].count('\n') + 1
print(f"connectWebSocket ends at line {end_line} (inclusive)")
print(f"Function spans {end_line - start_line + 1} lines")

# Extract function text
func_text = text[start_pos:end_pos+1]

# Remove function from text (replace with empty string)
new_text = text[:start_pos] + text[end_pos+1:]

# Remove extra blank lines that might result
# (the function was on its own lines, so we might have duplicate blank lines)
new_text = re.sub(r'\n{3,}', '\n\n', new_text)

# Verify new file
new_line_count = new_text.count('\n')
print(f"\nNew chat.js: {new_line_count} lines (removed {len(lines) - new_line_count} lines)")

# Write output files
os.makedirs(os.path.dirname(WS_JS), exist_ok=True)

with open(WS_JS, 'w', encoding='utf-8') as f:
    f.write('// === WebSocket Handler (extracted from chat.js) ===\n')
    f.write('// Loaded before chat.js. All functions are global and called at runtime.\n\n')
    f.write(func_text)
    if not func_text.endswith('\n'):
        f.write('\n')
    f.write('\n')

with open(CHAT_JS, 'w', encoding='utf-8') as f:
    f.write(new_text)
    if not new_text.endswith('\n'):
        f.write('\n')

# Verify JS syntax
import subprocess
result = subprocess.run(['node', '-c', WS_JS], capture_output=True, text=True)
if result.returncode == 0:
    print(f"\nchat-ws.js: Syntax OK")
else:
    print(f"\nchat-ws.js: Syntax ERROR - {result.stderr}")

result = subprocess.run(['node', '-c', CHAT_JS], capture_output=True, text=True)
if result.returncode == 0:
    print(f"chat.js: Syntax OK")
else:
    print(f"\nchat.js: Syntax ERROR - {result.stderr.split(chr(10))[-2]}")

# Update index.html
with open(INDEX, 'r', encoding='utf-8') as f:
    html = f.read()

old_tag = '<script src="chat.js'
new_tags = '<script src="js/chat-ws.js?v=1"></script>\n    <script src="chat.js'

if html.count(old_tag) == 1 and old_tag in html:
    html = html.replace(old_tag, new_tags)
    with open(INDEX, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f"index.html: Updated")
else:
    print(f"index.html: WARNING - pattern issue (found {html.count(old_tag)} times)")

print("\nDone!")
