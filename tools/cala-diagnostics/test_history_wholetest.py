"""Factor files for history_wholetest.py: tiny hand-built v1 and v2 files, no recordings."""

import struct
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import history_wholetest as H

FRAMES = 3
RANK = 2
# Plain tiles of 2 px on a 3 x 2 frame: (x0, y0, w, h).
TILES = [(0, 0, 2, 2), (2, 0, 1, 2)]


def arrays(i: int, w: int, h: int) -> dict[str, np.ndarray]:
    """Distinct values per tile and array, so a wrong offset shows."""
    p = w * h
    base = 100.0 * (i + 1)
    return {
        "mean": base + np.arange(p, dtype="<f4"),
        "discarded": base + 10 + np.arange(p, dtype="<f4"),
        "valid": np.full(p, 0.5, "<f4"),
        "spatial": base + 20 + np.arange(p * RANK, dtype="<f4"),
        "temporal": base + 40 + np.arange(FRAMES * RANK, dtype="<f4"),
    }


def record(i: int, v2: bool) -> bytes:
    """A tile record as `TileFactors::to_bytes` writes it (`CTF2`) or v1 did (`CTF1`)."""
    x0, y0, w, h = TILES[i]
    a = arrays(i, w, h)
    b = (b"CTF2" if v2 else b"CTF1") + struct.pack(
        "<7I", x0, y0, w, h, RANK, FRAMES, RANK + 3
    )
    b += struct.pack("<dd", 12.0, 10.0)
    keys = ["mean", "discarded", "valid"] if v2 else ["mean"]
    for k in keys + ["spatial", "temporal"]:
        b += a[k].astype("<f4").tobytes()
    return b


def factor_file(v2: bool, kind: int = 0, param: int = 0) -> bytes:
    """A window as `WindowFactors::to_bytes` writes it (v2), or a v1 file."""
    b = (b"CALAFAC2" if v2 else b"CALAFAC1") + struct.pack(
        "<5I", 3, 2, 2, FRAMES, len(TILES)
    )
    b += struct.pack("<d", 600.0)
    if v2:
        b += struct.pack("<II", kind, param)
    for i in range(len(TILES)):
        r = record(i, v2)
        b += struct.pack("<I", len(r)) + r
    return b


class FactorFiles(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "w0000.fac"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def read(self, data: bytes) -> list[H.Tile]:
        self.path.write_bytes(data)
        return H.read_factor_file(self.path)

    def check(self, tiles: list[H.Tile]) -> None:
        self.assertEqual(len(tiles), len(TILES))
        for i, (x0, y0, w, h, sp, tm, mean) in enumerate(tiles):
            self.assertEqual((x0, y0, w, h), TILES[i])
            a = arrays(i, w, h)
            np.testing.assert_array_equal(mean, a["mean"])
            np.testing.assert_array_equal(sp, a["spatial"].reshape(w * h, RANK))
            np.testing.assert_array_equal(tm, a["temporal"].reshape(FRAMES, RANK))

    def test_a_v2_file_reads_past_the_per_pixel_arrays(self) -> None:
        self.check(self.read(factor_file(v2=True)))

    def test_a_v1_file_still_reads(self) -> None:
        self.check(self.read(factor_file(v2=False)))

    def test_a_tiling_other_than_plain_is_refused(self) -> None:
        for kind, param in ((2, 0), (1, 8)):
            with self.assertRaisesRegex(ValueError, "plain"):
                self.read(factor_file(v2=True, kind=kind, param=param))

    def test_a_truncated_or_foreign_file_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            self.read(b"CALAFAC3" + factor_file(v2=True)[8:])
        with self.assertRaises((ValueError, struct.error)):
            self.read(factor_file(v2=True)[:-4])


if __name__ == "__main__":
    unittest.main()
