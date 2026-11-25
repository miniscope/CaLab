"""Stage-0 item 4: quality with all frames vs a share of the batches dropped (`--slow-keep`).

usage: $MINISIM_PY skip_summary.py RUNS_DIR SIMS_V3_DIR

Runs are `RUNS_DIR/<arm>_<sim>_s<seed>` (`run.sh sim`, with `demix_metrics.py`
applied). Prints per run and per (sim, arm) mean: cells, matched (r >= 0.7),
false cells, recall (matched / detectable ground-truth cells), visits.
"""
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import demix_metrics as DM  # noqa: E402


def main():
    runs, sims = Path(sys.argv[1]), Path(sys.argv[2])
    ndet = {}
    res = defaultdict(list)
    print("| run | cells | matched | false | recall | visits | slow frames observed |")
    print("|---|---:|---:|---:|---:|---:|---:|")
    for d in sorted(p for p in runs.iterdir() if p.is_dir() and (p / "demix_det.json").exists()):
        m = re.match(r"(.+?)_(v3_\w+?_s\d)_s(\d+)$", d.name)
        if not m:
            continue
        arm, sim, seed = m.groups()
        if sim not in ndet:
            _h, _w, units, _c = DM.read_oracle(sims / sim / "oracle.bin")
            ndet[sim] = sum(1 for u in units if u["det"])
        det = json.loads((d / "demix_det.json").read_text())
        log = Path(str(d) + ".log").read_text()
        vis = re.search(r"visit rate: .*?: (\d+) visits over (\d+) frames", log)
        fwd = re.search(r"slow loop: (\d+) of (\d+) batches forwarded \((\d+) frames\)", log)
        rec = det["matched"] / ndet[sim]
        v = int(vis.group(1)) if vis else -1
        fr = int(fwd.group(3)) if fwd else -1
        res[(sim, arm)].append((det["cells"], det["matched"], det["false"], rec, v))
        print(f"| {d.name} | {det['cells']} | {det['matched']} | {det['false']} | {rec:.4f} | {v} | {fr} |")
    print("\n| sim | arm | n | cells | matched | false | recall | visits |")
    print("|---|---|---:|---:|---:|---:|---:|---:|")
    for (sim, arm), rs in sorted(res.items()):
        n = len(rs)
        mean = [sum(r[k] for r in rs) / n for k in range(5)]
        print(f"| {sim} | {arm} | {n} | {mean[0]:.1f} | {mean[1]:.1f} | {mean[2]:.1f} | {mean[3]:.4f} | {mean[4]:.0f} |")


if __name__ == "__main__":
    main()
