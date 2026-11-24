#!/usr/bin/env python
"""Strip helpers in qc_eval (`obsstrips.sh eq`): off against `--observe-strips K`, same seed, by cell id.

    python tools/cala-eval/obsstrips_eq.py ROOT/eq FRAMES SEEDS K

qc_eval's untimed runs are deterministic, so the same seed's cells keep their ids in both arms. Per seed: final cells
in each arm and shared, the last GT line's precision and recall of each arm, the relative L2 change of each shared
cell's footprint (median, p90, max) beside how far the Final settle itself moved the footprints (`settle_checks.tsv`
rel_l2_med of the last checkpoint), and the strip counters (`strips.txt`: batches with strips, deltas dropped).
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from csdelta_final_eq import fps, rel_l2  # noqa: E402


def gt(d: Path) -> tuple[float, float]:
    found = re.findall(r"GT \[([\d.]+), ([\d.]+),", (d.parent / f"{d.name}.log").read_text())
    return (float(found[-1][0]), float(found[-1][1])) if found else (np.nan, np.nan)


def strips(d: Path) -> str:
    f = d / "strips.txt"
    if not f.exists():
        return "?"
    t = f.read_text()
    b = re.search(r"(\d+) batches with strips, (\d+) the ordinary way", t)
    dc = re.search(r"dropped_cells: (\d+), dropped_clusters: (\d+)", t)
    return f"{b.group(1)} / {b.group(2)}, dropped {int(dc.group(1)) + int(dc.group(2))}" if b and dc else "?"


def main() -> int:
    root, frames, seeds, k = Path(sys.argv[1]), sys.argv[2], sys.argv[3].split(","), sys.argv[4]
    print(
        "| seed | cells off / strips / shared | GT precision, recall: off / strips | rel L2 off vs strips: median, p90,"
        " max | settle moved (rel_l2_med) | batches with strips / ordinary, deltas dropped |"
    )
    print("|---|---|---|---|---|---|")
    for s in seeds:
        off, on = root / f"{frames}_s{s}_off", root / f"{frames}_s{s}_k{k}"
        a, b = fps(off), fps(on)
        shared = sorted(set(a) & set(b))
        r = np.array([rel_l2(a[i], b[i]) for i in shared]) if shared else np.array([np.nan])
        moved = (off / "settle_checks.tsv").read_text().strip().splitlines()[-1].split("\t")[4]
        (pa, ra), (pb, rb) = gt(off), gt(on)
        print(
            f"| {s} | {len(a)} / {len(b)} / {len(shared)} | {pa:.4f}, {ra:.4f} / {pb:.4f}, {rb:.4f} |"
            f" {np.median(r):.2e}, {np.quantile(r, 0.9):.2e}, {r.max():.2e} | {moved} | {strips(on)} |"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
