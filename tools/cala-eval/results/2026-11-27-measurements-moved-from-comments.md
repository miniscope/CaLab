# Measurements moved out of code comments (crate sweep, 27 Nov 2026)

The comment policy (`/CLAUDE.md`) keeps measured numbers out of code comments. These are the
measurements the crate comments carried before the sweep, verbatim, grouped by the file they
documented. Fragments are quoted as they stood; `git log -p` on the file gives the full context.

## `crates/cala/src/motion/corrector.rs`

> Default 384: beyond it accuracy no longer improves but cost does.

## `crates/cala/src/motion/mod.rs`

> texture is a sizeable fraction of the shift (0.7 px of 4.6 px on a
> 108 px region before; under 0.015 px after). The peak is refined to a

> dominate and returns (0, 0) even for a known 3 px shift; plain

> slowly varying registration bias integrates into a drift of ~0.5 px
> over 20 minutes). Frames whose brightness or peak quality is anomalous

## `crates/cala/src/motion/session.rs`

> cost P8 .95 → .80 and doubled the adds, because neither the rigid shift

> rotation the data do not ask for still raises the peak a little: on a
> 64 x 48 test movie with no rotation, 0.28° gave ncc .9633 against
> .9630);

## `crates/cala/src/motion/xcorr.rs`

> division over-corrects it and the shift reads too large: by about 9 % for
> a lone blob and up to about 1.3x (plus a fixed part) for a tight cluster
> with a broad correlation peak. The corrector's rigid stage re-cuts the

> rely on band-passed images that fill the window. On the v3 motion sims
> switching the division off changes the rigid shift by about 0.001 px RMS
> (`tools/cala-eval/results/2026-11-26-motion-xcorr-bias.md`).

## `crates/cala/src/preprocess/background.rs`

> a downward step in baseline brightness (the workshop CA1 data drops from
> ~53 to ~41 at file 2) and bleaching, but it has two failure modes:

> snaps; about 2.7 σ_s below the mean for α = 1/2400) instead of drifting.

> (120 s at 20 fps): a 5 s burst loses about 4 % of its amplitude at its
> end, while a baseline rise is 95 % tracked after 3 · 120 s = 6 min.

> and a frame counter: `(k + 1) · W · H` floats (8.6 MB at 600x600, k = 5).

> its level above the floor, about 1.3 σ, and 0, an edge of false
> events along the FOV edge; measured on the minisim motion
> recordings.) It is NaN while the pixel has no valid sample yet, and

## `crates/cala/src/preprocess/flatfield.rs`

> the workshop CA1 recording (D4 diagnosis, Nov 2026) the motion-response
> images of the registered video are explained by this pattern (R² 0.55-0.65
> of their high-passed variance) and not at all by misregistered tissue
> (R² 0.001), and 75 % of the texture-flagged cells had traces with a
> cross-validated motion R² above 0.2 (6 % of the others).

> temperature. On the workshop recording the column profile is 12 % of the
> high-passed log-gain variance, and the column offsets measured in the
> unlit rows explain about a sixth of that (r .41, slope .74 where a pure
> offset predicts 1): the column structure is part offset, part gain.

> switch at a batch boundary (on the workshop recording it moves the
> corrected mean image by 0.8 σ median per pixel), later refinements are
> small (median 0.07 σ falling to 0.02 σ, 99th percentile below 0.35 σ;
> [`FlatFieldUpdate`]). What the slow loop accumulated across a change:

> gain above 1 (see tools/cala-eval/results/2026-11-27-ff-motion-gain.md).

## `crates/cala/src/preprocess/flatten.rs`

> two references on this data: minian's tophat window (radius 20 px) and

## `crates/cala/src/preprocess/flicker.rs`

> that keeps at least [`FlickerConfig::grid_pixels`] pixels: 4287 at stride 8
> on the workshop data's 600x600 frames). The fit is trimmed least squares:

> regression cannot tell from flicker: on a 600x600 calibrated minisim
> render without flicker the stage reads `m` with an RMS of 1.4 % at 1 s, of
> which 0.3 % is in the 2–8 Hz band (0.8 % / 0.3 % at 0.25 s, 1.8 % / 0.3 %
> at 2 s), while the band-limited recovery of an injected flicker is the
> same for all three (r 0.95–0.96).

> moves the fine texture. Measured on the workshop CA1 data (frames
> 5000–7000, `examples/flicker_eval.rs`): estimating on the raw frames after
> the recorded motion correction leaves 4.0 % of the 2–8 Hz pixel power in
> the common mode, against 0.4 % in sensor coordinates (12.4 % before).

> fit (the dominant kind on the workshop data) and reports
> [`FlickerRecord::separable`] `= false`. On the workshop data the contrast
> is 0.39 and every frame separates, but the split is only moderately
> identified: regressing each pixel's 2–8 Hz series on the estimated `a_t`
> and `m_t` gives a loading of 0.95 on `a_t` and `13 + 0.73 · F0` on `m_t`
> (`F0` the pixel's mean), so part of an offset that moves with the gain is
> booked as gain. Their sum, the change at each pixel, is what is removed.

> Proportional to the grid (~11 µs per 1000 grid pixels: four passes and two
> selections) plus one multiply-add over the FOV: 62 µs per 600x600 frame
> native, ~0.1 ms in WASM.

## `crates/cala/src/preprocess/fov.rs`

> sensor reads only its dark level (the workshop CA1 data: corners ~0 against
> ~115 in the centre), and every later stage should ignore those pixels: they

> A real lens disk fails neither by a wide margin (CA1 data: ~60% of the
> frame, a contrast of hundreds of noise sigmas).

## `crates/cala/src/preprocess/gaussian.rs`

> `σ² = Σₖ 2 dₖ / (dₖ − 1)²`, is exactly the requested σ². The older
> Young & van Vliet (1995) closed-form coefficients were tried first and
> rejected: their effective σ is 8-13 % larger than requested (measured
> 21.7 for σ = 20) with heavy tails (kurtosis 5.7 against 3), which breaks
> the derivative identity the flattening stage relies on. Measured here: the

> to within 2 % of its peak for σ ≥ 5 (4 % at σ = 2, 7 % at σ = 1; see the
> tests).

## `crates/cala/src/preprocess/hot_pixels.rs`

> Default `k = 5`: on the workshop CA1 data (global σ_r ≈ 2.25 grey
> levels) the cut is ≈ 11 levels, close to the +10 reference used to
> describe that recording, and far beyond the Gaussian tail of the texture
> (a 5σ one-sided tail is 3 pixels in 10⁷).

## `crates/cala/src/preprocess/lines.rs`

> the clipped mean of the noise is biased by only −0.02 σ. Three passes over

> Its default (both) comes from the workshop CA1 recording, measured by
> `examples/preprocess_eval.rs` on 2000 frames after flattening:

> - **Rows carry per-frame noise.** The frame-to-frame MAD-diff σ of a row's
>   mean is 0.42 grey levels where white pixel noise alone gives 0.13
>   (3.3x); for columns it is 0.17 against 0.13. Shared row noise couples
>   the noise of cells on the same rows: 9x9-pixel blocks on the same rows
>   had a noise correlation of 0.035 (0.000 across rows). Correcting rows
>   brings it to −0.016 and lowers the block-trace noise by 2.6 % (3.3 %
>   with columns too).

> flattened mean image has 0.85 grey levels of column-to-column structure
> (rows: 0.15). Without motion the background stage absorbs it (it is

> The cost is 0.34 ms per 600x600 frame for both.

## `crates/cala/src/preprocess/noise.rs`

> An exact per-pixel median needs every past |Δy| (or a histogram per pixel:
> 32 bins x 360 k pixels x 2 bytes = 23 MB at 600x600, plus a choice of bin
> range). Two O(1)-memory estimators are offered:

> σ = 3 the undithered tracker reads 4 % high (3.13 against 3.01, see the

> σ smoothly (3.03); the dither adds 1/12 to the variance of Δy, a bias of
> +0.5 % at σ = 3 grey levels (+4 % at σ = 1). After flattening, real frames
> are no longer exactly integer and the dither makes no measurable
> difference there; it matters for raw integer input.

> On the workshop CA1 data (`examples/preprocess_eval.rs`, 4000 frames) the
> tracker equals the batch MAD-diff of the last 600 frames to 0.1 %. It reads
> 4 % below the batch value over all 4000 frames, correctly: the noise fell
> with the brightness step at frame 2000 (shot noise), and the tracker
> follows the present. On the minisim fixture it matches the simulator's
> per-pixel σ to 0.3 % off cells.

## `crates/cala/src/preprocess/pipeline.rs`

> the estimate low (by ~4 % over the first 160 frames of the minisim
> fixture, while the floor is still settling).

> Those samples are missing, not data (on the minisim motion
> recordings, the median-|Δ| σ of a pixel 1 px inside the mask edge
> fell to about half that of the tissue next to it, and the on/off
> light read as 5-30 σ events that grew false cells):

## `crates/cala/src/preprocess/session.rs`

> to follow it. Measured on stitched sims
> (`tools/cala-eval/results/2026-11-13-session-boundary.md`): a ×1.25 step
> lifts every cell's baseline by ~5 % of its peak for ~150 frames, mostly
> because the background floor (a running minimum) drops at once but rises
> with τ = 120 s; the flicker reference holds the step for ~1 s first; the
> noise map needs ~800 frames to follow.

> reset would also remove the bump (measured: +5.1 % → +1.4 %) but warms
> up on frames that hold activity and dips by ~1 %; a rescaled floor
> keeps everything the old one had learned.

## `crates/cala/src/qc/heldout.rs`

> wrong by the residual's spatial correlation (5–12× on real data). The

> The plan's estimator of `μ` was the median of `g_k,t`; it is 0 (most
> placebos are clamped at 0 on most frames), so it would not penalise
> anything. The mean is the expected gain of a non-cell column.

## `crates/cala/src/qc/mod.rs`

> Every metric was checked against ground truth (`examples/qc_eval.rs`):
> minisim recordings run through the merged fast and slow loops (1759
> cells, 1540 true positives, three recordings), the GT footprints with a
> share deliberately wrong (shifted, merged, split, a neighbour deleted),
> and 10 min of real CA1 data against Minian. Numbers are AUC for "detected
> cell is real" and Spearman ρ with the true trace r.

> - **Trace quality, validated.** [`TraceStats::peak_snr`] (CaLab robust
>   peak SNR): AUC 0.80, ρ 0.78 on sims, 0.95 with oracle footprints; on
>   real data AUC 0.75 for "also found by Minian", ρ 0.39 with the trace r
>   against Minian. `proj_r` (trace vs the cell's own footprint
>   projection): AUC 0.71, ρ 0.57 (oracle); real AUC 0.64, ρ 0.37.
> - **Demixing, validated.** `vif` (noise inflation from the local Gram
>   matrix) and `max_overlap` rank true crosstalk (ρ 0.44-0.47 with the
>   neighbours' share of the trace variance). `max_neighbour_r` finds split
>   cells (AUC 1.00 against unperturbed cells; r > 0.8 flags 87 % of split
>   halves and no unperturbed cell) and duplicates: in a pair above 0.8 the
>   lower-SNR member is the extra cell in 22 of 45 pairs, the other in 3.
>   `fp_error` (residual a cell leaves when it fires, relative to its SNR)
>   ranks wrong footprints (AUC 0.68-0.73 for shifted, merged, missing
>   neighbour; inverted AUC 0.71 for real cells) but no threshold separates
>   them, so it is a colour scale, not a flag.

> (fast rise, slow decay) predict real cells on sims (AUC 0.82 / 0.66) but
> not on the real recording (0.52 / 0.60), whose transients rise over
> several frames. `slow_frac` is not a failure: on the real recording the
> slow "humps" are long calcium events that Minian finds too (low-pass r
> 0.89), and slow share correlates _positively_ with agreement with
> Minian (ρ 0.63). `events`, widths, `zero_frac` (non-negativity clamp),
> footprint shape and stability are descriptive.
>
> - **Global, validated.** `explained` and `residual_excess` track true
>   recall over a run (ρ 0.93-1.00 and −0.87 to −1.00), and `adds_per_min`
>   falls as recall rises (ρ −0.64 to −0.92). `pass_frac` and the median
>   SNR do not track recall consistently. For comparing runs or library
>   versions, `explained` is superseded by the held-out score
>   ([`heldout`]): `explained` also rises with every column that soaks up
>   structured noise, the held-out score nets out what a cell-shaped
>   non-cell gains.
> - **Convergence: existing-cell stability.** Cell discovery never stops
>   on long recordings (batch tools find nearly twice the cells in 30-120
>   min as in 10-30 min), so adds per minute cannot say whether a run has

> `trace_sigma_change`; per cell `fp_ref_cos`, `sigma_ref_change`). On
> minisim, `stable_frac` rises from ~0.6 to a plateau of 0.87-0.96 while
> GT precision is flat. It is a run-level signal, not a per-cell flag:
> cells that are unstable at a given moment are true positives about as
> often as stable ones (0.96 vs 0.98, 8-min runs; 0.89 vs 0.96, 20 min)
> with traces as good (true r 0.95-0.96 either way). The slow loop's add
> classification (re-adds, adds removed again, removals of established
> cells: `crate::discover::ChurnCounts`) is the other half of the
> convergence rule, which lives in the app (`apps/cala/src/lib/qc.ts`).

## `crates/cala/src/qc/tests.rs`

> A diverged trace (halo_s5: the fast loop returned 1e37, then inf):
> the running mean turns NaN once `inf - inf` enters its sum, and the
> event scan used to spin on the first NaN sample forever. Run it on a
> thread so a regression fails here instead of hanging the suite.

## `crates/cala/src/trace/background.rs`

> not explained by cells is dominated by one global mode (about 90 % of the
> non-noise variance on the workshop CA1 recording: common-mode flicker and

## `crates/cala/src/trace/library.rs`

> projected SOR step runs away (halo_s5: traces of 1e37, then inf);

> `−s_i q_ij` to its neighbours, which then dwarf the curvature (a Joint
> run in the app: 0.012 `ã_iᵀã_i` with `s_i` = −116 and couplings of
> ~10). The coordinate system is far from diagonally dominant, projected
> SOR grows ~11x per sweep, the traces reach inf within one frame, and

> `ã_iᵀã_i`). Other cells are unchanged. (On the app library above the
> next-smallest ratio was 0.69: the rule picks out the degenerate cell
> only.)

## `crates/cala/src/trace/mod.rs`

> leaks 3-11 % of each neighbour into a trace (experiments for milestone 3).

## `crates/cala/src/trace/tests.rs`

> all but exact: 0.05 % of the peak (1.1 % with the moat dropped).

> halo_s5: a large footprint at the FOV edge, its ring clipped to a few
> pixels that its own moat fills, had `ã_iᵀã_i − s_i q_ii < 0`. The
> curvature was floored at 1e-3 `ã_iᵀã_i`, so each SOR step was ~1000x
> too long with the wrong sign: traces ran to 1e37, then inf, which
> hung the QC event scan downstream. Reproduce the degenerate terms on

> A Joint run in the app (two stitched sessions of a minisim motion
> recording): a 26 px footprint at the FOV edge had `ã_iᵀã_i − s_i q_ii`
> = 0.012 `ã_iᵀã_i` (positive, so the m <= 0 rule above left it alone)
> with `s_i` = −116. Its row of the coordinate system was then the
> small curvature against ring couplings `−s_i q_ij` of ~10 to its
> neighbours: projected SOR grew by ~11x per sweep, the traces ran to
> inf within one frame's 200 sweeps, and the next frame with missing
> pixels filled them with NaN ("frame N has non-finite pixels under
> cell M", which stopped Refine or Extract). Reproduce the terms: the

> `ã_0ᵀã_0 − s_0 q_00 = 0.012 ã_0ᵀã_0`, as in the app (its own moat

## `crates/cala/tests/motion.rs`

> Rigid shifts against minisim's ground truth (content-calibrated preset;
> measured 0.28 px RMSE, correlation 0.97 / 0.96). Cell activity still moves

## `crates/cala/tests/motion_proptest.rs`

> switching the division off changes the rigid shift by about 0.001 px
> RMS (`tools/cala-eval/results/2026-11-26-motion-xcorr-bias.md`).

> estimate towards zero by about 4 % of the shift, which this catches
> (on 2000 random cases 3 % of the axes fail, so a 64-case run almost
> always does).

## `crates/cala/tests/preprocess_fixture.rs`

> Before the step: the floor sits a stationary ~2-3 σ_s below the truth
> (σ_s = σ/√5 = 1.34), uniformly (that offset is the same everywhere).

> relative threshold gave before the check existed (area and FNV-1a hash of
> the mask bytes, recorded from that version).
