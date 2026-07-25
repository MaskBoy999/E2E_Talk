"""
Extract the 5 remaining UI functions from chat.js into chat-ui.js.
Uses content matching from the original git HEAD to find function boundaries.
"""
import subprocess, re, os

PROJECT = "X:/Documents/GitHub/E2E_Talk"
CHAT_JS = os.path.join(PROJECT, "static/chat.js")
UI_JS = os.path.join(PROJECT, "static/js/chat-ui.js")

# Read original from git HEAD
result = subprocess.run(
    ["git", "show", "HEAD:static/chat.js"],
    capture_output=True, cwd=PROJECT
)
orig = result.stdout.decode("utf-8", errors="replace")

def find_matching_brace(text, start_pos):
    """Find matching close brace with string/template/comment awareness."""
    depth = 0
    i = start_pos
    in_dq = in_sq = in_bt = False
    bt_depth = 0
    
    while i < len(text):
        ch = text[i]
        nc = text[i+1] if i+1 < len(text) else ""
        
        if ch == "\\" and (in_dq or in_sq or in_bt):
            i += 2
            continue
        
        # String toggles
        if not (in_bt and bt_depth > 0):
            if ch == '"' and not in_sq and not in_bt:
                in_dq = not in_dq
            elif ch == "'" and not in_dq and not in_bt:
                in_sq = not in_sq
            elif ch == "`" and not in_dq and not in_sq:
                if in_bt and bt_depth == 0:
                    in_bt = False
                else:
                    in_bt = True
                    bt_depth = 0
        
        # Template literal interpolation
        if in_bt and not in_dq and not in_sq:
            if ch == "$" and nc == "{":
                bt_depth += 1
                i += 2
                continue
            elif ch == "}" and bt_depth > 0:
                bt_depth -= 1
                i += 1
                continue
        
        # Comments
        if not in_dq and not in_sq and not in_bt:
            if ch == "/" and nc == "/":
                while i < len(text) and text[i] != "\n":
                    i += 1
            elif ch == "/" and nc == "*":
                i += 2
                while i < len(text):
                    if text[i] == "*" and i+1 < len(text) and text[i+1] == "/":
                        i += 1
                        break
                    i += 1
        
        # Brace counting
        if not in_dq and not in_sq:
            if not (in_bt and bt_depth == 0):
                if ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        return i
        i += 1
    return -1

def extract_from_original(name):
    """Find function in original git HEAD and return its text."""
    pat = re.compile(r"(?:async\s+)?function\s+" + re.escape(name) + r"\s*\(")
    m = pat.search(orig)
    if not m:
        return None
    
    start = m.start()
    brace = orig.find("{", start)
    if brace < 0:
        return None
    
    end = find_matching_brace(orig, brace)
    if end < 0:
        return None
    
    func_text = orig[start:end+1]
    opens = func_text.count("{")
    closes = func_text.count("}")
    
    if opens != closes:
        print(f"  {name}: brace MISMATCH {opens}/{closes}")
        return None
    
    return func_text

# Read current files
with open(CHAT_JS, "r", encoding="utf-8") as f:
    chat = f.read()
with open(UI_JS, "r", encoding="utf-8") as f:
    ui = f.read()

# Functions to extract
NAMES = ["escapeAttr", "highlightHtml", "highlightCss", 
         "highlightKeyValue", "highlightGeneric"]

extracted_count = 0
for name in NAMES:
    # Check if already in chat-ui.js
    if ("function " + name + "(") in ui:
        print(f"  {name}: already in chat-ui.js, skipping")
        continue
    
    # Get function from original
    func_text = extract_from_original(name)
    if not func_text:
        print(f"  {name}: could not extract from original")
        continue
    
    # Find in current chat.js using first-line matching
    first_line = func_text.split("\n")[0].strip()
    func_start = chat.find(first_line)
    if func_start < 0:
        # Try with just the function name
        pat = re.compile(r"(?:async\s+)?function\s+" + re.escape(name) + r"\s*\(")
        m = pat.search(chat)
        if not m:
            print(f"  {name}: not found in current chat.js")
            continue
        brace = chat.find("{", m.end())
        end = find_matching_brace(chat, brace)
        if end < 0:
            print(f"  {name}: could not find end in current chat.js")
            continue
        func_start = m.start()
        func_end = end
    else:
        # Find the end using brace matching from the start position
        brace = chat.find("{", func_start)
        if brace < 0:
            print(f"  {name}: no opening brace")
            continue
        end = find_matching_brace(chat, brace)
        if end < 0:
            print(f"  {name}: could not find end")
            continue
        func_end = end
    
    # Verify function text
    func_in_chat = chat[func_start:func_end+1]
    o = func_in_chat.count("{")
    c = func_in_chat.count("}")
    if o != c:
        print(f"  {name}: brace MISMATCH in chat.js {o}/{c}")
        continue
    
    # Remove from chat.js
    chat = chat[:func_start] + chat[func_end+1:]
    
    # Add to chat-ui.js
    # Check if function uses await (needs async)
    if "await " in func_in_chat and not func_in_chat.startswith("async "):
        func_in_chat = "async " + func_in_chat
    
    ui = ui.rstrip() + "\n\n" + func_in_chat + "\n"
    extracted_count += 1
    print(f"  {name}: extracted ({len(func_in_chat.split(chr(10)))} lines)")

# Clean up excessive blank lines in chat.js
chat = re.sub(r"\n{3,}", "\n\n", chat)

# Write files
with open(CHAT_JS, "w", encoding="utf-8") as f:
    f.write(chat)
with open(UI_JS, "w", encoding="utf-8") as f:
    f.write(ui)

print(f"\n=== Summary ===")
print(f"  Extracted: {extracted_count}/5 functions")
print(f"  chat.js: {chat.count(chr(10))+1} lines")
print(f"  chat-ui.js: {ui.count(chr(10))+1} lines")

# Verify syntax
import subprocess as sp
for path, label in [(CHAT_JS, "chat.js"), (UI_JS, "chat-ui.js")]:
    r = sp.run(["node", "-c", path], capture_output=True, text=True)
    ok = r.returncode == 0
    print(f"  {label}: {'OK' if ok else 'FAIL'}")
    if not ok:
        print(f"    {r.stderr.split(chr(10))[-2]}")
