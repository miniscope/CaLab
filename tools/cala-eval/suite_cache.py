"""Content-addressed cache of demixing-suite arm runs (`demix_suite.py`).

qc_eval is deterministic (byte-identical across reruns), so a run is a pure function of the binary, its
full argument list and the sim. The key is

    sha256(CACHE_VERSION, sha256(binary), the qc_eval args in order, sim hash)

where the sim hash covers `oracle.bin` (the GT, including the `detectable` flags), `spec.json`, `gen.json`
and the names and sizes of the files under `daq/` (the video). Any change to any of them is a new key.

Layout: `<root>/v<CACHE_VERSION>/<key>/run/` is the finished run directory (copied copy-on-write where the
filesystem allows), `<root>/v<CACHE_VERSION>/<key>/metrics-<mkey>/` holds that run's `demix_*` files for one
version of the metric code (`mkey` hashes `demix_metrics.py` and `demix_clusters.py`, and the `--all-det` flag).
Entries are immutable: written to a temporary directory and renamed into place.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

CACHE_VERSION = 1
HERE = Path(__file__).resolve().parent
METRIC_SOURCES = ("demix_metrics.py", "demix_clusters.py")

_file_hashes: dict[tuple, str] = {}


def default_root() -> Path:
    env = os.environ.get("CALA_SUITE_CACHE")
    if env:
        return Path(env)
    return Path(os.environ.get("CALA_DATA", Path.home() / "Projects" / "cala-data")) / "suite-cache"


def file_sha256(path: Path) -> str:
    path = Path(path).resolve()
    st = path.stat()
    memo = (str(path), st.st_size, st.st_mtime_ns)
    if memo not in _file_hashes:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        _file_hashes[memo] = h.hexdigest()
    return _file_hashes[memo]


def sim_hash(sim: Path) -> str:
    """Hash of the sim's content: oracle.bin, spec.json, gen.json (when present), daq/ file names and sizes."""
    sim = Path(sim)
    h = hashlib.sha256()
    for name in ("oracle.bin", "spec.json", "gen.json"):
        p = sim / name
        h.update(name.encode() + b"\0" + (file_sha256(p).encode() if p.exists() else b"-") + b"\0")
    daq = sim / "daq"
    if daq.is_dir():
        for p in sorted(daq.rglob("*")):
            if p.is_file():
                h.update(f"{p.relative_to(daq)}:{p.stat().st_size}\0".encode())
    return h.hexdigest()


def run_key(binary: Path, args: list[str], sim: Path) -> str:
    """Cache key of one qc_eval run. `args` is the full argument list after `qc_eval sim SIM RUN`, in order."""
    blob = json.dumps([CACHE_VERSION, file_sha256(binary), list(args), sim_hash(sim)])
    return hashlib.sha256(blob.encode()).hexdigest()


def metrics_key(all_det: bool) -> str:
    h = hashlib.sha256(b"all-det" if all_det else b"default")
    for name in METRIC_SOURCES:
        h.update(file_sha256(HERE / name).encode())
    return h.hexdigest()[:16]


def _copy_tree(src: Path, dst: Path) -> None:
    """Copy the contents of `src` into `dst` (created), copy-on-write when possible."""
    dst.mkdir(parents=True, exist_ok=True)
    for cmd in (["cp", "-cR"], ["cp", "-R", "--reflink=auto"], ["cp", "-R"]):
        r = subprocess.run([*cmd, f"{src}/.", str(dst)], capture_output=True)
        if r.returncode == 0:
            return
    raise OSError(f"could not copy {src} to {dst}")


class SuiteCache:
    def __init__(self, root: Path | None = None):
        self.root = Path(root) if root else default_root()
        self.base = self.root / f"v{CACHE_VERSION}"

    def entry(self, key: str) -> Path:
        return self.base / key

    def has_run(self, key: str) -> bool:
        return (self.entry(key) / "run" / "run.json").exists()

    def _publish(self, key: str, sub: str, src: Path, only_prefix: str | None = None) -> bool:
        """Atomically add `src` as `<entry>/<sub>`; False when it is already there."""
        dest = self.entry(key) / sub
        if dest.exists():
            return False
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.parent / f".tmp-{sub}-{os.getpid()}"
        shutil.rmtree(tmp, ignore_errors=True)
        if only_prefix is None:
            _copy_tree(src, tmp)
        else:
            tmp.mkdir()
            for p in src.glob(only_prefix + "*"):
                shutil.copy2(p, tmp / p.name)
        try:
            os.rename(tmp, dest)
        except OSError:  # a concurrent writer won
            shutil.rmtree(tmp, ignore_errors=True)
            return False
        return True

    def store_run(self, key: str, run_dir: Path) -> bool:
        """Cache a finished run (rc 0 only) directory."""
        info = Path(run_dir) / "run.json"
        if not info.exists() or json.loads(info.read_text()).get("rc") != 0:
            return False
        return self._publish(key, "run", run_dir)

    def restore_run(self, key: str, run_dir: Path) -> None:
        _copy_tree(self.entry(key) / "run", Path(run_dir))

    def has_metrics(self, key: str, mkey: str) -> bool:
        return (self.entry(key) / f"metrics-{mkey}" / "demix_det.json").exists()

    def store_metrics(self, key: str, mkey: str, run_dir: Path) -> bool:
        if not (Path(run_dir) / "demix_det.json").exists():
            return False
        return self._publish(key, f"metrics-{mkey}", Path(run_dir), only_prefix="demix_")

    def restore_metrics(self, key: str, mkey: str, run_dir: Path) -> None:
        for p in (self.entry(key) / f"metrics-{mkey}").iterdir():
            shutil.copy2(p, Path(run_dir) / p.name)
