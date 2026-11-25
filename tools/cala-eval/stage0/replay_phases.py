"""Visit phases from a job replay (`qc_eval --replay-jobs DIR`, `--features timing`).

usage: python3 replay_phases.py OUT/replay_phases.tsv [--parts 3]

Per part of the captured run (jobs in file order = Discover order): ms per
visit by phase (fastest repetition) and the edits each phase made.
"""
import csv
import sys

VIS = ["keep", "load", "solve", "split", "refine", "merge", "add"]
EDITS = ["adds", "merges", "refines", "splits", "deletes", "absorbs", "proposals"]


def main():
    rows = list(csv.DictReader(open(sys.argv[1]), delimiter="\t"))
    parts = int(sys.argv[sys.argv.index("--parts") + 1]) if "--parts" in sys.argv else 3
    n = len(rows)
    bounds = [round(n * k / parts) for k in range(parts + 1)]
    groups = [("all", rows)] + [(f"part {k + 1}/{parts}", rows[bounds[k]:bounds[k + 1]]) for k in range(parts)]
    for title, g in groups:
        if not g:
            continue
        tot = {p: sum(float(r[f"{p}_ms"]) for r in g) for p in VIS}
        T = sum(tot.values())
        cells = sum(float(r["cells"]) for r in g) / len(g)
        print(f"\n### {title}: {len(g)} visits ({g[0]['file']} .. {g[-1]['file']}), zone cells {cells:.0f},"
              f" {T / len(g):.2f} ms/visit")
        print("| phase | ms/visit | share | " + " | ".join(EDITS) + " |")
        print("|---" * (3 + len(EDITS)) + "|")
        for p in VIS:
            e = [sum(int(r[f"{p}_{k}"]) for r in g) for k in EDITS]
            print(f"| {p} | {tot[p] / len(g):.3f} | {100 * tot[p] / max(T, 1e-9):.1f}% | "
                  + " | ".join(str(x) for x in e) + " |")


if __name__ == "__main__":
    main()
