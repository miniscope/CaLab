#!/usr/bin/env python
"""Quality by stage and over time: judge "Discover with look-back" against "Discover + N Refines".

    # run: one arm (label) over some sims; stages Discover, +1 Refine, +2, +3 and checkpoints inside Discover
    $MINISIM_PY tools/cala-eval/demix_stages.py run --label z3 --flags "--refine-z 3" --bin $QC_EVAL_BIN \
        --only static_s5,pairs_s5 --name stages-z3-vs-z0
    $MINISIM_PY tools/cala-eval/demix_stages.py run --label z0 --flags "--refine-z 0" ... --name stages-z3-vs-z0
    # report: any number of arms of one --name, side by side
    $MINISIM_PY tools/cala-eval/demix_stages.py report --name stages-z3-vs-z0 --arms z3,z0 --md OUT.md
    $MINISIM_PY tools/cala-eval/demix_stages.py report ... --ref z3:1     # judge every arm against z3's Discover + 1 Refine

Needs the qc_eval of this branch or later (`--lib-at`, `--wrap-libs`). Per sim and arm it runs ONE
`qc_eval sim SIM RUN/main --passes N+1 --later-passes refine --batch 8 --budget 30000000 --slow-seed 1 --dump
--wrap-libs --lib-at ...` (`--passes 4` default, Discover + 3 Refines), then, for every library worth scoring, an
extract-only run `qc_eval sim SIM RUN/lib_X --passes 1 --library FILE --dump` (fast loop only, the traces the same
fixed-library path `--dump` uses) followed by `demix_metrics.py --ledger RUN/main` (the birth frames come from
the main run's `adds.tsv`; ids survive the fixed-library rebuild). One qc_eval at a time (this script is serial);
`run_arms.run_one` still waits while `run_arms.MAX_LIGHT` `qc_eval sim` runs are going machine-wide. Outputs: `$CALA_DATA/demix-suite/<name>/<label>/<sim>/`.

Stages (what the app ends each step with):

  S0 Discover only        `footprints_wrap1.bin`, the library the first wrap publishes (`SlowLoop::finalize`)
  S1 Discover + 1 Refine  `footprints_wrap2.bin` (for --passes 2: the main run's final footprints.bin)
  S2, S3 ...              wrap3 ..., the last stage is the main run's final `footprints.bin` (finalized after the last pass)
  All stages are scored from extract-only runs (`--library`), never from the main run's own `--dump`: the fixed-library
  rebuild is not bit-identical to the main dump (pairs_s5: headline +0.122 vs +0.138, trace r median 0.99995), so mixing
  the two would put a small systematic step between the last stage and the others.
  cumulative wall         the sum of `passes.tsv` wall_s up to and including the stage's pass: seconds of the qc_eval
                          pass loop (fast + slow loop and the GT scoring that rides along, the same for all arms).
                          It excludes the finalize at the wrap and the metric extraction.

Checkpoints inside Discover (pass 1) are the *live* library when pass 1 reaches 25 / 50 / 75 % of the frames
(`footprints_t{frame}.bin`) and 100 % (`footprints_pass1.bin`, before the wrap's finalize). Cells not yet born are
simply absent, so "undetected neighbour" metrics at early checkpoints measure the cost of cells found later.

TIME TO GOOD FOOTPRINTS (defined here, used in the report). Reference stage R (default: the arm's last stage; or
another arm's stage with `--ref LABEL:K`, e.g. today's Discover + 1 Refine). A stage of an arm is *good* when BOTH
  (a) its headline trace-correlation excess (< 1 D) is at most the upper bound of R's 95 % bootstrap CI, and
  (b) its bite share (ratio < 0.5, 0.75-1 D) is at most the upper bound of R's 95 % bootstrap CI.
Lower is better for both, so a stage better than R is good. The time to good footprints of an arm is the cumulative
wall time of its first good stage, or "not reached"; the report also gives it as a ratio of R's own cumulative wall
time (design_discover_lookback.md section 6 asks for <= 0.7 against Discover + 1 Refine). Only the stage
granularity is available.

Cluster churn: from the libraries written at 12.5 % steps of pass 1 (cheap, footprints only; no traces needed) the
share of surviving cells whose overlap cluster (demix_clusters.py) changed between consecutive checkpoints, and why.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import subprocess
import sys
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import numpy as np  # noqa: E402

import demix_clusters as CL  # noqa: E402
import demix_metrics as DM  # noqa: E402
import demix_report as REP  # noqa: E402
import demix_suite as SUITE  # noqa: E402
import run_arms as RA  # noqa: E402

PASSES = 4
LIB_AT = [k / 8 for k in range(1, 8)]  # written at 12.5 % steps (cluster churn); traces for EXTRACT_AT only
EXTRACT_AT = [0.25, 0.5, 0.75]
GOOD_METRICS = ("headline", "bite75")  # both must be within the reference CI

MAIN_ARGS = ["--later-passes", "refine", "--batch", "8", "--budget", "30000000", "--slow-seed", "1", "--dump", "--wrap-libs"]
EXTRACT_ARGS = ["--passes", "1", "--batch", "8", "--budget", "30000000", "--slow-seed", "1", "--dump"]


# ------------------------------------------------------------------ layout


def lib_files(main: Path, passes: int):
    """Libraries of one main run as [(kind, key, file)]: kind 'stage' (key = stage index) or 'ckpt' (key = frame)."""
    out = [("stage", k - 1, main / f"footprints_wrap{k}.bin") for k in range(1, passes)]
    out.append(("stage", passes - 1, main / "footprints.bin"))  # the last stage: the finalized library of the main run
    out += [("ckpt", int(m.group(1)), p) for p in sorted(main.glob("footprints_t*.bin")) if (m := re.search(r"_t(\d+)\.bin$", p.name))]
    if (main / "footprints_pass1.bin").exists():
        out.append(("ckpt", None, main / "footprints_pass1.bin"))  # 100 %: the live library at the end of pass 1
    return out


def pass_walls(main: Path):
    rows = DM.read_tsv(main / "passes.tsv")
    return [float(r["wall_s"]) for r in rows], int(float(rows[0]["frame"]))


def scored(run: Path) -> bool:
    return (run / "demix_det.json").exists()


# --------------------------------------------------------------------- run


def run_arm(a):
    root = SUITE.data_root() / "demix-suite" / a.name / a.label
    state = {"lock": threading.Lock(), "parallel": RA.MAX_LIGHT}  # machine-wide cap of run_arms; this script itself runs one at a time
    sims = SUITE.tier_sims("full", a.only) if a.only else [(k, s) for k, seeds in SUITE.TIERS["quick"] for s in seeds]
    extra = a.flags.split()
    for kind, seed in sims:
        sim = SUITE.sim_dir(kind, seed, None, None)
        if not (sim / "oracle.bin").exists():
            sys.exit(f"missing sim {sim}")
        main = root / f"{kind}_s{seed}" / "main"
        motion = ["--motion"] if kind == "motion" else []
        args = RA.merge_args(["--passes", str(a.passes), *MAIN_ARGS, "--lib-at", ",".join(f"{f:g}" for f in LIB_AT)], extra) + motion
        job = {"label": a.label, "bin": Path(a.bin).resolve(), "sim": sim.resolve(), "out": main, "args": args, "kind": kind}
        done = main / "run.json"
        if not (done.exists() and json.loads(done.read_text())["rc"] == 0):
            if RA.run_one(job, state)["rc"] != 0:
                sys.exit(f"main run failed: {main}")
        score(sim, main, kind, None)
        walls, T = pass_walls(main)
        for kind_, key, fp in lib_files(main, a.passes):
            if kind_ == "ckpt" and not any(abs((key or T) / T - f) < 2e-3 for f in EXTRACT_AT + [1.0]):
                continue  # footprints only (cluster churn)
            run = main.parent / f"lib_{fp.stem.replace('footprints_', '')}"
            ejob = {"label": a.label, "bin": job["bin"], "sim": job["sim"], "out": run, "kind": kind,
                    "args": EXTRACT_ARGS + ["--library", str(fp)] + motion}  # fmt: skip
            if not ((run / "run.json").exists() and json.loads((run / "run.json").read_text())["rc"] == 0):
                if RA.run_one(ejob, state)["rc"] != 0:
                    sys.exit(f"extract run failed: {run}")
            score(sim, run, kind, main)


def score(sim: Path, run: Path, kind: str, ledger: Path | None):
    if scored(run):
        return
    cmd = [sys.executable, str(HERE / "demix_metrics.py"), str(sim), str(run)] + (["--all-det"] if kind == "pairs" else [])
    if ledger:
        cmd += ["--ledger", str(ledger)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        sys.exit(f"demix_metrics failed on {run}:\n{r.stderr[-800:]}")
    print(f"[metrics] {run.parent.name}/{run.name}: {r.stdout.strip()}", flush=True)


# ------------------------------------------------------------------ report


def arm_dirs(root: Path):
    return sorted(p for p in root.iterdir() if (p / "main").is_dir())


def load_stages(root: Path):
    """Stages of one arm: [{'name', 'idx', 'wall', 'runs': {sim: run dict}}], checkpoints [{'frac', 'runs'}], T by sim."""
    sims = arm_dirs(root)
    per_sim = {}
    for sd in sims:
        passes = len(DM.read_tsv(sd / "main" / "passes.tsv"))
        walls, T = pass_walls(sd / "main")
        per_sim[sd.name] = (sd, passes, walls, T)
    n_stage = min(p for _, p, _, _ in per_sim.values())
    stages = []
    for k in range(n_stage):
        runs = {}
        for name, (sd, passes, walls, T) in per_sim.items():
            run = sd / ("lib_footprints" if k == passes - 1 else f"lib_wrap{k + 1}")  # every stage through the same extract path
            if scored(run):
                run_ = REP.load_run(run)
                run_["name"] = name
                runs[name] = run_
        wall = float(np.mean([sum(w[: k + 1]) for _, _, w, _ in per_sim.values()]))
        stages.append({"name": "Discover" if k == 0 else f"+{k} Refine", "idx": k, "wall": wall, "runs": runs})
    ckpts = []
    for f in EXTRACT_AT + [1.0]:
        runs = {}
        for name, (sd, passes, walls, T) in per_sim.items():
            frame = round(f * T)
            run = sd / "lib_pass1" if f == 1.0 else sd / f"lib_t{frame}"
            if scored(run):
                run_ = REP.load_run(run)
                run_["name"] = name
                runs[name] = run_
        if runs:
            ckpts.append({"name": f"{int(f * 100)} % of Discover", "frac": f, "runs": runs})
    return stages, ckpts, per_sim


def stat_rows(ref_runs, runs):
    """REP.compare(ref, runs) rows keyed by metric name (new = runs). Both dicts {sim: run}."""
    names = [n for n in ref_runs if n in runs]
    if not names:
        return [], {}
    nm, rows = REP.compare([ref_runs[n] for n in names], [runs[n] for n in names])
    return nm, {r["name"]: r for r in rows}


KEY = [  # (row name or prefix, short label)
    ("Trace corr excess < 1 D (15 s", "corr excess < 1 D (headline)"),
    ("Trace corr excess 0.5-1 D", "corr excess 0.5-1 D"),
    ("Bite share ratio < 0.5, 0.0-0.5 D", "bite share 0-0.5 D"),
    ("Bite share ratio < 0.5, 0.5-0.75 D", "bite share 0.5-0.75 D"),
    ("Bite share ratio < 0.5, 0.75-1.0 D", "bite share 0.75-1 D"),
    ("Bite share ratio < 0.5, later-born cell, 0.75-1.0 D", "bite share 0.75-1 D, later-born"),
    ("Bite share ratio < 0.5, earlier-born cell, 0.75-1.0 D", "bite share 0.75-1 D, earlier-born"),
    ("Bite share ratio < 0.5, late-born cell, 0.75-1.0 D", "bite share 0.75-1 D, late-born (last 20 %)"),
    ("Over-fill share est/true > 1.3 at undetected neighbour, < 1 D", "over-fill share at undetected neighbour < 1 D"),
    ("leak_sd share > 0.1, < 1 D", "leak share > 0.1 < 1 D"),
    ("Matched cells", "matched"),
    ("False cells", "false"),
    ("Final cells matching 2+ GT units", "cells matching 2+ GT units"),
    ("Close GT pairs, both matched, 0.5-0.75 D", "pairs both matched 0.5-0.75 D"),
    ("Close GT pairs, both matched, 0.75-1 D", "pairs both matched 0.75-1 D"),
]


def _row(rows, prefix):
    return next((r for n, r in rows.items() if n.startswith(prefix)), None)


def _cell(r):
    if r is None:
        return "n/a"
    s = REP._f(r["fmt"], r["new"])
    ci = r["new_ci"]
    if ci is not None and np.isfinite(ci[0]):
        s += f" [{REP._f(r['fmt'], ci[0])}, {REP._f(r['fmt'], ci[1])}]"
    return s


def good_stage(stage_rows, ref_rows):
    """True when the stage's headline and 0.75-1 D bite share are within (below the upper bound of) the reference CI."""
    for pre in ("Trace corr excess < 1 D (15 s", "Bite share ratio < 0.5, 0.75-1.0 D"):
        s, r = _row(stage_rows, pre), _row(ref_rows, pre)
        if s is None or r is None or not np.isfinite(s["new"]) or r["new_ci"] is None or not np.isfinite(r["new_ci"][1]):
            return False
        if s["new"] > r["new_ci"][1]:
            return False
    return True


def time_to_good(stages, ref_stage, ref_runs=None):
    """(index, name, wall) of the first good stage of `stages` against the reference stage, or None.

    ref_stage: the stage whose CI is the target; its rows come from comparing it with itself.
    """
    ref = ref_stage["runs"]
    _, ref_rows = stat_rows(ref, ref)
    for st in stages:
        _, rows = stat_rows(ref, st["runs"])
        if rows and good_stage(rows, ref_rows):
            return st["idx"], st["name"], st["wall"]
    return None


def table(cols, ref_runs, title, note):
    """cols: [(label, runs)]; one value-with-CI table plus a difference-from-reference table with flags."""
    stats = [(lab, stat_rows(ref_runs, runs)[1]) for lab, runs in cols]
    out = ["", f"## {title}", "", note, "", "| metric | " + " | ".join(l for l, _ in stats) + " |", "|---|" + "---|" * len(stats)]
    for pre, lab in KEY:
        out.append(f"| {lab} | " + " | ".join(_cell(_row(r, pre)) for _, r in stats) + " |")
    out += ["", "Difference from the reference (last stage, or `--ref`), 95 % CI, flag (`better`/`worse` need the CI to exclude 0 and 2/3 of the sims to agree):", "",
            "| metric | " + " | ".join(l for l, _ in stats) + " |", "|---|" + "---|" * len(stats)]  # fmt: skip
    for pre, lab in KEY[:10]:
        cells = []
        for _, r in stats:
            x = _row(r, pre)
            if x is None or not np.isfinite(x["diff"]):
                cells.append("n/a")
                continue
            f = x["fmt"]
            cells.append(f"{x['diff']:+.3f} [{REP._f(f, x['lo'])}, {REP._f(f, x['hi'])}] {x['flag']}")
        out.append(f"| {lab} | " + " | ".join(cells) + " |")
    return out


def churn_section(per_sim_by_arm):
    out = ["", "## Cluster membership during Discover (overlap clusters, rho >= 0.05, K_max 6)", "",
           "From the library at each 12.5 % step of pass 1 (live library). `changed` = share of cells present at both checkpoints whose "
           "cluster member set differs; causes in order `birth` (a new cell joined), `loss` (a member was removed), `regroup` "
           "(same cells, other grouping). `frames between changes` = interval / share changed of cells that were in a cluster of 2+ "
           "(a rate estimate, not a median).", ""]  # fmt: skip
    for label, per_sim in per_sim_by_arm.items():
        agg = {}
        sizes = {}
        for name, (sd, passes, walls, T) in per_sim.items():
            libs = [(round(f * T), sd / "main" / f"footprints_t{round(f * T)}.bin") for f in LIB_AT]
            libs.append((T, sd / "main" / "footprints_pass1.bin"))
            mem, prev = {}, None
            for frame, p in libs:
                if not p.exists():
                    continue
                h, w, ids, cells, filt = DM.read_library(p)
                m = CL.membership(ids, filt, h * w)
                cs = CL.cluster_stats(filt, h * w)
                sizes.setdefault(frame / T, []).append(cs)
                if prev is not None:
                    c = CL.membership_change(prev[1], m)
                    a = agg.setdefault(round(frame / T, 3), {"interval": frame - prev[0], **{k: 0 for k in ("survivors", "changed", "birth", "loss", "regroup", "clustered", "clustered_changed")}})
                    for k in ("survivors", "changed", "birth", "loss", "regroup", "clustered", "clustered_changed"):
                        a[k] += c[k]
                prev = (frame, m)
        out += [f"**{label}** (sims pooled)", "", "| checkpoint | interval (frames) | survivors | changed | birth / loss / regroup | clustered cells changed | frames between changes (clustered) | share in cluster 2+ | max component |",
                "|---|---|---|---|---|---|---|---|---|"]  # fmt: skip
        for f, a in sorted(agg.items()):
            sc = a["clustered_changed"] / a["clustered"] if a["clustered"] else math.nan
            fb = a["interval"] / sc if sc and np.isfinite(sc) and sc > 0 else math.nan
            cs = sizes.get(f, [])
            share = float(np.mean([c["share_clustered"] for c in cs])) if cs else math.nan
            mx = max((c["max_component"] for c in cs), default=0)
            out.append(f"| {f:.1%} | {a['interval']} | {a['survivors']} | {a['changed'] / max(a['survivors'], 1):.1%} | {a['birth']} / {a['loss']} / {a['regroup']} | "
                       f"{sc:.1%} | {fb:.0f} | {share:.1%} | {mx} |")  # fmt: skip
        out.append("")
    return out


def report(a):
    root = SUITE.data_root() / "demix-suite" / a.name
    labels = a.arms.split(",") if a.arms else [p.name for p in sorted(root.iterdir()) if p.is_dir()]
    loaded = {lab: load_stages(root / lab) for lab in labels}
    ref = None
    if a.ref:
        rl, rk = a.ref.split(":")
        ref = loaded[rl][0][int(rk)]
    out = [f"# Demixing quality by stage and over time ({a.name})", "",
           "Stages are what the app ends each step with (Discover, then each Refine). Checkpoints are the live library inside Discover. "
           "Pair metrics pooled over sims with a 95 % bootstrap CI over pairs (`demix_report.py` machinery); the reference for the "
           "difference table is the arm's last stage unless `--ref LABEL:K` names another arm's stage K (0 = Discover only). "
           "Definitions and the time-to-good rule: `demix_stages.py` docstring.", ""]  # fmt: skip
    summary = ["", "## Time to good footprints", "",
               "Good = headline correlation excess and 0.75-1 D bite share both at or below the upper bound of the reference stage's 95 % CI. "
               "Cumulative wall = sum of the pass walls in `passes.tsv` (qc_eval pass loop).", "",
               "| arm | reference | first good stage | cumulative wall (s) | reference wall (s) | ratio |", "|---|---|---|---|---|---|"]  # fmt: skip
    sections = []
    for lab in labels:
        stages, ckpts, per_sim = loaded[lab]
        rst = ref or stages[-1]
        rname = f"{a.ref} ({rst['name']})" if ref else f"{lab} {rst['name']}"
        ttg = time_to_good(stages, rst)
        if ttg:
            summary.append(f"| {lab} | {rname} | {ttg[1]} | {ttg[2]:.0f} | {rst['wall']:.0f} | {ttg[2] / rst['wall']:.2f} |")
        else:
            summary.append(f"| {lab} | {rname} | not reached | n/a | {rst['wall']:.0f} | n/a |")
        names = ", ".join(sorted(stages[0]["runs"]))
        cols = [(f"{s['name']} ({s['wall']:.0f} s)", s["runs"]) for s in stages]
        sections += table(cols, rst["runs"], f"{lab}: stage comparison", f"Sims: {names}. Column header = stage and cumulative wall seconds.")
        if ckpts:
            sections += table([(c["name"], c["runs"]) for c in ckpts], rst["runs"], f"{lab}: quality during Discover (live library at 25 / 50 / 75 / 100 % of the frames)",
                              "Cells not yet born are absent from early libraries, so matched counts rise and the undetected-neighbour row measures cells that come later.")  # fmt: skip
    out += summary + sections + churn_section({lab: loaded[lab][2] for lab in labels})
    md = "\n".join(out) + "\n"
    if a.md:
        a.md.write_text(md)
    print(md)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--label", required=True)
    r.add_argument("--name", required=True)
    r.add_argument("--bin", default=os.environ.get("QC_EVAL_BIN"))
    r.add_argument("--flags", default="")
    r.add_argument("--only", help="comma list, e.g. static_s5,pairs_s5 (default: the quick tier)")
    r.add_argument("--passes", type=int, default=PASSES, help="passes of the main run: Discover + (N-1) Refines")
    p = sub.add_parser("report")
    p.add_argument("--name", required=True)
    p.add_argument("--arms", help="comma list of arm labels (default: every arm under --name)")
    p.add_argument("--ref", help="LABEL:K, reference stage K (0 = Discover only) of that arm")
    p.add_argument("--md", type=Path)
    a = ap.parse_args(argv)
    if a.cmd == "run":
        if not a.bin:
            sys.exit("give --bin or set QC_EVAL_BIN")
        if a.passes < 2:
            sys.exit("--passes must be at least 2 (stages need a wrap)")
        run_arm(a)
    else:
        report(a)
    return 0


if __name__ == "__main__":
    sys.exit(main())
