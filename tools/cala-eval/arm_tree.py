#!/usr/bin/env python
"""Any number of arms of one qc_eval binary over a demix-suite tier, as a suite run tree (the concurrent-settle study).

    $MINISIM_PY tools/cala-eval/arm_tree.py --tier quick --bin $BIN --name cs-q --parallel 3 --branch-after discover \
        --arm "LIVE=--passes 1 --lookback 2" --arm "SETTLE=--passes 1 --lookback 2 --settle-frames 9600"

`demix_suite.py` takes two arms; this is the same queue, branching, run layout and metrics for N arms (no cache, no
report: read the tree with `settle_ladder.py` or `demix_suite.py --report-only`). Each `--arm LABEL=FLAGS` is added to
the suite's `QC_ARGS` (a flag given again replaces the suite's). With `--branch-after`, arms that share their flags up
to the branch point run as one qc_eval per sim. `--parallel` counts this queue's qc_eval jobs; a branched job shows two
processes while a branch runs, and the machine-wide cap of `run_arms.py` still applies. Finished runs are skipped.
"""

from __future__ import annotations

import argparse
import shlex
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import demix_suite as DS  # noqa: E402
import run_arms as RA  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tier", choices=sorted(DS.TIERS), default="quick")
    ap.add_argument("--only", help="comma list of sims within the tier")
    ap.add_argument("--bin", type=Path, required=True)
    ap.add_argument("--arm", action="append", required=True, help='LABEL=FLAGS (repeatable)')
    ap.add_argument("--name", required=True, help="run directory name under $CALA_DATA/demix-suite")
    ap.add_argument("--parallel", type=int, default=3)
    ap.add_argument("--branch-after", choices=["off", "discover", "drain"], default="off")
    a = ap.parse_args()
    out_root = DS.data_root() / "demix-suite" / a.name
    arms = []
    for spec in a.arm:
        label, _, flags = spec.partition("=")
        arms.append((label, a.bin.resolve(), shlex.split(flags)))
    jobs = DS.build_jobs(arms, DS.tier_sims(a.tier, a.only), out_root, None, None)
    todo = [j for j in jobs if not (j["out"] / "run.json").exists()]
    out_root.mkdir(parents=True, exist_ok=True)
    state = {"lock": threading.Lock(), "parallel": a.parallel, "own_only": True}
    t0 = time.time()
    groups, _ = RA.branch_groups(todo, a.branch_after)
    print(f"{len(jobs)} runs, {len(todo)} to do, {len(groups)} branched groups; root {out_root}", flush=True)
    errs: list[str] = []

    def run_group(g: list[dict]) -> None:
        for j, info in zip(g, RA.run_branched(g, state, a.branch_after)):
            if info["rc"] != 0:
                errs.append(f"{j['label']}/{j['out'].name}: branched qc_eval failed (see {j['out']}/stdout.log)")

    with ThreadPoolExecutor(a.parallel) as ex:
        list(ex.map(run_group, groups))
    with ThreadPoolExecutor(a.parallel) as ex:
        errs += [e for e in ex.map(lambda j: DS.run_job(j, state, sys.executable, False, False, None), jobs) if e]
    print(f"runs and metrics done in {(time.time() - t0) / 60:.1f} min", flush=True)
    if errs:
        print("\n".join(errs), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
