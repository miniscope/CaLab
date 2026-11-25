#!/usr/bin/env python3
"""Pull approved cala data donations onto the lab server (data-donation phase 5).

See ``apps/cala/docs/data-donation.md``. For every donation an admin approved,
this script downloads its files from presigned R2 URLs, verifies the CALARAW1
recording strictly and against the donor's declared metadata, stores it
read-only under ``<dest>/<donation id>/`` and marks it ``ingested`` (the edge
function then deletes the cloud copies).

Per donation::

    <dest>/.incoming/<id>/   download + verification (never read by anything else)
    <dest>/<id>/             verified: chunk files, timestamps.csv, meta.json,
                             donation.json (the row); files 0444, folder 0555;
                             contact.json (the sharer's sign-in email, kept
                             out of donation.json and never published) 0400
    <dest>/.rejected/<id>/   failed verification: the download plus reason.txt;
                             not marked ingested, so the cloud copy stays.
                             Delete the folder to retry on the next run.

Lab server setup
----------------
- Needs Python >= 3.11 with ``calab`` installed (only its CALARAW1 reader and
  numpy are used) and outbound HTTPS. The server makes outbound requests only:
  to the Supabase edge function and to the presigned R2 URLs it hands out.
- Needs only the ingest token, no R2 keys and no Supabase service key. The
  token can list approved donations, presign downloads and mark them ingested.
- Environment::

      SUPABASE_URL=https://<project>.supabase.co
      SUPABASE_ANON_KEY=<public anon key>      # the gateway wants it on every call
      INGEST_TOKEN=<secret, from the edge function's INGEST_TOKEN secret>

  The token is read from the environment only (command-line arguments are
  visible in ``ps``). Keep it in a file readable by the ingest user only, e.g.
  ``/etc/calab/ingest.env`` with mode 0600.
- Cron (hourly; the lock file makes overlapping runs exit at once)::

      15 * * * *  set -a; . /etc/calab/ingest.env; set +a; \\
        /opt/calab/.venv/bin/python /opt/calab/ingest_donations.py \\
        --dest /data/raw/donations >> /var/log/calab-ingest.log 2>&1

- Try it first with ``--dry-run``: lists what would be done, writes nothing.
- Exit status 1 when a donation failed or was rejected in this run, so cron
  mails about it.
"""

from __future__ import annotations

import argparse
import fcntl
import importlib.util
import json
import logging
import math
import os
import re
import shutil
import sys
import urllib.error
import urllib.request
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Protocol


def _load_calaraw() -> Any:
    """The CALARAW1 reader: from an installed calab, else `_calaraw.py` beside this script.

    On a lab server copy this script and `python/src/calab/_calaraw.py` into one
    folder; then only Python 3.11+ and numpy are needed (no calab build, no Rust).
    """
    try:
        from calab import _calaraw

        return _calaraw
    except ImportError:
        pass
    here = Path(__file__).resolve().parent
    for path in (here / "_calaraw.py", here.parent / "src" / "calab" / "_calaraw.py"):
        if path.is_file():
            spec = importlib.util.spec_from_file_location("calaraw_reader", path)
            assert spec and spec.loader
            module = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = module  # dataclasses need the module registered
            spec.loader.exec_module(module)
            return module
    raise ImportError("CALARAW1 reader not found: put _calaraw.py next to this script")


_reader = _load_calaraw()
CalarawError = _reader.CalarawError
iter_calaraw = _reader.iter_calaraw

log = logging.getLogger("ingest_donations")

# ---------------------------------------------------------------------------
# Limits (mirrored from packages/community/src/donation-service.ts)
# ---------------------------------------------------------------------------

MAX_CHUNK_BYTES = 100 * 1024 * 1024
MAX_TIMESTAMPS_BYTES = 50 * 1024 * 1024
MAX_META_BYTES = 1024 * 1024
MAX_DONATION_BYTES = 10 * 1024**3
#: Largest JSON answer accepted from the edge function.
MAX_API_BYTES = 32 * 1024 * 1024
BLOCK_BYTES = 1024 * 1024
#: Free space to leave on the dataset disk after a download.
DISK_MARGIN_BYTES = 1024**3

CHUNK_NAME = re.compile(r"^frames-(\d{4})\.calaraw\.gz$")
OTHER_NAMES = {"timestamps.csv": MAX_TIMESTAMPS_BYTES, "meta.json": MAX_META_BYTES}
DONATION_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

INCOMING = ".incoming"
REJECTED = ".rejected"
LOCK_FILE = ".ingest.lock"
ROW_FILE = "donation.json"
CONTACT_FILE = "contact.json"
REASON_FILE = "reason.txt"


class VerificationError(Exception):
    """The donation is not what it claims to be: reject it."""


class ApiError(Exception):
    """The edge function refused or failed a call: retry on the next run."""


# ---------------------------------------------------------------------------
# HTTP layer (injectable for tests)
# ---------------------------------------------------------------------------


class Response(Protocol):
    """The part of ``http.client.HTTPResponse`` this script uses."""

    status: int
    headers: Any

    def read(self, n: int = -1) -> bytes: ...
    def __enter__(self) -> Response: ...
    def __exit__(self, *exc: object) -> None: ...


#: Opens a request and returns the response; raises ``urllib.error.URLError`` on failure.
Opener = Callable[[urllib.request.Request], Response]


def default_opener(timeout: float) -> Opener:
    def open_(req: urllib.request.Request) -> Response:
        # Only the edge function and https presigned URLs reach here.
        return urllib.request.urlopen(req, timeout=timeout)

    return open_


@dataclass(frozen=True)
class IngestApi:
    """The ingest actions of the ``donation`` edge function."""

    supabase_url: str
    anon_key: str
    ingest_token: str
    opener: Opener

    @property
    def endpoint(self) -> str:
        return f"{self.supabase_url.rstrip('/')}/functions/v1/donation"

    def call(self, action: str, **body: Any) -> dict[str, Any]:
        req = urllib.request.Request(
            self.endpoint,
            data=json.dumps({"action": action, **body}).encode(),
            method="POST",
            headers={
                "Content-Type": "application/json",
                "apikey": self.anon_key,
                "Authorization": f"Bearer {self.anon_key}",
                "x-ingest-token": self.ingest_token,
            },
        )
        try:
            with self.opener(req) as resp:
                raw = resp.read(MAX_API_BYTES + 1)
        except urllib.error.HTTPError as e:
            raise ApiError(f"{action}: HTTP {e.code} {_error_message(e)}") from e
        except (urllib.error.URLError, OSError) as e:
            raise ApiError(f"{action}: {e}") from e
        if len(raw) > MAX_API_BYTES:
            raise ApiError(f"{action}: answer larger than {MAX_API_BYTES} bytes")
        try:
            data = json.loads(raw)
        except ValueError as e:
            raise ApiError(f"{action}: answer is not JSON") from e
        if not isinstance(data, dict):
            raise ApiError(f"{action}: answer is not a JSON object")
        return data

    def list_approved(self) -> list[dict[str, Any]]:
        rows = self.call("ingest_list").get("donations")
        if not isinstance(rows, list):
            raise ApiError("ingest_list: no donations list")
        return [r for r in rows if isinstance(r, dict) and r.get("status") == "approved"]

    def download_request(self, donation_id: str, name: str) -> urllib.request.Request:
        p = self.call("ingest_download_url", donation_id=donation_id, name=name)
        url, headers = p.get("url"), p.get("headers") or {}
        if not isinstance(url, str) or not url.startswith("https://"):
            raise ApiError(f"ingest_download_url: not an https URL for {name}")
        if not isinstance(headers, dict):
            raise ApiError("ingest_download_url: headers is not an object")
        return urllib.request.Request(url, headers={str(k): str(v) for k, v in headers.items()})

    def done(self, donation_id: str) -> None:
        self.call("ingest_done", donation_id=donation_id)


def _error_message(e: urllib.error.HTTPError) -> str:
    try:
        body = json.loads(e.read(64 * 1024))
        return str(body.get("error", "")) if isinstance(body, dict) else ""
    except (ValueError, OSError):
        return ""


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------


def expected_files(row: dict[str, Any]) -> list[tuple[str, int]]:
    """The declared files as (name, bytes), after checking names, sizes and chunk count."""
    files = row.get("files")
    if not isinstance(files, list) or not files:
        raise VerificationError("no files declared")
    out: list[tuple[str, int]] = []
    chunks: list[str] = []
    for f in files:
        name = f.get("name") if isinstance(f, dict) else None
        size = f.get("bytes") if isinstance(f, dict) else None
        if not isinstance(name, str) or not isinstance(size, int) or isinstance(size, bool):
            raise VerificationError(f"malformed file entry {f!r}")
        if CHUNK_NAME.match(name):
            cap = MAX_CHUNK_BYTES
            chunks.append(name)
        elif name in OTHER_NAMES:
            cap = OTHER_NAMES[name]
        else:
            raise VerificationError(f"unexpected file name {name!r}")
        if not 0 < size <= cap:
            raise VerificationError(f"{name}: declared size {size} outside 1..{cap}")
        out.append((name, size))
    names = [n for n, _ in out]
    if len(set(names)) != len(names):
        raise VerificationError("duplicate file names")
    n_chunks = row.get("n_chunks")
    if sorted(chunks) != [f"frames-{i:04d}.calaraw.gz" for i in range(len(chunks))]:
        raise VerificationError("chunk files are not frames-0000.. without gaps")
    if len(chunks) != n_chunks:
        raise VerificationError(f"{len(chunks)} chunk files, row says n_chunks {n_chunks}")
    total = sum(s for _, s in out)
    if total != row.get("declared_bytes") or total > MAX_DONATION_BYTES:
        raise VerificationError(
            f"files sum to {total} bytes, row says declared_bytes {row.get('declared_bytes')}"
        )
    return out


def verify_recording(directory: Path, row: dict[str, Any]) -> int:
    """Read every chunk strictly and compare the recording with the row; returns frames read."""
    frames = 0
    try:
        for header, _ in iter_calaraw(directory):
            meta = header.meta
            if header.first_frame == 0:
                check_meta_matches(asdict(meta), row)
            frames += header.frames
    except CalarawError as e:
        raise VerificationError(f"CALARAW1: {e}") from e
    return frames


# timestamps.csv: an optional header line of words, then rows of numbers only.
# No "=", "+" or "@" anywhere, so nothing can act as a spreadsheet formula.
TIMESTAMP_HEADER = re.compile(r"^[A-Za-z][A-Za-z0-9 \t()._/,-]*$")
TIMESTAMP_ROW = re.compile(r"^[0-9eE.,\t -]*$")


def verify_sidecars(directory: Path) -> None:
    """The non-video files must be plain data: meta.json a JSON object, timestamps.csv numbers."""
    meta = directory / "meta.json"
    if meta.exists():
        try:
            parsed = json.loads(meta.read_bytes().decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            raise VerificationError(f"meta.json is not valid JSON: {e}") from e
        if not isinstance(parsed, dict):
            raise VerificationError("meta.json is not a JSON object")
    stamps = directory / "timestamps.csv"
    if stamps.exists():
        try:
            text = stamps.read_bytes().decode("ascii")
        except UnicodeDecodeError as e:
            raise VerificationError("timestamps.csv is not plain ASCII text") from e
        lines = text.replace("\r\n", "\n").rstrip("\n").split("\n")
        start = 1 if lines and TIMESTAMP_HEADER.match(lines[0]) else 0
        for n, line in enumerate(lines[start:], start + 1):
            if not TIMESTAMP_ROW.match(line):
                raise VerificationError(f"timestamps.csv line {n} is not numeric")


def check_meta_matches(meta: dict[str, Any], row: dict[str, Any]) -> None:
    """The chunk header's recording metadata must equal what the donor declared."""
    pairs = [
        ("width", meta["width"], row.get("width")),
        ("height", meta["height"], row.get("height")),
        ("frames", meta["total_frames"], row.get("n_frames")),
        ("bytes per pixel", meta["bytes_per_pixel"], row.get("bytes_per_pixel")),
    ]
    bad = [f"{name}: file {a}, row {b}" for name, a, b in pairs if a != b]
    fps = row.get("fps")
    if not isinstance(fps, int | float) or not math.isclose(meta["fps"], fps, rel_tol=1e-9):
        bad.append(f"fps: file {meta['fps']}, row {fps}")
    if bad:
        raise VerificationError("metadata mismatch: " + "; ".join(bad))


# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------


def download(opener: Opener, req: urllib.request.Request, path: Path, size: int) -> None:
    """Stream ``req`` to ``path``; the body must be exactly ``size`` bytes.

    Network errors raise ``ApiError`` (retry later); a wrong size raises
    ``VerificationError`` (reject).
    """
    got = 0
    try:
        with opener(req) as resp, path.open("xb") as out:
            length = resp.headers.get("Content-Length") if resp.headers else None
            if length is not None and length.isdigit() and int(length) != size:
                raise VerificationError(
                    f"{path.name}: server sends {length} bytes, declared {size}"
                )
            while True:
                # Ask for one byte past the declared size so an oversized body is seen.
                block = resp.read(min(BLOCK_BYTES, size - got + 1))
                if not block:
                    break
                got += len(block)
                if got > size:
                    raise VerificationError(f"{path.name}: larger than the declared {size} bytes")
                out.write(block)
    except (urllib.error.URLError, OSError) as e:
        raise ApiError(f"{path.name}: download failed: {e}") from e
    if got != size:
        raise VerificationError(f"{path.name}: got {got} bytes, declared {size}")


# ---------------------------------------------------------------------------
# Bookkeeping
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Layout:
    """Where a donation lives under ``dest`` at each stage."""

    dest: Path

    def final(self, donation_id: str) -> Path:
        return self.dest / donation_id

    def incoming(self, donation_id: str) -> Path:
        return self.dest / INCOMING / donation_id

    def rejected(self, donation_id: str) -> Path:
        return self.dest / REJECTED / donation_id


def write_row(directory: Path, row: dict[str, Any]) -> None:
    """donation.json (the row, without the email) and the private contact.json."""
    record = {k: v for k, v in row.items() if k != "contact_email"}
    (directory / ROW_FILE).write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
    contact = {"email": row.get("contact_email"), "user_id": row.get("user_id")}
    path = directory / CONTACT_FILE
    path.touch(mode=0o600)
    path.chmod(0o600)
    path.write_text(json.dumps(contact, indent=2, sort_keys=True) + "\n")


def publish(incoming: Path, final: Path) -> None:
    """Make the verified download read-only and move it into place in one rename."""
    for p in incoming.iterdir():
        p.chmod(0o400 if p.name == CONTACT_FILE else 0o444)
    # Moving a directory to a new parent updates its "..", which needs write
    # permission on it: rename first, then lock the folder.
    os.rename(incoming, final)
    final.chmod(0o555)


def reject(incoming: Path, rejected: Path, row: dict[str, Any], reason: str) -> None:
    """Keep the download for inspection, out of the dataset tree."""
    rejected.parent.mkdir(parents=True, exist_ok=True)
    if incoming.exists():
        os.rename(incoming, rejected)
    else:
        rejected.mkdir()
    write_row(rejected, row)
    (rejected / REASON_FILE).write_text(reason + "\n")


def clear(path: Path) -> None:
    """Remove a leftover download (from a crashed or failed run)."""
    if path.exists():
        shutil.rmtree(path)


@contextmanager
def run_lock(dest: Path) -> Iterator[bool]:
    """An exclusive, non-blocking lock so overlapping cron runs do not race."""
    with (dest / LOCK_FILE).open("a") as f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        try:
            yield True
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


# ---------------------------------------------------------------------------
# One donation
# ---------------------------------------------------------------------------

# Outcomes of ingest_one.
INGESTED = "ingested"
ALREADY = "already ingested"
REJECTED_NOW = "rejected"
PREVIOUSLY_REJECTED = "previously rejected"
FAILED = "failed"
DRY_RUN = "dry run"


def ingest_one(api: IngestApi, row: dict[str, Any], layout: Layout, dry_run: bool = False) -> str:
    """Ingest one approved donation; returns one of the outcome strings above."""
    donation_id = str(row.get("id", ""))
    if not DONATION_ID.match(donation_id):
        log.error("skipping a donation with a malformed id %r", donation_id)
        return FAILED
    final, incoming, rejected = (
        layout.final(donation_id),
        layout.incoming(donation_id),
        layout.rejected(donation_id),
    )

    if final.exists():
        log.info("%s: already in %s, marking ingested", donation_id, final)
        if not dry_run:
            api.done(donation_id)
        return ALREADY
    if rejected.exists():
        log.warning("%s: rejected earlier (see %s); delete it to retry", donation_id, rejected)
        return PREVIOUSLY_REJECTED
    if dry_run:
        log.info(
            "%s: would download %s files, %s bytes, into %s",
            donation_id,
            len(row.get("files") or []),
            row.get("declared_bytes"),
            final,
        )
        return DRY_RUN

    clear(incoming)
    incoming.mkdir(parents=True)
    try:
        files = expected_files(row)
        free = shutil.disk_usage(layout.dest).free
        if free < sum(s for _, s in files) + DISK_MARGIN_BYTES:
            clear(incoming)
            log.error("%s: not enough disk space (%s bytes free)", donation_id, free)
            return FAILED
        for name, size in files:
            download(api.opener, api.download_request(donation_id, name), incoming / name, size)
        frames = verify_recording(incoming, row)
        verify_sidecars(incoming)
        write_row(incoming, row)
    except VerificationError as e:
        reject(incoming, rejected, row, str(e))
        log.error("%s: rejected: %s (kept in %s)", donation_id, e, rejected)
        return REJECTED_NOW
    except ApiError as e:
        clear(incoming)
        log.error("%s: will retry next run: %s", donation_id, e)
        return FAILED

    publish(incoming, final)
    log.info("%s: verified %s frames, stored in %s", donation_id, frames, final)
    try:
        api.done(donation_id)
    except ApiError as e:
        # The data is safe; the next run sees the folder and retries ingest_done.
        log.error("%s: stored, but marking it ingested failed: %s", donation_id, e)
        return FAILED
    return INGESTED


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------


def run(api: IngestApi, dest: Path, dry_run: bool = False) -> dict[str, str]:
    """Ingest every approved donation; returns id -> outcome."""
    rows = api.list_approved()
    log.info("%s approved donation(s)", len(rows))
    layout = Layout(dest)
    outcomes: dict[str, str] = {}
    for row in rows:
        donation_id = str(row.get("id", ""))
        try:
            outcomes[donation_id] = ingest_one(api, row, layout, dry_run)
        except ApiError as e:
            log.error("%s: %s", donation_id, e)
            outcomes[donation_id] = FAILED
    return outcomes


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument(
        "--dest", type=Path, required=True, help="dataset root, e.g. /data/raw/donations"
    )
    p.add_argument("--supabase-url", default=os.environ.get("SUPABASE_URL"))
    p.add_argument("--anon-key", default=os.environ.get("SUPABASE_ANON_KEY"))
    p.add_argument("--timeout", type=float, default=120.0, help="seconds per HTTP request")
    p.add_argument("--dry-run", action="store_true", help="list what would be done, write nothing")
    p.add_argument("-v", "--verbose", action="store_true")
    return p.parse_args(argv)


def main(argv: list[str] | None = None, opener: Opener | None = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        stream=sys.stderr,
    )
    token = os.environ.get("INGEST_TOKEN")
    missing = [
        n
        for n, v in [
            ("SUPABASE_URL", args.supabase_url),
            ("SUPABASE_ANON_KEY", args.anon_key),
            ("INGEST_TOKEN", token),
        ]
        if not v
    ]
    if missing:
        log.error("missing %s", ", ".join(missing))
        return 2
    if not args.dest.is_dir():
        log.error("%s is not a directory", args.dest)
        return 2
    api = IngestApi(args.supabase_url, args.anon_key, token, opener or default_opener(args.timeout))

    with run_lock(args.dest) as locked:
        if not locked:
            log.info("another run holds %s; exiting", args.dest / LOCK_FILE)
            return 0
        try:
            outcomes = run(api, args.dest, args.dry_run)
        except ApiError as e:
            log.error("%s", e)
            return 1
    for donation_id, outcome in outcomes.items():
        log.info("%s: %s", donation_id, outcome)
    return 1 if any(o in (FAILED, REJECTED_NOW) for o in outcomes.values()) else 0


if __name__ == "__main__":
    sys.exit(main())
