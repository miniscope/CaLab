"""Native stage tables from a qc_eval log built with `--features timing`.

usage: python3 stage_tables.py RUN.log

qc_eval prints `stage TAG: frames F cells N | <StageTiming::to_vec>` at
every progress line (cumulative) and at the start and end of the Final
settle. Prints per chunk the observe stages (ms per observe call) and the
visit phases (ms per visit, and edits), and the Final settle on its own.

Logs that also carry `build TAG: | <BuildTiming::to_vec>` lines (after
each `stage` line) get the library-build split, Discover and Final settle
separately.
"""
import re
import sys

OBS = ["render", "whiten", "scale", "ncorr", "ledger", "fpstats", "clusters", "reservoir", "probes"]
VIS = ["keep", "load", "solve", "split", "refine", "merge", "add"]
EDITS = ["adds", "merges", "refines", "splits", "deletes", "absorbs", "proposals"]
NO, NV = len(OBS), len(VIS)
BUILD = ["prep", "filter", "finish", "setup", "cell", "pair", "ring_scan", "ring_q", "rest", "cells"]
BCOUNT = ["builds", "cells", "filtered", "passes", "pairs_computed", "pairs_copied", "ring_computed",
          "ring_copied", "block_of_calls", "cal_calls"]


def parse(line):
    m = re.match(r"stage (.*?): frames (\d+) cells (\d+) \| (.*)", line)
    if not m:
        return None
    v = [float(x) for x in m.group(4).split()]
    return {"tag": m.group(1), "frames": int(m.group(2)), "cells": int(m.group(3)),
            "obs_calls": v[0], "obs": v[1:1 + NO], "vis_calls": v[1 + NO],
            "vis": v[2 + NO:2 + NO + NV],
            "edits": [v[2 + NO + NV + 7 * k: 2 + NO + NV + 7 * (k + 1)] for k in range(NV)]}


def diff(a, b):
    d = {"obs_calls": b["obs_calls"] - a["obs_calls"], "vis_calls": b["vis_calls"] - a["vis_calls"]}
    d["obs"] = [y - x for x, y in zip(a["obs"], b["obs"])]
    d["vis"] = [y - x for x, y in zip(a["vis"], b["vis"])]
    d["edits"] = [[y - x for x, y in zip(ra, rb)] for ra, rb in zip(a["edits"], b["edits"])]
    return d


def parse_build(line):
    m = re.match(r"build (.*?): \| (.*)", line)
    if not m:
        return None
    v = [float(x) for x in m.group(2).split()]
    nb, nc = len(BUILD), len(BCOUNT)
    return {"tag": m.group(1), "ms": v[:nb], "counts": v[nb:nb + nc], "cal_ms": v[nb + nc]}


def build_table(title, a, b):
    """The library builds between two cumulative `build` lines."""
    ms = [y - x for x, y in zip(a["ms"], b["ms"])]
    c = dict(zip(BCOUNT, [y - x for x, y in zip(a["counts"], b["counts"])]))
    cal = b["cal_ms"] - a["cal_ms"]
    n = max(c["builds"], 1)
    tot = sum(ms)
    print(f"\n### Library builds, {title}: {c['builds']:.0f} builds, {tot / n:.1f} ms per build")
    print("| part | ms per build | share |")
    print("|---|---:|---:|")
    for name, x in zip(BUILD, ms):
        print(f"| {name} | {x / n:.2f} | {100 * x / max(tot, 1e-9):.1f}% |")
    print(f"| **total** | {tot / n:.2f} | 100% |")
    print("per build: " + ", ".join(f"{k} {c[k] / n:.0f}" for k in BCOUNT[1:9]))
    pc = c["pairs_computed"]
    if pc:
        print(f"pair + cell + ring per computed pair: pair part {1000 * ms[5] / pc:.2f} us/computed pair")
    if c["cal_calls"]:
        ns = 1e6 * cal / c["cal_calls"]
        est = ns * c["block_of_calls"] / 1e6
        print(f"block_of: {ns:.2f} ns per call (calibration), {c['block_of_calls'] / n:.0f} calls per build"
              f" = about {est / n:.1f} ms per build ({100 * est / max(tot, 1e-9):.0f}% of the build; estimate)")


def main():
    rows = [r for r in (parse(l) for l in open(sys.argv[1])) if r]
    builds = [r for r in (parse_build(l) for l in open(sys.argv[1])) if r]
    disc = [r for r in rows if r["tag"].startswith("t") and not r["tag"].startswith("settle")]
    start = next((r for r in rows if r["tag"].startswith("settle-start")), None)
    end = next((r for r in rows if r["tag"].startswith("settle-end")), None)
    # Discover chunks: up to the settle start (a progress line after it includes the settle).
    chunks = [r for r in disc if start is None or r["obs_calls"] <= start["obs_calls"]]
    zero = {"obs_calls": 0, "vis_calls": 0, "obs": [0] * NO, "vis": [0] * NV, "edits": [[0] * 7] * NV}
    print("### Native observe, ms per observe call, by Discover chunk")
    print("| frames | cells | " + " | ".join(OBS) + " | total | fpstats+clusters share |")
    print("|---" * (NO + 4) + "|")
    prev, pf = zero, 0
    for r in chunks + ([start] if start else []):
        d = diff(prev, r)
        n = max(d["obs_calls"], 1)
        tot = sum(d["obs"])
        print(f"| {pf}–{r['frames']} | {r['cells']} | " + " | ".join(f"{x / n:.3f}" for x in d["obs"])
              + f" | {tot / n:.3f} | {100 * (d['obs'][5] + d['obs'][6]) / max(tot, 1e-9):.0f}% |")
        prev, pf = r, r["frames"]
    def visits(title, d):
        n = max(d["vis_calls"], 1)
        print(f"\n### {title}: {d['vis_calls']:.0f} visits, {sum(d['vis']) / 1000:.1f} s")
        print("| phase | ms/visit | share of visit time | " + " | ".join(EDITS) + " |")
        print("|---" * (3 + len(EDITS)) + "|")
        tot = sum(d["vis"])
        for k, name in enumerate(VIS):
            print(f"| {name} | {d['vis'][k] / n:.3f} | {100 * d['vis'][k] / max(tot, 1e-9):.1f}% | "
                  + " | ".join(f"{x:.0f}" for x in d["edits"][k]) + " |")
    if start:
        visits("Discover visits (native step)", diff(zero, start))
        half = [r for r in chunks if r["frames"] <= start["frames"] / 2]
        if half:
            visits("Discover visits, first half", diff(zero, half[-1]))
            visits("Discover visits, second half", diff(half[-1], start))
    if start and end:
        d = diff(start, end)
        n = max(d["obs_calls"], 1)
        wall = re.search(r"wall_s ([\d.]+)", end["tag"])
        print(f"\n### Final settle: {d['obs_calls']:.0f} observe calls"
              + (f", wall {float(wall.group(1)):.1f} s" if wall else ""))
        print("observe ms/call: " + ", ".join(f"{nm} {x / n:.3f}" for nm, x in zip(OBS, d["obs"]))
              + f"; total {sum(d['obs']) / n:.3f}")
        if wall:
            w = float(wall.group(1)) * 1000
            print(f"per settle frame: wall {w / n:.2f} ms = observe {sum(d['obs']) / n:.2f} + visits"
                  f" {sum(d['vis']) / n:.2f} + other (look-back re-read/preprocess/solve, checkpoints) {(w - sum(d['obs']) - sum(d['vis'])) / n:.2f}")
        visits("Final settle visits", d)
    bstart = next((r for r in builds if r["tag"].startswith("settle-start")), None)
    bend = next((r for r in builds if r["tag"].startswith("settle-end")), None)
    if bstart:
        bzero = {"ms": [0] * len(BUILD), "counts": [0] * len(BCOUNT), "cal_ms": 0}
        build_table("Discover", bzero, bstart)
        if bend:
            build_table("Final settle", bstart, bend)


if __name__ == "__main__":
    main()
