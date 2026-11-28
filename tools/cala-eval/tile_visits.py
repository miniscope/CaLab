#!/usr/bin/env python
"""Share of Discover visits and visit time spent on tiles that never host a cell.

    python tools/cala-eval/tile_visits.py RUN [RUN ...] [--chunks 10] [--md] [--per-tile]

Each RUN is a `qc_eval --tile-visits` output directory (diagnostics build): `tiles.tsv` (tile geometry),
`tile_visits.tsv` (one row per visit made by `SlowLoop::step`), `final.tsv` and, on sims, `gt.tsv`.

A tile "hosts" a cell when a cell centre lies in its core. Host sets:
  - `matched`: detectable ground-truth units matched by a final cell (qc_eval's own matching, `final.tsv`
    `best_gt`), at the GT centre (sims only);
  - `det`: every detectable ground-truth unit (sims only);
  - `final`: the final cells' centres (sims and real data).
A tile is `empty` when its core hosts none, and `empty+ring` when its 8 grid neighbours (tiles that do not exist,
outside the FOV, count as empty) host none either. Only Discover visits (`discover` = 1: the slow loop could add
cells) are counted. Time is the visit's wall time; `work` is its work units (deterministic).

Prints one TSV row per run and host set; with --md, a Markdown table of means and 95 % t intervals over runs of the
same arm (the run directory name without its `_s<seed>` suffix), and the empty share per frame chunk.
With --per-tile, one row per run, host set and tile instead: core, Discover visits, visit ms, proposals,
proposals past the pre-test, adds, and whether the core and the ring host a cell. Standard library only.
"""

from __future__ import annotations

import csv
import math
import re
import sys
from pathlib import Path

T95 = {1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262}


def rows(path: Path) -> list[dict[str, str]]:
    with path.open() as f:
        return list(csv.DictReader(f, delimiter="\t"))


def tile_of(tiles: list[dict[str, int]], cy: float, cx: float) -> int | None:
    y, x = int(cy), int(cx)
    for t in tiles:
        if t["y0"] <= y < t["y0"] + t["h"] and t["x0"] <= x < t["x0"] + t["w"]:
            return t["tile"]
    return None


def neighbours(tiles: list[dict[str, int]], step: int) -> dict[int, list[int]]:
    """Per tile, the existing tiles among its 8 grid neighbours (cores sit on a `step` px grid)."""
    at = {(t["y0"], t["x0"]): t["tile"] for t in tiles}
    out = {}
    for t in tiles:
        nb = []
        for dy in (-step, 0, step):
            for dx in (-step, 0, step):
                if (dy or dx) and (t["y0"] + dy, t["x0"] + dx) in at:
                    nb.append(at[(t["y0"] + dy, t["x0"] + dx)])
        out[t["tile"]] = nb
    return out


def host_sets(run: Path, tiles: list[dict[str, int]]) -> dict[str, set[int]]:
    fin = rows(run / "final.tsv")
    sets = {"final": {tile_of(tiles, float(r["cy"]), float(r["cx"])) for r in fin}}
    if (run / "gt.tsv").exists():
        gt = rows(run / "gt.tsv")
        matched = {int(r["best_gt"]) for r in fin if r["matched"] == "1"}
        det = [r for r in gt if r["detectable"] == "1"]
        sets["det"] = {tile_of(tiles, float(r["cy"]), float(r["cx"])) for r in det}
        sets["matched"] = {tile_of(tiles, float(r["cy"]), float(r["cx"])) for r in det if int(r["gt"]) in matched}
    return {k: {t for t in v if t is not None} for k, v in sets.items()}


def per_tile(run: Path) -> list[dict[str, object]]:
    """One row per host set and tile of `run` (Discover visits only)."""
    tiles = [{k: int(v) for k, v in r.items()} for r in rows(run / "tiles.tsv")]
    nb = neighbours(tiles, max(t["h"] for t in tiles))
    acc = {t["tile"]: [0, 0.0, 0, 0, 0] for t in tiles}
    for r in rows(run / "tile_visits.tsv"):
        if r["discover"] == "1":
            a = acc[int(r["tile"])]
            a[0] += 1
            a[1] += float(r["ns"]) / 1e6
            a[2] += int(r["proposals"])
            a[3] += int(r["pretest_pass"])
            a[4] += int(r["adds"])
    out = []
    for name, hosts in host_sets(run, tiles).items():
        for t in tiles:
            a = acc[t["tile"]]
            out.append(
                {
                    "run": run.name,
                    "hosts": name,
                    "tile": t["tile"],
                    "y0": t["y0"],
                    "x0": t["x0"],
                    "visits": a[0],
                    "visit_ms": a[1],
                    "proposals": a[2],
                    "pretest_pass": a[3],
                    "adds": a[4],
                    "core_hosts": int(t["tile"] in hosts),
                    "ring_hosts": int(any(n in hosts for n in nb[t["tile"]])),
                }
            )
    return out


def analyse(run: Path, chunks: int) -> list[dict[str, object]]:
    tiles = [{k: int(v) for k, v in r.items()} for r in rows(run / "tiles.tsv")]
    step = max(t["h"] for t in tiles)
    nb = neighbours(tiles, step)
    visits = [r for r in rows(run / "tile_visits.tsv") if r["discover"] == "1"]
    frames = max(int(r["recording_frame"]) for r in visits) + 1
    out = []
    for name, hosts in host_sets(run, tiles).items():
        empty = {t["tile"] for t in tiles if t["tile"] not in hosts}
        ring = {t for t in empty if not any(n in hosts for n in nb[t])}
        tot = {"n": 0, "ns": 0.0, "work": 0.0, "prop": 0, "pass": 0, "adds": 0}
        sub = {c: dict.fromkeys(tot, 0.0) for c in ("empty", "ring")}
        by_chunk = [[0.0, 0.0, 0.0, 0.0] for _ in range(chunks)]  # ns all, ns empty, ns ring, visits ring
        for r in visits:
            ti = int(r["tile"])
            v = {
                "n": 1,
                "ns": float(r["ns"]),
                "work": float(r["work"]),
                "prop": int(r["proposals"]),
                "pass": int(r["pretest_pass"]),
                "adds": int(r["adds"]),
            }
            c = min(chunks - 1, int(r["recording_frame"]) * chunks // frames)
            by_chunk[c][0] += v["ns"]
            for k in tot:
                tot[k] += v[k]
            if ti in empty:
                by_chunk[c][1] += v["ns"]
                for k in tot:
                    sub["empty"][k] += v[k]
            if ti in ring:
                by_chunk[c][2] += v["ns"]
                by_chunk[c][3] += 1
                for k in tot:
                    sub["ring"][k] += v[k]

        def share(a: float, b: float) -> float:
            return a / b if b else float("nan")

        out.append(
            {
                "run": run.name,
                "hosts": name,
                "tiles": len(tiles),
                "empty_tiles": len(empty),
                "ring_tiles": len(ring),
                "visits": tot["n"],
                "visit_s": tot["ns"] / 1e9,
                "empty_visits": share(sub["empty"]["n"], tot["n"]),
                "empty_time": share(sub["empty"]["ns"], tot["ns"]),
                "empty_work": share(sub["empty"]["work"], tot["work"]),
                "ring_visits": share(sub["ring"]["n"], tot["n"]),
                "ring_time": share(sub["ring"]["ns"], tot["ns"]),
                "ring_work": share(sub["ring"]["work"], tot["work"]),
                "proposals": tot["prop"],
                "pretest_pass": tot["pass"],
                "adds": tot["adds"],
                "empty_proposals": sub["empty"]["prop"],
                "empty_pretest_pass": sub["empty"]["pass"],
                "empty_adds": sub["empty"]["adds"],
                "ring_adds": sub["ring"]["adds"],
                "chunk_empty_time": [share(b[1], b[0]) for b in by_chunk],
                "chunk_ring_time": [share(b[2], b[0]) for b in by_chunk],
            }
        )
    return out


def mean_ci(xs: list[float]) -> str:
    xs = [x for x in xs if not math.isnan(x)]
    if not xs:
        return "–"
    m = sum(xs) / len(xs)
    if len(xs) < 2:
        return f"{100 * m:.1f}"
    sd = math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))
    h = T95.get(len(xs) - 1, 1.96) * sd / math.sqrt(len(xs))
    return f"{100 * m:.1f} [{100 * (m - h):.1f}, {100 * (m + h):.1f}]"


def markdown(res: list[dict[str, object]], chunks: int) -> str:
    arm = lambda r: re.sub(r"_s\d+$", "", str(r["run"]))  # noqa: E731
    groups: dict[tuple[str, str], list[dict[str, object]]] = {}
    for r in res:
        groups.setdefault((arm(r), str(r["hosts"])), []).append(r)
    out = [
        "| arm | hosts | runs | tiles | empty tiles | empty+ring tiles | visits % empty | time % empty | "
        "visits % empty+ring | time % empty+ring | work % empty+ring | adds on empty |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for (a, h), g in groups.items():
        col = lambda k: [float(r[k]) for r in g]  # noqa: E731
        avg = lambda k: sum(col(k)) / len(g)  # noqa: E731
        out.append(
            f"| {a} | {h} | {len(g)} | {avg('tiles'):.0f} | {avg('empty_tiles'):.1f} | {avg('ring_tiles'):.1f} | "
            f"{mean_ci(col('empty_visits'))} | {mean_ci(col('empty_time'))} | {mean_ci(col('ring_visits'))} | "
            f"{mean_ci(col('ring_time'))} | {mean_ci(col('ring_work'))} | {sum(col('empty_adds')):.0f} |"
        )
    out += ["", "Share of Discover visit time on empty tiles (empty / empty+ring), % per tenth of the recording:", ""]
    out.append("| arm | hosts | " + " | ".join(f"{10 * i}–{10 * i + 10}" for i in range(chunks)) + " |")
    out.append("| --- | --- | " + " | ".join("---:" for _ in range(chunks)) + " |")
    for (a, h), g in groups.items():
        cells = []
        for i in range(chunks):
            e = [r["chunk_empty_time"][i] for r in g]  # type: ignore[index]
            q = [r["chunk_ring_time"][i] for r in g]  # type: ignore[index]
            mean = lambda xs: sum(x for x in xs if not math.isnan(x)) / max(1, sum(not math.isnan(x) for x in xs))  # noqa: E731
            cells.append(f"{100 * mean(e):.0f} / {100 * mean(q):.0f}")
        out.append(f"| {a} | {h} | " + " | ".join(cells) + " |")
    return "\n".join(out)


def main(argv: list[str]) -> int:
    chunks = 10
    if "--chunks" in argv:
        chunks = int(argv[argv.index("--chunks") + 1])
    runs = [Path(a) for a in argv[1:] if Path(a).is_dir()]
    if "--per-tile" in argv:
        res = [r for run in runs for r in per_tile(run)]
    else:
        res = [r for run in runs for r in analyse(run, chunks)]
    if "--md" in argv:
        print(markdown(res, chunks))
        return 0
    keys = [k for k in res[0] if not k.startswith("chunk_")]
    print("\t".join(keys))
    for r in res:
        print("\t".join(f"{r[k]:.4f}" if isinstance(r[k], float) else str(r[k]) for k in keys))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
