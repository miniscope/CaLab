"""Run the phase-0 arms of the factor pipeline on one recording and write the report.

    python factor_arms.py --rec AVI_DIR --out DIR [--frames N] [--no-motion]
        [--refine 5] [--budget U] [--jobs 3] [--arms raw,plain,...] [--truth truth.npz]
        [--qc-eval PATH] [--dry-run]

Arms (each a `qc_eval real` run in `DIR/<arm>`; pass 1 is the same in all):

- `raw`: Discover, `--refine` refine replays and the Extract pass on the raw replay.
- `null_lo`, `null_hi`: `raw` with half and twice the slow-loop budget in the
  replays (`--budget`, default `DEFAULT_BUDGET`). Their distance to `raw` is the null spread.
  A finished arm is skipped only when its stored command equals the current one.
- `plain`, `overlap8`, `overlap16`, `offset`: the replays and the Extract pass
  solve frames rebuilt from the factors of pass 1, under that tiling.
- `plain_recal`: as `plain`, but the factors are those of the first replay
  (the final flat field from frame 0).
- `x_raw` and `x_<tiling>`: Discover and the Extract pass only, so the two
  Extracts solve with one and the same library.

A finished arm (`run.json` with return code 0) is skipped. Raw data is only
read. Needs numpy (for the report).
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import factor_closeness

TILINGS: dict[str, str] = {
    "plain": "plain",
    "overlap8": "overlap:8",
    "overlap16": "overlap:16",
    "offset": "offset",
}
DEFAULT_QC_EVAL = (
    Path(__file__).resolve().parents[2] / "crates/cala/target/release/examples/qc_eval"
)
# qc_eval's default `--budget` (slow-loop work units per frame)
DEFAULT_BUDGET = 30_000_000


def arms(refine: int, budget: int = DEFAULT_BUDGET) -> dict[str, list[str]]:
    """Arm name to its `qc_eval` flags (without recording, output and factor folder)."""
    full = ["--passes", str(refine + 1), "--later-passes", "refine", "--extract-pass"]
    extract = ["--passes", "1", "--extract-pass"]
    out = {
        "raw": full,
        "null_lo": full + ["--later-budget", str(budget // 2)],
        "null_hi": full + ["--later-budget", str(budget * 2)],
        "x_raw": extract,
    }
    for name, tiling in TILINGS.items():
        factors = ["--replay-source", "factors", "--tiling", tiling]
        out[name] = full + factors
        out[f"x_{name}"] = extract + factors
    out["plain_recal"] = out["plain"] + ["--factors-pass", "2"]
    return out


def command(
    qc_eval: Path,
    rec: Path,
    run: Path,
    flags: list[str],
    motion: bool,
    frames: int | None,
    budget: int | None = None,
) -> list[str]:
    cmd = [str(qc_eval), "real", str(rec), str(run), *flags]
    if "--replay-source" in flags:
        cmd += ["--factors-out", str(run / "factors")]
    if motion:
        cmd.append("--motion")
    if frames is not None:
        cmd += ["--frames", str(frames)]
    if budget is not None:
        cmd += ["--budget", str(budget)]
    return cmd


def done(run: Path, cmd: list[str] | None = None) -> bool:
    """True when the arm's `run.json` has return code 0 (and, given `cmd`, the same command)."""
    path = run / "run.json"
    if not path.exists():
        return False
    try:
        record = json.loads(path.read_text())
    except ValueError:
        return False
    if record.get("returncode") != 0:
        return False
    return cmd is None or record.get("cmd") == cmd


def max_rss_mb(log: str) -> float | None:
    """Peak memory from the `/usr/bin/time -l` lines of a run log (macOS reports bytes)."""
    m = re.search(r"(\d+)\s+maximum resident set size", log)
    return int(m.group(1)) / 1e6 if m else None


def run_arm(name: str, cmd: list[str], run: Path) -> int:
    """Run one arm; its output goes to `<run>/run.log`, the result to `<run>/run.json`."""
    run.mkdir(parents=True, exist_ok=True)
    # An interrupted rerun must not leave the old record to be taken as finished.
    (run / "run.json").unlink(missing_ok=True)
    timed = ["/usr/bin/time", "-l", *cmd] if sys.platform == "darwin" else cmd
    t0 = time.time()
    with open(run / "run.log", "w") as log:
        rc = subprocess.run(
            timed, stdout=log, stderr=subprocess.STDOUT, check=False
        ).returncode
    wall = time.time() - t0
    rss = max_rss_mb((run / "run.log").read_text(errors="replace"))
    record = {
        "arm": name,
        "cmd": cmd,
        "returncode": rc,
        "wall_s": wall,
        "max_rss_mb": rss,
    }
    (run / "run.json").write_text(json.dumps(record, indent=1))
    print(f"{name}: return code {rc}, {wall:.0f} s", flush=True)
    return rc


def cost_row(run: Path) -> tuple[str, float, float, float] | None:
    """(arm, mean rank, MB per 1000 frames, compression ms per frame) from `factors/factors.tsv`."""
    path = run / "factors" / "factors.tsv"
    if not path.exists():
        return None
    rows = factor_closeness.read_tsv(path)
    frames = sum(int(r["frames"]) for r in rows)
    if frames == 0:
        return None
    rank = sum(float(r["mean_rank"]) * int(r["frames"]) for r in rows) / frames
    mb = sum(int(r["bytes"]) for r in rows) / 1e6 * 1000 / frames
    ms = sum(float(r["compress_s"]) for r in rows) * 1000 / frames
    return (run.name, rank, mb, ms)


def stage_table(run: Path) -> list[str]:
    path = run / "stage_times.tsv"
    if not path.exists():
        return []
    out = [
        f"Seconds per stage, `{run.name}`:",
        "",
        "| stage | read | preprocess | compress | solve | slow loop | wall |",
    ]
    out.append("| --- | --- | --- | --- | --- | --- | --- |")
    for r in factor_closeness.read_tsv(path):
        cells = [
            r["stage"],
            r["read_s"],
            r["pre_s"],
            r["compress_s"],
            r["solve_s"],
            r["slow_s"],
            r["wall_s"],
        ]
        out.append("| " + " | ".join(cells) + " |")
    return out + [""]


def stored_budget(cmd: list[str]) -> int:
    """The slow-loop budget of a stored command: the value after `--budget`, else the default."""
    return int(cmd[cmd.index("--budget") + 1]) if "--budget" in cmd else DEFAULT_BUDGET


def report(
    out_dir: Path,
    names: list[str],
    truth: Path | None,
    cmds: dict[str, list[str]] | None = None,
) -> str:
    """The recording's Markdown report from the finished arms."""
    have = [n for n in names if done(out_dir / n, cmds[n] if cmds else None)]
    text = [f"## {out_dir.name}", ""]
    if have:
        first = json.loads((out_dir / have[0] / "run.json").read_text())
        text += [
            f"Slow-loop budget: {stored_budget(first['cmd'])} work units per frame.",
            "",
        ]
    text += [
        "| arm | wall s | peak memory MB |",
        "| --- | --- | --- |",
    ]
    for n in have:
        rec = json.loads((out_dir / n / "run.json").read_text())
        rss = rec.get("max_rss_mb")
        text.append(
            f"| {n} | {rec['wall_s']:.0f} | {'n/a' if rss is None else f'{rss:.0f}'} |"
        )
    text.append("")
    for n in ("raw", "plain"):
        if n in have:
            text += stage_table(out_dir / n)
    costs = [c for c in (cost_row(out_dir / n) for n in have) if c]
    if costs:
        text += [
            "| arm | mean rank | MB per 1000 frames | compression ms per frame |",
            "| --- | --- | --- | --- |",
        ]
        text += [f"| {a} | {r:.1f} | {mb:.1f} | {ms:.2f} |" for a, r, mb, ms in costs]
        text.append("")
    nulls = [out_dir / n for n in ("null_lo", "null_hi") if n in have]
    for n in have:
        if n in TILINGS or n == "plain_recal":
            if "raw" in have:
                text.append(
                    factor_closeness.report(
                        out_dir / "raw", out_dir / n, nulls, truth_path=truth
                    )
                )
        elif n.startswith("x_") and n != "x_raw" and "x_raw" in have:
            text.append(
                factor_closeness.report(
                    out_dir / "x_raw", out_dir / n, [], truth_path=truth
                )
            )
    return "\n".join(text)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument(
        "--rec", type=Path, required=True, help="folder of 0.avi, 1.avi, ..."
    )
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--frames", type=int)
    ap.add_argument("--no-motion", action="store_true")
    ap.add_argument(
        "--refine", type=int, default=5, help="refine replays after Discover"
    )
    ap.add_argument(
        "--jobs", type=int, default=3, help="runs at once (at most 4 machine-wide)"
    )
    ap.add_argument(
        "--budget",
        type=int,
        default=DEFAULT_BUDGET,
        help="slow-loop work units per frame (qc_eval --budget); the null arms use half and twice it",
    )
    ap.add_argument("--arms", help="comma-separated subset")
    ap.add_argument("--truth", type=Path)
    ap.add_argument("--qc-eval", type=Path, default=DEFAULT_QC_EVAL)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    assert 1 <= a.jobs <= 4, "--jobs must be 1 to 4"
    assert a.refine >= 2, "--refine must be at least 2 (plain_recal compresses pass 2)"
    if a.budget < 2:
        ap.error("--budget must be at least 2 (the null arms use half of it)")
    table = arms(a.refine, a.budget)
    names = a.arms.split(",") if a.arms else list(table)
    unknown = [n for n in names if n not in table]
    assert not unknown, f"unknown arms: {unknown}"
    budget = None if a.budget == DEFAULT_BUDGET else a.budget
    cmds = {
        n: command(
            a.qc_eval, a.rec, a.out / n, table[n], not a.no_motion, a.frames, budget
        )
        for n in names
    }
    if a.dry_run:
        for c in cmds.values():
            print(" ".join(c))
        return
    assert a.qc_eval.exists(), (
        f"{a.qc_eval}: build it with `cargo build --release --example qc_eval`"
    )
    todo = [n for n in names if not done(a.out / n, cmds[n])]
    with ThreadPoolExecutor(max_workers=a.jobs) as pool:
        codes = list(pool.map(lambda n: run_arm(n, cmds[n], a.out / n), todo))
    (a.out / "report.md").write_text(report(a.out, names, a.truth, cmds))
    print(f"report: {a.out / 'report.md'}")
    if any(codes):
        sys.exit(1)


if __name__ == "__main__":
    main()
