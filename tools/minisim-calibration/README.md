# minisim calibration

Tooling that calibrates a [minisim](https://github.com/miniscope/minisim) spec to a real
V4 CA1 Miniscope recording and renders the motion-correction fixtures from it. It lives
here rather than under `crates/cala/tests/fixtures/` because it is Python with its own
venv, not test data; the committed fixture (`crates/cala/tests/fixtures/motion_small`)
only needs its output.

- Pinned minisim commit: `e33edad` (main, includes the realistic-motion PR #33).
- `ca1_workshop_calibrated.spec.json`: the calibrated 600 px spec (focal depth pinned at 180 um).
- `ca1_workshop_v2.spec.json`: v1 plus realistic activity (event rate, burst size and long events, giving real peak SNR), cell density, bleaching and neuropil (see `CALIBRATION.md`, "v2"). Use it to validate cell discovery and QC; the motion fixtures stay on v1.
- `ca1_workshop_v2_fpn.spec.json`: v2 plus a `sensor_defects` step (PRNU 2.4 %, column offsets 1.0 ADU, default hot pixels). It reproduces the workshop data's sensor-fixed pixel pattern: 2.4 grey levels SD, 2.7 % of brightness, which motion correction turns into a slow pixel-scale shimmer. See `tools/cala-diagnostics/PIXEL_NOISE.md`. On the GT sims tested so far the pattern does not hurt discovery. Use this spec when testing anything that is sensitive to pixel-scale texture.
- `calibrated.py`: `calibrated_spec(duration_s, seed=, n_px=, version="v1"|"v2")` re-times or crops either spec; `python calibrated.py [v2]` rebuilds the JSON.
- `calibrate_to_real.py`: realism statistics, real vs simulated (see `CALIBRATION.md`).
- `make_fixtures.py <dir>`: renders the 2 min 600 px DAQ fixture and a 128 px small one.
- `make_trace_sim.py OUT --f 0.45 --dur 60 [--spec ca1_workshop_v2.spec.json]`: streams a 600 px recording plus oracle footprints (with and without the scatter halo) for `crates/cala/examples/trace_eval.rs` and `discover_eval.rs`.
- `activity_stats.py RUN_DIR ...`: per-cell peak SNR, events, widths, bursts and drift of `discover_eval` traces (real or sim), using cala QC's definitions.
- `session_curve.py AVI_DIR`: grey level and static structure over a session (bleaching).
- `background_stats.py AVI_DIR`: frame-mean wander, 2-8 Hz flicker and the global share of the background.
- `neuropil_truth.py SIM_DIR ...`: global share and correlation length of a sim's true neuropil.
- `vessel_share.py REAL_AVI REAL_SHIFTS.npy [SIM_DIR ...]`: static power in vessel lines.

## Sim arms for the cala evaluation

All arms are 600 px, 480 s, seeds 5-9, generated with `make_trace_sim.py OUT --dur 480 --npx 600 --seed S --spec SPEC [--motion]`.

| arm      | spec                             | flags                              | what it adds                                                                                        |
| -------- | -------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `static` | `ca1_workshop_v2.spec.json`      |                                    | reference                                                                                           |
| `motion` | `ca1_workshop_v2.spec.json`      | `--motion`                         | mask edge, shimmer, shift dipoles                                                                   |
| `halo`   | `ca1_workshop_v2_halo.spec.json` | `--motion`                         | scatter halo: 45 % of each cell's light in a broad diffuse wing (`scatter_halo_fraction` 0.45)      |
| `oof`    | `ca1_workshop_v2_oof.spec.json`  | `--motion --target-depth-um 0 200` | halo, plus an out-of-focus soma population 200-280 um deep (20-100 um below the 180 um focal plane) |
| `fpn`    | `ca1_workshop_v2_fpn.spec.json`  | `--motion`                         | PRNU and column fixed-pattern noise                                                                 |

**Halo.** 0.45 was tuned earlier to look like the real recording; the halo spec is `v2` plus that one field.

**Out-of-focus population.** The oof spec adds a second entry to the `place_neurons` populations: `morphology: "soma"`, radius 7 um, depth 200-280 um, 4000 cells/mm3 (about 310 cells in the 600 px field, next to about 720 in-focus ones). At those depths minisim blurs a soma to a core sigma of 9-20 px, so it renders as a dim, extended, coreless blob, which is the "textured dim blob" the cala slow loop turns into false cells.

- Density: the deep population is 12 % of the in-focus layer's density (33750/mm3). Below the pyramidal layer there are few labelled somata.
- Haze: the deep cells add diffuse light. At 25000/mm3 the field centre is 50 % brighter than the real recording. The spec therefore lowers the static `leakage` glow from 0.08 to 0.04, so the mean grey (41 vs 42) and the centre (83 vs 83) match the real recording at the same display range.
- RAM: `make_trace_sim.py` peaks at 2.6 GB for a halo sim and 3.6 GB for an oof sim at 600 px and 480 s, and the oof peak grows with the number of units (about 3 MB each).
- Detectability: minisim's `detectable` is a pure SNR test, so a blurred deep cell can still pass it (27 % of the 200-280 um cells do at 25000/mm3). The oof cells are nuisance, not targets, so `--target-depth-um 0 200` clears `detectable` in `oracle.bin` for every unit deeper than 200 um. In-focus units are all shallower than 200 um, so the target set matches the other arms. `in_focus` and the rest of the oracle are unchanged.

**Shallow variant.** `ca1_workshop_v2_oof_shallow.spec.json` puts 8000 cells/mm3 at 185-235 um (core sigma 6-13 px), generated with `--target-depth-um 0 185`. It is brighter than the real recording (centre +6 %, mean +25 %). On seed 6 the main binary recovers 24 of its cells as cells (all matched to non-detectable units), where the 200-280 um spec gives none.

**Measured on the seed 5-6 sims (main at 18bffa1, default budget, FP classes at frame 9600).**

| arm              | cells | P@8   | R@8   | noise | adjacent | partial | dup | matches to a non-detectable unit |
| ---------------- | ----- | ----- | ----- | ----- | -------- | ------- | --- | -------------------------------- |
| motion s5        | 521   | 0.893 | 0.749 | 17    | 15       | 18      | 6   | 0                                |
| halo s6          | 499   | 0.872 | 0.682 | 36    | 16       | 8       | 4   | 0                                |
| oof s5           | 458   | 0.937 | 0.690 | 5     | 2        | 19      | 2   | 1                                |
| oof s6           | 474   | 0.935 | 0.697 | 5     | 5        | 19      | 2   | 0                                |
| oof (shallow) s6 | 485   | 0.891 | 0.670 | 6     | 6        | 16      | 1   | 24                               |

The halo arm doubles the `noise` class (leftover light). The 200-280 um oof arm does not add textured false cells: its extra population is smooth enough (blur above 9 px) that the pipeline mostly ignores it. The halo s5 sim stalls `qc_eval` before its first checkpoint (see the PR), so halo is shown on seed 6.

Display and statistics check against the real recording (`tools/cala-diagnostics/compare_sim_real.py`, fixed display ranges, no auto-contrast): `residual_after_cells.py sim SIM --det-only` fits only the detectable units, so the nuisance light stays in the residual.

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
