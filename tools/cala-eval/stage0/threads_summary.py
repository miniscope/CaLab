"""Stage-0 threads kill test: observe ms per call and bit-identity across runs.

usage: python3 threads_summary.py RUNS_DIR BASE RUN [RUN ...]

Each RUN is a `run.sh sim` directory name (with `RUN.log` beside it, built
with `--features timing`). Prints, for the Discover part (up to the settle
start) and the Final settle, the observe ms per call (all stages, and
fpstats + clusters), the speed-up against BASE, the wall time, and whether
`footprints.bin` / `final.tsv` are byte-identical to BASE's.
"""
import filecmp
import re
import sys
from pathlib import Path

NO = 9


def stages(log):
    rows = {}
    for line in open(log):
        m = re.match(r"stage (.*?): frames (\d+) cells (\d+) \| (.*)", line)
        if m:
            v = [float(x) for x in m.group(4).split()]
            tag = m.group(1).split()[0]
            rows[tag] = (v[0], v[1:1 + NO])
    return rows


def part(rows, a, b):
    ca, oa = rows.get(a, (0.0, [0.0] * NO))
    cb, ob = rows[b]
    d = [y - x for x, y in zip(oa, ob)]
    n = max(cb - ca, 1)
    return sum(d) / n, (d[5] + d[6]) / n


def main():
    runs = Path(sys.argv[1])
    base = sys.argv[2]
    names = sys.argv[3:]
    res = {}
    for n in [base] + names:
        rows = stages(runs / f"{n}.log")
        wall = re.search(r"([\d.]+) real", (runs / f"{n}.time").read_text())
        res[n] = (part(rows, None, "settle-start"), part(rows, "settle-start", "settle-end"),
                  float(wall.group(1)) if wall else float("nan"))
    print("| run | Discover observe ms/call | fpstats+clusters | share | speed-up | settle observe ms/call | speed-up | wall s | footprints.bin | final.tsv |")
    print("|---|---:|---:|---:|---:|---:|---:|---:|---|---|")
    for n in [base] + names:
        (d, dfc), (s, _sfc), wall = res[n]
        same = []
        for f in ("footprints.bin", "final.tsv"):
            a, b = runs / base / f, runs / n / f
            same.append("same" if a.exists() and b.exists() and filecmp.cmp(a, b, shallow=False) else "DIFFERS")
        print(f"| {n} | {d:.3f} | {dfc:.3f} | {100 * dfc / d:.0f}% | {res[base][0][0] / d:.2f}x | {s:.3f} | "
              f"{res[base][1][0] / s:.2f}x | {wall:.0f} | {same[0]} | {same[1]} |")


if __name__ == "__main__":
    main()
