#!/usr/bin/env python3
"""Plaintext-leak audit for e2e_chat.db (live server DB).

For every table: row count, column list, and for each TEXT/BLOB column a
sample-based classification (NULL / EMPTY / UUID / TIMESTAMP / SHA256 /
BASE64-likely / PLAINTEXT-likely / BLOB-bytes). Prints samples so a human
can verify the heuristic.
"""
import sqlite3
import re
import sys

DB = sys.argv[1] if len(sys.argv) > 1 else "server/e2e_chat.db"
SAMPLE_LIMIT = 3

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z)?$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
INT_RE = re.compile(r"^\d+$")
HEX_RE = re.compile(r"^[0-9a-f]+$", re.I)
B64_RE = re.compile(r"^[A-Za-z0-9+/]+={0,2}$")


def classify(v):
    if v is None:
        return "NULL"
    if isinstance(v, bytes):
        return f"BLOB({len(v)}B)"
    s = str(v)
    if s == "":
        return "EMPTY"
    if UUID_RE.match(s):
        return "UUID"
    if TS_RE.match(s):
        return "TIMESTAMP"
    if DATE_RE.match(s):
        return "DATE"
    if INT_RE.match(s):
        return "INT"
    if len(s) == 64 and HEX_RE.match(s):
        return "SHA256?"
    if len(s) == 32 and HEX_RE.match(s):
        return "HASH32?"
    if B64_RE.match(s) and len(s) >= 12:
        return "BASE64?"
    if ":" in s and all(c in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=:" for c in s) and len(s) > 16:
        return "B64:COMPOSITE?"
    if len(s) > 8 and HEX_RE.match(s):
        return "HEX?"
    if re.search(r"[a-zA-Z]{3,}", s):
        return "PLAINTEXT?"
    return "OTHER"


def main():
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    cur = con.cursor()
    tables = [r[0] for r in cur.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]

    print(f"===== PLAINTEXT AUDIT: {DB} =====")
    for t in tables:
        try:
            n = cur.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
        except Exception as e:
            print(f"\n== {t}: ERROR {e}")
            continue
        cols = cur.execute(f'PRAGMA table_info("{t}")').fetchall()
        print(f"\n== {t} ({n} rows)")
        print(f"   columns: {[c[1] for c in cols]}")
        for c in cols:
            name, typ = c[1], (c[2] or "").upper()
            if "TEXT" not in typ and "BLOB" not in typ and "CHAR" not in typ and "CLOB" not in typ:
                continue
            try:
                rows = cur.execute(
                    f'SELECT "{name}" FROM "{t}" WHERE "{name}" IS NOT NULL LIMIT {SAMPLE_LIMIT * 3}'
                ).fetchall()
            except Exception as e:
                print(f"   - {name} [{typ}]: QUERY-ERR {e}")
                continue
            vals = [r[0] for r in rows if r[0] is not None]
            non_null = len(vals)
            if non_null == 0:
                print(f"   - {name} [{typ}]: 0 non-null")
                continue
            tags = [classify(v) for v in vals]
            tag = tags[0] if tags else "?"
            shown = []
            for s in vals[:SAMPLE_LIMIT]:
                if isinstance(s, bytes):
                    shown.append(f"<{len(s)}B>")
                else:
                    t2 = str(s)
                    shown.append(t2[:45] + ("…" if len(t2) > 45 else ""))
            print(f"   - {name} [{typ}]: {non_null}+ non-null | tag={tag} | samples={shown}")
    con.close()


if __name__ == "__main__":
    main()
