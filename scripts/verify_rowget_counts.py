#!/usr/bin/env python3
"""Verify each query_map closure's row.get count matches its SELECT column count.

Uses brace-matching for the closure and paren-aware comma counting for the
column list, so COALESCE(...) / subqueries don't inflate the count. A real
mismatch would silently return wrong/empty rows (filter_map swallows errors).

Run from project root: python scripts/verify_rowget_counts.py
"""
import re
import sys

src = open("server/src/db.rs", encoding="utf-8").read()

def extract_select(src, m):
    sel_start = m.start(1)
    q = src.find('"', sel_start)
    q_end = src.find('"', q + 1)
    return src[sel_start:q_end]

def count_top_level_commas(s):
    """Count commas not nested inside parentheses."""
    depth = 0
    count = 0
    for ch in s:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
        elif ch == "," and depth == 0:
            count += 1
    return count

def count_select_cols(sel):
    # cut at the first top-level FROM (handles subqueries by taking the outer list)
    depth = 0
    cut = -1
    upper = sel.upper()
    i = 0
    while i < len(upper) - 5:
        ch = sel[i]
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
        elif depth == 0 and upper.startswith(" FROM ", i):
            cut = i
            break
        i += 1
    if cut == -1:
        return None
    cols_part = sel[:cut]
    return count_top_level_commas(cols_part) + 1

def extract_closure(src, start):
    m = re.search(r"\|row\|\s*\{", src[start:start + 2000])
    if not m:
        return None
    i = start + m.end()
    depth = 1
    j = i
    n = len(src)
    while j < n and depth > 0:
        c = src[j]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        j += 1
    if depth != 0:
        return None
    return src[i - 1:j]

prep_re = re.compile(r"\.prepare\s*\(\s*\"(SELECT)", re.S)
issues = []
checked = 0
for m in prep_re.finditer(src):
    sel = extract_select(src, m)
    ncols = count_select_cols(sel)
    if ncols is None:
        continue
    tail_start = m.end()
    tail = src[tail_start:tail_start + 6000]
    qm = tail.find(".query_map(")
    if qm == -1:
        continue
    closure = extract_closure(src, tail_start + qm)
    if closure is None:
        continue
    nrowget = len(re.findall(r"row\.get", closure))
    checked += 1
    if nrowget != ncols:
        fn_region = src[max(0, m.start() - 3000):m.start()]
        fn = re.findall(r"pub fn (\w+)", fn_region)
        fname = fn[-1] if fn else "?"
        issues.append(f"[{fname}] cols={ncols} rowget={nrowget} :: {sel.strip()[:70]}")

for i in issues:
    print("MISMATCH", i)
print("checked:", checked)
if issues:
    sys.exit(1)
print("ALL MATCH")
