#!/usr/bin/env python
"""One command that judges a cala change: baseline vs candidate over a tier of sims, with error bars.

    # quick tier (5 sims, 10 runs): the same binary, two flag sets
    $MINISIM_PY tools/cala-eval/demix_suite.py --tier quick --bin $QC_EVAL_BIN \
        --base-flags "--refine-z 3" --new-flags "--refine-z 0" --md tools/cala-eval/results/<date>-<task>.md
    # full tier (14 sims: static 5-9, motion 5-9, pairs 5-8, ~1.7 h): two binaries
    $MINISIM_PY tools/cala-eval/demix_suite.py --tier full --base-bin <main-build> --new-bin <branch-build> \
        --md ...

Needs numpy and scipy (run it with the minisim venv python, `$MINISIM_PY` after sourcing
`~/Projects/cala-data/sims.env`). For every arm and sim it runs
`qc_eval sim SIM RUN --passes 2 --later-passes refine --batch 8 --budget 30000000 --slow-seed 1 --dump --no-heldout --no-signed`
(plus `--motion` on the motion sims; Discover + one Refine pass, Extract traces of the final library),
then `demix_metrics.py` on the run, then `demix_report.py` on the two arms. Finished runs and metrics are
skipped when the same `--name` is given again (resume); a changed binary needs a new `--name`.

Scheduling: at most `--parallel` of THIS suite's `qc_eval sim` runs at once (default and cap
`run_arms.MAX_LIGHT` = 4), and the machine-wide count of light runs (other agents' included) never exceeds
`MAX_LIGHT`; no run starts below 5 GB free. Each run is ~0.7-1.8 GB; the metrics step peaks near 2.5 GB.
Jobs go longest-first (motion, static, pairs). Outputs go under `$CALA_DATA/demix-suite/<name>/` (never /tmp).

Cache: qc_eval is deterministic, so every finished run is cached under `$CALA_DATA/suite-cache` keyed by
binary hash + full qc_eval args + sim hash (`suite_cache.py`); a rerun of the same arm (baselines!) is a copy,
not a 7 min run. `--no-cache` bypasses it, `--cache-dir` moves it.

Tiers: `smoke` (static_s5 + pairs_s5) is a crash/sanity check only, NOT a significance test; `quick` (5 sims)
detects only large effects (~97% power for an effect like -0.047 pooled, ~37% with 3 sims); `full` (14 sims).
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import shlex
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import demix_report as REP  # noqa: E402
import run_arms as RA  # noqa: E402
import suite_cache as SC  # noqa: E402

MAX_PARALLEL = RA.MAX_LIGHT  # one machine-wide cap constant, defined in run_arms.py
QC_ARGS = ["--passes", "2", "--later-passes", "refine", "--batch", "8", "--budget", "30000000", "--slow-seed", "1", "--dump", "--no-heldout", "--no-signed"]
MIN_PER_RUN = 7.0  # wall minutes of one run alone on this Mac (static, 9600 frames, 2 passes)

TIERS = {
    # dense static sims plus the designed isolated-pairs sims, where close pairs are plentiful
    # crash/sanity check only: two sims, far too few for a significance test
    "smoke": [("static", [5]), ("pairs", [5])],
    "quick": [("static", [5, 6, 7]), ("pairs", [5, 6])],
    "full": [("static", [5, 6, 7, 8, 9]), ("motion", [5, 6, 7, 8, 9]), ("pairs", [5, 6, 7, 8])],
}


def data_root() -> Path:
    return Path(os.environ.get("CALA_DATA", Path.home() / "Projects" / "cala-data"))


def sim_dir(kind: str, seed: int, sims: Path | None, pairs: Path | None) -> Path:
    if kind == "pairs":
        root = pairs or Path(os.environ.get("CALA_PAIRS", data_root() / "demix-bench" / "measure" / "pairsim_v2191"))
    else:
        root = sims or Path(os.environ.get("CALA_SIMS", data_root() / "sims-gt110"))
    return root / f"{kind}_s{seed}"


def tier_sims(tier: str, only: str | None):
    out = [(k, s) for k, seeds in TIERS[tier] for s in seeds]
    if only:
        want = set(only.split(","))
        out = [(k, s) for k, s in out if f"{k}_s{s}" in want]
    return out


def build_jobs(arms, sims, out_root: Path, sim_root, pairs_root, force=False):
    """arms: [(label, bin, extra args)]; sims: [(kind, seed)] -> job dicts for run_arms.run_one."""
    jobs = []
    for kind, seed in sims:
        sim = sim_dir(kind, seed, sim_root, pairs_root)
        if not (sim / "oracle.bin").exists():
            sys.exit(f"missing sim {sim} (no oracle.bin); see ~/Projects/cala-data/README.md")
        for label, binary, extra in arms:
            out = out_root / label / f"{kind}_s{seed}"
            args = RA.merge_args(QC_ARGS, extra)
            if kind == "motion" and "--motion" not in args:
                args.append("--motion")
            jobs.append({"label": label, "bin": binary, "sim": sim.resolve(), "out": out, "args": args, "kind": kind})
    return order_jobs(jobs)


KIND_ORDER = {"motion": 0, "static": 1, "pairs": 2}  # longest runs first so the tail is short


def order_jobs(jobs):
    """Longest-first (motion, static, pairs); stable, so arms of one sim stay adjacent."""
    return sorted(jobs, key=lambda j: KIND_ORDER.get(j["kind"], 1))


def run_job(job, state, python, force=False, recompute=False, cache: SC.SuiteCache | None = None):
    out: Path = job["out"]
    done = out / "run.json"
    key = SC.run_key(job["bin"], job["args"], job["sim"]) if cache else None
    if not force and done.exists() and json.loads(done.read_text())["rc"] == 0:
        pass  # run finished before
    elif cache and not force and cache.has_run(key):
        out.mkdir(parents=True, exist_ok=True)
        cache.restore_run(key, out)
        print(f"[cache hit] {job['label']}/{out.name} ({key[:10]})", flush=True)
    else:
        info = RA.run_one(job, state)
        if info["rc"] != 0:
            return f"{job['label']}/{out.name}: qc_eval failed rc={info['rc']} (see {out}/stdout.log, time.txt)"
        if cache:
            cache.store_run(key, out)
    all_det = job["kind"] == "pairs"
    mkey = SC.metrics_key(all_det) if cache else None
    if cache and not recompute and not (out / "demix_det.json").exists() and cache.has_metrics(key, mkey):
        cache.restore_metrics(key, mkey, out)
        print(f"[cache hit] {job['label']}/{out.name} metrics", flush=True)
        return None
    cmd = [python, str(HERE / "demix_metrics.py"), str(job["sim"]), str(out)]
    if job["kind"] == "pairs":
        cmd.append("--all-det")
    if recompute:
        cmd.append("--force")
    r = subprocess.run(cmd, capture_output=True, text=True)
    print(f"[metrics] {job['label']}/{out.name}: {(r.stdout or r.stderr).strip().splitlines()[-1:]}", flush=True)
    if cache and r.returncode == 0:
        cache.store_metrics(key, mkey, out)
    return None if r.returncode == 0 else f"{job['label']}/{out.name}: demix_metrics failed:\n{r.stderr[-800:]}"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tier", choices=sorted(TIERS), default="quick")
    ap.add_argument("--only", help="comma list of sims (e.g. static_s5,pairs_s6) within the tier, for a smoke test")
    ap.add_argument("--bin", type=Path, default=os.environ.get("QC_EVAL_BIN"), help="qc_eval for both arms (default $QC_EVAL_BIN)")
    ap.add_argument("--base-bin", type=Path)
    ap.add_argument("--new-bin", type=Path)
    ap.add_argument("--base-flags", default="", help='extra qc_eval flags for the baseline, e.g. "--refine-z 3"')
    ap.add_argument("--new-flags", default="", help="extra qc_eval flags for the candidate")
    ap.add_argument("--base-label", default="base")
    ap.add_argument("--new-label", default="new")
    ap.add_argument("--name", help="run directory name under $CALA_DATA/demix-suite (reuse to resume)")
    ap.add_argument("--out", type=Path, help="run root (default $CALA_DATA/demix-suite/<name>)")
    ap.add_argument("--sims-dir", type=Path, help="static/motion sims (default $CALA_SIMS)")
    ap.add_argument("--pairs-dir", type=Path, help="pairs sims (default $CALA_PAIRS)")
    ap.add_argument("--parallel", type=int, default=MAX_PARALLEL, help="this suite's concurrent qc_eval runs (default and cap: the machine-wide light-run cap, run_arms.MAX_LIGHT)")
    ap.add_argument("--no-cache", action="store_true", help="neither read nor write the run cache")
    ap.add_argument("--cache-dir", type=Path, help="run cache root (default $CALA_SUITE_CACHE or $CALA_DATA/suite-cache)")
    ap.add_argument("--md", type=Path, help="write the report here")
    ap.add_argument("--report-only", action="store_true", help="skip the runs, report what is in --out")
    ap.add_argument("--force", action="store_true", help="rerun qc_eval even where a run.json exists")
    ap.add_argument("--recompute", action="store_true", help="redo the metrics of finished runs (not with --report-only)")
    a = ap.parse_args(argv)
    if a.parallel > MAX_PARALLEL:
        sys.exit(f"--parallel is capped at {MAX_PARALLEL} (machine-wide light-run cap)")
    base_bin, new_bin = a.base_bin or a.bin, a.new_bin or a.bin
    if not a.report_only and (not base_bin or not new_bin):
        sys.exit("give --bin (both arms) or --base-bin and --new-bin")
    if a.base_label == a.new_label:
        sys.exit("--base-label and --new-label must differ")
    name = a.name or f"{a.tier}-{a.base_label}-vs-{a.new_label}-{datetime.date.today():%Y%m%d}"
    out_root = a.out or data_root() / "demix-suite" / name
    sims = tier_sims(a.tier, a.only)
    arms = [
        (a.base_label, Path(base_bin).resolve() if base_bin else None, shlex.split(a.base_flags)),
        (a.new_label, Path(new_bin).resolve() if new_bin else None, shlex.split(a.new_flags)),
    ]
    meta = {
        "tier": a.tier, "sims": [f"{k}_s{s}" for k, s in sims], "run root": str(out_root),
        "qc_eval args": " ".join(QC_ARGS),
        f"{a.base_label}": f"`{base_bin}` flags `{a.base_flags}`", f"{a.new_label}": f"`{new_bin}` flags `{a.new_flags}`",
    }  # fmt: skip
    if not a.report_only:
        jobs = build_jobs(arms, sims, out_root, a.sims_dir, a.pairs_dir)
        cache = None if a.no_cache else SC.SuiteCache(a.cache_dir)
        todo = [
            j for j in jobs
            if a.force or not (j["out"] / "run.json").exists()
        ]  # fmt: skip
        n_hit = sum(1 for j in todo if cache and not a.force and cache.has_run(SC.run_key(j["bin"], j["args"], j["sim"])))
        n_run = len(todo) - n_hit
        print(f"{len(jobs)} runs ({n_hit} cached, {n_run} to run), {a.parallel} at a time, ~{n_run * MIN_PER_RUN / a.parallel:.0f} min; "
              f"root {out_root}; cache {'off' if cache is None else cache.root}", flush=True)
        out_root.mkdir(parents=True, exist_ok=True)
        (out_root / "suite.json").write_text(json.dumps({k: str(v) for k, v in meta.items()}, indent=1))
        state = {"lock": threading.Lock(), "parallel": a.parallel, "own_only": True}
        t0 = time.time()
        with ThreadPoolExecutor(a.parallel) as ex:
            errs = [e for e in ex.map(lambda j: run_job(j, state, sys.executable, a.force, a.recompute, cache), jobs) if e]
        print(f"runs and metrics done in {(time.time() - t0) / 60:.1f} min", flush=True)
        if errs:
            print("\n".join(errs), file=sys.stderr)
            return 1
        meta["wall minutes"] = f"{(time.time() - t0) / 60:.0f}"
    arm_b, arm_n = REP.load_arm(out_root / a.base_label), REP.load_arm(out_root / a.new_label)
    names, rows = REP.compare(arm_b, arm_n)
    if not names:
        sys.exit(f"no finished runs with metrics under {out_root}")
    md = REP.render(names, rows, a.base_label, a.new_label, f"Demixing evaluation: {a.new_label} vs {a.base_label} ({a.tier} tier)", meta,
                    [REP.pair_res_totals(arm_b, names), REP.pair_res_totals(arm_n, names)],
                    [REP.cluster_totals(arm_b, names), REP.cluster_totals(arm_n, names)])
    (out_root / "report.md").write_text(md)
    if a.md:
        a.md.write_text(md)
    print(md)
    return 0


if __name__ == "__main__":
    sys.exit(main())
