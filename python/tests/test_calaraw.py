"""Tests for the CALARAW1 reader.

The fixtures in ``fixtures/calaraw`` are written by the browser encoder
(``node packages/io/src/__fixtures__/gen-calaraw-fixtures.ts``), so decoding them
here checks the TypeScript writer against the Python reader.
"""

from __future__ import annotations

import gzip
import shutil
import struct
from pathlib import Path

import numpy as np
import numpy.testing as npt
import pytest

from calab import CalarawError, iter_calaraw, read_calaraw
from calab._calaraw import HEADER_BYTES, parse_header, read_chunk

FIXTURES = Path(__file__).parent / "fixtures" / "calaraw"


def pattern(width: int, height: int, frames: int, bytes_per_pixel: int) -> np.ndarray:
    """Same pattern as packages/io/src/__tests__/calaraw.test.ts."""
    mask = 0xFF if bytes_per_pixel == 1 else 0xFFFF
    t, y, x = np.meshgrid(np.arange(frames), np.arange(height), np.arange(width), indexing="ij")
    values = (t * 40503 + y * 9973 + x * 7919) & mask
    return values.astype(np.uint8 if bytes_per_pixel == 1 else np.uint16)


def header_bytes(
    *,
    width: int = 5,
    height: int = 4,
    first: int = 0,
    frames: int = 1,
    total: int = 1,
    bpp: int = 2,
    predictor: int = 1,
    reserved: int = 0,
    fps: float = 20.0,
    magic: bytes = b"CALARAW1",
) -> bytes:
    return struct.pack(
        "<8sIIIIIBBHd", magic, width, height, first, frames, total, bpp, predictor, reserved, fps
    )


def write_chunk(path: Path, payload: bytes) -> Path:
    path.write_bytes(gzip.compress(payload))
    return path


# ---------------------------------------------------------------------------
# Fixtures from the browser encoder
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "width", "height", "frames", "bpp", "predictor", "fps"),
    [("u16", 5, 4, 7, 2, 1, 20.0), ("u8", 3, 6, 3, 1, 0, 30.5)],
)
def test_reads_browser_fixtures(
    name: str, width: int, height: int, frames: int, bpp: int, predictor: int, fps: float
) -> None:
    meta, data = read_calaraw(FIXTURES / name)
    assert (meta.width, meta.height, meta.total_frames) == (width, height, frames)
    assert (meta.bytes_per_pixel, meta.predictor, meta.fps) == (bpp, predictor, fps)
    assert data.dtype == (np.uint8 if bpp == 1 else np.uint16)
    npt.assert_array_equal(data, pattern(width, height, frames, bpp))


def test_iter_yields_chunks_in_order() -> None:
    starts = [(h.first_frame, h.frames) for h, _ in iter_calaraw(FIXTURES / "u16")]
    assert starts == [(0, 2), (2, 2), (4, 2), (6, 1)]


# ---------------------------------------------------------------------------
# Header validation
# ---------------------------------------------------------------------------


def test_header_round_trip() -> None:
    h = parse_header(header_bytes(first=2, frames=3, total=7))
    assert (h.first_frame, h.frames, h.meta.total_frames, h.meta.dtype) == (
        2,
        3,
        7,
        np.dtype("<u2"),
    )


@pytest.mark.parametrize(
    "kwargs",
    [
        {"magic": b"CALARAW2"},
        {"reserved": 1},
        {"bpp": 3},
        {"predictor": 2},
        {"width": 0},
        {"height": 16385},
        {"frames": 2, "total": 1},
        {"frames": 0},
        {"fps": float("nan")},
        {"fps": -1.0},
    ],
)
def test_header_rejects(kwargs: dict) -> None:
    with pytest.raises(CalarawError):
        parse_header(header_bytes(**kwargs))


def test_header_rejects_truncation() -> None:
    with pytest.raises(CalarawError, match="truncated"):
        parse_header(header_bytes()[: HEADER_BYTES - 1])


# ---------------------------------------------------------------------------
# Chunk validation
# ---------------------------------------------------------------------------

FRAME_BYTES = 5 * 4 * 2


def test_chunk_rejects_truncated_payload(tmp_path: Path) -> None:
    p = write_chunk(tmp_path / "c.gz", header_bytes(frames=2, total=2) + bytes(FRAME_BYTES))
    with pytest.raises(CalarawError, match="header says"):
        read_chunk(p)


def test_chunk_rejects_trailing_data(tmp_path: Path) -> None:
    p = write_chunk(tmp_path / "c.gz", header_bytes() + bytes(FRAME_BYTES + 1))
    with pytest.raises(CalarawError, match="trailing"):
        read_chunk(p)


def test_chunk_rejects_a_second_gzip_member(tmp_path: Path) -> None:
    p = tmp_path / "c.gz"
    p.write_bytes(gzip.compress(header_bytes() + bytes(FRAME_BYTES)) + gzip.compress(b"x"))
    with pytest.raises(CalarawError, match="trailing"):
        read_chunk(p)


def test_chunk_rejects_declared_size_over_cap(tmp_path: Path) -> None:
    p = write_chunk(tmp_path / "c.gz", header_bytes(frames=3, total=3) + bytes(3 * FRAME_BYTES))
    with pytest.raises(CalarawError, match="more than"):
        read_chunk(p, max_bytes=2 * FRAME_BYTES)


def test_chunk_rejects_non_gzip(tmp_path: Path) -> None:
    p = tmp_path / "c.gz"
    p.write_bytes(b"not gzip at all")
    with pytest.raises(CalarawError, match="gzip"):
        read_chunk(p)


def test_chunk_rejects_cut_off_gzip(tmp_path: Path) -> None:
    p = tmp_path / "c.gz"
    p.write_bytes(gzip.compress(header_bytes() + bytes(FRAME_BYTES))[:-10])
    with pytest.raises(CalarawError):
        read_chunk(p)


# ---------------------------------------------------------------------------
# Recording validation
# ---------------------------------------------------------------------------


def test_recording_rejects_missing_chunk(tmp_path: Path) -> None:
    shutil.copytree(FIXTURES / "u16", tmp_path / "rec")
    (tmp_path / "rec" / "frames-0001.calaraw.gz").unlink()
    with pytest.raises(CalarawError, match="expected 2"):
        read_calaraw(tmp_path / "rec")


def test_recording_rejects_missing_last_chunk(tmp_path: Path) -> None:
    shutil.copytree(FIXTURES / "u16", tmp_path / "rec")
    (tmp_path / "rec" / "frames-0003.calaraw.gz").unlink()
    with pytest.raises(CalarawError, match="header says 7"):
        read_calaraw(tmp_path / "rec")


def test_recording_rejects_mixed_metadata(tmp_path: Path) -> None:
    rec = tmp_path / "rec"
    rec.mkdir()
    write_chunk(rec / "frames-0000.calaraw.gz", header_bytes(total=2) + bytes(FRAME_BYTES))
    write_chunk(
        rec / "frames-0001.calaraw.gz",
        header_bytes(first=1, total=2, fps=30.0) + bytes(FRAME_BYTES),
    )
    with pytest.raises(CalarawError, match="metadata differs"):
        read_calaraw(rec)


def test_recording_rejects_empty_folder(tmp_path: Path) -> None:
    with pytest.raises(CalarawError, match="no frames-"):
        read_calaraw(tmp_path)
