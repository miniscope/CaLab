"""Brightness and static structure over a session (bleaching), real or simulated.

    python session_curve.py AVI_DIR [--block 600] [--avg 100] [--json OUT.json]

Reads every numbered AVI in AVI_DIR in order (a real DAQ folder or a minisim
``daq/Miniscope`` folder) and, every ``--block`` frames, averages the next
``--avg`` frames into a mean image. Per block it reports the mean grey inside the
FOV (pixels of the session's first mean image above 25 % of its 99th percentile)
and the static structure: the registration-band power (3x3 median, DoG sigma 1.5 /
15 px, as in ``calibrate_to_real.py``) of the mean image over the central 256 px.
Short averages keep motion blur small; both curves are also given relative to the
first block.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import numpy as np

from calibrate_to_real import bandpass, read_grey_avi


def avi_files(d: Path) -> list[Path]:
    fs = [p for p in d.glob("*.avi") if re.fullmatch(r"\d+", p.stem)]
    return sorted(fs, key=lambda p: int(p.stem))


def curve(d: Path, block: int, avg: int) -> dict:
    files = avi_files(d)
    lens = []
    from minisim.avi import read_avi_header

    for f in files:
        lens.append(len(read_avi_header(f)["frames"]))
    starts = np.cumsum([0] + lens)
    out = dict(t_min=[], grey=[], static=[])
    mask = None
    for s in range(0, int(starts[-1]) - avg + 1, block):
        k = int(np.searchsorted(starts, s, side="right") - 1)
        off = s - int(starts[k])
        n = min(avg, lens[k] - off)
        m = read_grey_avi(files[k], n, off).astype(np.float64).mean(axis=0)
        if mask is None:
            mask = m > 0.25 * np.percentile(m, 99)
        h, w = m.shape
        c = bandpass(m)[h // 2 - 128 : h // 2 + 128, w // 2 - 128 : w // 2 + 128]
        out["t_min"].append(s / 20.0 / 60.0)
        out["grey"].append(float(m[mask].mean()))
        out["static"].append(float(np.mean(c**2)))
    for k in ("grey", "static"):
        out[k + "_rel"] = (np.asarray(out[k]) / out[k][0]).tolist()
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("avi_dir", type=Path)
    ap.add_argument("--block", type=int, default=600)
    ap.add_argument("--avg", type=int, default=100)
    ap.add_argument("--json", type=Path)
    a = ap.parse_args()
    c = curve(a.avi_dir, a.block, a.avg)
    for t, g, s, gr, sr in zip(c["t_min"], c["grey"], c["static"], c["grey_rel"], c["static_rel"]):
        print(f"{t:6.2f} min  grey {g:6.1f} ({gr:4.2f})  static {s:7.2f} ({sr:4.2f})")
    if a.json:
        a.json.write_text(json.dumps(c))


if __name__ == "__main__":
    main()
