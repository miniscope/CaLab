#!/usr/bin/env python
"""Run `qc_eval sim` binaries over arms x seeds: a queue with machine-load limits.

    python tools/cala-eval/run_arms.py \
        --bin base=tools/cala-eval/bin/<base> --bin new=tools/cala-eval/bin/<new> \
        --sims <sims> --arms static,motion --seeds 5-9 --out <runs> [--parallel 4] \
        [--extra new="--joint"] [--budget-mult 4] \
        -- --batch 8 --budget 30000000 --slow-seed 1

Arguments after `--` go to every `qc_eval`; `--extra LABEL="..."` adds (or, for
a flag already present, replaces) arguments for one binary only. `--motion` is
added for the motion arms. Output: `<runs>/<label>/<arm>_s<seed>/` holding the
`qc_eval` outputs plus `run.json` (rc, wall s, max RSS) and `time.txt`.

Limits: at most `--parallel` (cap 6) light runs at once *machine-wide*
(other `qc_eval sim` and `qc_eval real` processes count: since 19 Nov 2026 real runs are light, under ~2.5 GB peak each), no new run while free memory is below
5 GB (the `vm_stat` rule), and a run whose max RSS exceeds 6 GB is reported.
Sim generation is not started here; it is limited to 2 machine-wide and launched by hand after checking `ps`.
Finished runs (run.json with rc 0) are skipped unless `--force`.
"""

from __future__ import annotations

import argparse
import json
import re
import shlex
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import arms as A  # noqa: E402

MIN_FREE_GB = 5.0
RSS_LIMIT_GB = 6.0
# Machine-wide cap on light `qc_eval sim` runs (PI-approved 18 Nov 2026, raised from 4); raise only with the PI's approval.
MAX_LIGHT = 6


def free_gb() -> float:
    """Free + inactive + speculative memory as the vm_stat rule counts it."""
    out = subprocess.run(["vm_stat"], capture_output=True, text=True).stdout
    page = int(re.search(r"page size of (\d+) bytes", out).group(1))
    pages = 0
    for key in ("Pages free", "Pages inactive", "Pages speculative"):
        m = re.search(rf"{key}:\s+(\d+)", out)
        pages += int(m.group(1)) if m else 0
    return pages * page / 1e9


def light_running() -> int:
    """`qc_eval sim` and `qc_eval real` processes on the machine, whoever started them (PI, 19 Nov 2026: real runs
    count as light and share the cap; keep each under ~2.5 GB peak)."""
    out = subprocess.run(["ps", "-axo", "command"], capture_output=True, text=True).stdout
    n = 0
    for line in out.splitlines():
        words = line.split()
        if len(words) > 2 and words[1] in ("sim", "real") and ("qc_eval" in words[0] or "/cala-eval/bin/" in words[0]):
            n += 1
    return n


def slot_free(state: dict) -> bool:
    """May this queue start another run? Default (`run_arms.py`): `parallel` counts every `qc_eval sim` on the
    machine. With `state["own_only"]` (the suite): only this queue's runs count against `parallel`, and the
    machine-wide total must still stay below MAX_LIGHT."""
    if state.get("own_only"):
        return state.get("own", 0) < state["parallel"] and light_running() < MAX_LIGHT
    return light_running() < state["parallel"]


def merge_args(base: list[str], extra: list[str]) -> list[str]:
    """`base` with every flag named in `extra` (and its value) replaced."""

    def flags(args: list[str]) -> dict[str, list[str]]:
        out: dict[str, list[str]] = {}
        i = 0
        while i < len(args):
            if args[i].startswith("--"):
                vals = []
                j = i + 1
                while j < len(args) and not args[j].startswith("--"):
                    vals.append(args[j])
                    j += 1
                out[args[i]] = vals
                i = j
            else:
                i += 1
        return out

    merged = flags(base)
    merged.update(flags(extra))
    return [t for k, v in merged.items() for t in [k, *v]]


def scale_budget(args: list[str], mult: float) -> list[str]:
    if mult == 1:
        return args
    out = list(args)
    if "--budget" in out:
        i = out.index("--budget") + 1
        out[i] = str(int(float(out[i]) * mult))
    else:
        out += ["--budget", str(int(30_000_000 * mult))]
    return out


def run_one(job: dict, state: dict) -> dict:
    out: Path = job["out"]
    # Wait for a slot (machine-wide) and for memory. The lock serialises the
    # check-then-start so two threads do not both take the last slot.
    while True:
        with state["lock"]:
            if slot_free(state) and free_gb() >= MIN_FREE_GB:
                if state.get("own_only"):
                    state["own"] = state.get("own", 0) + 1
                out.mkdir(parents=True, exist_ok=True)
                t0 = time.time()
                proc = subprocess.Popen(
                    ["/usr/bin/time", "-l", str(job["bin"]), "sim", str(job["sim"]), str(out), *job["args"]],
                    stdout=open(out / "stdout.log", "w"),
                    stderr=open(out / "time.txt", "w"),
                )
                time.sleep(2)  # let it show up in pgrep
                break
        time.sleep(15)
    rc = proc.wait()
    if state.get("own_only"):
        with state["lock"]:
            state["own"] -= 1
    wall = time.time() - t0
    txt = (out / "time.txt").read_text()
    m = re.search(r"(\d+)\s+maximum resident set size", txt)
    rss = int(m.group(1)) / 1e9 if m else float("nan")
    info = {"rc": rc, "wall_s": round(wall, 1), "rss_gb": round(rss, 2), "args": job["args"]}
    (out / "run.json").write_text(json.dumps(info))
    flag = " OVER 6 GB" if rss > RSS_LIMIT_GB else ""
    print(f"[done] {job['label']}/{out.name} rc={rc} wall={wall:.0f}s rss={rss:.2f}GB{flag}", flush=True)
    return info


# --- branched runs: arms that share Discover run as ONE qc_eval ------------------------------------
# qc_eval `--branch-after POINT --branch NAME:FLAGS` runs to POINT once and forks the process per branch.
# Only these flags act after Discover's last frame (qc_eval `TAIL_FLAGS`); arms whose args differ only in them
# can share the prefix. DRAIN_FLAGS act inside the look-back drain, so they must match for `drain`.
SETTLE_FLAGS = (
    "--settle-frames",
    "--settle-round",
    "--settle-observe",
    "--settle-steps",
    "--settle-batch",
    "--settle-due",
    "--settle-publish",
    "--settle-check",
    "--settle-stop-k",
    "--settle-stop-share",
    "--settle-stop-checks",
    "--settle-min-frames",
    "--settle-libs",
)
TAIL_FLAGS = ("--passes", "--later-passes", "--lookback-drain", "--lookback-drain-rate", "--lookback-settle-all", *SETTLE_FLAGS)
DRAIN_FLAGS = ("--lookback-drain", "--lookback-drain-rate", "--lookback-settle-all")


def _split_flags(args: list[str]) -> list[tuple[str, list[str]]]:
    out: list[tuple[str, list[str]]] = []
    for t in args:
        if t.startswith("--"):
            out.append((t, []))
        elif out:
            out[-1][1].append(t)
    return out


def supports_branching(binary: Path) -> bool:
    """Does this qc_eval build know `--branch-after`? (An older build would silently ignore it.)"""
    return b"--branch-after" in Path(binary).read_bytes()


def branch_split(args: list[str], point: str) -> tuple[list[str], list[str]]:
    """(prefix args, tail args) of one arm: the tail holds the flags that may differ between branches."""
    movable = TAIL_FLAGS if point == "discover" else tuple(f for f in TAIL_FLAGS if f not in DRAIN_FLAGS)
    prefix, tail = [], []
    for k, v in _split_flags(args):
        (tail if k in movable else prefix).extend([k, *v])
    return prefix, tail


def branch_groups(jobs: list[dict], point: str) -> tuple[list[list[dict]], list[dict]]:
    """Split jobs into branched groups (same binary, sim and prefix args, 2+ arms) and the rest."""
    if point == "off":
        return [], list(jobs)
    keyed: dict[tuple, list[dict]] = {}
    for j in jobs:
        prefix, _ = branch_split(j["args"], point)
        keyed.setdefault((str(j["bin"]), str(j["sim"]), tuple(sorted(map(tuple, ((k, *v) for k, v in _split_flags(prefix)))))), []).append(j)
    groups = [g for g in keyed.values() if len(g) > 1 and len({j["label"] for j in g}) == len(g)]
    in_group = {id(j) for g in groups for j in g}
    return groups, [j for j in jobs if id(j) not in in_group]


def run_branched(group: list[dict], state: dict, point: str) -> list[dict]:
    """Run a group as one qc_eval; lay each arm's outputs out as a separate run (`<out>/run.json` etc.)."""
    first = group[0]
    prefix, _ = branch_split(first["args"], point)
    args = list(prefix)
    for j in group:
        _, tail = branch_split(j["args"], point)
        args += ["--branch", f"{j['label']}:{' '.join(tail)}"]
    args += ["--branch-after", point]
    # One directory per group: several groups of one sim (different prefixes) may run at once in one tree.
    tmp = first["out"].parent.parent / "_branched" / f"{first['label']}__{first['out'].name}"
    shutil.rmtree(tmp, ignore_errors=True)
    info = run_one({**first, "out": tmp, "args": args, "label": "+".join(j["label"] for j in group)}, state)
    for j in group:
        out: Path = j["out"]
        shutil.rmtree(out, ignore_errors=True)
        ok = info["rc"] == 0 and (tmp / j["label"]).is_dir()
        if ok:
            shutil.move(str(tmp / j["label"]), out)
        else:
            out.mkdir(parents=True, exist_ok=True)
        for f in ("stdout.log", "time.txt"):
            shutil.copy2(tmp / f, out / f)
        rc = info["rc"] if ok else (info["rc"] or 1)
        (out / "run.json").write_text(json.dumps({**info, "rc": rc, "args": j["args"], "branched": [x["label"] for x in group]}))
    shutil.rmtree(tmp, ignore_errors=True)
    try:
        tmp.parent.rmdir()  # `_branched`, once the last group is done
    except OSError:
        pass
    return [json.loads((j["out"] / "run.json").read_text()) for j in group]


def main() -> int:
    argv = sys.argv[1:]
    rest: list[str] = []
    if "--" in argv:
        k = argv.index("--")
        argv, rest = argv[:k], argv[k + 1 :]
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bin", action="append", required=True, help="LABEL=PATH (repeatable)")
    ap.add_argument("--extra", action="append", default=[], help='LABEL="extra qc_eval args"')
    ap.add_argument("--sims", required=True, type=Path)
    ap.add_argument("--arms", default="static,motion")
    ap.add_argument("--seeds", default="5-9")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--parallel", type=int, default=MAX_LIGHT)
    ap.add_argument("--budget-mult", type=float, default=1.0)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--branch-after", choices=["off", "discover", "drain"], default="off",
                    help="run the arms of one sim that share their args up to POINT as one branched qc_eval")
    a = ap.parse_args(argv)
    if a.parallel > MAX_LIGHT:
        sys.exit(f"--parallel is capped at {MAX_LIGHT} light runs")

    bins = {}
    for b in a.bin:
        label, _, path = b.partition("=")
        if not path:
            label, path = Path(b).name, b
        bins[label] = Path(path).resolve()
    extras = {}
    for e in a.extra:
        label, _, s = e.partition("=")
        extras[label] = shlex.split(s)

    jobs = []
    for arm in A.parse_list(a.arms):
        if not A.available(arm):
            print(f"[skip] arm {arm}: spec not committed yet")
            continue
        for seed in A.parse_seeds(a.seeds):
            sim = a.sims / A.run_name(arm, seed)
            if not (sim / "oracle.bin").exists():
                print(f"[skip] {sim.name}: recording missing (run gen_sims.py)")
                continue
            for label, path in bins.items():
                out = a.out / label / A.run_name(arm, seed)
                done = out / "run.json"
                if done.exists() and not a.force and json.loads(done.read_text())["rc"] == 0:
                    continue
                args = merge_args(rest, extras.get(label, []))
                args = scale_budget(args, a.budget_mult)
                if A.ARMS[arm]["motion"] and "--motion" not in args:
                    args.append("--motion")
                jobs.append({"label": label, "bin": path, "sim": sim.resolve(), "out": out, "args": args})
    print(f"{len(jobs)} runs queued, parallel {a.parallel}", flush=True)
    state = {"lock": __import__("threading").Lock(), "parallel": a.parallel}
    groups, singles = branch_groups(jobs, a.branch_after)
    if groups and not all(supports_branching(g[0]["bin"]) for g in groups):
        sys.exit("--branch-after: a qc_eval build lacks --branch-after")
    if groups:
        print(f"{len(groups)} branched groups ({sum(map(len, groups))} arms share a Discover)", flush=True)
    with ThreadPoolExecutor(a.parallel) as ex:
        futs = [ex.submit(run_one, j, state) for j in singles] + [ex.submit(run_branched, g, state, a.branch_after) for g in groups]
        infos = [i for f in futs for i in (f.result() if isinstance(f.result(), list) else [f.result()])]
    return 1 if any(i["rc"] != 0 for i in infos) else 0


if __name__ == "__main__":
    sys.exit(main())
