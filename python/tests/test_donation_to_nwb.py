"""Tests for python/scripts/donation_to_nwb.py (data donation, DANDI publishing)."""

from __future__ import annotations

import gzip
import importlib.util
import json
import struct
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pytest

pynwb = pytest.importorskip("pynwb")

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))


def _load(name: str) -> Any:
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


nwb = _load("donation_to_nwb")

DONATION_ID = "abcdef12-1111-4111-8111-111111111111"
HEADER = struct.Struct("<8sIIIIIBBHd")


def write_calaraw(directory: Path, frames: np.ndarray, fps: float, per_chunk: int = 7) -> None:
    """Chunk files with predictor 0 (raw), like the browser writes with predictor 1."""
    n, h, w = frames.shape
    bpp = frames.dtype.itemsize
    for c, start in enumerate(range(0, n, per_chunk)):
        part = frames[start : start + per_chunk]
        header = HEADER.pack(b"CALARAW1", w, h, start, len(part), n, bpp, 0, 0, fps)
        data = header + part.astype(f"<u{bpp}").tobytes()
        (directory / f"frames-{c:04d}.calaraw.gz").write_bytes(gzip.compress(data))


def row(**over: Any) -> dict[str, Any]:
    base = {
        "id": DONATION_ID,
        "status": "approved",
        "sharing": "public",
        "license": "cc-by-4.0",
        "indicator": "GCaMP8m",
        "species": "mouse",
        "brain_region": "M1",
        "scope": "UCLA v4",
        "behavior": "open field",
        "notes": None,
        "fps": 20.0,
        "width": 6,
        "height": 4,
        "n_frames": 0,
        "bytes_per_pixel": 1,
        "subject_id": "m7",
        "subject_sex": "F",
        "subject_age": "P90D",
        "session_date": "2026-11-20",
        "genotype": None,
        "credit_name": "Jane Doe",
        "credit_lab": "Doe Lab, UCLA",
    }
    base.update(over)
    return base


def stored(tmp_path: Path, frames: np.ndarray, **over: Any) -> tuple[Path, dict[str, Any]]:
    d = tmp_path / "store" / DONATION_ID
    d.mkdir(parents=True)
    r = row(n_frames=frames.shape[0], bytes_per_pixel=frames.dtype.itemsize, **over)
    write_calaraw(d, frames, r["fps"])
    (d / "donation.json").write_text(json.dumps(r))
    (d / "meta.json").write_text(
        json.dumps({"format": "cala-donation-meta", "sharing": r["sharing"]})
    )
    return d, r


def frames_u8(n: int) -> np.ndarray:
    rng = np.random.default_rng(1)
    return rng.integers(0, 256, size=(n, 4, 6), dtype=np.uint8)


# ---------------------------------------------------------------------------
# Naming
# ---------------------------------------------------------------------------


def test_species_names() -> None:
    assert nwb.scientific_species("mouse") == "Mus musculus"
    assert nwb.scientific_species("Rat") == "Rattus norvegicus"
    assert nwb.scientific_species("zebrafish larva") == "Danio rerio"
    assert nwb.scientific_species("Mus musculus") == "Mus musculus"
    with pytest.raises(nwb.ConversionError, match="species"):
        nwb.scientific_species("songbird")


@pytest.mark.parametrize(
    ("lab", "slug"),
    [
        ("Doe Lab, UCLA", "doe-lab-ucla"),
        ("Müller Lab", "m-ller-lab"),
        ("!!!", "lab"),
        ("A" * 40, "a" * 24),
    ],
)
def test_lab_slug(lab: str, slug: str) -> None:
    assert nwb.lab_slug(lab) == slug


def test_nwb_relpath_is_a_valid_dandi_path() -> None:
    path = nwb.nwb_relpath(row(credit_lab="Müller Lab, Zürich!"))
    assert (
        path == "sub-m-ller-lab-z-rich-m7/sub-m-ller-lab-z-rich-m7_ses-20261120-abcdef12_ophys.nwb"
    )
    assert nwb.DANDI_PATH.fullmatch(path)


# ---------------------------------------------------------------------------
# Safety: CaLab-only never converts
# ---------------------------------------------------------------------------


def test_lab_donations_are_refused(tmp_path: Path) -> None:
    d, r = stored(tmp_path, frames_u8(5), sharing="lab", license="lab-use-only")
    with pytest.raises(nwb.ConversionError, match="CaLab only"):
        nwb.check_public(r, json.loads((d / "meta.json").read_text()))
    # Row says public but meta.json says lab: refused too.
    with pytest.raises(nwb.ConversionError, match="CaLab only"):
        nwb.check_public(row(), {"sharing": "lab"})


def test_missing_subject_fields_are_refused() -> None:
    with pytest.raises(nwb.ConversionError, match="subject_age"):
        nwb.check_public(row(subject_age=None), {"sharing": "public"})


# ---------------------------------------------------------------------------
# Writing and verifying
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("n", [5, 16, 37])
def test_write_and_verify_round_trip(tmp_path: Path, n: int) -> None:
    frames = frames_u8(n)
    d, r = stored(tmp_path, frames)
    out = tmp_path / "out.nwb"
    nwb.write_nwb(d, r, out)
    nwb.verify_nwb(d, out)
    with pynwb.NWBHDF5IO(str(out), "r") as io:
        f = io.read()
        series = f.acquisition["OnePhotonSeries"]
        assert series.rate == 20.0
        np.testing.assert_array_equal(series.data[:], frames)
        assert series.data.chunks == (min(16, n), 4, 6)
        assert series.data.compression == "gzip"
        assert f.subject.species == "Mus musculus"
        assert f.subject.subject_id == "doe-lab-ucla-m7"
        assert f.subject.sex == "F"
        assert f.subject.age == "P90D"
        assert f.identifier == DONATION_ID
        assert f.session_start_time.isoformat() == "2026-11-20T00:00:00+00:00"
        assert f.imaging_planes["ImagingPlane"].location == "M1"


def test_write_uint16(tmp_path: Path) -> None:
    frames = np.arange(3 * 4 * 6, dtype=np.uint16).reshape(3, 4, 6) * 1000
    d, r = stored(tmp_path, frames)
    out = tmp_path / "out.nwb"
    nwb.write_nwb(d, r, out)
    nwb.verify_nwb(d, out)


def test_verify_catches_a_changed_frame(tmp_path: Path) -> None:
    frames = frames_u8(5)
    d, r = stored(tmp_path, frames)
    out = tmp_path / "out.nwb"
    nwb.write_nwb(d, r, out)
    changed = frames.copy()
    changed[2, 0, 0] ^= 1
    for f in d.glob("frames-*.calaraw.gz"):
        f.unlink()
    write_calaraw(d, changed, 20.0)
    with pytest.raises(nwb.ConversionError, match="frame 2"):
        nwb.verify_nwb(d, out)


def test_inspector_finds_no_critical_issue(tmp_path: Path) -> None:
    d, r = stored(tmp_path, frames_u8(5))
    out = tmp_path / "out.nwb"
    nwb.write_nwb(d, r, out)
    assert nwb.inspect_nwb(out) == []


# ---------------------------------------------------------------------------
# Upload and publish
# ---------------------------------------------------------------------------


class FakeApi:
    def __init__(self, answer: Exception | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self.answer = answer

    def call(self, action: str, **body: Any) -> dict[str, Any]:
        self.calls.append({"action": action, **body})
        if self.answer:
            raise self.answer
        return {"status": "published"}


def test_convert_uploads_and_marks_published(tmp_path: Path) -> None:
    d, r = stored(tmp_path, frames_u8(5))
    ran: list[tuple[list[str], Path]] = []
    api = FakeApi()
    path = nwb.convert(
        DONATION_ID,
        store=tmp_path / "store",
        work=tmp_path / "work",
        dandiset="000999",
        instance="dandi-sandbox",
        api=api,
        run=lambda cmd, cwd: ran.append((cmd, cwd)),
    )
    assert path == nwb.nwb_relpath(r)
    dandiset_dir = tmp_path / "work" / "000999"
    assert (dandiset_dir / path).is_file()
    assert ran[0][0][:2] == ["dandi", "download"]
    assert ran[1] == (["dandi", "validate", path], dandiset_dir)
    assert ran[2] == (["dandi", "upload", "-i", "dandi-sandbox", path], dandiset_dir)
    assert api.calls == [
        {"action": "ingest_published", "donation_id": DONATION_ID, "dandi_path": path}
    ]


def test_convert_again_reuses_the_file_and_accepts_already_published(tmp_path: Path) -> None:
    stored(tmp_path, frames_u8(5))
    kwargs = dict(
        store=tmp_path / "store",
        work=tmp_path / "work",
        dandiset="000999",
        instance="dandi-sandbox",
        run=lambda cmd, cwd: None,
    )
    nwb.convert(DONATION_ID, api=FakeApi(), **kwargs)
    out = next((tmp_path / "work" / "000999").rglob("*.nwb"))
    mtime = out.stat().st_mtime_ns
    already = nwb.ApiError("ingest_published: HTTP 409 donation is already published")
    nwb.convert(DONATION_ID, api=FakeApi(already), **kwargs)
    assert out.stat().st_mtime_ns == mtime


def test_convert_with_no_upload_stops_after_writing(tmp_path: Path) -> None:
    stored(tmp_path, frames_u8(5))
    api = FakeApi()
    ran: list[Any] = []
    nwb.convert(
        DONATION_ID,
        store=tmp_path / "store",
        work=tmp_path / "work",
        dandiset="000999",
        instance="dandi-sandbox",
        api=api,
        run=lambda cmd, cwd: ran.append(cmd),
        upload=False,
    )
    assert api.calls == []
    assert all(cmd[1] != "upload" for cmd in ran)
