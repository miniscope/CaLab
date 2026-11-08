# minisim calibration

Tooling that calibrates a [minisim](https://github.com/miniscope/minisim) spec to a real
V4 CA1 Miniscope recording and renders the motion-correction fixtures from it. It lives
here rather than under `crates/cala/tests/fixtures/` because it is Python with its own
venv, not test data; the committed fixture (`crates/cala/tests/fixtures/motion_small`)
only needs its output.

- Pinned minisim commit: `e33edad` (main, includes the realistic-motion PR #33).
- `ca1_workshop_calibrated.spec.json`: the calibrated 600 px spec (focal depth pinned at 180 um).
- `ca1_workshop_v2.spec.json`: v1 plus realistic activity (event rate, burst size and long events, giving real peak SNR), cell density, bleaching and neuropil (see `CALIBRATION.md`, "v2"). Use it to validate cell discovery and QC; the motion fixtures stay on v1.
- `calibrated.py`: `calibrated_spec(duration_s, seed=, n_px=, version="v1"|"v2")` re-times or crops either spec; `python calibrated.py [v2]` rebuilds the JSON.
- `calibrate_to_real.py`: realism statistics, real vs simulated (see `CALIBRATION.md`).
- `make_fixtures.py <dir>`: renders the 2 min 600 px DAQ fixture and a 128 px small one.
- `make_trace_sim.py OUT --f 0.45 --dur 60 [--spec ca1_workshop_v2.spec.json]`: streams a 600 px recording plus oracle footprints (with and without the scatter halo) for `crates/cala/examples/trace_eval.rs` and `discover_eval.rs`.
- `activity_stats.py RUN_DIR ...`: per-cell peak SNR, events, widths, bursts and drift of `discover_eval` traces (real or sim), using cala QC's definitions.
- `session_curve.py AVI_DIR`: grey level and static structure over a session (bleaching).
- `background_stats.py AVI_DIR`: frame-mean wander, 2-8 Hz flicker and the global share of the background.
- `neuropil_truth.py SIM_DIR ...`: global share and correlation length of a sim's true neuropil.
- `vessel_share.py REAL_AVI REAL_SHIFTS.npy [SIM_DIR ...]`: static power in vessel lines.

## Setup

```sh
uv venv --python 3.12
uv pip install "minisim @ git+https://github.com/miniscope/minisim@e33edad"
uv pip install scipy zarr  # extra deps of the scripts
```

## Regenerate the fixtures

```sh
# large fixtures (not committed): writes <dir>/daq_v4_2min_realmotion_v2 and <dir>/small_realmotion_v2
.venv/bin/python make_fixtures.py <dir>

# the committed fixture: spec from the calibrated spec, then render + cut to 180 frames
.venv/bin/python -c "
from calibrated import calibrated_spec
open('../../crates/cala/tests/fixtures/motion_small/spec.json','w').write(
    calibrated_spec(15.0, seed=7, n_px=128).model_dump_json(indent=1))"
.venv/bin/python ../../crates/cala/tests/fixtures/motion_small/make_fixture.py <out_dir>
cp <out_dir>/*.npy ../../crates/cala/tests/fixtures/motion_small/
```

Real recordings are not in the repo; `calibrate_to_real.py` and `vessel_share.py` take their paths as arguments.
