#!/usr/bin/env python
"""Where the ordinary visits go: `qc_eval --visit-diag` runs side by side (concurrent settle, round 3).

    python tools/cala-eval/concsettle3_diag.py NAME=RUN_DIR [NAME=RUN_DIR ...] [--md OUT.md]

The first run is the baseline; every other column is also given relative to it. Reads `visit_diag.txt` (sums),
`visit_diag.tsv` (one row per visit job) and the pass line of `RUN_DIR.log`.
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path

import numpy as np


def read_run(d: Path):
    kv = {}
    for line in (d / "visit_diag.txt").read_text().splitlines():
        k, v = line.split("\t")
        kv[k] = float(v)
    rows = (d / "visit_diag.tsv").read_text().splitlines()
    head = rows[0].split("\t")
    kind = np.array([r.split("\t", 3)[2] for r in rows[1:]])
    num = np.array([[float(x) if i != 2 else 0.0 for i, x in enumerate(r.split("\t"))] for r in rows[1:]])
    tab = {h: num[:, i] for i, h in enumerate(head)}
    tab["kind"] = kind
    log = Path(str(d) + ".log")
    m = re.search(r"pass 1 done: (\d+) cells, adds (\d+) merges (\d+) deletes (\d+) splits (\d+)", log.read_text()) if log.exists() else None
    kv["cells"], kv["adds"], kv["merges"], kv["deletes"], kv["splits"] = (float(x) for x in m.groups()) if m else [np.nan] * 5
    return kv, tab


def rel(v, b):
    return f"{v:,.4g} ({100 * (v / b - 1):+.1f} %)" if b else f"{v:,.4g}"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("runs", nargs="+", help="NAME=RUN_DIR")
    ap.add_argument("--md", type=Path)
    a = ap.parse_args(argv)
    names, data = [], []
    for spec in a.runs:
        n, d = spec.split("=", 1)
        names.append(n)
        data.append(read_run(Path(d)))
    rows = []

    def add(label, fn, pct=False):
        vals = [fn(kv, t) for kv, t in data]
        if pct:
            rows.append((label, [f"{100 * v:.1f} %" for v in vals]))
        else:
            rows.append((label, [f"{vals[0]:,.4g}"] + [rel(v, vals[0]) for v in vals[1:]]))

    def v(t):
        return t["kind"] == "visit"

    wall = lambda kv: kv["wall_ms"]  # noqa: E731
    wk = lambda kv: kv["wall_ms"] * kv["workers"]  # noqa: E731
    add("cells at the end of the stream", lambda kv, t: kv["cells"])
    add("adds", lambda kv, t: kv["adds"])
    add("merges", lambda kv, t: kv["merges"])
    add("ordinary visits of the stream (visit jobs)", lambda kv, t: kv["jobs"])
    add("round 2's \"visits\" (these plus the visits of the end pass after the stream)", lambda kv, t: kv["visits"])
    add("tiles seen coming due", lambda kv, t: kv["due_seen"])
    add("came due: live-frame slots", lambda kv, t: kv["due_by_slots"])
    add("came due: look-back slots", lambda kv, t: kv["due_by_lookback"])
    add("came due: edit by a visit of another tile", lambda kv, t: kv["due_by_touch"])
    add("came due: own visit", lambda kv, t: kv["due_by_own_visit"])
    add("wait of a due tile for its hand-out, mean ms", lambda kv, t: kv["wait_ms_mean_job"])
    add("wait, median ms", lambda kv, t: np.median(t["wait_ms"][v(t)]))
    add("wait, p90 ms", lambda kv, t: np.percentile(t["wait_ms"][v(t)], 90))
    add("slots at hand-out, mean (due at 6)", lambda kv, t: kv["slots_at_handout_mean"])
    add("time of a visit job on its worker, mean ms", lambda kv, t: t["dur_ms"][v(t)].mean())
    add("work per visit job, M units", lambda kv, t: t["work"][v(t)].mean() / 1e6)
    for st in ("load", "refine", "merge", "add", "keep", "split"):
        add(f"work per visit job: {st}, M units", lambda kv, t, st=st: t[f"work_{st}"][v(t)].mean() / 1e6)
    add("cells in a job's zone, mean", lambda kv, t: t["zone_cells"][v(t)].mean())
    add("refinements accepted per visit job", lambda kv, t: t["refines"][v(t)].mean())
    add("total work of the visit jobs, 1e12 units", lambda kv, t: t["work"][v(t)].sum() / 1e12)
    add("visit workers: busy", lambda kv, t: kv["worker_busy_ms"] / wk(kv), True)
    add("visit workers: idle, nothing due", lambda kv, t: kv["worker_idle_nothing_due_ms"] / wk(kv), True)
    add("visit workers: idle, a tile due but its zone held", lambda kv, t: kv["worker_idle_zone_held_ms"] / wk(kv), True)
    for k, lab in (("batch", "a live batch"), ("result", "a visit result"), ("lookback", "need-driven look-back frames"), ("settle", "a settle answer"), ("load", "the test load")):  # fmt: skip
        add(f"visit workers: idle, result waiting while the slow worker is on {lab}", lambda kv, t, k=k: kv[f"worker_idle_owner_on_{k}_ms"] / wk(kv), True)  # fmt: skip
    for k, lab in (("batch", "live batches"), ("result", "visit results and hand-outs"), ("lookback", "need-driven look-back frames"), ("settle", "settle answers"), ("load", "the test load")):  # fmt: skip
        add(f"slow worker: time on {lab}", lambda kv, t, k=k: kv[f"owner_{k}_ms"] / wall(kv), True)
    add("a visit result waits for the slow worker, mean ms", lambda kv, t: kv["queue_result_ms_mean"])
    add("a visit result waits, longest ms", lambda kv, t: kv["queue_result_ms_max"])
    add("a live batch waits, mean ms", lambda kv, t: kv["queue_batch_ms_mean"])
    L = ["| measure | " + " | ".join(names) + " |", "| --- |" + " --- |" * len(names)]
    for label, vals in rows:
        L.append(f"| {label} | " + " | ".join(vals) + " |")
    # By quarter of the stream.
    L += ["", "Visit jobs and work per job by quarter of the stream:", "",
          "| quarter | " + " | ".join(f"{n}: jobs; work per job, M; zone cells; wait, ms" for n in names) + " |", "| --- |" + " --- |" * len(names)]  # fmt: skip
    for q in range(4):
        cells = []
        for kv, t in data:
            m = v(t) & (t["t_ms"] >= q * kv["wall_ms"] / 4) & (t["t_ms"] < (q + 1) * kv["wall_ms"] / 4 + (1e9 if q == 3 else 0))
            cells.append(f"{m.sum():,}; {t['work'][m].mean() / 1e6:.1f}; {t['zone_cells'][m].mean():.1f}; {t['wait_ms'][m].mean():.0f}")
        L.append(f"| {q + 1} | " + " | ".join(cells) + " |")
    md = "\n".join(L)
    print(md)
    if a.md:
        a.md.write_text(md + "\n")


if __name__ == "__main__":
    main()
