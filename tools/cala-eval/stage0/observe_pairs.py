"""Paired slow-loop timing of two `run_arms.py` trees whose binaries were built with `--features timing`.

usage: python3 observe_pairs.py BASE_TREE NEW_TREE

Per run (`<tree>/<sim>/stdout.log`, parsed with `stage_tables.py`): the last Discover chunk's observe stages and the
Final settle's (ms per observe call: ledger, fpstats, clusters, total), the settle's wall ms per frame, and qc_eval's
`slow observe` ms per frame over pass 1. Prints a Markdown table of per-arm means (base -> new) with the paired mean
ratio new/base and its 95 % t-CI over seeds. Wall times are only comparable when the two binaries ran side by side
(`run_arms.py --parallel 2` runs each sim's pair together).
"""
import math
import re
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import stage_tables as ST  # noqa: E402

T975 = {1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262}


def stages(log):
    """`{name: ms}` of one run."""
    text = log.read_text()
    out = {}
    m = re.search(r"slow observe ([\d.]+) ms/frame", text)
    out["slow observe (pass 1)"] = float(m.group(1)) if m else math.nan
    lines = [ln for ln in text.splitlines() if ln.startswith("stage ")]
    vec = []
    for ln in lines:
        tag = ln.split(":")[0][6:]
        vals = [float(v) for v in ln.split("|", 1)[1].split()]
        frames = int(re.search(r"frames (\d+)", ln).group(1))
        vec.append((tag, frames, vals))
    disc = [v for v in vec if not v[0].startswith("settle")]
    start = next(v for v in vec if v[0] == "settle-start")
    end = next(v for v in vec if v[0].startswith("settle-end"))
    wall = float(re.search(r"wall_s ([\d.]+)", next(ln for ln in lines if ln.startswith("stage settle-end"))).group(1))

    def per_call(a, b):
        calls = b[2][0] - a[2][0]
        return {n: (b[2][1 + i] - a[2][1 + i]) / max(calls, 1) for i, n in enumerate(ST.OBS)}, calls

    pre = [v for v in disc if v[1] <= start[1]]
    last, prev = pre[-1], pre[-2] if len(pre) > 1 else pre[0]
    d, _ = per_call(prev, last)
    s, calls = per_call(start, end)
    for k in ("ledger", "fpstats", "clusters"):
        out[f"Discover late {k}"] = d[k]
        out[f"settle {k}"] = s[k]
    out["Discover late observe total"] = sum(d.values())
    out["settle observe total"] = sum(s.values())
    out["settle wall ms/frame"] = 1e3 * wall / max(calls, 1)
    return out


def main():
    base, new = Path(sys.argv[1]), Path(sys.argv[2])
    arms = {}
    for run in sorted(base.iterdir()):
        if (new / run.name / "stdout.log").exists() and (run / "stdout.log").exists():
            arm = re.sub(r"_s\d+$", "", run.name)
            arms.setdefault(arm, []).append((stages(run / "stdout.log"), stages(new / run.name / "stdout.log")))
    print("| arm | ms | base | new | new / base (95 % CI) | n |")
    print("|---|---|---:|---:|---:|---:|")
    for arm, pairs in arms.items():
        for k in pairs[0][0]:
            b = [p[0][k] for p in pairs]
            n = [p[1][k] for p in pairs]
            r = [y / x for x, y in zip(b, n) if x > 0]
            m = statistics.mean(r)
            ci = T975.get(len(r) - 1, 2.0) * statistics.stdev(r) / math.sqrt(len(r)) if len(r) > 1 else math.nan
            print(f"| {arm} | {k} | {statistics.mean(b):.3f} | {statistics.mean(n):.3f} | {m:.3f} +- {ci:.3f} |"
                  f" {len(r)} |")


if __name__ == "__main__":
    main()
