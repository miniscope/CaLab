#!/usr/bin/env python
"""Run `qc_eval sim` binaries over arms x seeds: a queue with machine-load limits.

    python tools/cala-eval/run_arms.py \
        --bin base=tools/cala-eval/bin/<base> --bin new=tools/cala-eval/bin/<new> \
        --sims <sims> --arms static,motion --seeds 5-9 --out <runs> [--parallel 4] \
        [--extra new="--core-test trim"] [--budget-mult 4] \
        -- --batch 8 --budget 30000000 --slow-seed 1

Arguments after `--` go to every `qc_eval`; `--extra LABEL="..."` adds (or, for
a flag already present, replaces) arguments for one binary only. `--motion` is
added for the motion arms. Output: `<runs>/<label>/<arm>_s<seed>/` holding the
`qc_eval` outputs plus `run.json` (rc, wall s, max RSS) and `time.txt`.

Limits: at most `--parallel` (cap 4) light `sim` runs at once *machine-wide*
(other `qc_eval sim` processes count), no new run while free memory is below
5 GB (the `vm_stat` rule), and a run whose max RSS exceeds 6 GB is reported.
Heavy jobs (`qc_eval real`, sim generation) are not started here; they are
limited to 2 machine-wide and are launched by hand after checking `ps`.
Finished runs (run.json with rc 0) are skipped unless `--force`.
"""

from __future__ import annotations

import argparse
import json
import re
import shlex
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import arms as A  # noqa: E402

MIN_FREE_GB = 5.0
RSS_LIMIT_GB = 6.0
MAX_LIGHT = 4


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
    """`qc_eval sim` processes on the machine, whoever started them."""
    out = subprocess.run(["ps", "-axo", "command"], capture_output=True, text=True).stdout
    n = 0
    for line in out.splitlines():
        words = line.split()
        if len(words) > 2 and words[1] == "sim" and ("qc_eval" in words[0] or "/cala-eval/bin/" in words[0]):
            n += 1
    return n


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
            if light_running() < state["parallel"] and free_gb() >= MIN_FREE_GB:
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
    wall = time.time() - t0
    txt = (out / "time.txt").read_text()
    m = re.search(r"(\d+)\s+maximum resident set size", txt)
    rss = int(m.group(1)) / 1e9 if m else float("nan")
    info = {"rc": rc, "wall_s": round(wall, 1), "rss_gb": round(rss, 2), "args": job["args"]}
    (out / "run.json").write_text(json.dumps(info))
    flag = " OVER 6 GB" if rss > RSS_LIMIT_GB else ""
    print(f"[done] {job['label']}/{out.name} rc={rc} wall={wall:.0f}s rss={rss:.2f}GB{flag}", flush=True)
    return info


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
    with ThreadPoolExecutor(a.parallel) as ex:
        infos = list(ex.map(lambda j: run_one(j, state), jobs))
    return 1 if any(i["rc"] != 0 for i in infos) else 0


if __name__ == "__main__":
    sys.exit(main())
