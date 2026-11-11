#!/usr/bin/env python
"""Generate (or reuse) the minisim recordings of the evaluation arms.

Run with the pinned minisim venv's python (it imports minisim to rebuild the
exact spec a recording would have):

    $MS tools/cala-eval/gen_sims.py --sims <dir> --arms static,motion --seeds 5-9 \
        [--reuse <dir-with-old-sims> ...] [--parallel 2]

A recording lands in `<sims>/<arm>_s<seed>`. Before generating, every directory
under the `--reuse` roots is compared with the spec this arm and seed would
produce (`spec.json`, byte for byte); an identical one is symlinked instead.
Generation runs at most `--parallel` (default and cap 2) processes, each under
`/usr/bin/time -l`; the first one runs alone, and if it needs more than 3 GB the
rest run serially. A generation above 6 GB stops the script (decision D2).
Check `ps` for other heavy jobs first: no more than 2 heavy processes in total.
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
import arms as A  # noqa: E402

RSS_PARALLEL_GB = 3.0
RSS_STOP_GB = 6.0


def expected_spec_json(arm: str, seed: int) -> str:
    """The `spec.json` text `make_trace_sim.py` writes for this arm and seed."""
    sys.path.insert(0, str(A.SPEC_DIR))
    from calibrated import calibrated_spec
    from minisim import Spec

    cfg = A.ARMS[arm]
    base = Spec.model_validate_json(A.spec_path(arm).read_text())
    spec = calibrated_spec(
        A.DUR_S,
        seed=seed,
        n_px=None if A.NPX == 600 else A.NPX,
        motion=cfg["motion"],
        base=base,
    )
    if cfg["halo"] > 0:
        acq = spec.acquisition
        tissue = acq.tissue.model_copy(update={"scatter_halo_fraction": cfg["halo"]})
        spec = spec.model_copy(update={"acquisition": acq.model_copy(update={"tissue": tissue})})
    return spec.model_dump_json(indent=1)


def complete(d: Path) -> bool:
    return (d / "oracle.bin").exists() and (d / "daq" / "Miniscope" / "timeStamps.csv").exists()


def find_reusable(expected: str, roots: list[Path]) -> Path | None:
    for root in roots:
        for d in sorted(root.iterdir()) if root.is_dir() else []:
            sp = d / "spec.json"
            if sp.is_file() and complete(d) and sp.read_text() == expected:
                return d.resolve()
    return None


def command(arm: str, seed: int, out: Path, python: str) -> list[str]:
    cfg = A.ARMS[arm]
    cmd = [
        "/usr/bin/time", "-l", python, str(A.SPEC_DIR / "make_trace_sim.py"), str(out),
        "--dur", str(int(A.DUR_S)), "--npx", str(A.NPX), "--seed", str(seed),
        "--spec", str(A.spec_path(arm)),
    ]  # fmt: skip
    if cfg["motion"]:
        cmd.append("--motion")
    if cfg["halo"] > 0:
        cmd += ["--f", str(cfg["halo"])]
    return cmd


def generate(arm: str, seed: int, out: Path, python: str) -> dict:
    t0 = time.time()
    p = subprocess.run(command(arm, seed, out, python), capture_output=True, text=True)
    wall = time.time() - t0
    m = re.search(r"(\d+)\s+maximum resident set size", p.stderr)
    rss_gb = int(m.group(1)) / 1e9 if m else float("nan")
    info = {
        "arm": arm,
        "seed": seed,
        "rc": p.returncode,
        "wall_s": round(wall, 1),
        "rss_gb": round(rss_gb, 2),
    }
    out.mkdir(parents=True, exist_ok=True)
    (out.parent / f"{out.name}.log").write_text(p.stdout + p.stderr)
    if p.returncode == 0:
        (out / "gen.json").write_text(json.dumps(info))
    return info


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sims", required=True, type=Path)
    ap.add_argument("--arms", default="static,motion")
    ap.add_argument("--seeds", default="5-9")
    ap.add_argument("--reuse", action="append", default=[], type=Path)
    ap.add_argument("--parallel", type=int, default=2)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if a.parallel > 2:
        sys.exit("sim generation is heavy: --parallel is capped at 2")
    a.sims.mkdir(parents=True, exist_ok=True)

    todo = []
    for arm in A.parse_list(a.arms):
        if not A.available(arm):
            print(f"[skip] arm {arm}: spec not committed yet")
            continue
        for seed in A.parse_seeds(a.seeds):
            out = a.sims / A.run_name(arm, seed)
            if complete(out):
                print(f"[have] {out.name}")
                continue
            old = find_reusable(expected_spec_json(arm, seed), a.reuse)
            if old is not None:
                if not a.dry_run:
                    if out.is_symlink():
                        out.unlink()
                    out.symlink_to(old)
                print(f"[reuse] {out.name} -> {old}")
                continue
            todo.append((arm, seed, out))
    if a.dry_run:
        for arm, seed, out in todo:
            print("[generate]", " ".join(command(arm, seed, out, sys.executable)))
        return 0

    infos, parallel = [], a.parallel
    py = sys.executable
    if todo:
        first = generate(*todo.pop(0), py)
        infos.append(first)
        print("[gen]", first, flush=True)
        if first["rc"] != 0 or first["rss_gb"] > RSS_STOP_GB:
            print("stopping: generation failed or exceeded 6 GB (decision D2)")
            return 1
        if first["rss_gb"] > RSS_PARALLEL_GB:
            parallel = 1
            print(f"first generation used {first['rss_gb']} GB: running the rest serially")
    with ThreadPoolExecutor(parallel) as ex:
        for info in ex.map(lambda t: generate(*t, py), todo):
            infos.append(info)
            print("[gen]", info, flush=True)
    bad = [i for i in infos if i["rc"] != 0 or i["rss_gb"] > RSS_STOP_GB]
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
