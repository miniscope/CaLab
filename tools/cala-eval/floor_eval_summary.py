"""PR H, floor and default eval (results/2026-11-22-floor-eval-plan.md).

  floor_eval_summary.py targets DIR      Max runs -> DIR/targets.txt (rule R1 of the plan)
  floor_eval_summary.py fp DIR TAG       DIR/TAG-final.json -> DIR/score/TAG/footprints.bin (CALAFP01)
  floor_eval_summary.py runs DIR         per-run table: time, cells, floor estimates, service readings
  floor_eval_summary.py quality DIR      quality proxies from the fixed-library scoring (DIR/score/TAG)
  floor_eval_summary.py all DIR          runs + quality + the plan's readings -> DIR/summary.md

Run tags are <rec>-<arm>-<rep>: rec sa | sb | ws; arm max | see | f14 | f10 | f07.
"""

from __future__ import annotations

import json
import re
import statistics as st
import struct
import sys
from pathlib import Path

import numpy as np

RECS = ["sa", "sb", "ws"]
ARMS = ["max", "see", "f14", "f10", "f07"]  # fastest to slowest
ARM_NAME = {"max": "Max", "see": "seeAllFps", "f14": "1.4x floor", "f10": "floor", "f07": "0.7x floor"}
LADDER = [10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100, 120, 150, 200, 250, 300]
FLOOR_RE = re.compile(
    r"floor (\S+) fps \(raw ([\d.]+)\) · set by (\S+) · (measured paced|measured at Max)( · ABOVE MAX)? · "
    r"sees every frame below (\d+)"
)
TERMS_RE = re.compile(r"terms: look-back need (\S+) settle (\S+) · slow worker (\S+) · visits (\S+)")
TIME_RE = re.compile(r"^(\d+)s (running|paused|done)")


def tags(d: Path) -> list[str]:
    out = []
    for p in sorted(d.glob("*-final.json")):
        t = p.name[: -len("-final.json")]
        if t.split("-")[0] in RECS and t.split("-")[1] in ARMS:
            out.append(t)
    return out


# ---------------------------------------------------------------- log parsing


def floor_readings(log: Path) -> list[dict]:
    """Every floor line of the ?debug readout while Discover runs: (sample seconds, published, raw, limiting,
    confidence, seeAll, terms). Stops at DISCOVER_FRAMES_DONE (the floor freezes after it)."""
    rows, t, cur = [], None, None
    for line in log.read_text(errors="replace").splitlines():
        if line.startswith("DISCOVER_FRAMES_DONE") or line.startswith("PROBE discover"):
            break
        m = TIME_RE.match(line)
        if m:
            t = int(m.group(1))
        m = FLOOR_RE.search(line)
        if m:
            cur = dict(
                t=t,
                published=None if m.group(1) == "-" else float(m.group(1)),
                raw=float(m.group(2)),
                limiting=m.group(3),
                confidence="paced" if m.group(4) == "measured paced" else "unpaced",
                above_max=bool(m.group(5)),
                see_all=float(m.group(6)),
            )
            rows.append(cur)
            continue
        m = TERMS_RE.search(line)
        if m and cur is not None and "terms" not in cur:
            f = lambda s: None if s == "-" else float(s)  # noqa: E731
            cur["terms"] = dict(need=f(m.group(1)), settle=f(m.group(2)), slow=f(m.group(3)), visits=f(m.group(4)))
    return rows


def last_floor(log: Path) -> dict | None:
    r = floor_readings(log)
    return r[-1] if r else None


def snap(fps: float) -> float:
    lo = [s for s in LADDER if s <= fps]
    return lo[-1] if lo else LADDER[0]


# ---------------------------------------------------------------- targets (rule R1)


def cmd_targets(d: Path) -> None:
    lines = []
    for rec in RECS:
        maxes = [t for t in tags(d) if t.startswith(f"{rec}-max-")]
        fl = [last_floor(d / f"{t}.log") for t in maxes]
        fl = [x for x in fl if x is not None and x["published"] is not None]
        if not fl:
            print(f"{rec}: no Max run with a published floor")
            continue
        F = st.median([x["published"] for x in fl])
        S = st.median([x["see_all"] for x in fl])
        lines += [
            f"{rec} f10 {F:g}",
            f"{rec} f14 {round(1.4 * F)}",
            f"{rec} f07 {round(0.7 * F)}",
            f"{rec} see {int(S)}",
        ]
        print(rec, "Max runs", maxes, "published", [x["published"] for x in fl], "raw", [x["raw"] for x in fl],
              "seeAll", [x["see_all"] for x in fl])
    (d / "targets.txt").write_text("\n".join(lines) + "\n")
    print((d / "targets.txt").read_text())


# ---------------------------------------------------------------- library conversion


def cmd_fp(d: Path, tag: str, dy: int = 0, dx: int = 0) -> Path:
    """Chrome final library (unfiltered values, `JsTraceLibrary.footprintValues`) -> CALAFP01.
    qc_eval `--library` reads the unfiltered column only and rebuilds the filter itself; the filtered column is
    written as a copy and ignored. `dy`, `dx`: shift every footprint (the alignment check), into
    score/TAG_shift{dy}{dx}; pixels shifted off the frame are dropped."""
    lib = json.loads((d / f"{tag}-final.json").read_text())
    h, w = lib["height"], lib["width"]
    ids, starts, pix, val = lib["ids"], lib["starts"], lib["pixels"], lib["values"]
    out = d / "score" / (tag if (dy, dx) == (0, 0) else f"{tag}_shift{dy}{dx}")
    out.mkdir(parents=True, exist_ok=True)
    b = bytearray(b"CALAFP01")
    b += struct.pack("<3I", h, w, len(ids))
    for i, cid in enumerate(ids):
        a, z = starts[i], starts[i + 1]
        p = np.asarray(pix[a:z], dtype=np.int64)
        v = np.asarray(val[a:z], dtype="<f4")
        if (dy, dx) != (0, 0):
            y, x = p // w + dy, p % w + dx
            ok = (y >= 0) & (y < h) & (x >= 0) & (x < w)
            p, v = y[ok] * w + x[ok], v[ok]
        p = p.astype("<u4")
        b += struct.pack("<2I", int(cid), len(p))
        b += p.tobytes() + v.tobytes() + v.tobytes()
    f = out / "footprints.bin"
    f.write_bytes(bytes(b))
    return f


def read_lib(d: Path, tag: str):
    """Chrome final library as (ids, list of (pixels, values)), unfiltered."""
    lib = json.loads((d / f"{tag}-final.json").read_text())
    s = lib["starts"]
    pix = np.asarray(lib["pixels"], dtype=np.int64)
    val = np.asarray(lib["values"], dtype=np.float64)
    cells = [(pix[s[i] : s[i + 1]], val[s[i] : s[i + 1]]) for i in range(len(lib["ids"]))]
    return lib["ids"], cells, lib["width"]


def main(argv: list[str]) -> None:
    cmd, d = argv[1], Path(argv[2]).expanduser()
    if cmd == "targets":
        cmd_targets(d)
    elif cmd == "fp":
        print(cmd_fp(d, argv[3], *(int(a) for a in argv[4:6])))
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
