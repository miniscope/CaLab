#!/usr/bin/env python
"""Final-settle settle delta in qc_eval (`csdelta_final.sh`; PR #470): off against on, same seed, by cell id.

    python tools/cala-eval/csdelta_final_eq.py ROOT FRAMES SEEDS

qc_eval's Final settle is untimed and deterministic, so the same seed's cells keep their ids in both arms. Per
seed: cells in both and in one only, the relative L2 change of each shared cell's footprint (off against on; median,
p90, max) beside how far the settle itself moved the footprints (`settle_checks.tsv` rel_l2_med of the last
checkpoint), and the settle line's visits and refines of each arm.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from seed_jaccard import load  # noqa: E402


def fps(d: Path, w: int | None = None) -> dict[int, dict[int, float]]:
    _, _, cells = load(d / "footprints.bin")
    return {cid: dict(zip(idx.tolist(), a.astype(np.float64).tolist())) for cid, idx, a in cells}


def rel_l2(a: dict[int, float], b: dict[int, float]) -> float:
    keys = set(a) | set(b)
    da = np.array([a.get(k, 0.0) for k in keys])
    db = np.array([b.get(k, 0.0) for k in keys])
    return float(np.linalg.norm(da - db) / max(np.linalg.norm(da), 1e-12))


def settle_line(d: Path) -> str:
    m = re.search(r"settle: .*?(\d+ visits, \d+ refines)", (d.parent / f"{d.name}.log").read_text())
    return m.group(1) if m else "?"


def main() -> int:
    root, frames, seeds = Path(sys.argv[1]), sys.argv[2], sys.argv[3].split(",")
    print("| seed | cells off / on / shared | rel L2 off vs on: median, p90, max | settle moved (rel_l2_med) | off | on |")
    print("|---|---|---|---|---|---|")
    for s in seeds:
        off, on = root / f"{frames}_s{s}_off", root / f"{frames}_s{s}_on"
        a, b = fps(off), fps(on)
        shared = sorted(set(a) & set(b))
        r = np.array([rel_l2(a[i], b[i]) for i in shared]) if shared else np.array([np.nan])
        moved = (off / "settle_checks.tsv").read_text().strip().splitlines()[-1].split("\t")[4]
        print(
            f"| {s} | {len(a)} / {len(b)} / {len(shared)} | {np.median(r):.2e}, {np.quantile(r, 0.9):.2e},"
            f" {r.max():.2e} | {moved} | {settle_line(off)} | {settle_line(on)} |"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
