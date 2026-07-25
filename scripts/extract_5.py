"""
Extract the 5 remaining functions from chat.js into chat-ui.js.
Uses regex-literal-aware brace counting from the original git HEAD to find exact boundaries.
"""
import subprocess, re, os, json

PROJECT = "X:/Documents/GitHub/E2E_Talk"
CHAT_JS = os.path.join(PROJECT, "static/chat.js")
UI_JS = os.path.join(PROJECT, "static/js/chat-ui.js")

# Read original from git HEAD
result = subprocess.run(
    ["git", "show", "HEAD:static/chat.js"],
    capture_output=True, cwd=PROJECT
)
orig = result.stdout.decode("utf-8", errors="replace")
orig_lines = orig.split("\n")

# Read current files
with open(CHAT_JS, "r", encoding="utf-8") as f:
    chat = f.read()
with open(UI_JS, "r", encoding="utf-8") as f:
    ui = f.read()


def is_regex_literal(text, pos):
    """Heuristic: is the '/' at position 'pos' the start of a regex literal?"""
    if pos < 0 or pos >= len(text) or text[pos] != '/':
        return False
    # Look backwards skipping whitespace to see the previous token
    i = pos - 1
    while i >= 0 and text[i] in ' \t\n\r':
        i -= 1
    if i < 0:
        return False
    # Operators and keywords that precede regexes
    regex_preceders = set('=([{,:;!&|?^~*%/<>+-')
    ch = text[i]
    if ch in regex_preceders:
        return True
    # Also after return, case, throw, typeof, void, delete
    # Check the word ending at i
    word_end = i + 1
    while i >= 0 and (text[i].isalnum() or text[i] == '_' or text[i] == '$'):
        i -= 1
    word = text[i+1:word_end]
    if word in ('return', 'case', 'throw', 'typeof', 'void', 'delete', 'new', 'in', 'of', 'instanceof'):
        return True
    return False


def find_matching_brace(text, start_pos):
    """Find matching close brace with full string/template/regex/comment awareness."""
    depth = 1  # start after the opening brace
    i = start_pos + 1
    in_dq = in_sq = False
    in_bt = 0  # 0 = not in template, >0 = depth of template interpolation
    bt_stack = []
    
    while i < len(text):
        ch = text[i]
        nc = text[i+1] if i+1 < len(text) else ''
        
        # --- Handle different contexts ---
        
        # Escape sequence: skip next char
        if ch == '\\' and (in_dq or in_sq or in_bt > 0):
            i += 2
            continue
        
        # Single-quoted string
        if ch == "'" and not in_dq and in_bt == 0:
            in_sq = not in_sq
            i += 1
            continue
        
        # Double-quoted string
        if ch == '"' and not in_sq and in_bt == 0:
            in_dq = not in_dq
            i += 1
            continue
        
        # Template literal (backtick)
        if ch == '`' and not in_dq and not in_sq:
            if in_bt == 0:
                in_bt = 1  # entering template
            else:
                in_bt = 0  # leaving template
            i += 1
            continue
        
        # Template interpolation: ${ ... }
        if ch == '$' and nc == '{' and not in_dq and not in_sq:
            if in_bt > 0:
                bt_stack.append(in_bt)
                in_bt = 0  # temporarily leave template mood
            # Don't count the opening brace as a real brace
            i += 2
            continue
        
        # End of template interpolation: }
        if ch == '}' and not in_dq and not in_sq and in_bt == 0:
            if bt_stack:
                # This closes an interpolation, not a real brace
                bt_stack.pop()
                i += 1
                continue
        
        # Single-line comment: //
        if ch == '/' and nc == '/' and not in_dq and not in_sq and in_bt == 0:
            while i < len(text) and text[i] != '\n':
                i += 1
            continue
        
        # Multi-line comment: /* */
        if ch == '/' and nc == '*' and not in_dq and not in_sq and in_bt == 0:
            i += 2
            while i < len(text):
                if text[i] == '*' and i+1 < len(text) and text[i+1] == '/':
                    i += 2
                    break
                i += 1
            continue
        
        # Regex literal: /pattern/flags
        if ch == '/' and not in_dq and not in_sq and in_bt == 0:
            if is_regex_literal(text, i):
                i += 1  # skip opening /
                while i < len(text):
                    if text[i] == '\\':
                        i += 2
                        continue
                    if text[i] == '/':
                        # End of regex pattern, include flags
                        i += 1
                        while i < len(text) and text[i].isalpha():
                            i += 1
                        break
                    i += 1
                continue
        
        # Brace counting
        if not in_dq and not in_sq and in_bt == 0 and not bt_stack:
            if ch == '{':
                depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0:
                    return i
        
        i += 1
    return -1


def extract_function(text, name):
    """Find a function declaration by name and return (start, end+1) or None."""
    # Match patterns like: function name( or async function name(
    pat = re.compile(r'(?:async\s+)?function\s+' + re.escape(name) + r'\s*\(')
    m = pat.search(text)
    if not m:
        return None
    
    func_start = m.start()
    
    # Find the opening brace
    brace = text.find('{', m.end())
    if brace < 0:
        return None
    
    # Find the matching closing brace
    end = find_matching_brace(text, brace)
    if end < 0:
        return None
    
    func_text = text[func_start:end+1]
    opens = func_text.count('{')
    closes = func_text.count('}')
    
    print(f"  {name}: lines ~{text[:func_start].count(chr(10))+1}-{text[:end].count(chr(10))+1}, "
          f"{len(func_text.split(chr(10)))} lines, braces {opens}/{closes}")
    
    if opens != closes:
        print(f"    WARNING: Brace mismatch!")
        return None
    
    return (func_start, end + 1)


# Functions to extract
NAMES = ["escapeAttr", "highlightHtml", "highlightCss", "highlightKeyValue", "highlightGeneric"]

# Debug: first find in original git HEAD
print("=== Finding functions in git HEAD ===")
for name in NAMES:
    result = extract_function(orig, name)
    if result:
        start, end = result
        print(f"  FOUND at characters {start}-{end}")


print("\n=== Finding functions in current chat.js ===")
for name in NAMES:
    # Check if already in chat-ui.js
    pat_ui = re.compile(r'(?:async\s+)?function\s+' + re.escape(name) + r'\s*\(')
    if pat_ui.search(ui):
        print(f"  {name}: already in chat-ui.js, skipping")
        continue
    
    result = extract_function(chat, name)
    if not result:
        print(f"  {name}: NOT FOUND in chat.js")
        continue
    
    func_start, func_end = result
    func_text = chat[func_start:func_end]
    
    # Remove from chat.js
    chat = chat[:func_start] + chat[func_end:]
    
    # Ensure 'async' keyword
    if 'await ' in func_text and not func_text.startswith('async '):
        func_text = 'async ' + func_text
    
    # Append to chat-ui.js
    ui = ui.rstrip() + '\n\n' + func_text + '\n'
    print(f"  {name}: extracted ✓")


print("\n=== Summary ===")

# Clean up excessive blank lines
chat = re.sub(r'\n{3,}', '\n\n', chat)

# Write files
with open(CHAT_JS, "w", encoding="utf-8") as f:
    f.write(chat)
with open(UI_JS, "w", encoding="utf-8") as f:
    f.write(ui)

chat_lines = chat.count('\n') + 1
ui_lines = ui.count('\n') + 1
print(f"  chat.js: {chat_lines} lines")
print(f"  chat-ui.js: {ui_lines} lines")

# Verify syntax
for path, label in [(CHAT_JS, "chat.js"), (UI_JS, "chat-ui.js")]:
    r = subprocess.run(["node", "-c", path], capture_output=True, text=True)
    ok = r.returncode == 0
    print(f"  {label}: {'OK' if ok else 'FAIL'}")
    if not ok:
        print(f"    {r.stderr.split(chr(10))[-2]}")
