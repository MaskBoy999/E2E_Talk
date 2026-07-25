"""
Debug: find why highlightGeneric's close brace can't be found.
We use a simple character-by-character approach, track quotes only.
"""
import re

with open('static/chat.js', 'r', encoding='utf-8') as f:
    text = f.read()

# Find highlightGeneric
m = re.search(r'function\s+highlightGeneric\s*\(', text)
pos = m.start()
line_no = text[:pos].count('\n') + 1
print(f'highlightGeneric at line {line_no}, pos {pos}')

# Find the function's opening brace
brace = text.find('{', pos)
print(f'Opening brace at pos {brace}')

# Simple character walk, track only quotes
depth = 0
in_dq = in_sq = in_bt = False
i = brace
while i < len(text):
    ch = text[i]
    nc = text[i+1] if i+1 < len(text) else ''
    
    if ch == '\\' and (in_dq or in_sq or in_bt):
        i += 2
        continue
    
    if ch == '"' and not in_sq and not in_bt:
        in_dq = not in_dq
    elif ch == "'" and not in_dq and not in_bt:
        in_sq = not in_sq
    elif ch == '`' and not in_dq and not in_sq:
        in_bt = not in_bt
    
    if not in_dq and not in_sq and not in_bt:
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                end_line = text[:i].count('\n') + 1
                print(f'Match: }} at line {end_line}, pos {i}')
                print(f'Function: {end_line - line_no + 1} lines')
                break
    i += 1
else:
    print(f'FAILED: No matching brace (depth={depth} at end of file)')

# Now check with template literal interpolation tracking
print('\n\nWith template literal interpolation tracking:')
depth = 0
in_dq = in_sq = in_bt = False
bt_interp = 0
i = brace
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
            if in_bt and bt_interp == 0:
                in_bt = False
            else:
                in_bt = True
                bt_interp = 0
    
    if in_bt and not in_dq and not in_sq:
        if ch == '$' and nc == '{':
            bt_interp += 1
            i += 2
            continue
        elif ch == '}' and bt_interp > 0:
            bt_interp -= 1
            i += 1
            continue
    
    if not in_dq and not in_sq:
        if not in_bt or bt_interp > 0:
            if ch == '{':
                depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0:
                    end_line = text[:i].count('\n') + 1
                    print(f'Match: }} at line {end_line}, pos {i}')
                    print(f'Function: {end_line - line_no + 1} lines')
                    break
    i += 1
else:
    print(f'FAILED: No matching brace (depth={depth})')
    # Show last 100 chars before end
    print(f'Last 200 chars: {repr(text[-200:])}')

# Now show the actual content at lines 9584-9800 to see what's there
print('\n\nContent around highlightGeneric:')
content_lines = text.split('\n')
for ln in range(line_no - 2, line_no + 5):
    if 0 < ln <= len(content_lines):
        print(f'  {ln}: {content_lines[ln-1][:120]}')
