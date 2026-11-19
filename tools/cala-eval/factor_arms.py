"""Run the arms of the factor pipeline on one recording and write the closeness report
with gate A1.

    python factor_arms.py --rec AVI_DIR --out DIR [--frames N] [--no-motion]
        [--refine 5] [--budget U] [--jobs 3] [--arms raw,plain,...] [--truth truth.npz]
        [--qc-eval PATH] [--seed-from F] [--extra FLAGS] [--dry-run]

Arms (each a `qc_eval real` run in `DIR/<arm>`; pass 1 is the same in all):

- `raw`: Discover, `--refine` refine replays and the Extract pass on the raw replay.
- `null_lo`, `null_hi`: `raw` with half and twice the slow-loop budget in the
  replays (`--budget`, default `DEFAULT_BUDGET`). Their distance to `raw` is the null spread.
- `plain`, `overlap8`, `overlap16`, `offset`: the replays and the Extract pass
  solve frames rebuilt from the factors of pass 1, under that tiling.
- `plain_recal`: as `plain`, but the factors are those of the first replay
  (the final flat field from frame 0).
- `recal_rho0`, `recal_z2`, `recal_k80`, `recal_full`, `recal_iter2` and the rank
  sweep `recal_r10` to `recal_r80`: `plain_recal` with another rank cut or SVD
  setting of the compressor (`REMEDIES`); only run when named in `--arms`.
- `chosen`: the combination chosen after phase 0: the offset grids on recalibrated factors
  (the compressor's default of two power iterations).
- `c_chosen`: as `chosen`, with the Extract pass solved by the factor engine (arm C).
- `x_raw` and `x_<tiling>`: Discover and the Extract pass only, so the two
  Extracts solve with one and the same library.
- Phase 4a, not in the default set:
  - `live`: Discover's own factors (pass 1, offset grids) feed the refine replays
    (rebuilt frames) and the Extract pass (factor engine); no factor comes from a replay.
  - `seed` (needs `--seed-from F`): Discover alone on the later stretch of the recording
    that starts at frame F; `raw_seed` and `live_seed` are `raw` and `live` with the flat
    field it ended with in force from frame 0 (`--ff-seed-run`). `seed` runs first. When
    it makes no flat field map the seeded arms are not run, and the report says so.
  - `lb_raw`: main's default look-back arm (`LBD-x2`) with an Extract pass; `lb_fac`: the
    same with the look-back reading Discover's factors; `lb_live`: `lb_fac` with Extract on
    the factor engine. Their Discovers differ, so the report pairs cells by footprint.

An arm is run again unless its `run.json` holds return code 0 and the same
command as now; such a finished arm is reused, also by the report. Raw data is
only read. Needs numpy (for the report).
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
import factor_closeness

TILINGS: dict[str, str] = {
    "plain": "plain",
    "overlap8": "overlap:8",
    "overlap16": "overlap:16",
    "offset": "offset",
}
# Remedy arms: `plain_recal` with another rank cut of the compressor. Not in the default set.
REMEDIES: dict[str, list[str]] = {
    # cut at the whiteness rule alone, 4 / sqrt(window) = 0.16 instead of 0.2
    "recal_rho0": ["--factors-rho-min", "0"],
    # cut at 2 / sqrt(window) = 0.08
    "recal_z2": ["--factors-rho-min", "0", "--factors-z", "2"],
    # starting rank 80 instead of 40
    "recal_k80": ["--factors-k0", "80"],
    # no cut: every component up to the largest rank (the ceiling of what the cut can gain)
    "recal_full": ["--factors-rho-min", "-1", "--factors-z", "-100"],
    # two power iterations of the randomized SVD instead of one, default cut
    "recal_iter2": ["--factors-n-iter", "2"],
}
# Rank sweep: a fixed rank per tile and no cut (thin edge tiles keep fewer).
for _rank in (10, 20, 40, 80):
    REMEDIES[f"recal_r{_rank}"] = [
        "--factors-rho-min",
        "-1",
        "--factors-z",
        "-100",
        "--factors-k0",
        str(_rank),
        "--factors-max-rank",
        str(_rank),
    ]
DEFAULT_QC_EVAL = (
    Path(__file__).resolve().parents[2] / "crates/cala/target/release/examples/qc_eval"
)
# qc_eval's default `--budget` (slow-loop work units per frame)
DEFAULT_BUDGET = 30_000_000
# Phase 4a: what a live run may claim. main's default look-back arm `LBD-x2`
# (tools/cala-eval/results/2026-11-19-concurrent-refine.md), with the Extract pass added so
# that the arms have traces to compare. The joint flags belong to the arm, not to `--extra`.
LOOKBACK: list[str] = [
    "--passes",
    "1",
    "--joint-update",
    "all",
    "--joint-sign",
    "all",
    "--lookback",
    "2",
    "--lookback-drain",
    "4800",
    "--extract-pass",
]
# The arms of phase 4a; not in the default set.
LIVE_ARMS: tuple[str, ...] = (
    "live",
    "seed",
    "raw_seed",
    "live_seed",
    "lb_raw",
    "lb_fac",
    "lb_live",
)
# Arms that read the flat field the run `seed` ended with.
SEEDED: tuple[str, ...] = ("raw_seed", "live_seed")


def arms(
    refine: int,
    budget: int = DEFAULT_BUDGET,
    seed: tuple[int, Path] | None = None,
) -> dict[str, list[str]]:
    """Arm name to its `qc_eval` flags (without recording, output and factor folder).

    `seed`: (first frame of the later stretch the run `seed` reads, that run's folder); adds
    the arms `seed`, `raw_seed` and `live_seed`."""
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
    out["chosen"] = out["offset"] + ["--factors-pass", "2"]
    out["c_chosen"] = out["chosen"] + ["--extract-engine", "factors"]
    for name, cut in REMEDIES.items():
        out[name] = out["plain_recal"] + cut
    out["live"] = out["offset"] + ["--extract-engine", "factors"]
    out["lb_raw"] = list(LOOKBACK)
    out["lb_fac"] = LOOKBACK + ["--lookback-source", "factors", "--tiling", "offset"]
    out["lb_live"] = out["lb_fac"] + [
        "--replay-source",
        "factors",
        "--extract-engine",
        "factors",
    ]
    if seed is not None:
        first, run = seed
        out["seed"] = ["--passes", "1", "--from", str(first)]
        out["raw_seed"] = full + ["--ff-seed-run", str(run)]
        out["live_seed"] = out["live"] + ["--ff-seed-run", str(run)]
    return out


def default_arms(table: dict[str, list[str]]) -> list[str]:
    """The arms run without `--arms`: all but the remedy arms and the arms of phase 4a."""
    return [n for n in table if n not in REMEDIES and n not in LIVE_ARMS]


def line_step(flags: list[str]) -> int:
    """Distance between tile lines for an arm, px, from its flags or command: 32 where the
    tiles are the two offset grids (`--tiling offset`), else 64."""
    if "--tiling" in flags:
        i = flags.index("--tiling")
        if flags[i + 1 : i + 2] == ["offset"]:
            return 32
    return 64


def command(
    qc_eval: Path,
    rec: Path,
    run: Path,
    flags: list[str],
    motion: bool,
    frames: int | None,
    budget: int | None = None,
    extra: list[str] | None = None,
) -> list[str]:
    """The `qc_eval` command of an arm; `extra` flags end it (the same for every arm of a run)."""
    cmd = [str(qc_eval), "real", str(rec), str(run), *flags]
    if "--replay-source" in flags or "--lookback-source" in flags:
        cmd += ["--factors-out", str(run / "factors")]
    if motion:
        cmd.append("--motion")
    if frames is not None:
        cmd += ["--frames", str(frames)]
    if budget is not None:
        cmd += ["--budget", str(budget)]
    # `qc_eval` takes the first occurrence of a flag, so a repeat would be ignored silently.
    for flag in (t for t in extra or [] if t.startswith("--")):
        if flag in cmd:
            raise ValueError(f"--extra {flag} is already set by the arm or the command")
    return cmd + (extra or [])


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


def extract_row(run: Path) -> tuple[str, float, float, float] | None:
    """(arm, seconds preparing, seconds solving, wall seconds) of the Extract pass."""
    path = run / "stage_times.tsv"
    if not path.exists():
        return None
    for r in factor_closeness.read_tsv(path):
        if r["stage"] == "extract":
            return (
                run.name,
                float(r["pre_s"]),
                float(r["solve_s"]),
                float(r["wall_s"]),
            )
    return None


def flat_maps(run: Path) -> list[dict[str, str]] | None:
    """The flat field maps the run made (rows of its `flat_field_updates.tsv` with outcome
    `updated`), or None when the run wrote no such file."""
    path = run / "flat_field_updates.tsv"
    if not path.exists():
        return None
    return [r for r in factor_closeness.read_tsv(path) if r["outcome"] == "updated"]


def seed_has_map(run: Path) -> bool:
    """True when the run made a flat field map (`qc_eval --ff-seed-run` refuses one that did not)."""
    return bool(flat_maps(run))


def flat_row(run: Path) -> tuple[str, int, str, bool] | None:
    """(arm, flat field maps made, frame of the first map or "none", seeded) from the arm's
    `flat_field_updates.tsv` and command."""
    made = flat_maps(run)
    if made is None:
        return None
    seeded = "--ff-seed-run" in json.loads((run / "run.json").read_text())["cmd"]
    return (run.name, len(made), made[0]["frame"] if made else "none", seeded)


def seed_line(run: Path) -> str | None:
    """What the run `seed` left as the seed: its last map's frame, frames used, gain sd and
    dark level; or that it made none."""
    made = flat_maps(run)
    if made is None:
        return None
    if not made:
        return f"The run `{run.name}` made no flat field map: the seeded arms have no seed."
    m = made[-1]
    return (
        f"Seed: the last flat field map of the run `{run.name}` (made at its frame "
        f"{m['frame']}, {m['frames_used']} frames used, gain sd {m['gain_sd']}, "
        f"dark {m['dark']})."
    )


def lookback_row(run: Path) -> tuple[str, int, int, int, float] | None:
    """(arm, look-back frames, cell-frames, cells still in need, look-back wall s) from the
    first row of `lookback.tsv`."""
    path = run / "lookback.tsv"
    if not path.exists():
        return None
    rows = factor_closeness.read_tsv(path)
    if not rows:
        return None
    r = rows[0]
    return (
        run.name,
        int(r["frames"]),
        int(r["cell_frames"]),
        int(r["in_need"]),
        float(r["wall_s"]),
    )


def run_order(todo: list[str]) -> tuple[list[str], list[str]]:
    """The arms to run first, one at a time (the run `seed`, whose flat field the seeded
    arms read), and the rest."""
    return [n for n in todo if n == "seed"], [n for n in todo if n != "seed"]


def hold_seeded(todo: list[str]) -> tuple[list[str], list[str]]:
    """Split off the seeded arms, for when the seed run gave no flat field to read."""
    return [n for n in todo if n not in SEEDED], [n for n in todo if n in SEEDED]


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


def arm_cmd(out_dir: Path, name: str) -> list[str]:
    """The command stored in the arm's `run.json`."""
    return json.loads((out_dir / name / "run.json").read_text())["cmd"]


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
        if (
            n in TILINGS
            or n in ("plain_recal", "chosen", "c_chosen", "live")
            or n in REMEDIES
        ):
            if "raw" in have:
                text.append(
                    factor_closeness.report(
                        out_dir / "raw",
                        out_dir / n,
                        nulls,
                        tile=line_step(arm_cmd(out_dir, n)),
                        truth_path=truth,
                    )
                )
        elif n == "live_seed" and "raw_seed" in have:
            text.append(
                factor_closeness.report(
                    out_dir / "raw_seed",
                    out_dir / n,
                    [],
                    tile=line_step(arm_cmd(out_dir, n)),
                    truth_path=truth,
                )
            )
        elif n in ("lb_fac", "lb_live") and "lb_raw" in have:
            # The look-back arms have their own Discovers, so cells are paired by footprint.
            text.append(
                factor_closeness.report(
                    out_dir / "lb_raw",
                    out_dir / n,
                    [],
                    tile=line_step(arm_cmd(out_dir, n)),
                    truth_path=truth,
                    match=True,
                )
            )
        elif n.startswith("x_") and n != "x_raw" and "x_raw" in have:
            text.append(
                factor_closeness.report(
                    out_dir / "x_raw",
                    out_dir / n,
                    [],
                    tile=line_step(arm_cmd(out_dir, n)),
                    truth_path=truth,
                )
            )
    if "chosen" in have and "c_chosen" in have:
        text.append(
            factor_closeness.engine_report(out_dir / "chosen", out_dir / "c_chosen")
        )
    rows = [r for r in (extract_row(out_dir / n) for n in have) if r]
    if rows:
        text += [
            "| arm | Extract: preparing s | solving s | wall s |",
            "| --- | --- | --- | --- |",
        ]
        text += [f"| {a} | {p:.2f} | {s:.2f} | {w:.2f} |" for a, p, s, w in rows]
        text += [
            "",
            "Preparing: projectors built (factor engine), or frames preprocessed (frame engine).",
            "",
        ]
    if "seed" in have:
        line = seed_line(out_dir / "seed")
        if line:
            text += [line, ""]
        held = [n for n in names if n in SEEDED and n not in have]
        if held and not seed_has_map(out_dir / "seed"):
            text += [f"{', '.join(held)}: not run (the seed run made no map).", ""]
    flats = [r for r in (flat_row(out_dir / n) for n in have) if r]
    if flats:
        text += [
            "| arm | seeded | flat field maps made | first map at frame |",
            "| --- | --- | --- | --- |",
        ]
        text += [
            f"| {a} | {'yes' if s else 'no'} | {k} | {f} |" for a, k, f, s in flats
        ]
        text.append("")
    lbs = [r for r in (lookback_row(out_dir / n) for n in have) if r]
    if lbs:
        text += [
            "| arm | look-back frames | cell-frames | cells still in need | look-back wall s |",
            "| --- | --- | --- | --- | --- |",
        ]
        text += [f"| {a} | {f} | {c} | {k} | {w:.1f} |" for a, f, c, k, w in lbs]
        text.append("")
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
    ap.add_argument(
        "--extra",
        default="",
        help="qc_eval flags added to every arm, in one quoted string "
        "(for example '--joint-iters 3'); must not repeat a flag an arm sets itself "
        "(the look-back arms set the joint flags)",
    )
    ap.add_argument(
        "--seed-from",
        type=int,
        help="phase 4a: first frame of the later stretch of the recording that the arm "
        "`seed` runs on; its final flat field seeds the arms raw_seed and live_seed",
    )
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    assert 1 <= a.jobs <= 4, "--jobs must be 1 to 4"
    assert a.refine >= 2, "--refine must be at least 2 (plain_recal compresses pass 2)"
    if a.budget < 2:
        ap.error("--budget must be at least 2 (the null arms use half of it)")
    seed = (a.seed_from, a.out / "seed") if a.seed_from is not None else None
    table = arms(a.refine, a.budget, seed)
    names = a.arms.split(",") if a.arms else default_arms(table)
    unknown = [n for n in names if n not in table]
    assert not unknown, (
        f"unknown arms: {unknown} (seed, raw_seed and live_seed need --seed-from)"
    )
    assert "seed" in names or not set(SEEDED) & set(names), (
        "raw_seed and live_seed need the arm seed in --arms"
    )
    budget = None if a.budget == DEFAULT_BUDGET else a.budget
    cmds = {
        n: command(
            a.qc_eval,
            a.rec,
            a.out / n,
            table[n],
            not a.no_motion,
            a.frames,
            budget,
            shlex.split(a.extra),
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
    first, rest = run_order(todo)
    codes = [run_arm(n, cmds[n], a.out / n) for n in first]
    if "seed" in names:
        finished = done(a.out / "seed", cmds["seed"])
        if not (finished and seed_has_map(a.out / "seed")):
            rest, held = hold_seeded(rest)
            if held:
                why = "made no flat field map" if finished else "did not finish"
                print(f"seed {why}: not run: {', '.join(held)}", flush=True)
                codes.append(0 if finished else 1)
    with ThreadPoolExecutor(max_workers=a.jobs) as pool:
        codes += list(pool.map(lambda n: run_arm(n, cmds[n], a.out / n), rest))
    (a.out / "report.md").write_text(report(a.out, names, a.truth, cmds))
    print(f"report: {a.out / 'report.md'}")
    if any(codes):
        sys.exit(1)


if __name__ == "__main__":
    main()
