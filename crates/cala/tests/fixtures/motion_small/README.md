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
| `make_fixture.py`      | the generator                                                                                         |

Total motion at a pixel is `shifts + spline(nonrigid_field)`, i.e. minisim's
`GroundTruth.displacement`. A motion correction estimates the negation
(`minisim.metrics.shift_rmse(..., correction=True)`).

## Recording

UCLA Miniscope V4 preset with the sensor cropped to 128 x 128 px
(1.66 um/px), CA1 region preset, 9 s at 20 fps, seed 7, plus
`presets.realistic_motion()` (the "miniscope" motion model calibrated on a
20-min V4 CA1 recording: broadband motion, bursts, drift, and the coupled 4x4
non-rigid deformation). 56 cells, 42 detectable. Rigid motion std
(0.87, 1.35) px, max |shift| (2.3, 5.7) px; non-rigid node std 0.58 px.

## How it was made

minisim commit `81e680d` ("feat: realistic miniscope brain motion and
non-rigid deformation"), branch `feat/realistic-motion` (minisim PR #33,
stacked on `feat/daq-layout` #31, both unmerged at the time), installed in a
fresh Python 3.12.15 venv (numpy 2.5.4):

```sh
git -C <minisim> worktree add --detach <scratch>/minisim-rm feat/realistic-motion
uv venv --python 3.12 <scratch>/venv
VIRTUAL_ENV=<scratch>/venv uv pip install -e <scratch>/minisim-rm
<scratch>/venv/bin/python make_fixture.py <out_dir>
```

## What it can and cannot test

The frames of this preset do not follow the ground-truth motion to better than
a few tenths of a pixel: cell activity and neuropil change the image strongly
from frame to frame (median frame-template correlation ~0.5 on the 600 x 600
version of the preset, vs ~0.8 on the real CA1 recording). An independent
Python registration of the 600 x 600 preset with an *oracle* template (the
movie un-shifted by the true motion and averaged) reaches only ~0.7 px RMS
against the truth, and the same check on a rigid-only 320 x 320 variant
~0.4 px. So the rigid test here checks tracking (correlation with the truth,
RMSE < 0.6 px; measured 0.34 px) rather than sub-pixel accuracy, which
`recovers_known_shifts_of_a_static_image` checks on a static scene (errors
below 0.015 px), and `nonrigid_recovers_a_known_field` checks the non-rigid
stage on a known smooth field.
