#!/usr/bin/env python3
"""Restore row index 7 in notification_sounds admin query (the generic fix pattern
removed it because index 6/7 were both String). Run from project root."""
import sys

path = "server/src/db.rs"
with open(path, "rb") as f:
    data = f.read()
data = data.replace(b"\r\n", b"\n")
src = data.decode("utf-8")

old = (
    "                    row.get::<_, String>(0)?,\n"
    "                    row.get::<_, String>(1)?,\n"
    "                    row.get::<_, String>(2)?,\n"
    "                    row.get::<_, Vec<u8>>(3)?,\n"
    "                    row.get::<_, Vec<u8>>(4)?,\n"
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
new = (
    "                    row.get::<_, String>(0)?,\n"
    "                    row.get::<_, String>(1)?,\n"
    "                    row.get::<_, String>(2)?,\n"
    "                    row.get::<_, Vec<u8>>(3)?,\n"
    "                    row.get::<_, Vec<u8>>(4)?,\n"
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

n = src.count(old)
if n < 1:
    print(f"!! MISSED: notification_sounds rows (found={n})")
    sys.exit(1)
src = src.replace(old, new)
out = src.encode("utf-8").replace(b"\n", b"\r\n")
with open(path, "wb") as f:
    f.write(out)
print("OK  notification_sounds rows restored")
