#!/usr/bin/env python
"""Tables of the work-slider calibration (results/2026-11-21-work-slider.md).

    python tools/cala-eval/work_slider_summary.py chrome <dir> [<dir> ...]   paced / full-speed headed Chrome runs
    python tools/cala-eval/work_slider_summary.py model <run> [<run> ...]    qc_eval virtual-clock runs
    python tools/cala-eval/work_slider_summary.py at <log> <frame>           Chrome counters at a frame (prefix fits)

Chrome: the outputs of `apps/cala/scripts/memory-measure.mjs --single --lookback [--csettle] [--pacefps N]`
(`<tag>-probe.json`, `<tag>.log`). Model: qc_eval run directories (`timed.txt`, and the `lookback:` line of
`<run>.log`). Standard library only.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


def chrome_row(probe: Path) -> dict:
    tag = probe.name[: -len("-probe.json")]
    d = json.loads(probe.read_text())
    p, ch = d["probe"], d.get("endSettleChange") or {}
    a = p["atFramesDone"]
    lb, slow = a.get("lb") or {}, a.get("slow") or {}
    cs = lb.get("csettle") or {}
    disc_s = (p["lastFrameAt"] - p["t0"]) / 1e3
    end_s = (p["final"] - p["framesDone"]) / 1e3 if p.get("final") else float("nan")
    live = a["fwd"] + a["drop"]
    rr = lb.get("requested", 0) + cs.get("requested", 0)
    return {
        "tag": tag,
        "frames": p["frames"],
        "discover_s": disc_s,
        "fps": p["frames"] / disc_s,
        "final_s": end_s,
        "missed_pct": 100.0 * a["drop"] / max(1, live),
        "need": lb.get("requested", 0),
        "need_per_obs": lb.get("requested", 0) / max(1, slow.get("observed", a["fwd"])),
        "bg_per_live": cs.get("requested", 0) / max(1, cs.get("live", 0)) if cs else float("nan"),
        "bg": cs.get("requested", 0),
        "reread_per_s": rr / disc_s,
        "ans_ms": cs.get("answerMs", 0) / max(1, cs.get("answers", 0)) if cs else float("nan"),
        "ans_max": cs.get("maxBlockMs", float("nan")) if cs else float("nan"),
        "jobs": slow.get("jobs", 0),
        "cells": a.get("cells", 0),
        "above2": 100.0 * ch.get("shareK", float("nan")),
        "above1": 100.0 * ch.get("above1", 0) / max(1, ch.get("cells", 1)),
        "median_change": 100.0 * ch.get("medianChange", float("nan")),
    }


def chrome(dirs: list[str]) -> None:
    cols = [
        ("tag", "{}"), ("fps", "{:.1f}"), ("discover_s", "{:.0f}"), ("final_s", "{:.0f}"),
        ("missed_pct", "{:.2f}"), ("need", "{}"), ("need_per_obs", "{:.2f}"), ("bg", "{}"),
        ("bg_per_live", "{:.2f}"), ("reread_per_s", "{:.0f}"), ("ans_ms", "{:.1f}"), ("ans_max", "{:.0f}"),
        ("jobs", "{}"), ("cells", "{}"), ("above2", "{:.0f}"), ("above1", "{:.0f}"), ("median_change", "{:.1f}"),
    ]
    print("| " + " | ".join(c for c, _ in cols) + " |")
    print("|" + " --- |" * len(cols))
    for d in dirs:
        for probe in sorted(Path(d).glob("*-probe.json")):
            r = chrome_row(probe)
            print("| " + " | ".join(f.format(r[c]) for c, f in cols) + " |")


def model_row(run: Path) -> dict:
    t = (run / "timed.txt").read_text()
    m = re.search(r"offered (\S+) fps over (\S+) s: forwarded (\d+) frames, dropped (\d+), observed (\d+); "
                  r"visits (\d+) \((\d+) jobs\); owner busy (\S+)% , visit workers busy (\S+)%", t)
    fps, wall, fwd, drop, obs, visits, jobs, owner, vw = m.groups()
    r = {
        "run": run.name, "fps": float(fps), "missed_pct": 100.0 * int(drop) / max(1, int(fwd) + int(drop)),
        "jobs": int(jobs), "owner_busy": float(owner), "visit_busy": float(vw),
    }
    m = re.search(r"(\d+) frames re-read in (\d+) requests \((\S+) per forwarded frame.*look-back worker busy "
                  r"(\S+)%; longest batch wait (\S+) ms", t)
    if m:
        r["bg_per_live"] = float(m.group(3))
        r["lb_busy"] = float(m.group(4))
        r["max_wait"] = float(m.group(5))
    m = re.search(r"look-back gate: (\d+) need-driven frames", t)
    if m:
        r["need"] = int(m.group(1))
    else:
        log = run.parent / (run.name + ".log")
        m = re.search(r"^lookback: (\d+) frames", log.read_text(), re.M) if log.exists() else None
        r["need"] = int(m.group(1)) if m else -1
    r["need_per_obs"] = r["need"] / max(1, int(obs))
    return r


def model(runs: list[str]) -> None:
    cols = ["run", "fps", "missed_pct", "jobs", "need", "need_per_obs", "bg_per_live", "owner_busy", "visit_busy",
            "lb_busy", "max_wait"]
    print("| " + " | ".join(cols) + " |")
    print("|" + " --- |" * len(cols))
    for run in runs:
        r = model_row(Path(run))
        print("| " + " | ".join(
            (f"{r[c]:.2f}" if isinstance(r.get(c), float) else str(r.get(c, "-"))) for c in cols) + " |")


SAMPLE = re.compile(r"^(\d+)s \w+ lb pushed (\d+) .*?drop (\d+)/(\d+) jobs (\d+) refines (\d+) (\d+) fps")


def at(log: str, frame: int) -> None:
    """The first 5 s sample at or after `frame`: time, frames, dropped/forwarded, jobs, look-back pushed."""
    for line in Path(log).read_text().splitlines():
        m = SAMPLE.match(line)
        if m and int(m.group(7)) >= frame:
            s, pushed, drop, live, jobs, refines, fr = m.groups()
            print(f"t {s}s frame {fr} missed {100 * int(drop) / max(1, int(live)):.1f}% jobs {jobs} "
                  f"lb pushed {pushed} refines {refines}")
            return
    print("no sample at or after that frame")


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "chrome":
        chrome(sys.argv[2:])
    elif cmd == "model":
        model(sys.argv[2:])
    elif cmd == "at":
        at(sys.argv[2], int(sys.argv[3]))
    else:
        sys.exit(__doc__)
