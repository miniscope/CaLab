"""Generate and evaluate compact, reproducible Minisim discovery challenges.

Example:
  python run_small_benchmark.py --python /path/to/minisim/python --out /path/to/runs --generate --evaluate
The selected Python must import Minisim, NumPy, SciPy and zarr. This wrapper
uses the existing calibration generator and leaves all algorithm defaults intact.
"""
import argparse
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

CASES = {
    "v2_192_240_s0": (192, 0, []),
    "v2_192_240_s1": (192, 1, []),
    "v2_192_240_s0_motion": (192, 0, ["--motion"]),
    "v2_192_240_s1_motion": (192, 1, ["--motion"]),
    "v2_256_240_s7_sparse": (256, 7, ["--p-q2a", "0.00025", "--q-rate", "0"]),
    "v2_192_240_s0_halo45": (192, 0, ["--f", "0.45"]),
    "v2_192_240_s1_halo45": (192, 1, ["--f", "0.45"]),
}


def sha256(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def run(cmd, logfile):
    start = time.perf_counter()
    with logfile.open("w") as f:
        result = subprocess.run(cmd, stdout=f, stderr=subprocess.STDOUT)
    record = dict(command=cmd, wall_s=time.perf_counter()-start, exit_code=result.returncode)
    logfile.with_suffix(logfile.suffix + ".json").write_text(json.dumps(record, indent=2) + "\n")
    if result.returncode:
        raise RuntimeError(f"Failed: {logfile}")
    return record


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--python", default=sys.executable, help="Python with Minisim and calibration dependencies")
    ap.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
    ap.add_argument("--binary", type=Path)
    ap.add_argument("--out", type=Path, required=True, help="Benchmark data/output root; keep outside source control")
    ap.add_argument("--case", choices=CASES, action="append", help="Repeat to select cases; default all")
    ap.add_argument("--duration", type=float, default=240)
    ap.add_argument("--checkpoints", type=int, default=20)
    ap.add_argument("--generate", action="store_true")
    ap.add_argument("--evaluate", action="store_true")
    a = ap.parse_args()
    if not (a.generate or a.evaluate):
        ap.error("select --generate and/or --evaluate")
    a.repo, a.out = a.repo.resolve(), a.out.resolve()
    binary = (a.binary or a.repo / "crates/cala/target/release/examples/discover_eval").resolve()
    calibration = a.repo / "tools/minisim-calibration"
    spec = calibration / "ca1_workshop_v2.spec.json"
    (a.out / "simulations").mkdir(parents=True, exist_ok=True)
    (a.out / "small_runs").mkdir(parents=True, exist_ok=True)
    env_code = "import json,sys,minisim,numpy,scipy,zarr,subprocess; from pathlib import Path; p=Path(minisim.__file__).resolve(); r=subprocess.run(['git','-C',str(p.parent),'rev-parse','HEAD'],capture_output=True,text=True); print(json.dumps(dict(python=sys.version,minisim_path=str(p),minisim_commit=r.stdout.strip(),numpy=numpy.__version__,scipy=scipy.__version__,zarr=zarr.__version__)))"
    environment = json.loads(subprocess.check_output([a.python, "-c", env_code], text=True))
    for name in a.case or CASES:
        npx, seed, extras = CASES[name]
        sim, out = a.out / "simulations" / name, a.out / "small_runs" / name
        manifest_path = a.out / "simulations" / f"{name}.manifest.json"
        manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
        manifest.update(case=name, npx=npx, seed=seed, seconds=a.duration, environment=environment,
                        source_sha256={p.name:sha256(p) for p in [spec, calibration / "calibrated.py", calibration / "make_trace_sim.py"]})
        if a.generate:
            cmd = [a.python, str(calibration / "make_trace_sim.py"), str(sim), "--dur", str(a.duration),
                   "--npx", str(npx), "--seed", str(seed), "--spec", str(spec), *extras]
            manifest["generation"] = run(cmd, a.out / "simulations" / f"{name}.generate.log")
        if (sim / "spec.json").exists():
            manifest["generated_spec_sha256"] = sha256(sim / "spec.json")
            manifest["generated_spec"] = json.loads((sim / "spec.json").read_text())
        if (sim / "oracle.bin").exists():
            manifest["oracle_sha256"] = sha256(sim / "oracle.bin")
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
        if a.evaluate:
            cmd = [str(binary), "sim", str(sim), str(out), "--checkpoints", str(a.checkpoints)]
            if "--motion" in extras:
                cmd.append("--motion")
            manifest["evaluator_sha256"] = sha256(binary)
            manifest["evaluation"] = run(cmd, a.out / "small_runs" / f"{name}.log")
            manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
