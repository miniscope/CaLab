"""Split the suite's "final cells matching 2+ GT units" into resolved close pairs and blends,
and count duplicates of matched units.

Per run (`<root>/<arm>/<sim>`): a cell with footprint r >= 0.5 to two or more GT units is
`resolved` when it is matched (Hungarian, r >= 0.7) and every other unit it reaches at
r >= 0.5 is matched by another cell (a real close pair whose accurate footprints overlap
their neighbour's), else `blend`. `dup` = unmatched cells whose best GT unit (r >= 0.5) is
matched by another cell. Usage: multi_gt_split.py ROOT ARM [ARM ...]  (prints a table)
"""
import sys
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import demix_metrics as DM

CD = Path.home() / "Projects/cala-data"


def simdir(s):
    return (CD / "demix-bench/measure/pairsim_v2191" / s) if s.startswith("pairs") else (CD / "sims-gt110" / s)


root = Path(sys.argv[1])
print("| arm | sim | multi-GT | resolved | blend | dup of matched |")
print("|---|---|---:|---:|---:|---:|")
tot = {}
for arm in sys.argv[2:]:
    for run in sorted((root / arm).iterdir()):
        if not (run / "final.tsv").exists():
            continue
        h, w, units, _ = DM.read_oracle(simdir(run.name) / "oracle.bin")
        _, _, ids, cells, _ = DM.read_library(run / "footprints.bin")
        nonempty = [k for k, u in enumerate(units) if u["det"] and u["full"][2].max() > 0]
        G = np.stack([DM.dense_patch(units[k]["full"], h, w).ravel() for k in nonempty])
        R = DM.pearson_matrix(cells, G, h, w)
        dy, dx = DM.estimate_offset(cells, units, DM.match(R, nonempty, DM.LOOSE_R), w)
        if np.hypot(dy, dx) >= DM.MIN_OFFSET_PX:
            from scipy.ndimage import shift as nd_shift
            for r in range(G.shape[0]):
                G[r] = nd_shift(G[r].reshape(h, w), (dy, dx), order=1).ravel()
            R = DM.pearson_matrix(cells, G, h, w)
        m = DM.match(R, nonempty, DM.MATCH_R)  # cell -> unit id
        col = {u: j for j, u in enumerate(nonempty)}
        owner = {u: i for i, u in m.items()}
        multi = res = blend = dup = 0
        for i in range(R.shape[0]):
            reach = [nonempty[j] for j in np.flatnonzero(R[i] >= DM.LOOSE_R)]
            if len(reach) >= 2:
                multi += 1
                if i in m and all(u in owner and owner[u] != i for u in reach if u != m[i]):
                    res += 1
                else:
                    blend += 1
            if i not in m and R[i].max() >= DM.LOOSE_R:
                u = nonempty[int(np.argmax(R[i]))]
                if u in owner:
                    dup += 1
        print(f"| {arm} | {run.name} | {multi} | {res} | {blend} | {dup} |", flush=True)
        t = tot.setdefault(arm, np.zeros(4))
        t += [multi, res, blend, dup]
for arm, t in tot.items():
    print(f"| {arm} | total | {int(t[0])} | {int(t[1])} | {int(t[2])} | {int(t[3])} |")
