# trace_small

A tiny minisim recording with its ground-truth footprints and traces, used by
`crates/cala/tests/trace_fixture.rs` (oracle trace recovery through the real
preprocessing chain).

| File              | Contents                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `movie.npy`       | `uint8 (80, 64, 64)`: the observed movie (sensor counts, 20 fps)                                           |
| `footprints.npy`  | `float32 (n, 2, 21, 21)`: per unit, the footprint with the scatter halo `[0]` and its core component `[1]` |
| `meta.npy`        | `float64 (n, 5)`: unit index, window top row, window left column (may be < 0), detectable, in focus        |
| `C.npy`           | `float32 (n, 80)`: ground-truth traces (`GroundTruth.C`, baseline included)                                |
| `spec.json`       | the minisim spec                                                                                           |
| `make_fixture.py` | regenerates everything (needs minisim with the scatter halo, commit `c243dca` or later)                    |

Footprints are 21 x 21 windows centred on the core peak, zero-padded where
they stick out of the frame, in FOV pixel coordinates. They are the
**unfiltered** observed footprints multiplied by the static sensor-side gains
(illumination, vignette, vessel transmission) and by
`photons_per_unit · quantum_efficiency · gain_adu_per_e`, so a footprint times
`C` is the cell's contribution to the movie in grey levels.

## Recording

The calibrated CA1 spec (`tools/minisim-calibration`, focal depth pinned at
180 um) cropped to 64 x 64 px, seed 3, no brain motion, scatter halo fraction
0.45 (the value that matches the real halo plateau), 4 s. The crop holds 10
units, 7 detectable, none in focus: dim, blurry cells, which is why the test's
bounds are modest. About 370 KB in total.
