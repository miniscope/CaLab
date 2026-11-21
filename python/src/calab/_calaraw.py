"""Reader for CALARAW1 recordings (data donation, ``apps/cala/docs/data-donation.md``).

A recording is a folder of gzip chunk files ``frames-0000.calaraw.gz``, ... that
the browser writes with ``packages/io/src/calaraw.ts``; that file documents the
byte layout. Every chunk is checked strictly (header fields, exact payload
length, no trailing data, a cap on the declared size) because donations come
from outside the lab.
"""

from __future__ import annotations

import gzip
import math
import struct
import zlib
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import numpy as np

MAGIC = b"CALARAW1"
HEADER_BYTES = 40
MAX_EDGE = 16384
CHUNK_GLOB = "frames-*.calaraw.gz"
#: Largest uncompressed payload a chunk may declare (4x the browser's 64 MiB chunks).
DEFAULT_MAX_CHUNK_BYTES = 256 * 1024 * 1024

# magic, width, height, first frame, frames, total frames, bytes/px, predictor, reserved, fps
_HEADER = struct.Struct("<8sIIIIIBBHd")
assert _HEADER.size == HEADER_BYTES


class CalarawError(ValueError):
    """A CALARAW1 chunk or recording is malformed."""


@dataclass(frozen=True)
class CalarawMeta:
    """What all chunks of one recording share."""

    width: int
    height: int
    total_frames: int
    bytes_per_pixel: int
    predictor: int
    fps: float

    @property
    def dtype(self) -> np.dtype:
        return np.dtype("<u1" if self.bytes_per_pixel == 1 else "<u2")

    @property
    def frame_bytes(self) -> int:
        return self.width * self.height * self.bytes_per_pixel


@dataclass(frozen=True)
class CalarawHeader:
    """Header of one chunk: the recording's metadata and this chunk's frames."""

    meta: CalarawMeta
    first_frame: int
    frames: int


# ---------------------------------------------------------------------------
# Header
# ---------------------------------------------------------------------------


def parse_header(b: bytes) -> CalarawHeader:
    """Parse and validate the 40-byte chunk header."""
    if len(b) < HEADER_BYTES:
        raise CalarawError("truncated header")
    magic, width, height, first, frames, total, bpp, predictor, reserved, fps = _HEADER.unpack(
        b[:HEADER_BYTES]
    )
    if magic != MAGIC:
        raise CalarawError("not a CALARAW1 chunk")
    if reserved != 0:
        raise CalarawError("reserved header bytes are not 0")
    for name, edge in (("width", width), ("height", height)):
        if not 1 <= edge <= MAX_EDGE:
            raise CalarawError(f"{name} {edge} outside 1..{MAX_EDGE}")
    if total < 1:
        raise CalarawError("total frames is 0")
    if bpp not in (1, 2):
        raise CalarawError(f"bytes per pixel {bpp} is not 1 or 2")
    if predictor not in (0, 1):
        raise CalarawError(f"unknown predictor {predictor}")
    if not (math.isfinite(fps) and fps > 0):
        raise CalarawError(f"fps {fps} is not a positive number")
    if frames < 1 or first + frames > total:
        raise CalarawError(f"chunk frames {first}+{frames} do not fit the recording's {total}")
    meta = CalarawMeta(width, height, total, bpp, predictor, fps)
    return CalarawHeader(meta, first, frames)


# ---------------------------------------------------------------------------
# Chunks
# ---------------------------------------------------------------------------


def _undo_predictor(meta: CalarawMeta, stored: np.ndarray) -> np.ndarray:
    """Frames ``(T, H, W)`` from their stored form; the cumulative sum wraps like the encoder."""
    if meta.predictor == 0:
        return stored.copy()
    return np.cumsum(stored, axis=1, dtype=meta.dtype)


def read_chunk(
    path: str | Path, max_bytes: int = DEFAULT_MAX_CHUNK_BYTES
) -> tuple[CalarawHeader, np.ndarray]:
    """Read one chunk file: its header and frames, shape ``(frames, height, width)``.

    Raises :class:`CalarawError` for a bad header, a payload that is not exactly
    the declared frames, a declared size above ``max_bytes``, or broken gzip.
    """
    try:
        with gzip.open(path, "rb") as f:
            header = parse_header(f.read(HEADER_BYTES))
            meta = header.meta
            n = header.frames * meta.frame_bytes
            if n > max_bytes:
                raise CalarawError(f"chunk declares {n} bytes, more than {max_bytes}")
            payload = f.read(n)
            if len(payload) != n:
                raise CalarawError(f"chunk holds {len(payload)} payload bytes, header says {n}")
            if f.read(1):
                raise CalarawError("trailing data after the declared frames")
    except (OSError, EOFError, zlib.error) as e:
        raise CalarawError(f"{path}: not a valid gzip chunk ({e})") from e
    stored = np.frombuffer(payload, dtype=meta.dtype).reshape(
        header.frames, meta.height, meta.width
    )
    return header, _undo_predictor(meta, stored)


def chunk_paths(directory: str | Path) -> list[Path]:
    """The chunk files of a recording folder, in order."""
    paths = sorted(Path(directory).glob(CHUNK_GLOB))
    if not paths:
        raise CalarawError(f"no {CHUNK_GLOB} files in {directory}")
    return paths


# ---------------------------------------------------------------------------
# Recordings
# ---------------------------------------------------------------------------


def iter_calaraw(
    directory: str | Path, max_bytes: int = DEFAULT_MAX_CHUNK_BYTES
) -> Iterator[tuple[CalarawHeader, np.ndarray]]:
    """Yield ``(header, frames)`` chunk by chunk, checking that the chunks form one recording.

    Memory stays at one chunk, so this suits recordings larger than RAM.
    """
    meta: CalarawMeta | None = None
    next_frame = 0
    for path in chunk_paths(directory):
        header, frames = read_chunk(path, max_bytes)
        if meta is None:
            meta = header.meta
        elif header.meta != meta:
            raise CalarawError(f"{path.name}: metadata differs from the first chunk")
        if header.first_frame != next_frame:
            raise CalarawError(
                f"{path.name}: starts at frame {header.first_frame}, expected {next_frame}"
            )
        next_frame += header.frames
        yield header, frames
    if meta is not None and next_frame != meta.total_frames:
        raise CalarawError(f"chunks hold {next_frame} frames, header says {meta.total_frames}")


def read_calaraw(
    directory: str | Path, max_bytes: int = DEFAULT_MAX_CHUNK_BYTES
) -> tuple[CalarawMeta, np.ndarray]:
    """Read a whole recording: its metadata and frames, shape ``(frames, height, width)``."""
    chunks = list(iter_calaraw(directory, max_bytes))
    return chunks[0][0].meta, np.concatenate([frames for _, frames in chunks])
