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
- There is no bleaching step in v1. The real session dims ~30% and loses ~4x of its
  static structure after the first ~2 min. v2 (below) shows that most of this is a
  one-frame excitation step at 92 s, which minisim cannot express. The rest is a ~9 %
  dimming over the first minute, which v2 models.

# v2: activity, bleaching and background (`ca1_workshop_v2.spec.json`)

v1 matched what motion correction sees, but its cells were much brighter and busier
than the real ones, so cell discovery and QC were validated on easy data. v2 keeps
v1's optics, sensor, illumination, vessels and motion. It recalibrates activity and
background through spec parameters only (`calibrated._build_v2`,
`calibrated_spec(..., version="v2")`). v1 is unchanged and still drives the motion
fixtures.

## How it was measured

Activity is compared on cala's own traces, so the cell selection, the trace floor and
the background model are the same on both sides.
`crates/cala/examples/discover_eval.rs` (slow loop, pass-2 traces) runs on two 2-min
windows of the real recording (minutes 0-2 and 7-9, `--motion`). It also runs on 2-min
sims (`make_trace_sim.py --f 0.45 --dur 120 [--spec ...]`, seeds 0 and 1, no motion).
`activity_stats.py` then applies cala QC's definitions (`crates/cala/src/qc`) to each
60 s window:

- Peak SNR uses the CaLab robust convention: the mean of the top 1 % minus the median,
  divided by the MAD-of-differences noise.
- Events are runs of the 0.25 s running mean above 2 sigma whose peak reaches 4 sigma.
  Each event gives a half-height width, a rise and a decay.

Other statistics use these scripts:

- `session_curve.py`: the session curve.
- `background_stats.py`: the frame-mean wander and the flicker.
- `neuropil_truth.py`: the neuropil structure, from the sims' ground truth.
- `calibrate_to_real.py`: the registration statistics, on the same basis as the v1
  table (300 frames, 600 px, seeds 0 and 1).

## Result

Quartiles are over cells. Real values are minutes 0-2 and 7-9. Sim values are seeds 0
and 1.

| property                                        | real                                   | v1 spec                      | v2 spec                                |
| ----------------------------------------------- | -------------------------------------- | ---------------------------- | -------------------------------------- |
| cala cells found in 2 min                       | 371, 359                               | 647, 618                     | 382, 382                               |
| peak SNR q25 / median / q75                     | 12.4 / 21.1 / 35.0, 12.4 / 20.0 / 31.5 | 26 / 37 / 56, 28 / 41 / 61   | 13.6 / 20.4 / 29.9, 13.0 / 18.5 / 26.6 |
| events per min per cell, median (IQR)           | 6.5 (5-8.5), 7.0 (5.5-9)               | 13 (11.5-14.5), 14 (12.5-15) | 7.0 (5.5-8.5), 6.5 (5.5-8)             |
| event width at half height, median (q75), s     | 0.60 (1.25), 0.55 (1.05)               | 0.50 (0.65)                  | 0.58 (1.15), 0.60 (1.20)               |
| events wider than 2 s                           | 14 %, 12 %                             | 0.1 %                        | 13 %, 14 %                             |
| rise, median, s                                 | 0.18, 0.13                             | 0.13                         | 0.13, 0.18                             |
| decay (80 % to 50 %), median (q75), s           | 0.18 (0.38), 0.18 (0.33)               | 0.18 (0.23)                  | 0.18 (0.33)                            |
| inter-event intervals under 2 s (bursts)        | 26 %, 33 %                             | 26 %, 27 %                   | 27 %, 26 %                             |
| drifting cells (baseline > 5 sigma, > 1/4 peak) | 23 %\*, 12 %                           | 1 %, 2 %                     | 0.5 %, 0.3 %                           |
| frame dimming over the first 60 s               | -9 %, then flat\*\*                    | none                         | -10 % (mean B 0.90), then flat         |
| frame-mean wander (1 s means, detrended)        | 1.5 %, 1.8 %, 1.4 % (min 0, 3, 10)     | 3.9 %, 3.8 %                 | 1.2 %, 1.5 %                           |
| neuropil global share, local 1/e scale          | ~0.9, 100-120 px (earlier analysis)    | ~0.99, ~36 px (truth)        | 0.94-0.99, 95-99 px (truth)            |
| flicker, 2-8 Hz RMS of the frame mean           | 0.5 % (min 0-1), 1.6 % (later)         | 0.3-0.5 %                    | 0.2 %                                  |
| static (registration band)                      | 40.4 (early), 5-15 (later)             | 48.9, 49.5                   | 38.9, 34.5                             |
| slow / static, white / static                   | 0.19, 0.014 (early)                    | 0.19-0.24, 0.011-0.013       | 0.10-0.11, 0.009-0.013                 |
| NCC to template                                 | 0.88-0.93                              | 0.91-0.93                    | 0.95                                   |
| noise slope (grey/e-), intercept                | 0.128, 2.33                            | 0.135-0.137, 1.84-1.88       | 0.125-0.132, 2.0-2.2                   |
| mean grey in FOV                                | 79.6 (early), 55-72 (later)            | 60-68                        | 50-63                                  |
| rigid registration RMSE (px)                    | -                                      | 0.13-0.15                    | 0.10-0.12                              |

\* Minutes 0-2 contain the excitation step at 92 s (see below), which reads as baseline
drift. \*\* Followed by a one-frame -24 % step at 92 s.

Downstream cala results on 2-min sims (no motion unless stated; seeds 0 and 1):

| eval                                                              | v1 spec                    | v2 spec                    |
| ----------------------------------------------------------------- | -------------------------- | -------------------------- |
| trace_eval, oracle footprints (full, rank3): trace r median (p10) | 0.955 (0.72), 0.957 (0.70) | 0.917 (0.54), 0.905 (0.57) |
| trace_eval: crosstalk p90; amplitude bias, median                 | 0.11-0.14; -0.07           | 0.22-0.25; -0.23\*\*\*     |
| discover_eval: precision                                          | 0.937, 0.945               | 0.974, 0.961               |
| discover_eval: recall, all (in focus)                             | 0.736 (0.89), 0.725 (0.86) | 0.633 (0.78), 0.630 (0.77) |
| discover_eval: pass-2 trace r of matched cells                    | 0.958, 0.959               | 0.946, 0.940               |
| discover_eval with motion, seed 0: precision, recall, r           | 0.861, 0.716, 0.951        | 0.903, 0.668, 0.941        |

\*\*\* The ground-truth `C` excludes bleaching (the movie carries `C * B`), so the oracle
counts the bleached amplitude as bias.

## Parameters changed from v1

| parameter                                  | v1    | v2                                                   | why                                                                                                                            |
| ------------------------------------------ | ----- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `cell_activity.p_quiescent_to_active`      | 0.005 | 0.002                                                | event rate: one bout every ~25 s per cell                                                                                      |
| `cell_activity.p_active_to_quiescent`      | 0.3   | 0.02                                                 | long bouts (mean 2.5 s, geometric): the multi-second humps and plateaus of real CA1 traces                                     |
| `cell_activity.active_rate_hz`             | 150   | 18                                                   | burst size, which sets peak SNR. v1's 25-spike bursts in 0.17 s doubled the real SNR                                           |
| `cell_activity.quiescent_rate_hz`          | 0.6   | 0.05                                                 | v1's single-spike background was detected as extra events                                                                      |
| `cell_activity.tau_decay_s`                | 0.5   | 0.7                                                  | event widths and decays slightly longer than v1's                                                                              |
| `cell_activity.brightness_cv`              | 0.6   | 0.9                                                  | a wider SNR spread across cells                                                                                                |
| population density (cytosolic, 140-160 um) | 45000 | 33750                                                | as many cala cells in 2 min as real                                                                                            |
| `bleaching` step (new)                     | -     | susceptibility 6.3e-6, excitation 100, turnover 33 s | the real frame dims ~9 % over the first minute, then holds. The short turnover stands in for reversible (dark-state) bleaching |
| `neuropil.spatial_sigma_um`                | 40    | 190                                                  | ~100 px correlation length of the local background field                                                                       |
| `neuropil.n_components`                    | 3     | 5                                                    | adds some local variance (v1 was ~99 % global)                                                                                 |
| `neuropil.population_coupling`             | 0.7   | 0.85                                                 | frame-mean wander down from 3.8 % to ~1.5 %                                                                                    |

## What minisim cannot express

None of these got a minisim PR. Each is a candidate if it turns out to matter.

- **Per-cell slow baseline drift.** In 12 % of real cells (minutes 7-9) the baseline
  wanders by more than 5 sigma and more than a quarter of the cell's peak within 2 min.
  In v2 it is ~0.5 %. minisim has no per-cell slow baseline process. The neuropil is
  smooth (~100 px), and bleaching is monotone and saturates within a minute.
- **Per-cell firing heterogeneity.** One `cell_activity` step drives every cell, so rates
  and burst sizes vary between cells only through brightness. The real SNR upper
  quartile is 15-20 % above v2's.
- **LED flicker.** The real frame mean carries multiplicative flicker of ~1.5 % RMS in
  2-8 Hz after the first minute, plus an additive offset, and minisim has no
  time-varying excitation or offset. Inject it with `trace_eval --inject-flicker`.
- **The excitation step.** At 92 s (frame ~1850) the frame drops 24 % in one frame and
  then stays flat. This looks like an LED or gain change, not bleaching, and has the
  same missing cause as the flicker. It makes most of the gap noted above, where the
  first 2 minutes are brighter and carry ~4x the static structure.
- **Global share of the background.** `n_components` sets most of it, and over a 2-min
  window it varies strongly with the seed (0.78-0.99 for 5-6 components), so it only
  matches on average.

The mean grey is still set mostly by the random neuropil field (50-63 for v2 seeds 0
and 1). It falls in the later session's range rather than the first minute's.

# v3: cell size and optical blur (`ca1_workshop_v3*.spec.json`, 12 Nov 2026)

The v2 ground-truth footprints measure 14.4 px as half-max equivalent diameter
(`d = 2 sqrt(A_half / pi)`) and 3.3-3.8 px of edge blur; cala's footprints on the workshop
recording measure 9.8-10.2 px and about 1.5 px. v3 recalibrates the cells and the
optics to the real values. `make_v3_specs.py` writes the three JSONs from v2; its
comments give every change and why. Measurements are in
`tools/cala-eval/results/2026-11-12-sim-v3-scales.md`.

| parameter                                   | v2      | v3                                | why                                                                   |
| ------------------------------------------- | ------- | --------------------------------- | --------------------------------------------------------------------- |
| `tissue.scatter_blur_per_um`                | 0.05    | 0.010                             | scatter sigma (0.05 x 180 um = 9 um = 5.4 px) is most of v2's blur    |
| `place_neurons` cytosolic `soma_radius_um`  | 5.0     | 8.3 (size6 4.6, size16 13.1)      | with less blur the cells measure 6.9 px at 5 um; 8.3 um gives 10.1 px |
| `place_neurons` cytosolic `density_per_mm3` | 33750   | 50625 (size6 50625, size16 32737) | holds ~640 detectable cells per 600 px frame                          |
| `place_neurons` cytosolic `depth_range_um`  | 140-160 | 172-188                           | a layer straddling the focal depth (180 um)                           |
| `optics.field_curvature_radius_um`          | 2500    | none (flat)                       | see below                                                             |
| `neuropil.amplitude`                        | 0.25    | 1.5 (size6 1.5, size16 1.65)      | holds the mean grey level (64)                                        |
| `sensor.photons_per_unit`                   | 6500    | 1800                              | holds the per-cell peak SNR (and the 1.0.3 detectable flag)           |

The pixel size (4.8 um / 2.9 = 1.655 um) is unchanged, so vessels, neuropil field,
illumination, leakage, motion, activity and the frame stay as in v2 in pixels. Changing
the pixel pitch instead would rescale all of them and needs `--npx` changes to keep the
field.

Things learned while calibrating (all measured by short generations):

- **Detectability was a point-source test (minisim <= 1.0.3; fixed in 1.1.0, see below).** `detectable` used `sigma_0^2 / sigma_tot^2`
  (`sigma_0` = diffraction + scatter), which collapses once defocus exceeds the scatter
  blur, and `photons_per_unit`; it does not depend on the cell's size. With v2's wide
  scatter blur nearly all cells pass; with a sharp PSF only cells within a few um of the
  focal surface do. With the 2500 um field curvature that surface is a bowl, so
  detectable cells formed a ring (13 in the centre cell of a 3 x 3 grid, 130 at the edges).
  v3 therefore uses a flat field and a layer centred on the focal depth.
- **The grey level and the detectable count depend on the recording length** (the
  neuropil envelope draws differ with the number of frames), so v3 was tuned at the full
  480 s, not on short runs.
- **The haze sets the grey level.** The mean grey is mostly the neuropil field, which scales
  with `photons_per_unit x amplitude`. Bigger cells add haze, so the larger the cell the
  more the amplitude must rise to hold the mean.
- A sharper, bigger cell concentrates its light: at `photons_per_unit` 6500 the median
  peak SNR would be 4x v2's. 1800 brings it to 1.2x (3.5 against 2.9 on the proxy of the
  results note); lower values lose detectable cells at the frame edge.

Residual differences from v2 (documented, not hidden): the mean-image centre is 102
against v2's 116 (mean over the frame matches: 63 against 64); detectable cells are less
uniform over the frame (3 x 3 min/max 0.5 against 0.7, from the illumination falloff);
the peak SNR proxy is 20 % higher; the edge blur is 1.37 px against about 1.5; the
cell layer is thinner (16 um).

# Detectability with minisim 1.1.0 (12 Nov 2026)

minisim 1.1.0 (miniscope/minisim#36) replaces the point-source `detectable` test described in the v3 section. A cell is now detectable when its matched-filter SNR is at least 110. The SNR pools the realized footprint over its pixels and all the cell's transients, against per-pixel shot and read noise. The threshold is where cala recovers half the cells on `size6_static`, and it holds without retuning on `v3_static`. The ground truth of every sim was rewritten in place; v2's goes to `sims-gt110/` while `sims/` is in use. The videos are unchanged. Details, recovery curves and per-arm counts are in `tools/cala-eval/results/2026-11-12-matched-filter-detectable.md`.

| `static_s5`                                 | v2 before   | v2 after    | v3 before   | v3 after    |
| ------------------------------------------- | ----------- | ----------- | ----------- | ----------- |
| detectable cells (all units)                | 635 of 666  | 646 of 666  | 632 of 829  | 806 of 829  |
| P8 / R8 (same cala run)                     | 0.979/0.785 | 0.979/0.787 | 0.824/0.960 | 0.985/0.933 |
| cala cells matched to a non-detectable unit | 0           | 0           | 116         | 0           |

Over seeds 5-9, v3 static now has 805 detectable cells (801-809) where it had 649, and v2 static has 652 where it had 639. With the new flag the ring under field curvature disappears. The flat field and the layer at the focal depth chosen for v3 are therefore no longer needed for an even spread of detectable cells. They were kept so the v3 recordings stay as they are.
