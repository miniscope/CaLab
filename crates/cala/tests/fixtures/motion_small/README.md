# motion_small

A small minisim recording with realistic brain motion, used by
`crates/cala/tests/motion.rs`.

| File                   | Contents                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `movie.npy`            | `uint8 (180, 128, 128)`: the observed movie (sensor counts, 20 fps)                                   |
| `shifts.npy`           | `float64 (180, 2)`: true rigid motion `(dy, dx)` in px, content displacement (positive = down/right)  |
| `nonrigid_field.npy`   | `float64 (180, 4, 4, 2)`: non-rigid node displacements on top of `shifts`, same convention            |
| `nonrigid_nodes_y.npy` | `float64 (4,)`: node rows in FOV px (edge to edge); natural cubic spline between nodes                |
| `nonrigid_nodes_x.npy` | `float64 (4,)`: node columns                                                                          |
| `spec.json`            | the minisim spec                                                                                      |
| `make_fixture.py`      | regenerates the arrays from `spec.json`                                                               |

Total motion at a pixel is `shifts + spline(nonrigid_field)`, i.e. minisim's
`GroundTruth.displacement`. A motion correction estimates the negation
(`minisim.metrics.shift_rmse(..., correction=True)`).

## Recording

UCLA Miniscope V4 preset with the sensor cropped to 128 x 128 px
(1.66 um/px), CA1 region preset, seed 7, plus `presets.realistic_motion()`
(the "miniscope" motion model calibrated on a 20-min V4 CA1 recording:
broadband motion, bursts, drift, and the coupled 4x4 non-rigid deformation).
The photon budget and gain are the content-calibrated values
(`photons_per_unit` 6500, `gain_adu_per_e` 0.12), which bring the
static-to-dynamic content balance after the registration band-pass closer to
the real CA1 recording. The spec simulates 15 s; the fixture keeps the first
180 frames (9 s) to stay under 3 MB. Rigid motion std (0.99, 0.88) px.

## How it was made

minisim commit `e33edad` (main, includes the realistic-motion PR #33),
in a Python 3.12 venv (numpy 2.5.4):

```sh
<venv>/bin/python make_fixture.py <out_dir>
```

`spec.json` is `tools/minisim-calibration/calibrated.py`'s `calibrated_spec(15, seed=7, n_px=128)`,
with the focal depth pinned to 180 um (not "auto", which picked an out-of-focus plane). See
`tools/minisim-calibration/README.md`.

## What it can and cannot test

Even calibrated, the frames do not follow the ground-truth motion exactly:
cell activity changes the band-passed image from frame to frame, and with
little static structure in a 128 px field the registration peak moves with
it. The diagnosis on 384 px variants: with activity switched off the same
corrector reaches 0.037-0.11 px RMS; with it on, ~0.55-0.65 px before the
content calibration. On this calibrated fixture the rigid RMSE is 0.28 px
(0.17 px with the earlier auto-focus spec, whose focal plane sat further from the cells). So the rigid
test checks tracking (correlation with the truth and a loose RMSE bound)
rather than sub-pixel accuracy, which
`recovers_known_shifts_of_a_static_image` checks on a static scene (errors
up to 0.03 px on its 96 px region), and `nonrigid_recovers_a_known_field` checks the non-rigid
stage on a known smooth field.
