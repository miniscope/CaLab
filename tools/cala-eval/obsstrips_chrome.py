#!/usr/bin/env python
"""Strip helpers in headed Chrome (`obsstrips_chrome.sh`): Discover at Max and the Final settle per run.

    python tools/cala-eval/obsstrips_chrome.py <dir> TAG [TAG ...]

Per `memory-measure.mjs --lookback --headed` run (`<tag>.log`, `<tag>-probe.json`, `<tag>-work.json`):

- Discover: seconds, frames/s achieved, the share of the recording's frames the slow worker never
  observed (dropped for it), the slow worker's busy share (1 - idle) and its `live` duty share, the
  `live` ms per observed frame and its split (`SlowStatus.liveSplit`: observe calls, of which inside
  WASM, look-back bookkeeping, strip begin and apply, the rest), the mean strip helper's busy
  share, visits per observed frame.
- Final settle: seconds, frames/s, busy shares of the slow worker, look-back worker 0, the mean visit
  worker and the mean strip helper, visits per settle frame.
- Peak renderer footprint (MB), and the strip counters at the end (batches with helpers / the
  ordinary way, jobs summed locally, deltas dropped, MB per batch, ms waiting per batch).

Tags are grouped by their prefix before the last `-`: per group the median and range.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import numpy as np


def window(work: list, lo: float, hi: float) -> list:
    """The readings whose window lies inside [lo, hi] (ms, page clock)."""
    return [s for s in work if lo + s["work"]["spanMs"] <= s["t"] <= hi + 300]


def mean_share(rs: list, f) -> float:
    w = sum(s["work"]["spanMs"] for s in rs)
    return sum(s["work"]["spanMs"] * f(s["work"]) for s in rs) / w if w else np.nan


def one(d: Path, tag: str) -> dict:
    log = (d / f"{tag}.log").read_text()
    m = re.search(r"PROBE discover ([\d.]+)s .*end settle ([\d.]+)s", log)
    disc, settle = (float(m.group(1)), float(m.group(2))) if m else (np.nan, np.nan)
    st = re.search(r"DISCOVER_SETTLED \S+ (\{.*\})", log)
    lb = json.loads(st.group(1)) if st else {}
    fed = lb.get("settle", {}).get("fed", np.nan)
    feet = [float(x) for x in re.findall(r"foot ([\d.]+) gpu", log)]
    probe = json.loads((d / f"{tag}-probe.json").read_text())["probe"]
    work = json.loads((d / f"{tag}-work.json").read_text())
    t0, td, t1 = probe["t0"], probe.get("framesDone"), probe.get("final")
    out = {"discover_s": disc, "settle_s": settle, "fps": fed / settle if settle else np.nan,
           "peak_foot_mb": max(feet) if feet else np.nan}
    frames = probe.get("frames", np.nan)
    afd = (probe.get("atFramesDone") or {}).get("slow") or {}
    obs = afd.get("observed", np.nan)
    out["d_fps"] = frames / disc if disc else np.nan
    out["d_dropped"] = 1 - obs / frames if frames else np.nan
    dw = window(work, t0, td) if td else []
    out["d_busy"] = mean_share(dw, lambda w: 1 - w["slow"].get("idle", 0))
    out["d_live"] = mean_share(dw, lambda w: w["slow"].get("live", 0))
    out["d_strip"] = mean_share(dw, lambda w: np.mean([x["discovery"] for x in w["strip"]]) if w.get("strip") else 0)
    # Live ms per observed frame: the duty's share over Discover's wall time.
    live_ms = out["d_live"] * disc * 1000 if disc else np.nan
    out["live_ms"] = live_ms / obs if obs else np.nan
    sp = afd.get("liveSplit") or {}
    if sp and obs:
        out["obs_call_ms"] = sp["observeCall"] / sp["frames"]
        out["obs_inner_ms"] = sp["observeInner"] / sp["frames"]
        out["copy_ms"] = out["obs_call_ms"] - out["obs_inner_ms"]
        out["lb_ms"] = sp["lookback"] / obs
        out["strip_ms"] = (sp["stripBegin"] + sp["stripApply"]) / obs
        out["other_ms"] = out["live_ms"] - (sp["observeCall"] + sp["lookback"] + sp["stripBegin"] + sp["stripApply"]) / obs
        out["status_ack_ms"] = (sp["status"] + sp["ack"]) / obs
    out["d_visits_per_frame"] = afd.get("jobs", np.nan) / obs if obs else np.nan
    sw = window(work, td, t1) if td and t1 else []
    out["slow"] = mean_share(sw, lambda w: 1 - w["slow"].get("idle", 0))
    out["lb0"] = mean_share(sw, lambda w: (w["lookback"]["workers"] or [0])[0])
    out["visit"] = mean_share(sw, lambda w: float(np.mean(w["visit"])) if w["visit"] else 0)
    out["strip"] = mean_share(sw, lambda w: np.mean([x["finalSettle"] for x in w["strip"]]) if w.get("strip") else 0)
    last = next((s["slow"] for s in reversed(work) if s.get("slow")), None) or {}
    if afd.get("jobs") is not None and last.get("jobs") is not None and fed:
        out["s_visits_per_frame"] = (last["jobs"] - afd["jobs"]) / fed
    s = last.get("strips")
    if s:
        n = max(s["batches"], 1)
        loop = s.get("loop") or [np.nan] * 10
        out.update(batches=s["batches"], ordinary=s["ordinary"], local=s["local"],
                   dropped=loop[7] + loop[8], ctx_mb=s["contextBytes"] / n / 1e6,
                   delta_mb=s["deltaBytes"] / n / 1e6, wait_ms=s["waitMs"] / n,
                   begin_ms=s["beginMs"] / n, apply_ms=s["applyMs"] / n)
    return out


COLS = {
    "discover": ["discover_s", "d_fps", "d_dropped", "d_busy", "d_live", "d_strip", "d_visits_per_frame"],
    "live": ["live_ms", "obs_call_ms", "obs_inner_ms", "copy_ms", "lb_ms", "strip_ms", "other_ms", "status_ack_ms"],
    "settle": ["settle_s", "fps", "slow", "lb0", "visit", "strip", "s_visits_per_frame", "peak_foot_mb"],
    "strips": ["batches", "ordinary", "local", "dropped", "ctx_mb", "delta_mb", "wait_ms", "begin_ms", "apply_ms"],
}


def main() -> int:
    d = Path(sys.argv[1])
    rows = {t: one(d, t) for t in sys.argv[2:]}
    groups: dict[str, list[dict]] = {}
    for t, r in rows.items():
        groups.setdefault(t.rsplit("-", 1)[0], []).append(r)
    for name, cols in COLS.items():
        print(f"\n### {name}\n\n| group | " + " | ".join(cols) + " |")
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
