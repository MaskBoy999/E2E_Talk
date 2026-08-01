#!/usr/bin/env python3
"""Find fully-dead columns in the live DB: columns where every value is
NULL or an empty string (never meaningfully populated)."""
import sqlite3
import sys

DB = sys.argv[1] if len(sys.argv) > 1 else "server/e2e_chat.db"

con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
cur = con.cursor()

tables = [r[0] for r in cur.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]

print(f"===== FULLY-EMPTY COLUMN SCAN: {DB} =====")
for t in tables:
    try:
        n = cur.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
    except Exception as e:
        print(f"{t}: ERROR {e}")
        continue
    cols = cur.execute(f'PRAGMA table_info("{t}")').fetchall()
    for c in cols:
        name, typ = c[1], (c[2] or "").upper()
        if "TEXT" not in typ and "BLOB" not in typ and "CHAR" not in typ and "CLOB" not in typ:
            continue
        try:
            # count non-null, and count non-null-and-nonempty
            r = cur.execute(
                f'SELECT COUNT(*), SUM(CASE WHEN "{name}" IS NULL THEN 0 ELSE 1 END), '
                f'SUM(CASE WHEN "{name}" IS NOT NULL AND "{name}" != \'\' THEN 1 ELSE 0 END) '
                f'FROM "{t}"'
            ).fetchone()
            total, non_null, non_empty = r[0], (r[1] or 0), (r[2] or 0)
        except Exception as e:
            print(f"{t}.{name}: QUERY-ERR {e}")
            continue
        # dead if table has rows but column has zero non-empty values
        if n > 0 and non_empty == 0:
            print(f"DEAD  {t}.{name} [{typ}] rows={n} non_null={non_null} non_empty={non_empty}")
con.close()
