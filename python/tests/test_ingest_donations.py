"""Tests for python/scripts/ingest_donations.py (data-donation phase 5).

The script is not part of the calab package, so it is loaded from its path.
HTTP goes through a fake opener that plays the edge function and R2, serving
the browser-written CALARAW fixtures.
"""

from __future__ import annotations

import gzip
import importlib.util
import io
import json
import stat
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import pytest

from calab import read_calaraw

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "calaraw" / "u16"


def _load_script() -> Any:
    path = ROOT / "scripts" / "ingest_donations.py"
    spec = importlib.util.spec_from_file_location("ingest_donations", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


ing = _load_script()

ID_A = "11111111-1111-4111-8111-111111111111"
ID_B = "22222222-2222-4222-8222-222222222222"
ENDPOINT = "https://proj.supabase.test/functions/v1/donation"


# ---------------------------------------------------------------------------
# Fake backend
# ---------------------------------------------------------------------------


class FakeResponse(io.BytesIO):
    def __init__(self, body: bytes, headers: dict[str, str] | None = None) -> None:
        super().__init__(body)
        self.status = 200
        self.headers = headers or {}

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


class FakeBackend:
    """Plays the edge function's ingest actions and the presigned R2 GETs."""

    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []
        #: (donation id, file name) -> bytes served by R2.
        self.objects: dict[tuple[str, str], bytes] = {}
        self.done: list[str] = []
        self.downloads: list[tuple[str, str]] = []
        self.calls: list[dict[str, Any]] = []
        self.fail_downloads = False

    def add(self, donation_id: str, files: dict[str, bytes], **over: Any) -> dict[str, Any]:
        for name, data in files.items():
            self.objects[(donation_id, name)] = data
        declared = [{"name": n, "bytes": len(b)} for n, b in files.items()]
        row = {
            "id": donation_id,
            "status": "approved",
            "width": 5,
            "height": 4,
            "n_frames": 7,
            "bytes_per_pixel": 2,
            "fps": 20.0,
            "n_chunks": sum(1 for n in files if n.startswith("frames-")),
            "files": declared,
            "declared_bytes": sum(f["bytes"] for f in declared),
            "indicator": "GCaMP6f",
            **over,
        }
        self.rows.append(row)
        return row

    def __call__(self, req: urllib.request.Request) -> FakeResponse:
        url = req.full_url
        if url == ENDPOINT:
            assert req.get_method() == "POST"
            headers = {k.lower(): v for k, v in req.header_items()}
            assert headers["x-ingest-token"] == "tok"
            assert headers["apikey"] == "anon"
            assert headers["authorization"] == "Bearer anon"
            body = json.loads(req.data)
            self.calls.append(body)
            return FakeResponse(json.dumps(self.answer(body)).encode())
        prefix = "https://r2.test/approved/"
        assert url.startswith(prefix), url
        donation_id, name = url[len(prefix) :].split("/")
        assert req.get_header("X-test") == "1"
        if self.fail_downloads:
            raise urllib.error.URLError("connection reset")
        self.downloads.append((donation_id, name))
        return FakeResponse(self.objects[(donation_id, name)])

    def answer(self, body: dict[str, Any]) -> dict[str, Any]:
        action = body["action"]
        if action == "ingest_list":
            return {"donations": self.rows}
        if action == "ingest_download_url":
            url = f"https://r2.test/approved/{body['donation_id']}/{body['name']}"
            return {"url": url, "headers": {"X-Test": "1"}, "expires_in": 600}
        if action == "ingest_done":
            self.done.append(body["donation_id"])
            return {"ok": True}
        raise AssertionError(action)


def fixture_files() -> dict[str, bytes]:
    return {p.name: p.read_bytes() for p in sorted(FIXTURE.glob("frames-*.calaraw.gz"))}


@pytest.fixture
def backend() -> FakeBackend:
    return FakeBackend()


@pytest.fixture
def dest(tmp_path: Path) -> Path:
    d = tmp_path / "donations"
    d.mkdir()
    return d


def run_main(backend: FakeBackend, dest: Path, *extra: str) -> int:
    return ing.main(
        ["--dest", str(dest), "--supabase-url", "https://proj.supabase.test", "--anon-key", "anon"]
        + list(extra),
        opener=backend,
    )


@pytest.fixture(autouse=True)
def _token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INGEST_TOKEN", "tok")


def reason(dest: Path, donation_id: str) -> str:
    return (dest / ".rejected" / donation_id / "reason.txt").read_text()


def assert_rejected(backend: FakeBackend, dest: Path, donation_id: str) -> None:
    assert not (dest / donation_id).exists()
    assert not (dest / ".incoming" / donation_id).exists()
    assert (dest / ".rejected" / donation_id / "donation.json").exists()
    assert donation_id not in backend.done


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_ingests_verifies_and_locks_down(backend: FakeBackend, dest: Path) -> None:
    files = fixture_files()
    assert len(files) == 4
    files["meta.json"] = b'{"cala_version": "2.19.1"}'
    row = backend.add(ID_A, files)

    assert run_main(backend, dest) == 0

    final = dest / ID_A
    assert sorted(p.name for p in final.iterdir()) == sorted([*files, "donation.json"])
    for name, data in files.items():
        assert (final / name).read_bytes() == data
    assert json.loads((final / "donation.json").read_text()) == row
    assert stat.S_IMODE(final.stat().st_mode) == 0o555
    assert all(stat.S_IMODE(p.stat().st_mode) == 0o444 for p in final.iterdir())
    meta, frames = read_calaraw(final)
    assert frames.shape == (7, 4, 5)
    assert meta.bytes_per_pixel == 2
    assert backend.done == [ID_A]
    assert list((dest / ".incoming").iterdir()) == []
    assert not (dest / ".rejected").exists()


# ---------------------------------------------------------------------------
# Rejections
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("delta", [+1, -1])
def test_size_mismatch_is_rejected(backend: FakeBackend, dest: Path, delta: int) -> None:
    files = fixture_files()
    backend.add(ID_A, files)
    # Serve one byte more or less than the row declares.
    key = (ID_A, "frames-0001.calaraw.gz")
    data = backend.objects[key]
    backend.objects[key] = data + b"\0" if delta > 0 else data[:-1]

    assert run_main(backend, dest) == 1

    assert_rejected(backend, dest, ID_A)
    assert "frames-0001.calaraw.gz" in reason(dest, ID_A)
    assert ("larger" in reason(dest, ID_A)) == (delta > 0)


def test_metadata_mismatch_is_rejected(backend: FakeBackend, dest: Path) -> None:
    backend.add(ID_A, fixture_files(), width=6, fps=30.0)

    assert run_main(backend, dest) == 1

    assert_rejected(backend, dest, ID_A)
    text = reason(dest, ID_A)
    assert "width: file 5, row 6" in text
    assert "fps: file 20.0, row 30.0" in text


def test_corrupt_chunk_is_rejected(backend: FakeBackend, dest: Path) -> None:
    files = fixture_files()
    # A valid gzip whose payload is not a CALARAW1 chunk; the row declares its size.
    files["frames-0002.calaraw.gz"] = gzip.compress(b"NOTCALA!" + bytes(64))
    backend.add(ID_A, files)

    assert run_main(backend, dest) == 1

    assert_rejected(backend, dest, ID_A)
    assert "CALARAW1" in reason(dest, ID_A)
    # The download is kept for inspection.
    assert (dest / ".rejected" / ID_A / "frames-0002.calaraw.gz").exists()


@pytest.mark.parametrize("name", ["../escape.txt", "frames-1.calaraw.gz", "run.sh"])
def test_unexpected_file_name_is_rejected_before_download(
    backend: FakeBackend, dest: Path, name: str
) -> None:
    files = fixture_files()
    files[name] = b"x"
    backend.add(ID_A, files)

    assert run_main(backend, dest) == 1

    assert_rejected(backend, dest, ID_A)
    assert backend.downloads == []
    assert not (dest.parent / "escape.txt").exists()


def test_rejection_does_not_stop_the_next_donation(backend: FakeBackend, dest: Path) -> None:
    backend.add(ID_A, fixture_files(), n_frames=8)
    backend.add(ID_B, fixture_files())

    assert run_main(backend, dest) == 1

    assert_rejected(backend, dest, ID_A)
    assert (dest / ID_B).is_dir()
    assert backend.done == [ID_B]


# ---------------------------------------------------------------------------
# Idempotency and retries
# ---------------------------------------------------------------------------


def test_already_ingested_is_skipped_and_marked_done(backend: FakeBackend, dest: Path) -> None:
    backend.add(ID_A, fixture_files())
    (dest / ID_A).mkdir()

    assert run_main(backend, dest) == 0

    assert backend.downloads == []
    assert backend.done == [ID_A]


def test_previously_rejected_is_not_downloaded_again(backend: FakeBackend, dest: Path) -> None:
    backend.add(ID_A, fixture_files(), width=6)
    assert run_main(backend, dest) == 1
    backend.downloads.clear()

    assert run_main(backend, dest) == 0

    assert backend.downloads == []
    assert backend.done == []


def test_network_failure_is_retried_not_rejected(backend: FakeBackend, dest: Path) -> None:
    backend.add(ID_A, fixture_files())
    backend.fail_downloads = True

    assert run_main(backend, dest) == 1

    assert not (dest / ID_A).exists()
    assert not (dest / ".rejected" / ID_A).exists()
    assert not (dest / ".incoming" / ID_A).exists()
    assert backend.done == []

    backend.fail_downloads = False
    assert run_main(backend, dest) == 0
    assert backend.done == [ID_A]


def test_leftover_incoming_is_replaced(backend: FakeBackend, dest: Path) -> None:
    backend.add(ID_A, fixture_files())
    stale = dest / ".incoming" / ID_A
    stale.mkdir(parents=True)
    (stale / "frames-0000.calaraw.gz").write_bytes(b"partial")

    assert run_main(backend, dest) == 0
    assert (dest / ID_A / "frames-0000.calaraw.gz").read_bytes() == fixture_files()[
        "frames-0000.calaraw.gz"
    ]


# ---------------------------------------------------------------------------
# Dry run and configuration
# ---------------------------------------------------------------------------


def test_dry_run_writes_nothing(backend: FakeBackend, dest: Path) -> None:
    backend.add(ID_A, fixture_files())
    backend.add(ID_B, fixture_files())
    (dest / ID_B).mkdir()  # already ingested: dry run must not mark it done either

    assert run_main(backend, dest, "--dry-run") == 0

    assert backend.downloads == []
    assert backend.done == []
    assert [c["action"] for c in backend.calls] == ["ingest_list"]
    assert sorted(p.name for p in dest.iterdir()) == sorted([ID_B, ".ingest.lock"])


def test_missing_token_exits_2(
    backend: FakeBackend, dest: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("INGEST_TOKEN")
    assert run_main(backend, dest) == 2
    assert backend.calls == []


def test_only_approved_rows_are_considered(backend: FakeBackend, dest: Path) -> None:
    backend.add(ID_A, fixture_files(), status="uploaded")

    assert run_main(backend, dest) == 0

    assert backend.downloads == []
    assert not (dest / ID_A).exists()


def test_plain_timestamps_and_meta_are_accepted(backend: FakeBackend, dest: Path) -> None:
    files = fixture_files()
    files["timestamps.csv"] = b"Frame Number,Time Stamp (ms),Buffer Index\r\n0,0,0\r\n1,49.5,1\r\n"
    files["meta.json"] = b'{"cala_version": "dev", "files": ["0.avi"]}'
    backend.add(ID_A, files)
    assert run_main(backend, dest) == 0
    assert (dest / ID_A / "timestamps.csv").exists()


@pytest.mark.parametrize(
    ("name", "data", "why"),
    [
        ("timestamps.csv", b"0,0,0\n=cmd|' /C calc'!A0,1,1\n", "not numeric"),
        ("timestamps.csv", b"0,0,0\n\x7fELF\x02\x01\n", "not numeric"),
        ("timestamps.csv", "0,0,0\nü\n".encode(), "ASCII"),
        ("meta.json", b"MZ\x90\x00 not json", "not valid JSON"),
        ("meta.json", b"[1, 2]", "not a JSON object"),
    ],
)
def test_non_data_sidecars_are_rejected(
    backend: FakeBackend, dest: Path, name: str, data: bytes, why: str
) -> None:
    files = fixture_files()
    files[name] = data
    backend.add(ID_A, files)
    assert run_main(backend, dest) == 1
    assert_rejected(backend, dest, ID_A)
    assert why in reason(dest, ID_A)
