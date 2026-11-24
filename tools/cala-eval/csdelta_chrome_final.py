#!/usr/bin/env python
"""Final settle in headed Chrome, settle delta off against on (`csdelta_chrome_final.sh`; PR #470).

    python tools/cala-eval/csdelta_chrome_final.py <dir> TAG [TAG ...]

Per `memory-measure.mjs --lookback --headed` run (`<tag>.log`, `<tag>-probe.json`, `<tag>-work.json`): Discover and
Final-settle seconds, settle frames/s, the busy share of the slow worker (1 - idle), look-back worker 0 and the
mean visit worker over the Final settle (the work readouts whose window ends inside it, weighted by their span), the
peak renderer footprint (MB), and with the delta the requests applied / observed the ordinary way, MB per request
(context, delta), worker 0's ms summing per request, and the store deltas dropped as stale (share of stores). Tags
are grouped by their prefix before the last `-`; per group the median and range.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import numpy as np


def one(d: Path, tag: str) -> dict:
    log = (d / f"{tag}.log").read_text()
    m = re.search(r"PROBE discover ([\d.]+)s .*end settle ([\d.]+)s", log)
    disc, settle = (float(m.group(1)), float(m.group(2))) if m else (np.nan, np.nan)
    st = re.search(r"DISCOVER_SETTLED \S+ (\{.*\})", log)
    lb = json.loads(st.group(1)) if st else {}
    fed = lb.get("settle", {}).get("fed", np.nan)
    feet = [float(x) for x in re.findall(r"foot ([\d.]+) gpu", log)]
    out = {"discover_s": disc, "settle_s": settle, "fps": fed / settle if settle else np.nan,
           "peak_foot_mb": max(feet) if feet else np.nan}
    probe = json.loads((d / f"{tag}-probe.json").read_text())["probe"]
    t0, t1 = probe.get("framesDone"), probe.get("final")
    work = json.loads((d / f"{tag}-work.json").read_text())
    acc = {"slow": 0.0, "lb0": 0.0, "visit": 0.0, "w": 0.0}
    for s in work:
        w = s["work"]
        if t0 is None or t1 is None or not (t0 + 0.5 * w["spanMs"] <= s["t"] <= t1 + 300):
            continue
        span = w["spanMs"]
        acc["slow"] += span * (1 - w["slow"].get("idle", 0))
        acc["lb0"] += span * (w["lookback"]["workers"] or [0])[0]
        acc["visit"] += span * (float(np.mean(w["visit"])) if w["visit"] else 0)
        acc["w"] += span
    for k in ("slow", "lb0", "visit"):
        out[k] = acc[k] / acc["w"] if acc["w"] else np.nan
    # Discover: the slow worker's share by duty (readouts whose window ends inside it), fps, visits per
    # frame the slow loop observed, and the frames dropped for it.
    duties: dict[str, float] = {}
    span_d = 0.0
    for s in work:
        w = s["work"]
        if t0 is None or not (probe["t0"] + w["spanMs"] <= s["t"] <= t0):
            continue
        span_d += w["spanMs"]
        for k, v in w["slow"].items():
            duties[k] = duties.get(k, 0.0) + w["spanMs"] * v
    for k in ("live", "visit", "housekeep", "need", "csettle", "publish", "idle"):
        out[f"d_{k}"] = duties.get(k, np.nan) / span_d if span_d else np.nan
    afd = probe.get("atFramesDone") or {}
    sl = afd.get("slow") or {}
    out["d_fps"] = probe["frames"] / ((t0 - probe["t0"]) / 1000) if t0 else np.nan
    out["d_visits_per_frame"] = sl.get("jobs", np.nan) / max(sl.get("observed", 0), 1)
    out["d_dropped"] = afd.get("drop", np.nan)
    dl = lb.get("settle", {}).get("delta")
    if dl:
        n = max(dl["applied"] + dl["rejected"], 1)
        e = dl["engine"]
        stores = e[8] + e[9] + e[10] if len(e) > 10 else 0
        out.update(applied=dl["applied"], mismatched=dl["rejected"], ctx_mb=dl["contextBytes"] / n / 1e6,
                   delta_mb=dl["deltaBytes"] / n / 1e6, build_ms=dl["buildMs"] / n,
                   stale=(e[10] / stores) if stores else np.nan)
    return out


def main() -> int:
    d = Path(sys.argv[1])
    rows = {t: one(d, t) for t in sys.argv[2:] if not t.startswith("--")}
    cols = ["discover_s", "settle_s", "fps", "slow", "lb0", "visit", "peak_foot_mb", "applied", "mismatched",
            "ctx_mb", "delta_mb", "build_ms", "stale"]
    if "--discover" in sys.argv:
        cols = ["d_fps", "d_visits_per_frame", "d_dropped", "d_live", "d_visit", "d_housekeep", "d_need",
                "d_csettle", "d_publish", "d_idle"]
    print("| run | " + " | ".join(cols) + " |")
    print("|---" * (len(cols) + 1) + "|")
    for t, r in rows.items():
        print(f"| {t} | " + " | ".join(f"{r[c]:.3g}" if c in r else "-" for c in cols) + " |")
    groups: dict[str, list[dict]] = {}
    for t, r in rows.items():
        groups.setdefault(t.rsplit("-", 1)[0], []).append(r)
    print("\n| group | " + " | ".join(cols) + " |")
    print("|---" * (len(cols) + 1) + "|")
    for g, rs in groups.items():
        cells = []
        for c in cols:
            v = [r[c] for r in rs if c in r and not np.isnan(r[c])]
            cells.append(f"{np.median(v):.3g} ({min(v):.3g}-{max(v):.3g})" if v else "-")
        print(f"| {g} | " + " | ".join(cells) + " |")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
