"""Debug the brace-matching for connectWebSocket and other missed functions."""
import re

with open('static/chat.js', 'r', encoding='utf-8') as f:
    text = f.read()

lines = text.split('\n')
print(f"File: {len(lines)} lines")

# Find connectWebSocket
pattern = re.compile(r'function\s+connectWebSocket\s*\(')
m = pattern.search(text)
pos = m.start()
line_no = text[:pos].count('\n') + 1
print(f'\nconnectWebSocket at line {line_no}, char pos {pos}')

# Find the opening brace
brace_pos = text.find('{', pos)
print(f'Opening brace at char pos {brace_pos}, line {text[:brace_pos].count(chr(10)) + 1}')

# Simple brace matching with string/comment awareness
depth = 0
i = brace_pos
quotes_skipped = 0
comments_skipped = 0
regex_skipped = 0

while i < len(text):
    ch = text[i]
    nc = text[i+1] if i+1 < len(text) else ''
    
    if ch == '"' or ch == "'" or ch == '`':
        quote = ch
        i += 1
        while i < len(text):
            if text[i] == '\\':
                i += 2
                continue
            if text[i] == quote:
                break
            i += 1
        quotes_skipped += 1
    elif ch == '/' and nc == '/':
        while i < len(text) and text[i] != '\n':
            i += 1
        comments_skipped += 1
    elif ch == '/' and nc == '*':
        i += 2
        while i < len(text):
            if text[i] == '*' and i+1 < len(text) and text[i+1] == '/':
                i += 1
                break
            i += 1
        comments_skipped += 1
    elif ch == '/':
        # Could be regex - check if preceded by operator
        pass
    elif ch == '{':
        depth += 1
    elif ch == '}':
        depth -= 1
        if depth == 0:
            end_line = text[:i].count('\n') + 1
            print(f'Found matching }} at line {end_line}, char pos {i}')
            print(f'Function spans lines {line_no}-{end_line} ({end_line-line_no+1} lines)')
            # Show the first and last few chars of the function
            func_text = text[pos:i+1]
            first_line = func_text.split('\n')[0]
            last_line = func_text.split('\n')[-2] if '\n' in func_text else func_text
            print(f'First line: {first_line}')
            print(f'Last line:  {last_line}')
            break
    i += 1

if depth != 0:
    print(f'UNBALANCED! depth={depth} at char {i}, line {text[:i].count(chr(10))+1}')

print(f'\nStats: quotes_skipped={quotes_skipped}, comments_skipped={comments_skipped}')

# Now check if the issue with the v2 script was the find_function_end function
print('\n\n--- Checking find_function_end from v2 script ---')
# The issue was likely in find_matching_brace - the regex pattern '/'
# matching would incorrectly trigger on division operators in JS
# Let me check around the WS handler for regex patterns
# The WS handler has `protocol` variable assignments with `:` and `/`
# which shouldn't be an issue for brace matching
