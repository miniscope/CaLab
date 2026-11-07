# minisim calibration

Tooling that calibrates a [minisim](https://github.com/miniscope/minisim) spec to a real
V4 CA1 Miniscope recording and renders the motion-correction fixtures from it. It lives
here rather than under `crates/cala/tests/fixtures/` because it is Python with its own
venv, not test data; the committed fixture (`crates/cala/tests/fixtures/motion_small`)
only needs its output.

- Pinned minisim commit: `e33edad` (main, includes the realistic-motion PR #33).
- `ca1_workshop_calibrated.spec.json`: the calibrated 600 px spec (focal depth pinned at 180 um).
- `calibrated.py`: `calibrated_spec(duration_s, seed=, n_px=)` re-times or crops it; `python calibrated.py` rebuilds the JSON.
- `calibrate_to_real.py`: realism statistics, real vs simulated (see `CALIBRATION.md`).
- `make_fixtures.py <dir>`: renders the 2 min 600 px DAQ fixture and a 128 px small one.
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
