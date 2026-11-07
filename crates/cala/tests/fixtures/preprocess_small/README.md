# preprocess_small

A small minisim recording with known ground truth for the non-motion
preprocessing tests (`crates/cala/tests/preprocess_fixture.rs`).

- 128 x 128 px, 160 frames at 20 fps, 8-bit, 1 µm/px, 36 cells (soma radius 5 µm,
  so ~10 px across) on a jittered grid, no motion.
- Neuropil (amplitude 1.8), excitation `IlluminationProfile` (falloff 0.6),
  a strong `Vignette` (corner brightness 0.05, exponent 2.5) and a Gaussian
  `Leakage` glow (level 2.2), exposure `photons_per_unit` = 45. The glow and
  exposure are set so the background sits near 90 counts in the centre with
  cells at most ~+70 on it, like the workshop CA1 data, and nothing but hot
  and stuck pixels saturates (0.02 % of the other samples touch 255).
- `SensorDefects`: 40 hot pixels (Pareto excess, defaults), stuck pixels at
  255 (fraction 4e-4, 7 pixels), PRNU 1 %, column fixed-pattern noise with
  SD 1 count.

## Files

| file | dtype, shape | content |
|---|---|---|
| `movie_u8.npy` | u8 (160, 128, 128) | the recording |
| `hot_pixel_mask.npy` | u8 (128, 128) | ground-truth hot pixels |
| `stuck_pixel_mask.npy` | u8 (128, 128) | ground-truth stuck pixels |
| `A_observed_max.npy` | f32 (128, 128) | max over cells of the observed footprints |
| `cell_label.npy` | u16 (128, 128) | 1-based index of the dominant cell, 0 = none |
| `C.npy` | f32 (36, 160) | calcium traces |
| `illumination.npy`, `vignette.npy`, `leakage.npy` | f32 (128, 128) | the static optical fields |
| `fpn_column.npy` | f32 (128,) | per-column offset, counts |
| `noise_sigma.npy` | f32 (128, 128) | per-pixel noise σ of the sensor model (below) |
| `cells_mean.npy` | f32 (128, 128) | expected mean counts from cell light |
| `glow_mean.npy` | f32 (128, 128) | expected mean counts from everything else (neuropil, leakage; through illumination and vignette) |
| `meta.json` | | parameters and the minisim commit |

`noise_sigma` follows minisim's sensor model, `counts = floor(gain · Normal(λ,
√(λ + read²)))`: σ² = gain² (λ + read²) + 1/12, with λ recovered from the
time-mean counts (column offset removed, +0.5 for the floor). `cells_mean` and
`glow_mean` come from minisim's per-stage snapshots (`save_intermediates`):
cells = the `composite` stage times illumination and vignette, glow = the
pre-sensor intensity minus that, both times `photons_per_unit · QE · gain`.
Their sum matches the mean movie to within -0.5 (the floor) ± 3 counts.

## Regenerating

From minisim commit `ede7c36be12b12c400d9495d7b3f03ec62129646` (branch
`feat/sensor-defects`, PR #32), in a fresh Python 3.12 environment:

```bash
git -C <minisim> worktree add <dir> feat/sensor-defects
uv venv --python 3.12 venv && VIRTUAL_ENV=$PWD/venv uv pip install -e <dir>
venv/bin/python crates/cala/tests/fixtures/preprocess_small/make_fixture.py \
    crates/cala/tests/fixtures/preprocess_small
```

The defaults of `make_fixture.py` are the settings above (seed 7). The output
is deterministic (`movie_u8.npy` md5 `d469726207bd5b2580c86fc6abdfc445`).
