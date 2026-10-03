#!/usr/bin/env python3
"""Regenerate the real-numpy .npz fixture used by parser-robustness.test.ts.

Like gen-mat-fixtures.py, the point is a genuine writer: numpy itself decides
the header layout, padding, byte-order characters ('|' vs '<' vs '>') and the
shape-tuple spelling, so the parser is tested against reality rather than our
assumptions about it.

Every array holds the same small integer values (exactly representable in every
dtype, bool aside) so the TypeScript test can assert exact round-trips.

Usage:
    python gen-npy-fixtures.py          # requires numpy

Produces, next to this script:
    dtypes.npz   compressed (np.savez_compressed); one entry per case below
"""

import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))

# 2 x 3, C order: [[0, 1, 2], [3, 4, 5]] -- small non-negative ints fit every dtype.
BASE = np.arange(6).reshape(2, 3)

arrays = {}
for name in [
    "float16",
    "float32",
    "float64",
    "int8",
    "int16",
    "int32",
    "int64",
    "uint8",
    "uint16",
    "uint32",
    "uint64",
]:
    arrays[name] = BASE.astype(name)
    # Big-endian copy of the same values ('>f8', '>i4', ...; '|' for 1-byte types).
    arrays[f"be_{name}"] = BASE.astype(np.dtype(name).newbyteorder(">"))

arrays["bool"] = (BASE % 2).astype(np.bool_)
# Column-major storage of the same logical 2 x 3 array.
arrays["fortran_float64"] = np.asfortranarray(BASE.astype(np.float64))
# Zero-size dimensions and a 0-d scalar.
arrays["empty_0x5"] = np.zeros((0, 5), dtype=np.float32)
arrays["empty_3x0"] = np.zeros((3, 0), dtype=np.float64)
arrays["scalar"] = np.array(7.5, dtype=np.float64)

np.savez_compressed(os.path.join(HERE, "dtypes.npz"), **arrays)
print(f"wrote dtypes.npz with {len(arrays)} arrays")
