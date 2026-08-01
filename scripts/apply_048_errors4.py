#!/usr/bin/env python3
"""Restore row index 7 in notification_sounds admin query, anchored on the unique
ns.encrypted_sound SELECT so it can't hit the identical dm_keys block."""
import sys

path = "server/src/db.rs"
with open(path, "rb") as f:
    data = f.read()
data = data.replace(b"\r\n", b"\n")
src = data.decode("utf-8")

old = (
    "                \"SELECT ns.user_id, COALESCE(u.username, '?'), ns.file_name, ns.encrypted_sound, ns.nonce, ns.sender_public_key, ns.created_at, COALESCE(ns.updated_at, '')\n"
    "                 FROM notification_sounds ns LEFT JOIN users u ON ns.user_id = u.id ORDER BY ns.created_at\",\n"
    "            )\n"
    "            .map_err(|e| e.to_string())?;\n"
    "        let rows = stmt\n"
    "            .query_map([], |row| {\n"
    "                Ok((\n"
    "                    row.get::<_, String>(0)?,\n"
    "                    row.get::<_, String>(1)?,\n"
    "                    row.get::<_, String>(2)?,\n"
    "                    row.get::<_, Vec<u8>>(3)?,\n"
    "                    row.get::<_, Vec<u8>>(4)?,\n"
    "                    row.get::<_, Vec<u8>>(5)?,\n"
    "                    row.get::<_, String>(6)?,\n"
    "                ))\n"
)
new = (
    "                \"SELECT ns.user_id, COALESCE(u.username, '?'), ns.file_name, ns.encrypted_sound, ns.nonce, ns.sender_public_key, ns.created_at, COALESCE(ns.updated_at, '')\n"
    "                 FROM notification_sounds ns LEFT JOIN users u ON ns.user_id = u.id ORDER BY ns.created_at\",\n"
    "            )\n"
    "            .map_err(|e| e.to_string())?;\n"
    "        let rows = stmt\n"
    "            .query_map([], |row| {\n"
    "                Ok((\n"
    "                    row.get::<_, String>(0)?,\n"
    "                    row.get::<_, String>(1)?,\n"
    "                    row.get::<_, String>(2)?,\n"
    "                    row.get::<_, Vec<u8>>(3)?,\n"
    "                    row.get::<_, Vec<u8>>(4)?,\n"
    "                    row.get::<_, Vec<u8>>(5)?,\n"
    "                    row.get::<_, String>(6)?,\n"
    "                    row.get::<_, String>(7)?,\n"
    "                ))\n"
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
