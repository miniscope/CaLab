#!/usr/bin/env python3
"""Regenerate the real MATLAB .mat fixtures used by mat-parser.test.ts.

These fixtures are written by scipy (a genuine MATLAB Level-5 writer), which is
the whole point: hand-built .mat bytes can only encode our *assumptions* about
the format, including wrong ones. A real writer catches format-reality bugs --
e.g. that compressed data elements are NOT padded to an 8-byte boundary, which
a synthetic builder happily got wrong.

Keep the arrays tiny (fixtures are committed to the repo) and use integer values
so the TypeScript test can assert exact round-trip values.

Usage:
    python gen-mat-fixtures.py          # requires numpy + scipy

Produces, next to this script:
    traces_v6.mat     uncompressed (savemat do_compression=False, ~= MATLAB -v6)
    traces_v7.mat     zlib-compressed (do_compression=True,        ~= MATLAB -v7)
    traces_multi.mat  compressed, multiple variables (traces + fps + tvec)
    traces_struct.mat traces nested in a struct -- unreadable by design, and a
                      common enough MATLAB layout that the error path for it
                      deserves a real-writer fixture
"""

import os

import numpy as np
import scipy.io as sio

HERE = os.path.dirname(os.path.abspath(__file__))

# 3 cells x 5 timepoints, row-major logical layout [[1..5],[6..10],[11..15]].
TRACES = np.arange(1, 16, dtype=np.float64).reshape(3, 5)


def main() -> None:
    sio.savemat(os.path.join(HERE, "traces_v6.mat"), {"traces": TRACES}, do_compression=False)
    sio.savemat(os.path.join(HERE, "traces_v7.mat"), {"traces": TRACES}, do_compression=True)
    sio.savemat(
        os.path.join(HERE, "traces_multi.mat"),
        {"traces": TRACES, "fps": 30.0, "tvec": np.arange(5.0)},
        do_compression=True,
    )
    # Everything wrapped in a struct, plus a char array: no top-level numeric
    # variable, so parseMat must fail and say what it saw instead.
    sio.savemat(
        os.path.join(HERE, "traces_struct.mat"),
        {"session": {"traces": TRACES, "fps": 30.0}, "label": "mouse1"},
        do_compression=True,
    )
    for name in (
        "traces_v6.mat",
        "traces_v7.mat",
        "traces_multi.mat",
        "traces_struct.mat",
    ):
        path = os.path.join(HERE, name)
        print(f"wrote {name}: {os.path.getsize(path)} bytes")


if __name__ == "__main__":
    main()
