#!/usr/bin/env python
"""Slow-worker time per background-settle frame from Chrome runs of the settle delta (`csdelta_chrome.sh`).

    python tools/cala-eval/csdelta_summary.py OUT_DIR TAG [TAG ...]

From `<tag>-work.json` (the #459 work readout, one reading a second while Discover runs): the slow worker's time on
the background settle (duty `csettle`: making requests, and handling answers) and the settle frames the look-back
workers delivered, summed over Discover; their ratio is the slow worker's ms per re-read frame. Also the live
frames the slow loop missed (forward-pool drops) and the delta's own counters from the last status (`<tag>.json`).
"""

import json
import sys
from pathlib import Path


def summary(out: Path, tag: str) -> dict:
    work = json.loads((out / f"{tag}-work.json").read_text())
    cs_ms = frames = live_ms = span = 0.0
    for r in work:
        w = r.get("work")
        if not w or r.get("status") not in ("running", "paused"):
            continue
        s = w["spanMs"]
        span += s
        cs_ms += w["slow"].get("csettle", 0) * s
        live_ms += w["slow"].get("live", 0) * s
        frames += w["lookback"]["kinds"]["csettle"]["framesPerS"] * s / 1e3
    row = {
        "tag": tag,
        "discover_s": span / 1e3,
        "settle_frames": round(frames),
        "slow_csettle_s": cs_ms / 1e3,
        "ms_per_settle_frame": cs_ms / frames if frames else float("nan"),
        "slow_csettle_share": cs_ms / span if span else float("nan"),
        "slow_live_share": live_ms / span if span else float("nan"),
    }
    samples = json.loads((out / f"{tag}.json").read_text())
    last = next((x for x in reversed(samples.get("samples", samples) if isinstance(samples, dict) else samples)
                 if (x.get("st") or {}).get("lb", {}) and x["st"]["lb"].get("csettle")), None)
    if last:
        cs = last["st"]["lb"]["csettle"]
        row.update({"answers": cs["answers"], "answer_ms_mean": cs["answerMs"] / max(1, cs["answers"]),
                    "fit": cs["fit"], "heldOut": cs["heldOut"], "dropped": cs["dropped"]})
        if cs.get("delta"):
            d = cs["delta"]
            row.update({"delta_applied": d["applied"], "delta_rejected": d["rejected"],
                        "context_MB_per_req": d["contextBytes"] / 1e6 / max(1, d["applied"] + d["rejected"]),
                        "delta_MB_per_ans": d["deltaBytes"] / 1e6 / max(1, d["applied"] + d["rejected"]),
                        "context_ms_per_req": d["contextMs"] / max(1, d["applied"] + d["rejected"]),
                        "build_ms_per_ans": d["buildMs"] / max(1, d["applied"] + d["rejected"]),
                        "engine": d["engine"]})
        b = last["st"].get("batch")
        if b:
            row["drop"] = f'{b["drop"]}/{b["drop"] + b["fwd"]}'
    return row


if __name__ == "__main__":
    out = Path(sys.argv[1])
    for tag in sys.argv[2:]:
        print(json.dumps(summary(out, tag)))
