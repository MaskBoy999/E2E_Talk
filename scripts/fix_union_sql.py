import sys

with open('server/src/db.rs', 'r', encoding='utf-8') as f:
    content = f.read()

# Find the specific SQL string in list_messages_around
# The issue is: ORDER BY before UNION ALL needs parenthesized subqueries in SQLite
# Change: FROM (SELECT ... ORDER BY ... LIMIT ?3 UNION ALL SELECT ... ORDER BY ... LIMIT ?3) m
# To:     FROM ((SELECT ... ORDER BY ... LIMIT ?3) UNION ALL (SELECT ... ORDER BY ... LIMIT ?3)) m

# Find the pattern around the UNION ALL
old_pattern = "ORDER BY timestamp DESC\n                     LIMIT ?3\n                     UNION ALL\n                     SELECT id, channel_id, sender_id, encrypted_content, nonce, timestamp,"
new_pattern = "ORDER BY timestamp DESC\n                     LIMIT ?3)\n                     UNION ALL\n                     (SELECT id, channel_id, sender_id, encrypted_content, nonce, timestamp,"

if old_pattern in content:
    content = content.replace(old_pattern, new_pattern, 1)
    print("Fixed first ORDER BY before UNION ALL")
else:
    print("ERROR: Could not find first pattern")
    # Debug: find the UNION ALL in list_messages_around
    idx = content.find("list_messages_around")
    if idx >= 0:
        section = content[idx:idx+5000]
        # Find UNION ALL
        ua_idx = section.find("UNION ALL")
        if ua_idx >= 0:
            print(f"Found UNION ALL at relative offset {ua_idx}")
            print(f"Context: ...{section[ua_idx-200:ua_idx+200]}...")
    sys.exit(1)

# Also add closing paren after the second LIMIT ?3 inside the inner subquery
# The before part added ")" after the first LIMIT ?3
# The second subquery ends with "LIMIT ?3" followed by whitespace and ")"
# We need "LIMIT ?3)" followed by whitespace and newline + ")"
old_pattern2 = "ORDER BY timestamp ASC\n                     LIMIT ?3\n                 ) m"
new_pattern2 = "ORDER BY timestamp ASC\n                     LIMIT ?3)\n                 ) m"

if old_pattern2 in content:
    content = content.replace(old_pattern2, new_pattern2, 1)
    print("Fixed second ORDER BY after UNION ALL")
else:
    print("ERROR: Could not find second pattern")
    sys.exit(1)

with open('server/src/db.rs', 'w', encoding='utf-8') as f:
    f.write(content)

print("Done!")
