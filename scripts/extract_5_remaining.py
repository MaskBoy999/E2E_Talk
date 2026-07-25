"""
Manually extract the 5 remaining functions that the automatic brace-matcher
couldn't handle. Using exact line numbers verified from git HEAD.
"""
import subprocess, re

PROJECT = "X:/Documents/GitHub/E2E_Talk"
CHAT_JS = PROJECT + "/static/chat.js"
UI_JS   = PROJECT + "/static/js/chat-ui.js"

# Read original from git HEAD
result = subprocess.run(['git', 'show', 'HEAD:static/chat.js'],
    capture_output=True, cwd=PROJECT)
text = result.stdout.decode('utf-8')
lines = text.split('\n')
print(f"Original chat.js: {len(lines)} lines")

# Line boundaries verified from manual inspection:
# escapeAttr:     9075-9077  (simple, 2 braces)
# highlightHtml:  9441-9450  (10 lines, no internal braces)
# highlightCss:   9462-9472  (11 lines, regex has \{
# highlightKeyValue: 9474-9486 (13 lines, YAML-like highlighting)
# highlightGeneric: 9488-9795 (308 lines, but complex with many regexes)
#
# For escapeAttr, highlightHtml, highlightKeyValue: exact lines are correct.
# For highlightCss and highlightGeneric: the simple brace count fails
# because regex patterns contain \{ that throw off the count.
# Use string-aware brace matching for these.

extra = []

# 1. escapeAttr — simple 3-line function
extra.append(('\n'.join(lines[9074:9077]),
    'escapeAttr', 9075, 9077))

# 2. highlightHtml — 10 lines
extra.append(('\n'.join(lines[9440:9450]),
    'highlightHtml', 9441, 9450))

# 3. highlightCss — has regex with \{ inside. End at 9472
# Verify by reading the actual content
func_end = 9472
# Check if the line at 9472 starts with '}'
if lines[9471].strip() == '}':
    extra.append(('\n'.join(lines[9461:9472]),
        'highlightCss', 9462, 9472))
else:
    print("highlightCss: END LINE MISMATCH - expected } at line 9472")

# 4. highlightKeyValue — 13 lines
extra.append(('\n'.join(lines[9473:9486]),
    'highlightKeyValue', 9474, 9486))

# 5. highlightGeneric — complex, use string-aware brace matching
name = 'highlightGeneric'
m = re.search(r'function\s+' + name + r'\s*\(', text)
if m:
    brace = text.find('{', m.end())
    # String-aware brace matching
    depth = 0
    in_dq = in_sq = in_bt = False
    bt_interp = 0
    i = brace
    while i < len(text):
        ch = text[i]
        nc = text[i+1] if i+1 < len(text) else ''
        
        if ch == '\\' and (in_dq or in_sq or in_bt):
            i += 2; continue
        
        if not (in_bt and bt_interp > 0):
            if ch == '"' and not in_sq and not in_bt: in_dq = not in_dq
            elif ch == "'" and not in_dq and not in_bt: in_sq = not in_sq
            elif ch == '`' and not in_dq and not in_sq:
                if in_bt and bt_interp == 0: in_bt = False
                else: in_bt = True; bt_interp = 0
        
        if in_bt and not in_dq and not in_sq:
            if ch == '$' and nc == '{': bt_interp += 1; i += 2; continue
            elif ch == '}' and bt_interp > 0: bt_interp -= 1; i += 1; continue
        
        # Comments
        if not in_dq and not in_sq and not in_bt:
            if ch == '/' and nc == '/':
                while i < len(text) and text[i] != '\n': i += 1
            elif ch == '/' and nc == '*':
                i += 2
                while i < len(text):
                    if text[i] == '*' and i+1 < len(text) and text[i+1] == '/':
                        i += 1; break
                    i += 1
        
        if not in_dq and not in_sq and not (in_bt and bt_interp == 0):
            if ch == '{': depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0:
                    func_end_line = text[:i].count('\n') + 1
                    func_text = text[m.start():i+1]
                    opens = func_text.count('{')
                    closes = func_text.count('}')
                    print(f"highlightGeneric: braces {opens}/{closes}, ends at line {func_end_line}")
                    if opens == closes:
                        extra.append((func_text, name, lines[:m.start()].count('\n')+1, func_end_line))
                    break
        i += 1

print(f"\nFound {len(extra)} functions to extract:")
for f_text, name, sl, el in extra:
    print(f"  {name}: lines {sl}-{el} ({el-sl+1} lines)")
    # Validate brace balance
    o = f_text.count('{')
    c = f_text.count('}')
    if o != c:
        print(f"    WARNING: {o} open vs {c} close braces!")

# Now read the current chat.js and chat-ui.js
with open(CHAT_JS, 'r', encoding='utf-8') as f:
    chat_text = f.read()

with open(UI_JS, 'r', encoding='utf-8') as f:
    ui_text = f.read()

# For each extracted function, find it in CURRENT chat.js and remove it
removed = []
added = []
for f_text, name, sl, el in extra:
    # Find this function in current chat.js
    m = re.search(r'(?:async\s+)?function\s+' + re.escape(name) + r'\s*\(', chat_text)
    if m:
        brace = chat_text.find('{', m.end())
        # Find matching close brace using proper matching
        depth = 0
        in_dq = in_sq = in_bt = False
        bt_interp = 0
        i = brace
        while i < len(chat_text):
            ch = chat_text[i]
            nc = chat_text[i+1] if i+1 < len(chat_text) else ''
            if ch == '\\' and (in_dq or in_sq or in_bt):
                i += 2; continue
            if not (in_bt and bt_interp > 0):
                if ch == '"' and not in_sq and not in_bt: in_dq = not in_dq
                elif ch == "'" and not in_dq and not in_bt: in_sq = not in_sq
                elif ch == '`' and not in_dq and not in_sq:
                    if in_bt and bt_interp == 0: in_bt = False
                    else: in_bt = True; bt_interp = 0
            if in_bt and not in_dq and not in_sq:
                if ch == '$' and nc == '{': bt_interp += 1; i += 2; continue
                elif ch == '}' and bt_interp > 0: bt_interp -= 1; i += 1; continue
            if not in_dq and not in_sq and not in_bt:
                if ch == '/' and nc == '/':
                    while i < len(chat_text) and chat_text[i] != '\n': i += 1
                elif ch == '/' and nc == '*':
                    i += 2
                    while i < len(chat_text):
                        if chat_text[i] == '*' and i+1 < len(chat_text) and chat_text[i+1] == '/':
                            i += 1; break
                        i += 1
            if not in_dq and not in_sq and not (in_bt and bt_interp == 0):
                if ch == '{': depth += 1
                elif ch == '}':
                    depth -= 1
                    if depth == 0:
                        func_in_chat = chat_text[m.start():i+1]
                        o2 = func_in_chat.count('{')
                        c2 = func_in_chat.count('}')
                        if o2 == c2:
                            # Remove from chat.js
                            chat_text = chat_text[:m.start()] + chat_text[i+1:]
                            removed.append(name)
                            # Don't add to UI if already there
                            if ('function ' + name) not in ui_text:
                                added.append(name)
                                ui_text = ui_text.rstrip() + '\n\n' + func_in_chat + '\n'
                            print(f"  Extracted {name}: {o2}/{c2} braces, {len(func_in_chat.split(chr(10)))} lines")
                        break
            i += 1

chat_text = re.sub(r'\n{3,}', '\n\n', chat_text)

# Write files
with open(CHAT_JS, 'w', encoding='utf-8') as f:
    f.write(chat_text)
with open(UI_JS, 'w', encoding='utf-8') as f:
    f.write(ui_text)

print(f"\n=== Summary ===")
print(f"  Removed from chat.js: {len(removed)} functions")
print(f"  Added to chat-ui.js: {len(added)} functions")
print(f"  Already in chat-ui.js: {len(extra) - len(added)} functions")
print(f"  chat.js lines: {chat_text.count(chr(10))+1}")
print(f"  chat-ui.js lines: {ui_text.count(chr(10))+1}")
