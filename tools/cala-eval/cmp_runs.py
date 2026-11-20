#!/usr/bin/env python
"""Are two qc_eval run directories the same apart from wall-time fields?

    python tools/cala-eval/cmp_runs.py RUN_A RUN_B

Every file of RUN_A is compared with RUN_B's. A file that differs is compared again with its wall-time fields masked
(TSV columns named for a time; in text files numbers followed by a time unit or %). `cost.txt` (QC cost in ms) and
`slow_cost.tsv` (ms per frame) hold wall times under other names: check a reported difference by eye.
"""
import sys, re, os, csv
TIME_COL = re.compile(r"(wall|_s$|_ms|^ms|secs|_ns$|ns$|time|_us$)")
def norm(path):
    b = open(path, 'rb').read()
    if path.endswith('.tsv'):
        rows = [l.split('\t') for l in b.decode().splitlines()]
        if not rows: return b
        keep = [i for i, h in enumerate(rows[0]) if not TIME_COL.search(h)]
        return ('\n'.join('\t'.join(r[i] for i in keep if i < len(r)) for r in rows), [h for h in rows[0] if TIME_COL.search(h)])
    if path.endswith('.txt') or path.endswith('.log'):
        t = b.decode(errors='replace')
        t = re.sub(r"[0-9]+(\.[0-9]+)?(e[-+]?[0-9]+)? ?(s wall|ms|us|s\b|%)|(p50|p99|max) [0-9.]+", "T", t)
        t = re.sub(r"\[[0-9., ]+\] s", "T", t)
        return (t, [])
    return (b, [])
a, b = sys.argv[1], sys.argv[2]
bad = []; masked = set()
files = sorted(f for f in os.listdir(a) if os.path.isfile(os.path.join(a, f)))
for f in files:
    pa, pb = os.path.join(a, f), os.path.join(b, f)
    if not os.path.exists(pb): bad.append(f + ' (missing)'); continue
    if open(pa,'rb').read() == open(pb,'rb').read(): continue
    na, nb = norm(pa), norm(pb)
    if na[0] != nb[0]: bad.append(f)
    else: masked.add(f + (' [' + ','.join(na[1]) + ']' if na[1] else ''))
print(f"{a} vs {b}: {len(files)} files; identical after masking wall-time fields in: {sorted(masked)}; DIFFER: {bad}")
