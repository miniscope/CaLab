# minisim calibrated to the workshop V4 CA1 recording

`ca1_workshop_calibrated.spec.json` is a minisim `Spec` (minisim `main`, at or after
e33edad, which has the `"miniscope"` motion model) tuned so that motion-correction
validation on simulated data sees real-looking content. It is built only from the
public API (`build_spec(miniscope_v4(), ca1(), ...)` plus `model_copy` overrides) in
`calibrated.py`. Load it with `calibrated.calibrated_spec(duration_s, fps, seed,
n_px=None, motion=True, nonrigid=True)`. Measure any real recording or sim with
`calibrate_to_real.py`.

Real reference: `workshop-processing-and-analysis/data/sessions/prerecorded/raw/0.avi`,
frames 0-299 (600 x 600 uint8, 20 fps), registered with the reference rigid shifts.

## Statistics

Registration band: 3x3 median filter, then a DoG with sigma 1.5 and 15 px, un-shifted
by the true (or reference) rigid shifts. Values are per-pixel power on the central
256 px. Noise is measured as variance = slope * mean + intercept, where variance is
half the mean squared frame difference, taking the median per brightness bin.

| statistic             | real 0.avi (0-299) | real, later files* | sim before (preset, 600 px) | sim after (v2 fixture, 600 px, 3 windows) | target     |
| --------------------- | ------------------ | ------------------ | --------------------------- | ----------------------------------------- | ---------- |
| static                | 40.4               | 5-15               | 4.8                         | 46-48                                     | -          |
| slow dynamic          | 7.7                | 1.0-3.0            | 7.5                         | 11.4-12.4                                 | -          |
| white                 | 0.55               | 0.40               | 3.77                        | 0.62-0.67                                 | -          |
| slow / static         | 0.19               | 0.12-0.31          | 1.56                        | 0.25-0.27                                 | 0.1-0.3    |
| white / static        | 0.014              | 0.034-0.078        | 0.79                        | 0.013-0.014                               | 0.01-0.03  |
| NCC to template       | 0.93               | 0.88-0.93          | 0.56                        | 0.90-0.91                                 | ~0.9       |
| noise slope (grey/e-) | 0.128              | 0.117-0.23         | 1.005                       | 0.135-0.136 (+6%)                         | within 20% |
| noise intercept       | 2.33               | 0.8-2.8            | 4.3                         | 1.9                                       | -          |
| mean grey in FOV      | 79.6               | 55-72              | 81.4                        | 68-75 (-9%)                               | within 20% |
| centre 64 px grey     | 117.8              | 83-109             | 120.3                       | 108-118                                   | -          |

\* files 1, 2, 3, 6, 9, 15 and 20 (frames 0-299 of each). The first ~2 minutes are
brighter and carry ~4x the static structure of the rest of the session.

At 384 px with 300 frames and rigid motion, the seed-to-seed spread is static 31-45,
slow/static 0.19-0.29, white/static 0.012-0.019 and NCC 0.90-0.93. The scope's static
field (centre seeds 0-4 at 600 px) gives a centre grey of 95-140, because the random
neuropil field sets most of the mean level.

### Radial profile (smoothed mean / centre, rings from centre to corner, 600 px)

    real   1.00 1.00 0.96 0.86 0.75 0.65 0.53 0.33 0.20 0.09 0.01 0.01
    before 1.00 1.00 0.95 0.91 0.83 0.75 0.69 0.61 0.54 0.48 0.41 0.37
    after  1.00 1.01 0.96 0.91 0.80 0.69 0.56 0.44 0.34 0.23 0.14 0.08

Out to about 60% of the half-diagonal, the profile now matches. The real field ends
at a hard round GRIN aperture edge at r ~0.85, and minisim's
`1 - (1-f)*r^p` falloff cannot reproduce that edge. A field-stop or aperture mask
would be a missing effect. It does not matter for the central registration crop.

### Vessels

The `ca1()` vessel layer is unchanged. In this recording, the vessels carry almost
none of the registration-band static power. Measure it as the share of the DoG(mean)
power inside a dark-ridge mask (Hessian, sigma 2 px). That share is 0.10-0.14 across
real files. Vessel-free sims give the same 0.10-0.12, which is the detector's
baseline, so the real vessel share is close to zero. Real static structure is
dominated by bright, static somata. In the calibrated sim, removing vasculature
leaves the static power unchanged (+9% to +14%, because the shadow is gone) and leaves
registration RMSE unchanged (0.195 vs 0.201 px). The original target "removing vessels
drops static power by > 30%" contradicts this recording. A layer strong enough to
meet it (crisp vessels at 140 um, opacity 0.7) doubles the real dark-ridge share
(0.23) and deepens the DoG dips 1.6x beyond the real ones.

## Registration check

Rigid registration with a DoG and a plain (unnormalized) cross-correlation, using a
Tukey(0.2) window, 20x upsampled peak and iterative template
(`calibrate_to_real.py register`). RMSE is measured against the true rigid shifts
after removing the common offset.

| sim                                              | before                | after                           |
| ------------------------------------------------ | --------------------- | ------------------------------- |
| 384 px, 300 frames, rigid, seed 5 / 6 / 7        | 0.607 / 0.353 / 0.654 | 0.201 / 0.299 / 0.225           |
| 600 px fixture, frames 0-299 (rigid + non-rigid) | 0.398                 | 0.257 (frames 1000-1299: 0.235) |

## Parameters changed (everything else is the `miniscope_v4()` / `ca1()` default)

| parameter                     | default                                | calibrated                                               | why                                                                                                                                                                                                                                                |
| ----------------------------- | -------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `image_sensor.gain_adu_per_e` | 1.0                                    | 0.12                                                     | real noise slope is 0.12-0.13 grey/e-; at 1.0, white/static was 30x too high                                                                                                                                                                       |
| `image_sensor.read_noise_e`   | 2.0                                    | 12.5                                                     | noise intercept is ~2.3 grey^2                                                                                                                                                                                                                     |
| `image_sensor.n_px_*`         | 608                                    | 600                                                      | DAQ frame size                                                                                                                                                                                                                                     |
| `photons_per_unit`            | 600                                    | 6500                                                     | keeps grey levels real at the lower gain                                                                                                                                                                                                           |
| `cell_activity.f0`            | 1.0                                    | 8.0                                                      | realistic baseline (a single spike is dF/F ~0.1). This gives the static somata that dominate real registration content. Activity power is unchanged                                                                                                |
| `cell_activity.brightness_cv` | 0.3                                    | 0.6                                                      | gives the few very bright static cells seen in the real mean image                                                                                                                                                                                 |
| `neuropil.amplitude`          | 0.4                                    | 0.25                                                     | haze made the frame ~35% too bright for the same cell structure                                                                                                                                                                                    |
| `illumination` / `vignette`   | falloff 0.7 / 0.6, exponent 2, centred | falloff 0, exponent 2.5, centre offset (+21.3, +66.7) um | round GRIN field, fitted to the real radial profile and mean image                                                                                                                                                                                 |
| `focal_depth_in_tissue_um`    | "auto"                                 | 180                                                      | "auto" maximizes detectable yield from each trace's max over the whole recording. For the same seed it resolved to ~183 um for 15 s and ~230 um for 2 min, which defocused the 2-min sim and cut static ~8x. 180 is the value the short runs chose |

`calibrated_spec(n_px=...)` crops to the centre of the 600 px field. It re-expresses
the falloffs and the leakage width so a crop sees the centre of the calibrated field
rather than a shrunken copy.

## Not changed / pending

- Optics and scatter are unchanged. A separate experiment is measuring the real 1p
  scatter halo, which may later sharpen cells (real somata look crisper than sim).
- There is no bleaching step. The real session dims ~30% and loses ~4x of its static
  structure after the first ~2 min.
