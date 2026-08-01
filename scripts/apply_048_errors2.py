#!/usr/bin/env python3
"""Restore row index 7 in friend_requests + notification_sounds admin queries."""
import sys

def apply_file(path, style, replacements, label):
    with open(path, "rb") as f:
        data = f.read()
    if style == "CRLF":
        data = data.replace(b"\r\n", b"\n")
    src = data.decode("utf-8")
    misses = []
    for old, new, tag, count in replacements:
        n = src.count(old)
        if n < count:
            misses.append(f"{tag}: want>={count} found={n} :: {old[:80]!r}")
        else:
            src = src.replace(old, new)
    out = src.encode("utf-8")
    if style == "CRLF":
        out = out.replace(b"\n", b"\r\n")
    with open(path, "wb") as f:
        f.write(out)
    if misses:
        print(f"!! {label}: {len(misses)} MISSED")
        for m in misses:
            print(f"   - {m}")
        return False
    print(f"OK  {label}")
    return True

ok = True

# friend_requests: all-String 0..6 rows -> add index 7 (return type is 8-tuple)
fr_old = (
    "                    row.get::<_, String>(4)?,\n"
    "                    row.get::<_, String>(5)?,\n"
    "                    row.get::<_, String>(6)?,\n"
    "                ))\n"
    "            })\n"
    "            .map_err(|e| e.to_string())?\n"
    "            .filter_map(|r| r.ok())\n"
    "            .collect();\n"
    "        Ok(rows)\n"
    "    }\n"
    "\n"
    "    pub fn list_all_friendships_admin(\n"
)
fr_new = (
    "                    row.get::<_, String>(4)?,\n"
    "                    row.get::<_, String>(5)?,\n"
    "                    row.get::<_, String>(6)?,\n"
    "                    row.get::<_, String>(7)?,\n"
    "                ))\n"
    "            })\n"
    "            .map_err(|e| e.to_string())?\n"
    "            .filter_map(|r| r.ok())\n"
    "            .collect();\n"
    "        Ok(rows)\n"
    "    }\n"
    "\n"
    "    pub fn list_all_friendships_admin(\n"
)
ok &= apply_file("server/src/db.rs", "CRLF", [(fr_old, fr_new, "friend_requests rows", 1)],
                 "db.rs friend_requests")

# notification_sounds: String,String,String,Vec,Vec,Vec,String -> add index 7 (8-tuple)
ns_old = (
    "                    row.get::<_, String>(4)?,\n"
    "                    row.get::<_, Vec<u8>>(5)?,\n"
    "                    row.get::<_, String>(6)?,\n"
    "                ))\n"
    "            })\n"
    "            .map_err(|e| e.to_string())?\n"
    "            .filter_map(|r| r.ok())\n"
    "            .collect();\n"
    "        Ok(rows)\n"
    "    }\n"
    "\n"
    "    pub fn list_all_config_admin(\n"
)
ns_new = (
    "                    row.get::<_, String>(4)?,\n"
    "                    row.get::<_, Vec<u8>>(5)?,\n"
    "                    row.get::<_, String>(6)?,\n"
    "                    row.get::<_, String>(7)?,\n"
    "                ))\n"
    "            })\n"
    "            .map_err(|e| e.to_string())?\n"
    "            .filter_map(|r| r.ok())\n"
    "            .collect();\n"
    "        Ok(rows)\n"
    "    }\n"
    "\n"
    "    pub fn list_all_config_admin(\n"
)
ok &= apply_file("server/src/db.rs", "CRLF", [(ns_old, ns_new, "notification_sounds rows", 1)],
                 "db.rs notification_sounds")

print()
print("ALL DONE" if ok else "MISSED - fix before building")
sys.exit(0 if ok else 1)
