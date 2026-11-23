//! Validate the online QC metrics ([`calab_cala::qc`]) against ground truth.
//!
//! ```text
//! cargo run --release --example qc_eval -- sim    <sim dir> <out dir> [options]
//! cargo run --release --example qc_eval -- oracle <sim dir> <out dir> [options]
//! cargo run --release --example qc_eval -- real   <avi dir> <out dir> [options]
//!   --frames N         first N frames (default all)
//!   --motion           run the motion corrector upstream
//!   --rescore RUN      `sim` only, standalone: score an earlier run's
//!                      checkpoint footprints (`RUN/fp_history.bin`, from
//!                      `--churn-log`) against the GT in the tissue frame and
//!                      in cala's frame (`rescore.tsv`: P, R, median matched r
//!                      per checkpoint). Pass the run's `--motion` and scale
//!                      flags; the loops do not run
//!   --gt-offset M      motion runs with GT: `auto` (default) moves the GT
//!                      into cala's registered frame (see "GT frame");
//!                      `none` scores against the tissue frame as before
//!   --budget U         slow-loop work units per frame (default 3e7)
//!   --start N          frame at which the slow loop / oracle library starts (50)
//!   --every K          checkpoint every K frames (default 300)
//!   --perturb-frac F   oracle: share of cells perturbed (default 0.3)
//!   --seed S           oracle: perturbation seed
//!   --slow-seed S      slow-loop seed (held-out split, random slots)
//!   --passes N         run the recording N times (default 1). Pass 1 is
//!                      the app's Discover stage; later passes replay the
//!                      recording from frame 0 (S2.3). See "Repeated passes".
//!   --later-passes M   edits the slow loop may make in passes >= 2 (S2.3b;
//!                      the `EditScope` names): `all` (default: Discover
//!                      again, which counts the same frames' evidence twice;
//!                      not exposed in the app), `refine` (the app's Refine
//!                      stage: refine footprints only, no adds, absorbs,
//!                      splits, merges, keep tests or deletions),
//!                      `refine-prune` (also keep tests and deletions),
//!                      `refine-merge` (also merges). Pass 1 is unchanged.
//!                      Visit jobs carry the scope, so it holds with
//!                      `--via-jobs`, `--visit-workers` and `--offered-fps`.
//!                      Except with `--offered-fps`, a refine replay starts
//!                      from the previous pass's final library (the slow
//!                      loop publishes at the wrap), as the app's Refine does.
//!   --dump             re-extract with the final library and write per-cell
//!                      trace, ring background and the footprint projection of
//!                      the frame before and after the background floor; also
//!                      the signed (unclipped) traces (`dump_signed.f32`) and,
//!                      with GT, each cell's correlation with its best GT unit
//!                      for both (`traces_signed_gt.tsv`)
//!   --lib-at F,F,..    write the library as `footprints_t{frame}.bin` /
//!                      `final_t{frame}.tsv` when pass 1 reaches each given
//!                      share of the recording (fractions in (0, 1), e.g.
//!                      0.25,0.5,0.75): the live library at that moment, for
//!                      quality-over-time curves (`tools/cala-eval/
//!                      demix_stages.py`); examples only, no behaviour change
//!   --lookback R       concurrent Refine (pass 1, off by default): when
//!                      cells are born, re-read the frames before the birth
//!                      from the recording and feed them, solved with the
//!                      current library by a separate trace engine, to the
//!                      new cells' and their neighbours' running statistics
//!                      and cluster stores, at R look-back frames per
//!                      Discover frame (see `LookBack`; `lookback.tsv`)
//!   --lookback-reservoir M  experimental: look-back frames are also
//!                      offered to the reservoir, on the held-out side they
//!                      had as live frames: `test` (held-out frames only) or
//!                      `all`; --lookback-reservoir-share S offers the share
//!                      S of them (`LookbackReservoir`). Default off.
//!   --lookback-frames K  at most K frames before its birth per cell
//!                      (default 3000)
//!   --lookback-order O `shared` (default): the 64-frame block most cells
//!                      need first; `newest`: the newest cell's next block
//!   --lookback-target E  precision demand instead of the K-frame window:
//!                      every cell whose split-half footprint noise
//!                      (`SlowLoop::footprint_noise`) is above E needs
//!                      look-back frames it has not had from look-back
//!                      (frames before its birth first); newborns and their
//!                      neighbours are served first, noisy settled cells
//!                      after them, from the same block scheduler; a cell
//!                      stops at the target, the cursor idles when no cell
//!                      needs data (writes `fp_noise.tsv`)
//!   --noise-dump       write `fp_noise.tsv` (id, birth, final footprint
//!                      noise) at the end; examples only
//!   --lookback-drain N recorded data: after Discover's last frame keep
//!                      serving the cells in need, with Refine-scope visits,
//!                      for at most N steps (one step = R look-back frames
//!                      + one slow-loop step); ends when nothing is needed.
//!                      With `--passes N` > 1 it runs at the end of pass 1,
//!                      before the later passes (a Refine after a settled
//!                      look-back Discover)
//!   --lookback-settle-all N  after the drain, feed about N frames spread
//!                      evenly over the recording to every cell (frozen
//!                      cell set, untargeted look-back frames), with visits
//!                      (experiment: a convergence pass inside Discover)
//!   --settle-frames N  the end-of-Discover settle (with --lookback 0 a
//!                      settle-only look-back is kept for it; after
//!                      the drain if any, `--lookback-drain 0` for none):
//!                      cell set frozen, re-read frames go
//!                      to every cell until N were fed or the stop rule
//!                      fires (`LookBack::settle`; `settle_checks.tsv`).
//!                      Options: --settle-round F (frames per sweep of the
//!                      recording, in 64-frame blocks; default all),
//!                      --settle-observe full|frozen|stats (the ordinary
//!                      observe; the same with the reservoir frozen; the
//!                      look-back path), --settle-steps S (slow-loop steps
//!                      per frame, default 1), --settle-batch B (frames per
//!                      request, default 1), --settle-due D / --settle-publish P
//!                      (mark all tiles due / publish every so many frames;
//!                      default 0: by new reservoir slots / by `step`),
//!                      --settle-check C (frames between checkpoints, 1200),
//!                      --settle-stop-share Q with --settle-stop-k K (stop
//!                      when at most a share Q of the cells moved more than
//!                      K x their split-half noise since the last checkpoint;
//!                      --settle-stop-checks M in a row; not before
//!                      --settle-min-frames), --settle-libs (write the
//!                      checkpoint libraries)
//!   --lookback-drain-rate F  look-back frames per drain step instead of
//!                      R (bigger batches once Discover has ended)
//!   --catchup X        reference arm: every X Discover frames give all
//!                      cells frames 0..t at once (`--catchup-double`: at
//!                      X, 2X, 4X, ...)
//!   --wrap-libs        with `--passes N`: also write the library every wrap
//!                      publishes (`footprints_wrap{k}.bin`, `final_wrap{k}.tsv`,
//!                      k = passes completed), i.e. what the app's Discover
//!                      (k = 1) and each Refine stage end with
//!   --no-signed        with --dump: do not compute the signed traces (to time
//!                      their cost; the clipped traces are the same either way)
//!   --label-bundle C   `real` only, standalone: read candidate footprints from
//!                      `C` (tsv: cid, cy, cx) and its sidecar `C.bin` (the
//!                      `footprints.bin` format), run the preprocessing only and
//!                      write the raw material of the blind labelling bundle
//!                      (see `tools/cala-label`); no library is built
//!   --crop N           with --label-bundle: crop side in pixels (60)
//!   --batch B          forward frames to the slow loop in batches of B (the
//!                      app uses 8); library swaps land between batches (1)
//!   --no-bg-levels     diagnostics: forward the traces to the slow loop
//!                      without the fast loop's per-cell ring-background
//!                      levels (what the app did before it sent them)
//!   --slow-keep F      forward only a share F of the batches to the slow loop
//!                      (it observes and steps on those only), modelling the
//!                      app's drops when the slow worker is busy (1)
//!   --drop-mode M      `uniform`: evenly spaced batches; `score`: the batches
//!                      whose residual excursion score (`SlowLoop::tile_scores`,
//!                      summed over tiles above 4 σ) is in the top F of
//!                      recent batches go whenever capacity (a share F of
//!                      the batches, at most 4 banked) allows; quiet ones
//!                      only when capacity would otherwise go unused
//!   --frames-per-tile N / --reservoir-max-mb M   reservoir size target and cap
//!   --readd-window N / --churn-frames N   add classification windows
//!   --joint            add test with the joint neighbour-trace check
//!   --factors-out DIR  compress pass 1's preprocessed frames in 600-frame
//!                      windows ([`calab_cala::compress`]) and write every
//!                      window's factors to `DIR/w<start>.fac` (`CALAFAC2`), the
//!                      input of tools/cala-diagnostics/history_wholetest.py
//!   --settle-source S  raw (default) | factors: where the --settle-frames
//!                      settle gets its frames: re-read and preprocessed, or
//!                      rebuilt from the --factors-out windows (no raw read)
//!   --factors-tiling T plain (default) | offset: how --factors-out cuts the
//!                      frame (the dump is complete when Discover ends)
//!   --core-test M      transient-band core test: off (default) | report
//!                      (also writes fast.tsv, split.tsv) | trim | delete
//!   --basin-trim       trim refined footprints to their significant basin
//!                      (needs --support-rule rings, as does --core-test)
//!   --support-rule R   how the footprint statistics measure a support:
//!                      basin-skirt (default) | basin | rings (the rule
//!                      before S2.1)
//!   --support-alpha A  family-wise error rate of a basin support (0.05)
//!   --refine-gate G    when the statistics path proposes a refinement:
//!                      split-half (default; the change exceeds the
//!                      estimate's split-half noise, Î > 0) | legacy (χ²
//!                      disagreement and refine_min_change, the rule
//!                      before S2.1c)
//!   --refine-z Z       held-out paired z a statistics-path refinement must
//!                      exceed (default 0: any held-out gain; 3 = the gate
//!                      before the refine-gate fix)
//!   --merge-rule M     which merge tests may merge: split-half (default;
//!                      a pair overlapping less than ½ must also be one
//!                      soma by the cells' split-half measured light) |
//!                      legacy (the held-out test alone, the rule before
//!                      S2.1c)
//!   --merge-guard-sep S  apply the split-half merge gate to every pair whose
//!                      centres are >= S cell diameters apart, whatever
//!                      their overlap (default: off, overlap rule alone)
//!   --merge-log        DIAG (`--features diagnostics`): one JSON line per
//!                      merge test (`merges.jsonl` in the output directory;
//!                      `CALA_MERGE_LOG=<file>` does the same): the current
//!                      rule's statistic and both cells' supports, footprint
//!                      statistics and split halves, no decision changes
//!   --cell-diameter D  expected soma diameter, px (default 10): every scale
//!                      that follows it (detection, seed disk, statistics
//!                      margin, held-out placebos, and the flatten σ = 2 D
//!                      unless `--flatten-sigma` is given)
//!   --psf-sigma S      the slow loop's PSF smoothing σ, px (default 1.5)
//!   --flatten-sigma S  the glow flattener's σ, px (default 2 × the diameter)
//!   --tile-px T / --margin-px M  slow-loop tile side and margin (64 / 24)
//!   --bin K            `real` only: mean of each K × K pixel block, rounded
//!                      to u8 (a recording at 1/K the resolution)
//!   --stats-half-life F  half-life (frames) of the footprint statistics
//!                      (default 6000).
//!   --drop-step        keep stepping the slow loop on dropped batches (only
//!                      the observation is lost, not the compute)
//!   --csettle S        the concurrent settle (experimental; needs --lookback):
//!                      while Discover runs, a share S of the slow loop's
//!                      compute goes to settle work: saved frames spread
//!                      over the history are re-read (16 in a row,
//!                      `--csettle-chunk`), fed on the side they had live
//!                      (`SlowLoop::observe_settle`), and each earns one
//!                      frame's budget of refinement-only visits
//!                      (`SlowLoop::step_settle`). Without --offered-fps
//!                      every live frame earns S / (1 - S) settle frames,
//!                      weighted over the recording by `--csettle-ramp
//!                      flat|linear|late` (same total); with it the slow
//!                      worker spends S of its idle time (S up to 1), a
//!                      re-read frame being ready every `--lb-ms` (10) ms.
//!                      `--csettle-guard G`: with --offered-fps no unit
//!                      starts when G times the mean unit time would run
//!                      past the next expected batch (0: off).
//!                      S = 0: no settle (with --offered-fps the look-back
//!                      then runs on the virtual clock, the baseline).
//!                      `--csettle-mode visits|stats|full`: settle visits
//!                      only (no frames), frames to the statistics, frames
//!                      to the statistics and the reservoir (default);
//!                      `frames`: as `stats` without the settle visits
//!                      (the ordinary visits do all the refining).
//!                      `--csettle-quiet F`: no settle visit on a tile
//!                      whose cell set changed in the last F frames.
//!                      With `--offered-fps` and `--visit-workers K` > 0
//!                      (modes `stats` and `frames`): every live frame the
//!                      slow worker observes earns S / (1 - S) re-read
//!                      frames; they are requested from the look-back
//!                      worker 16 at a time, one request out at a time
//!                      (`--lb-ms` per frame on that worker, after the
//!                      need-driven look-back frames), the answer costs the
//!                      slow worker the statistics update of its fitting
//!                      frames (held-out frames are not solved), and the
//!                      settle visits they earn run as jobs on visit
//!                      workers that have no ordinary visit to run
//!                      (`SlowLoop::take_settle_job`).
//!                      `--csettle-yield N` (N divides the chunk): the slow
//!                      worker handles an answer N frames at a time and
//!                      goes back to its inbox in between (waiting batches
//!                      and visit results first, visits handed out), in
//!                      place of the whole answer in one go.
//!                      `--cs-answer-scale X` (diagnosis): the slow worker's
//!                      time for an answer is X times its work (0: free).
//!   --owner-load MS:PERIOD  diagnosis, with --offered-fps: the slow worker
//!                      loses MS ms every PERIOD ms, doing nothing.
//!   --visit-diag       with --offered-fps and --visit-workers: write
//!                      `visit_diag.tsv` (one row per visit job: when its
//!                      tile came due, how long it waited, its work) and
//!                      `visit_diag.txt` (how tiles came due, the slow
//!                      worker's time by message kind, and the visit
//!                      workers' idle time by cause). Changes no other
//!                      output.
//!   --offered-fps R    model the app's workers on a virtual clock instead
//!                      (`Timed`): the fast loop reads R frames per second,
//!                      batches of `--batch` frames are dropped when the
//!                      `--pool` (2) forward buffers are busy, and work
//!                      costs time at `--units-per-ms` (WASM calibration)
//!   --visit-workers K  with --offered-fps: the slow worker only observes and
//!                      hands its tile visits to K workers (0: it observes
//!                      and steps itself, as the app did before)
//!   --via-jobs         run every tile visit as a job through the parallel
//!                      protocol, one at a time (`SlowLoop::step_via`): must
//!                      give the same results as without
//!   --observe-ms O     with --offered-fps: cost of observing one frame (the
//!                      app's measured time; default: its work units)
//!   --job-ms C         with K > 0: owner-side cost of a visit job, hand-out
//!                      and result together (encode, copy, decode), ms; a
//!                      worker also spends it on top of the visit's work
//!   --visit-depth D    visits a worker may hold at once (1)
//!   --offered-burst B  calibration, with --offered-fps: the frames arrive B
//!                      at a time at the offered mean rate (the app's
//!                      pacer before #455 released 32 at once); default
//!                      evenly
//!   --ack-lag-ms P     calibration, with --offered-fps: a forward buffer the
//!                      slow worker gave back less than P ms ago is still
//!                      busy (the fast loop sees the ack only after the
//!                      batch it is processing); default 0
//!   --result-first     calibration, with --offered-fps and --visit-workers:
//!                      the slow worker takes a visit result that is waiting
//!                      before the batches and answers waiting with it
//!                      (default: arrival order)
//!   --flat-field M     sensor flat field ([`calab_cala::preprocess::flatfield`]),
//!                      default `online` with --motion, `off` without:
//!                      `online` runs what the app runs (uncorrected until the
//!                      first map after --ff-first s, a warm-started refinement
//!                      every --ff-refine s, forgetting with half-life
//!                      --ff-gain-half-life s, column dark offsets tracked with
//!                      --ff-offset-half-life s (0: no offset model);
//!                      --ff-seed G [--ff-seed-frames N] starts from a stored
//!                      gain map; writes `flat_field_updates.tsv`, the final
//!                      `flat_field.f32` (+ `_offset`)); `auto[:N]` estimates once from a first pass
//!                      over frames 0..N (3000) and corrects from frame 0; a
//!                      file path divides by that gain map (f32 LE per pixel)
//!   --inject-drift gain=A,offset=B  add a synthetic sensor drift growing
//!                      linearly over the run (pixel gain ±A, column offset
//!                      ±B grey levels; patterns written to `drift_*.f32`)
//!   --no-heldout       skip the ground-truth-free held-out score
//!   --fps R            frame rate for the time-based preprocessing and
//!                      flat-field settings (default 20; the sims' rate)
//!   --boundary-log     diagnostics builds only (`--features diagnostics`):
//!                      write `boundary_pre.tsv` (per frame: input mean,
//!                      glow, flicker fit, background floor, noise map every
//!                      10 frames, motion quality and flags) and
//!                      `boundary_traces.bin` (every cell's online trace and
//!                      ring level, pass 1). Read-only; see `BoundaryLog`
//!   --probe-bg-reset F diagnostics builds only: what-if probe (not a fix)
//!                      replacing the preprocessor's background floor with a
//!                      fresh one before frame F (session-boundary study)
//!   --sessions F1,..   first frames of sessions 2.. (a Joint run's session
//!                      boundaries); nothing changes unless --session-fix
//!   --session-fix L    boundary fixes (`crates/cala/src/{motion,preprocess}/session.rs`),
//!                      comma list of reg (session re-registration:
//!                      similarity transform to the mean of the previous
//!                      session's last --session-ref-frames (100) registered
//!                      frames, applied before the per-frame corrector),
//!                      flicker (re-seat the reference), floor (rescale the
//!                      background floor by a gain/offset fit), noise
//!                      (rescale the noise map), or all / none (default).
//!                      The floor and noise fits use the session's first
//!                      --session-fit-frames (8, the app's batch) frames.
//!                      Needs --motion; writes `session_boundaries.tsv`
//!                      (with re-registration also `boundary_null.tsv`: the
//!                      boundary correlation's within-session null samples,
//!                      as the app's boundary flags use them)
//!   --library F        a fixed library (`footprints.bin` of an earlier run,
//!                      `CALAFP01`) from `--start` on, no slow loop: scores
//!                      a given cell set (held-out frames: the split the
//!                      slow loop would use with `--slow-seed`)
//! ```
//!
//! **Held-out score** ([`calab_cala::qc::heldout`], on unless
//! `--no-heldout`): every frame the slow loop holds out is scored with the
//! library the fast loop used for it, against placebo columns (displaced
//! copies of a quarter of the cells). Checkpoint rows of `global.tsv` get
//! `ho_frames`, `ho_gain_per_frame`, `ho_cells`, `ho_placebos`, `ho_mu`,
//! `ho_penalty`, `ho_score` (S, per held-out frame, units of
//! s²), `ho_penalty_ci`, `ho_signal` (held-out light above noise) and
//! `ho_score_frac` (S / signal) over the window since the previous checkpoint;
//! `ho_cells.tsv` holds per checkpoint and cell `ho_marginal`, `ho_frames`,
//! `ho_marginal_z` (also columns of `final.tsv`), `heldout.tsv` one row per
//! library version, and `cost.txt` the score's share of the wall time.
//!
//! * `sim`: the merged fast and slow loops on a minisim recording, from an
//!   empty library, with a [`QcMonitor`] on the fast loop. At every
//!   checkpoint each cell's QC metrics are written next to its ground-truth
//!   labels: matched to a detectable GT unit (footprint r ≥ 0.7, Hungarian),
//!   duplicate, the true trace r over the QC window, and the true crosstalk
//!   (least squares of the trace on its own GT trace and those of GT units
//!   within 20 px: neighbours' share of the trace variance, and the largest
//!   neighbour coefficient relative to its own).
//! * `oracle`: the fast loop alone with the GT footprints, a share of them
//!   deliberately wrong (shifted 3 px, merged with the nearest overlapping
//!   neighbour, split in two halves, or deleted so its neighbours absorb its
//!   light), to test the demixing metrics on known errors.
//! * `real`: no ground truth; QC time course and final per-cell metrics, plus
//!   `footprints.bin` for matching to another pipeline's cells.
//!
//! `cells.tsv` rows carry `fp_class` (`tp`, or the FP class: `noise`,
//! `adjacent`, `partial`, `dup`, `nondetectable` for a match to a GT unit
//! that is not detectable) and `edge_px` (distance of the centroid to the
//! sensor-mask edge, capped at 40). With `--motion` the QC monitor also gets
//! each frame's rigid shift and `motion_r2` is the cross-validated R² of the
//! trace on a quadratic of that shift ([`calab_cala::qc::motion`]; flag bit
//! 16 above 0.2, display only, never part of `pass`); NaN without motion.
//!
//! GT frame (`sim` / `oracle` with `--motion`): cala registers every frame
//! onto its warm-up template, which sits wherever the tissue was in the
//! first frames, not at the sim's tissue frame; on the motion sims that is
//! 1 to 3 px off. The offset is measured from what the sim and cala did
//! ([`FrameOffset`]): the median over frames `0..=--start` of cala's rigid
//! record plus the sim's true rigid shift (`<sim>/shifts.npy`, written by
//! `make_trace_sim.py` or `tools/cala-eval/export_gt_motion.py`; a motion
//! run stops if it is missing, unless `--gt-offset none`). Every GT
//! footprint is moved by it (bicubic, sub-pixel; its centre is the moved
//! core's peak inside the frame, as in `make_trace_sim.py`) before anything
//! is scored, so matching, P/R, `fp_r`, the FP classes, crosstalk, the
//! oracle library and `traces_gt.tsv` all use the moved GT.
//! `motion_offset.tsv` holds the applied estimate, the same estimate over
//! the whole run and per 1200-frame block (constancy check; robust sd =
//! registration error), and `motion.tsv` cala's rigid shift of every frame.
//! The non-rigid part of the template's position (the sim's patch field
//! averaged over the warm-up, a few tenths of a px) is not modelled.
//!
//! Repeated passes (`--passes N`, offline only; with `--later-passes refine`
//! these are the app's Refine runs, see `apps/cala/docs/stages.md`): after the last frame the
//! loop restarts at frame 0 and runs the recording again. Carried over: the
//! fast loop's library and trace engine state (traces continue across the
//! wrap), the whole slow loop (footprints, fpstats, ledger, probation, frame
//! counter: running statistics with half-lives see a later pass as more
//! time), the QC monitor, the held-out score and the convergence tracker.
//! Fixed after pass 1: the calibration and FOV mask, the motion corrector
//! (later passes replay pass 1's motion records, no re-registration) and the
//! online flat field (its last pass-1 map stays applied; no more updates).
//! The preprocessor's running state (noise, background) continues. Frames in the output files are *virtual*: pass `k` (0-based)
//! frame `t` is written as `k * frames + t` (`global.tsv`, `cells.tsv`,
//! `convergence.tsv`, `adds.tsv`/`removals.tsv` `recording_frame`,
//! `ho_cells.tsv`), so the curves continue across passes;
//! `tools/cala-eval/split_passes.py` cuts a run into one directory per pass.
//! GT trace correlations use the current pass's frames only. The held-out
//! score is held out in pass 1 only: later passes score frames the slow loop
//! has already fitted on. At each pass end `passes.tsv` gets a row (cells,
//! cumulative adds / merges / deletes / splits, wall time) and
//! `footprints_pass{k}.bin` / `final_pass{k}.tsv` hold the library at that
//! point (the fast loop's current library; the final `footprints.bin` is
//! after `SlowLoop::finalize`).
//!
//! Outputs: `cells.tsv` (one row per cell per checkpoint), `global.tsv` (QC
//! every 100 frames, GT precision / recall / trace r at checkpoints, and the
//! slow loop's cumulative add classification), `adds.tsv` / `removals.tsv`
//! (every add with its class, every removal with its age; recording frames),
//! `final.tsv` (each cell of the final library: centroid, footprint match,
//! and the slow loop's evidence record) and, with GT, `gt.tsv` (GT units:
//! centroid in cala's frame, detectable, peak SNR, `unit` = `oracle.bin` index) and `traces_gt.tsv` (each final cell's
//! best trace correlation with *any* GT unit and that unit's distance, which
//! tells a distant unit's light from signal no GT unit made), and, with
//! `--dump`, `dump_{trace,ring,pre,post}.f32` (frames x cells, final library
//! order) and `cells_pass2.tsv` (QC of the re-extracted traces).
//!
//! `--churn-log` (attribution of footprint changes) adds `edits.tsv` (every
//! structural edit of the slow loop: add, merge, split, delete, refine,
//! absorb, with the cells involved and the decision's margin),
//! `fp_history.bin` (every cell's filtered and unfiltered footprint and
//! split-half noise at every checkpoint; `CALAFH01`, see
//! [`write_fp_history`]) and, built with `--features diagnostics`,
//! `tests.tsv` (every held-out refine / merge / split / absorb test,
//! accepted or not).

use std::collections::HashMap;
#[path = "common/oracle.rs"]
mod oracle;
#[cfg(test)]
use oracle::Unit;
use oracle::{read_f32s, read_oracle, read_u32, Oracle};

use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use calab_cala::avi::{idx1_payload_len, AviHeader};
use calab_cala::compress::blend::{BlendLayout, Tiling};
use calab_cala::compress::WindowFactors;
use calab_cala::discover::{
    CoreTest, EditScope, JointAdmit, JointSign, JointUpdate, LookBack as LbSched, LookbackConfig,
    LookbackNext, LookbackOrder, LookbackOutcome, LookbackReservoir, MergeRule, RefineGate,
    SettleSched, SlowLoop, SlowLoopConfig, SupportRule, VisitResult, VisitRunner, LB_BLOCK,
};
use calab_cala::motion::{
    Frame, Frames, MotionConfig, MotionCorrector, MotionRecord, NonRigidConfig,
};
use calab_cala::preprocess::flatfield::{
    DitherFlatField, FlatField, FlatFieldConfig, FlatFieldSeed, OnlineFlatField,
    OnlineFlatFieldConfig, RefineOutcome, FIRST_MAP_S, GAIN_HALF_LIFE_S, OFFSET_HALF_LIFE_S,
    REFINE_EVERY_S,
};
use calab_cala::preprocess::flatten::GlowFlattener;
use calab_cala::preprocess::warmup::WarmupAccumulator;
use calab_cala::preprocess::{Calibration, Dims, PreprocessConfig, Preprocessor};
use calab_cala::qc::heldout::{HeldOutConfig, HeldOutScore, HeldOutWindow};
use calab_cala::qc::{CellQc, GlobalQc, QcConfig, QcMonitor};
use calab_cala::trace::{
    BackgroundModel, Footprint, FrameTraces, Library, LibraryBuilder, SolverConfig, TraceEngine,
};
use std::fmt::Write as _;

#[path = "../tests/common/npy.rs"]
mod npy;
use npy::Npy;

struct Avi {
    file: File,
    header: AviHeader,
}

impl Avi {
    fn open(path: &Path) -> Avi {
        let mut file = File::open(path).unwrap_or_else(|e| panic!("{path:?}: {e}"));
        let size = file.metadata().unwrap().len();
        let mut prefix = vec![0u8; (64 * 1024).min(size as usize)];
        file.read_exact(&mut prefix).unwrap();
        let layout = AviHeader::parse_header(&prefix).expect("AVI header");
        let mut idx1 = None;
        if layout.info.movi_end > 0 && layout.info.movi_end + 8 <= size {
            let mut hdr = [0u8; 8];
            file.seek(SeekFrom::Start(layout.info.movi_end)).unwrap();
            file.read_exact(&mut hdr).unwrap();
            if let Ok(len) = idx1_payload_len(&hdr) {
                let mut payload = vec![0u8; len as usize];
                file.read_exact(&mut payload).unwrap();
                idx1 = Some(payload);
            }
        }
        let header = AviHeader::parse_with_size(&prefix, idx1.as_deref(), size).expect("AVI index");
        Avi { file, header }
    }

    fn read(&mut self, start: u32, count: u32, out: &mut Vec<u8>) {
        let px = self.header.pixel_bytes();
        let mut s = start;
        while s < start + count {
            let run = self.header.contiguous_run(s, start + count - s).max(1);
            let (a, b) = self.header.span_range(s, run).unwrap();
            let mut span = vec![0u8; (b - a) as usize];
            self.file.seek(SeekFrom::Start(a)).unwrap();
            self.file.read_exact(&mut span).unwrap();
            let o = out.len();
            out.resize(o + run as usize * px, 0);
            self.header
                .decode_span_into(&span, run, &mut out[o..])
                .unwrap();
            s += run;
        }
    }
}

/// The numbered AVIs of a recording directory as one frame stream.
struct Recording {
    files: Vec<Avi>,
    starts: Vec<u32>,
    dims: Dims,
    total: u32,
    /// Frames are binned `bin` × `bin` (1 = as recorded); `dims` is binned.
    bin: usize,
    raw_dims: Dims,
}

impl Recording {
    fn open(dir: &Path, bin: usize) -> Recording {
        assert!(bin >= 1, "--bin must be at least 1");
        let mut files = Vec::new();
        for i in 0.. {
            let p = dir.join(format!("{i}.avi"));
            if !p.exists() {
                break;
            }
            files.push(Avi::open(&p));
        }
        assert!(!files.is_empty(), "no 0.avi in {dir:?}");
        let mut starts = Vec::new();
        let mut total = 0;
        for f in &files {
            starts.push(total);
            total += f.header.frame_count();
        }
        let info = files[0].header.info();
        let raw_dims = Dims::new(info.width as usize, info.height as usize).unwrap();
        let dims = Dims::new(raw_dims.width / bin, raw_dims.height / bin).unwrap();
        Recording {
            files,
            starts,
            dims,
            total,
            bin,
            raw_dims,
        }
    }

    fn read(&mut self, start: u32, count: u32) -> Vec<u8> {
        let mut out = Vec::with_capacity(count as usize * self.raw_dims.pixels());
        let mut s = start;
        while s < start + count {
            let k = self.starts.partition_point(|&x| x <= s) - 1;
            let local = s - self.starts[k];
            let n = (self.files[k].header.frame_count() - local).min(start + count - s);
            self.files[k].read(local, n, &mut out);
            s += n;
        }
        if self.bin == 1 {
            return out;
        }
        // Mean of each bin x bin block, rounded; a partial last row or column is dropped.
        let (b, rw) = (self.bin, self.raw_dims.width);
        let (h, w) = (self.dims.height, self.dims.width);
        let mut binned = Vec::with_capacity(count as usize * h * w);
        for f in out.chunks_exact(self.raw_dims.pixels()) {
            for y in 0..h {
                for x in 0..w {
                    let mut sum = 0u32;
                    for dy in 0..b {
                        let row = (y * b + dy) * rw + x * b;
                        sum += f[row..row + b].iter().map(|&v| u32::from(v)).sum::<u32>();
                    }
                    let n = (b * b) as u32;
                    binned.push(((sum + n / 2) / n) as u8);
                }
            }
        }
        binned
    }
}

fn pearson(a: &[f32], b: &[f32]) -> f64 {
    let n = a.len() as f64;
    let ma = a.iter().map(|&v| f64::from(v)).sum::<f64>() / n;
    let mb = b.iter().map(|&v| f64::from(v)).sum::<f64>() / n;
    let (mut sab, mut saa, mut sbb) = (0.0, 0.0, 0.0);
    for (&x, &y) in a.iter().zip(b) {
        let (dx, dy) = (f64::from(x) - ma, f64::from(y) - mb);
        sab += dx * dy;
        saa += dx * dx;
        sbb += dy * dy;
    }
    if saa <= 0.0 || sbb <= 0.0 {
        0.0
    } else {
        sab / (saa * sbb).sqrt()
    }
}
fn quantile(v: &[f64], q: f64) -> f64 {
    let mut s: Vec<f64> = v.iter().copied().filter(|x| x.is_finite()).collect();
    if s.is_empty() {
        return f64::NAN;
    }
    s.sort_by(f64::total_cmp);
    let pos = q * (s.len() - 1) as f64;
    let (lo, hi) = (pos.floor() as usize, pos.ceil() as usize);
    s[lo] + (s[hi] - s[lo]) * (pos - lo as f64)
}

fn arg_value(args: &[String], key: &str) -> Option<String> {
    args.iter()
        .position(|a| a == key)
        .and_then(|i| args.get(i + 1).cloned())
}

fn read_f32_file(f: &str) -> Vec<f32> {
    let b = std::fs::read(f).unwrap_or_else(|e| panic!("{f}: {e}"));
    b.as_chunks::<4>()
        .0
        .iter()
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// `--inject-drift gain=A,offset=B`: a synthetic sensor drift added to the
/// raw frames, growing linearly from 0 at frame 0 to full at the last frame:
/// a pixel gain pattern `1 + A·(t/T)·P(x)` (P = ±1, pseudo-random per pixel)
/// and a column offset `B·(t/T)·C(col)` (C = ±1 per column, grey levels).
struct Drift {
    gain: f32,
    offset: f32,
    p: Vec<f32>,
    c: Vec<f32>,
    width: usize,
    total: f32,
}

impl Drift {
    fn parse(spec: &str, dims: Dims, total: u32) -> Drift {
        let (mut gain, mut offset) = (0.0, 0.0);
        for kv in spec.split(',') {
            let (k, v) = kv.split_once('=').expect("--inject-drift gain=A,offset=B");
            match k {
                "gain" => gain = v.parse().unwrap(),
                "offset" => offset = v.parse().unwrap(),
                _ => panic!("--inject-drift: unknown {k}"),
            }
        }
        let mut st = 0x9e37_79b9_7f4a_7c15u64;
        let mut sign = move || {
            st = st
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            if (st >> 40) & 1 == 1 {
                1.0f32
            } else {
                -1.0
            }
        };
        let p = (0..dims.pixels()).map(|_| sign()).collect();
        let c = (0..dims.width).map(|_| sign()).collect();
        Drift {
            gain,
            offset,
            p,
            c,
            width: dims.width,
            total: total.max(2) as f32 - 1.0,
        }
    }

    fn apply(&self, frame: &mut [u8], t: usize) {
        let a = t as f32 / self.total;
        // Deterministic sub-grey dither so the u8 rounding does not quantise
        // the small injected changes away.
        let mut h = (t as u32).wrapping_mul(2654435761);
        for (i, v) in frame.iter_mut().enumerate() {
            h ^= h << 13;
            h ^= h >> 17;
            h ^= h << 5;
            let dith = (h >> 8) as f32 / (1u32 << 24) as f32;
            let x = f32::from(*v) * (1.0 + self.gain * a * self.p[i])
                + self.offset * a * self.c[i % self.width];
            *v = (x + dith).floor().clamp(0.0, 255.0) as u8;
        }
    }
}

fn write_f32s(f: &mut impl Write, v: &[f32]) {
    for x in v {
        f.write_all(&x.to_le_bytes()).unwrap();
    }
}

/// `--noise-dump`: split-half footprint noise of every cell of `lib`
/// (`id`, slow-loop birth frame, [`SlowLoop::footprint_noise`]).
fn write_noise(path: &Path, lib: &Library, sl: &SlowLoop) {
    let born: HashMap<u64, u64> = sl.births().into_iter().collect();
    let mut t = String::from("id\tborn_slow\tnoise\n");
    for slot in 0..lib.len() {
        let id = lib.ids()[slot];
        let (pix, _) = lib.filtered(slot);
        let n = sl.footprint_noise(id, pix).unwrap_or(f64::NAN);
        let _ = writeln!(t, "{id}\t{}\t{n:.5}", born.get(&id).copied().unwrap_or(0));
    }
    std::fs::write(path, t).unwrap();
}

/// What a settle frame goes through (`--settle-observe`).
#[derive(Clone, Copy, PartialEq, Debug, Default)]
enum SettleObserve {
    /// The look-back path: footprint statistics and cluster stores only.
    Stats,
    /// The ordinary `observe` with the reservoir frozen (statistics,
    /// ledger and clocks; no new reservoir frames).
    Frozen,
    /// The ordinary `observe`, as a Refine pass feeds its frames.
    #[default]
    Full,
}

/// The end-of-Discover settle (`--settle-*`; see `LookBack::settle`).
#[derive(Clone, Debug)]
struct SettleCfg {
    /// Frame cap (0: no settle).
    frames: usize,
    /// Frames per round (0: the whole recording).
    round: usize,
    observe: SettleObserve,
    /// Slow-loop steps (of `--budget`) earned per frame fed.
    steps_per_frame: f64,
    /// Frames per request.
    batch: usize,
    /// Mark every tile due / publish every this many frames (0: left to
    /// the reservoir's new slots / to `step`).
    due_every: usize,
    publish_every: usize,
    /// Frames between checkpoints.
    check: usize,
    /// Stop rule (`stop_share` 0: none), not before `min_frames`.
    stop_k: f64,
    stop_share: f64,
    stop_checks: usize,
    min_frames: usize,
    /// Keep the checkpoint libraries (`footprints_settle{k}.bin`).
    libs: bool,
}

impl Default for SettleCfg {
    fn default() -> SettleCfg {
        SettleCfg {
            frames: 0,
            round: 0,
            observe: SettleObserve::Full,
            steps_per_frame: 1.0,
            batch: 1,
            due_every: 0,
            publish_every: 0,
            check: 1200,
            stop_k: 2.0,
            stop_share: 0.0,
            stop_checks: 1,
            min_frames: 0,
            libs: false,
        }
    }
}

impl SettleCfg {
    fn parse(args: &[String]) -> SettleCfg {
        let num = |k: &str| arg_value(args, k).map(|s| s.parse::<f64>().unwrap());
        let d = SettleCfg::default();
        let observe = match arg_value(args, "--settle-observe").as_deref() {
            None | Some("full") => SettleObserve::Full,
            Some("frozen") => SettleObserve::Frozen,
            Some("stats") => SettleObserve::Stats,
            Some(m) => panic!("--settle-observe: unknown mode {m}"),
        };
        let c = SettleCfg {
            frames: num("--settle-frames").map_or(d.frames, |v| v as usize),
            round: num("--settle-round").map_or(d.round, |v| v as usize),
            observe,
            steps_per_frame: num("--settle-steps").unwrap_or(d.steps_per_frame),
            batch: num("--settle-batch").map_or(d.batch, |v| (v as usize).max(1)),
            due_every: num("--settle-due").map_or(d.due_every, |v| v as usize),
            publish_every: num("--settle-publish").map_or(d.publish_every, |v| v as usize),
            check: num("--settle-check").map_or(d.check, |v| (v as usize).max(1)),
            stop_k: num("--settle-stop-k").unwrap_or(d.stop_k),
            stop_share: num("--settle-stop-share").unwrap_or(d.stop_share),
            stop_checks: num("--settle-stop-checks").map_or(d.stop_checks, |v| (v as usize).max(1)),
            min_frames: num("--settle-min-frames").map_or(d.min_frames, |v| v as usize),
            libs: args.iter().any(|a| a == "--settle-libs"),
        };
        assert!(c.steps_per_frame >= 0.0, "--settle-steps must be >= 0");
        c
    }
}

/// The published footprints at a settle checkpoint with their split-half
/// noise: unit-peak weights on the support, as the app compares them.
struct SettleSnap {
    cells: HashMap<u64, (Vec<u32>, Vec<f32>, f64)>,
}

/// Per-cell change between two checkpoints.
struct SettleChange {
    /// Relative change over the cell's split-half noise, sorted.
    ratio: Vec<f64>,
    rel_med: f64,
    shape_med: f64,
    noise_med: f64,
}

impl SettleSnap {
    fn take(lib: &Library, sl: &SlowLoop) -> SettleSnap {
        let mut cells = HashMap::new();
        for slot in 0..lib.len() {
            let id = lib.ids()[slot];
            let (pix, raw) = lib.unfiltered(slot);
            let (fpix, _) = lib.filtered(slot);
            let peak = raw.iter().fold(0.0f32, |a, &b| a.max(b));
            let v: Vec<f32> = raw
                .iter()
                .map(|&x| if peak > 0.0 { x / peak } else { x })
                .collect();
            let noise = sl.footprint_noise(id, fpix).unwrap_or(f64::NAN);
            cells.insert(id, (pix.to_vec(), v, noise));
        }
        SettleSnap { cells }
    }

    /// Change of every cell present in both, `prev` to `self`: the app's
    /// relative L2 (`|a' - a| / |a|` over the union of the supports) and
    /// 1 - cosine, against the noise at `self`.
    fn change_from(&self, prev: &SettleSnap) -> SettleChange {
        let (mut ratio, mut rel, mut shape, mut noise) =
            (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        for (id, (pix, v, n)) in &self.cells {
            let Some((ppix, pv, _)) = prev.cells.get(id) else {
                continue;
            };
            let old: HashMap<u32, f32> = ppix.iter().copied().zip(pv.iter().copied()).collect();
            let (mut d2, mut a2, mut b2, mut ab) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
            let mut seen = 0usize;
            for (p, &b) in pix.iter().zip(v) {
                let a = old.get(p).copied().unwrap_or(0.0);
                if old.contains_key(p) {
                    seen += 1;
                }
                let (a, b) = (f64::from(a), f64::from(b));
                d2 += (b - a) * (b - a);
                a2 += a * a;
                b2 += b * b;
                ab += a * b;
            }
            if seen < ppix.len() {
                // Pixels the old support had and the new one dropped.
                let new: std::collections::HashSet<u32> = pix.iter().copied().collect();
                for (p, &a) in ppix.iter().zip(pv) {
                    if !new.contains(p) {
                        d2 += f64::from(a) * f64::from(a);
                        a2 += f64::from(a) * f64::from(a);
                    }
                }
            }
            if !(a2 > 0.0 && b2 > 0.0) {
                continue;
            }
            let r = (d2 / a2).sqrt();
            rel.push(r);
            shape.push(1.0 - ab / (a2 * b2).sqrt());
            if n.is_finite() && *n > 0.0 {
                noise.push(*n);
                ratio.push(r / n);
            }
        }
        ratio.sort_by(f64::total_cmp);
        let med = |v: &mut Vec<f64>| {
            v.sort_by(f64::total_cmp);
            if v.is_empty() {
                f64::NAN
            } else {
                v[v.len() / 2]
            }
        };
        SettleChange {
            rel_med: med(&mut rel),
            shape_med: med(&mut shape),
            noise_med: med(&mut noise),
            ratio,
        }
    }
}

impl SettleChange {
    fn q(&self, q: f64) -> f64 {
        if self.ratio.is_empty() {
            return f64::NAN;
        }
        self.ratio[((self.ratio.len() - 1) as f64 * q).round() as usize]
    }

    /// Share of cells that moved by more than `k` times their noise.
    fn share_above(&self, k: f64) -> f64 {
        if self.ratio.is_empty() {
            return f64::NAN;
        }
        self.ratio.iter().filter(|&&r| r > k).count() as f64 / self.ratio.len() as f64
    }
}

/// Concurrent Refine (`--lookback R`, `--catchup X`): the frame I/O around
/// the crate's look-back scheduler ([`calab_cala::discover::LookBack`],
/// which decides which past frames to re-read for which cells). Past frames
/// are re-read from the saved recording (raw is always saved), preprocessed
/// with a copy of the live preprocessor (one per block), solved with a
/// separate trace engine on the *current* library, and pushed into the
/// running footprint statistics and cluster stores only
/// ([`SlowLoop::observe_lookback`]). The live fast loop and the slow loop's
/// clocks are never touched.
///
/// * Need-driven (`--lookback R`): see the scheduler's docs.
/// * Catch-up (`--catchup X`, the PI's simple reference): every `X`
///   Discover frames (`--catchup-double`: at X, 2X, 4X, ...) all cells get
///   frames `0..t` at once, as a Refine pass over the history would give.
struct LookBack {
    rate: f64,
    max_frames: usize,
    catchup: usize,
    catchup_double: bool,
    next_catchup: usize,
    /// The scheduler (need-driven and precision modes).
    sched: LbSched,
    /// The block in progress (scheduler sequence number) and the
    /// preprocessor copy it runs on.
    block: Option<(u64, Preprocessor)>,
    engine: Option<TraceEngine>,
    buf: Vec<f32>,
    y: Vec<f32>,
    valid: Vec<u8>,
    raw: Vec<u8>,
    raw_start: usize,
    raw_n: usize,
    frames: u64,
    pushed: u64,
    cell_frames: u64,
    wall_s: f64,
    drain_steps: usize,
    drain_frames: u64,
    /// `--lookback-drain-rate` (0: `rate`, at least 1).
    drain_rate: f64,
    /// Wall seconds of the drain (stdout only).
    drain_wall_s: f64,
    /// `--lookback-settle-all N` (0: off).
    settle_all: usize,
    /// `--settle-frames N` and its options (the end-of-Discover settle).
    settle: SettleCfg,
    /// The settle feeds frames through the ordinary `observe`.
    full_observe: bool,
    /// `--settle-source factors`: the settle's frames come from Discover's
    /// factor windows instead of the recording.
    settle_src: Option<FactorFrames>,
    /// Raw frames the settle read and preprocessed (0 on factors).
    settle_raw: u64,
    /// `settle_checks.tsv` rows and the checkpoint libraries.
    settle_out: String,
    settle_libs: Vec<(usize, Arc<Library>)>,
    /// Look-back frames and cell-frames per tenth of the recording (row
    /// 10: the drain).
    by_tenth: [(u64, u64); 11],
    /// `--lookback-target E` (0: the `K`-frame window).
    target: f64,
    /// Look-back frames per 1/20 of the recording (precision mode report).
    by_twentieth: [u64; 20],
    /// `--csettle`: the concurrent settle (see `CsCfg`).
    cs: Option<CsCfg>,
    cs_sched: SettleSched,
    /// The preprocessor copy of the settle chunk in progress.
    cs_pre: Option<Preprocessor>,
    /// A settle frame is being fed (`frame` hands it to `observe_settle`,
    /// with or without the reservoir).
    cs_now: Option<bool>,
    cs_frames: u64,
    cs_wall_s: f64,
    /// The settle with visit workers: a unit is a whole chunk of frames,
    /// held-out frames are passed over before the solve (counted in
    /// `cs_skipped`), and the settle visits are jobs.
    cs_jobs: bool,
    /// `--csettle-yield N`: frames per call of `cs_unit` (0: a whole chunk).
    cs_step: usize,
    cs_skipped: u64,
    /// `--offered-fps`: the slow-loop index of each recording frame after
    /// warm-up (`u32::MAX`: dropped or not forwarded yet). Empty: every
    /// frame is forwarded in order.
    slow_of: Vec<u32>,
}

/// What a settle frame feeds (`--csettle-mode`).
#[derive(Clone, Copy, PartialEq, Debug)]
enum CsMode {
    Visits,
    Frames,
    Stats,
    Full,
}

/// The concurrent settle (`--csettle S` and its options).
#[derive(Clone, Debug)]
struct CsCfg {
    share: f64,
    mode: CsMode,
    /// 0 flat, 1 linear, 2 late (weights of the lock-step schedule).
    ramp: u8,
    quiet: u64,
    chunk: usize,
}

impl CsCfg {
    fn parse(args: &[String]) -> Option<CsCfg> {
        let share: f64 = arg_value(args, "--csettle")?.parse().unwrap();
        assert!((0.0..=1.0).contains(&share), "--csettle must be in [0, 1]");
        Some(CsCfg {
            share,
            mode: match arg_value(args, "--csettle-mode").as_deref() {
                None | Some("full") => CsMode::Full,
                Some("stats") => CsMode::Stats,
                Some("frames") => CsMode::Frames,
                Some("visits") => CsMode::Visits,
                Some(m) => panic!("--csettle-mode: unknown mode {m}"),
            },
            ramp: match arg_value(args, "--csettle-ramp").as_deref() {
                None | Some("flat") => 0,
                Some("linear") => 1,
                Some("late") => 2,
                Some(m) => panic!("--csettle-ramp: unknown schedule {m}"),
            },
            quiet: arg_value(args, "--csettle-quiet").map_or(0, |s| s.parse().unwrap()),
            chunk: arg_value(args, "--csettle-chunk").map_or(16, |s| s.parse().unwrap()),
        })
    }
}

impl LookBack {
    fn new(
        rate: f64,
        max_frames: usize,
        newest_first: bool,
        catchup: usize,
        catchup_double: bool,
        target: f64,
        n_px: usize,
    ) -> LookBack {
        LookBack {
            rate,
            max_frames,
            catchup,
            catchup_double,
            next_catchup: catchup,
            sched: LbSched::new(LookbackConfig {
                rate,
                max_frames,
                order: if newest_first {
                    LookbackOrder::Newest
                } else {
                    LookbackOrder::Shared
                },
                target,
            }),
            block: None,
            engine: None,
            buf: vec![0.0; n_px],
            y: vec![0.0; n_px],
            valid: vec![0; n_px],
            raw: Vec::new(),
            raw_start: 0,
            raw_n: 0,
            frames: 0,
            pushed: 0,
            cell_frames: 0,
            wall_s: 0.0,
            drain_steps: 0,
            drain_frames: 0,
            drain_rate: 0.0,
            drain_wall_s: 0.0,
            settle_all: 0,
            settle: SettleCfg::default(),
            full_observe: false,
            settle_src: None,
            settle_raw: 0,
            settle_out: String::new(),
            settle_libs: Vec::new(),
            by_tenth: [(0, 0); 11],
            target,
            by_twentieth: [0; 20],
            cs: None,
            cs_sched: SettleSched::new(0.0, 16),
            cs_pre: None,
            cs_now: None,
            cs_frames: 0,
            cs_wall_s: 0.0,
            cs_jobs: false,
            cs_step: 0,
            cs_skipped: 0,
            slow_of: Vec::new(),
        }
    }

    /// One unit of concurrent settle work: re-read the next scheduled frame
    /// among recording frames `start..seen` and feed it, then the settle
    /// visits it earns (`budget`). In `visits` mode only the visits.
    /// Returns the slow-loop work spent; `None` when there is no saved
    /// frame to read yet.
    #[allow(clippy::too_many_arguments)]
    fn cs_unit(
        &mut self,
        seen: usize,
        budget: u64,
        start: usize,
        rec: &mut Recording,
        drift: Option<&Drift>,
        pipe: &mut Pipeline,
        live: &TraceEngine,
        sl: &mut SlowLoop,
        n_px: usize,
    ) -> Option<u64> {
        let mode = self.cs.as_ref()?.mode;
        let t0 = Instant::now();
        let w0 = sl.work();
        if self.cs_jobs {
            // One answer of the look-back worker: a chunk of frames to the
            // statistics; the visits they earn go out as jobs.
            let chunk = match self.cs_step {
                0 => self.cs.as_ref()?.chunk,
                n => n,
            };
            let mut n = 0u64;
            for _ in 0..chunk {
                let Some((f, new)) = self.cs_sched.next_frame(seen.saturating_sub(start)) else {
                    break;
                };
                let mut pre = match self.cs_pre.take() {
                    Some(p) if !new => p,
                    _ => pipe.pre.clone(),
                };
                self.cs_now = Some(false);
                self.frame(
                    f + start,
                    &mut pre,
                    None,
                    start,
                    rec,
                    drift,
                    pipe,
                    live,
                    sl,
                    n_px,
                    10,
                );
                self.cs_now = None;
                self.cs_pre = Some(pre);
                self.cs_frames += 1;
                n += 1;
            }
            self.cs_wall_s += t0.elapsed().as_secs_f64();
            if n == 0 {
                return None;
            }
            if mode != CsMode::Frames {
                sl.settle_credit(budget * n, budget * 64);
            }
            return Some(sl.work() - w0);
        }
        if mode != CsMode::Visits {
            let (f, new) = self.cs_sched.next_frame(seen.saturating_sub(start))?;
            let mut pre = match self.cs_pre.take() {
                Some(p) if !new => p,
                _ => pipe.pre.clone(),
            };
            self.cs_now = Some(mode == CsMode::Full);
            self.frame(
                f + start,
                &mut pre,
                None,
                start,
                rec,
                drift,
                pipe,
                live,
                sl,
                n_px,
                10,
            );
            self.cs_now = None;
            self.cs_pre = Some(pre);
            self.cs_frames += 1;
        }
        if mode != CsMode::Frames {
            sl.step_settle(budget).unwrap();
        }
        self.cs_wall_s += t0.elapsed().as_secs_f64();
        Some(sl.work() - w0)
    }

    /// The lock-step schedule (no `--offered-fps`): after Discover frame
    /// `t_rec` the settle gets the frames that frame earned.
    #[allow(clippy::too_many_arguments)]
    fn cs_after_frame(
        &mut self,
        t_rec: usize,
        t_len: usize,
        budget: u64,
        start: usize,
        rec: &mut Recording,
        drift: Option<&Drift>,
        pipe: &mut Pipeline,
        live: &TraceEngine,
        sl: &mut SlowLoop,
        n_px: usize,
    ) {
        let Some(cfg) = self.cs.as_ref() else { return };
        let x = (t_rec.saturating_sub(start)) as f64 / (t_len.saturating_sub(start)).max(1) as f64;
        let w = match cfg.ramp {
            0 => 1.0,
            1 => 2.0 * x,
            _ => {
                if x < 0.5 {
                    0.0
                } else {
                    2.0
                }
            }
        };
        self.cs_sched.earn(w);
        while self.cs_sched.take() {
            if self
                .cs_unit(t_rec + 1, budget, start, rec, drift, pipe, live, sl, n_px)
                .is_none()
            {
                break;
            }
        }
    }

    /// Spend the budget after Discover frame `t_rec` (recording frame).
    #[allow(clippy::too_many_arguments)]
    fn after_frame(
        &mut self,
        t_rec: usize,
        t_len: usize,
        start: usize,
        rec: &mut Recording,
        drift: Option<&Drift>,
        pipe: &mut Pipeline,
        live: &TraceEngine,
        sl: &mut SlowLoop,
        n_px: usize,
    ) {
        let t0 = Instant::now();
        let seen = t_rec + 1;
        let tenth = (10 * t_rec / t_len.max(1)).min(9);
        if self.catchup > 0 {
            // None at the last frame: nothing would use it.
            if seen >= self.next_catchup && seen < t_len {
                self.next_catchup = if self.catchup_double {
                    2 * self.next_catchup
                } else {
                    self.next_catchup + self.catchup
                };
                let mut pre = pipe.pre.clone();
                for f in 0..seen {
                    self.frame(
                        f, &mut pre, None, start, rec, drift, pipe, live, sl, n_px, tenth,
                    );
                }
            }
        } else {
            self.sched.note_frame(live.library(), seen);
            let rate = self.rate;
            self.spend(
                rate,
                usize::MAX,
                tenth,
                start,
                rec,
                drift,
                pipe,
                live,
                sl,
                n_px,
            );
        }
        self.wall_s += t0.elapsed().as_secs_f64();
    }

    /// Spend `add` look-back frames of budget on the cells in need;
    /// `false` when nothing is needed.
    #[allow(clippy::too_many_arguments)]
    fn spend(
        &mut self,
        add: f64,
        max: usize,
        tenth: usize,
        start: usize,
        rec: &mut Recording,
        drift: Option<&Drift>,
        pipe: &mut Pipeline,
        live: &TraceEngine,
        sl: &mut SlowLoop,
        n_px: usize,
    ) -> bool {
        self.sched.add_credit(add);
        for _ in 0..max {
            let req = match self.sched.next(sl, live.library()) {
                LookbackNext::Frame(r) => r,
                LookbackNext::NoCredit => return true,
                LookbackNext::Idle => {
                    self.block = None;
                    return false;
                }
            };
            // A new block starts from the live preprocessor's state.
            let (_, mut pre) = match self.block.take() {
                Some((seq, pre)) if seq == req.block => (seq, pre),
                _ => (req.block, pipe.pre.clone()),
            };
            let pushed = self.frame(
                req.frame,
                &mut pre,
                Some(&req.ids),
                start,
                rec,
                drift,
                pipe,
                live,
                sl,
                n_px,
                tenth,
            );
            self.block = Some((req.block, pre));
            // Precision mode: a held-out frame passed over is not solved.
            self.sched.frame_done(if pushed.is_none() {
                LookbackOutcome::Skipped
            } else {
                LookbackOutcome::Observed
            });
        }
        true
    }

    /// `--lb-gate` (virtual clock): the need-driven look-back as the app
    /// runs it (`SlowRunner.needRequest`): every forwarded frame earns
    /// `add` frames of budget, and frames go out only in requests of at
    /// most `max` when the look-back worker is free (`max` 0: it is busy,
    /// the budget is banked). Returns the frames taken.
    #[allow(clippy::too_many_arguments)]
    fn after_frame_gated(
        &mut self,
        t_rec: usize,
        t_len: usize,
        add: f64,
        max: usize,
        start: usize,
        rec: &mut Recording,
        drift: Option<&Drift>,
        pipe: &mut Pipeline,
        live: &TraceEngine,
        sl: &mut SlowLoop,
        n_px: usize,
    ) -> u64 {
        let t0 = Instant::now();
        let tenth = (10 * t_rec / t_len.max(1)).min(9);
        self.sched.note_frame(live.library(), t_rec + 1);
        self.sched.add_credit(add);
        let f0 = self.frames;
        if max > 0 {
            self.spend(0.0, max, tenth, start, rec, drift, pipe, live, sl, n_px);
        }
        self.wall_s += t0.elapsed().as_secs_f64();
        self.frames - f0
    }

    /// `--lb-gate`: the scheduler has budget and cells in need.
    fn need_pending(&self) -> bool {
        self.sched.credit() >= 1.0 && self.sched.in_need() > 0
    }

    /// `--lookback-drain N` (recorded data): after Discover's last frame,
    /// keep serving the cells in need (at most `N` steps of `rate` frames)
    /// with Refine-scope visits between them, as the app could before
    /// Extract. Returns (steps, look-back frames).
    #[allow(clippy::too_many_arguments)]
    fn drain(
        &mut self,
        max_steps: usize,
        budget: u64,
        start: usize,
        rec: &mut Recording,
        drift: Option<&Drift>,
        pipe: &mut Pipeline,
        engine: &mut TraceEngine,
        sl: &mut SlowLoop,
        n_px: usize,
    ) -> (usize, u64) {
        let t0 = Instant::now();
        let f0 = self.frames;
        sl.set_edit_scope(EditScope::Refine);
        let rate = if self.drain_rate > 0.0 {
            self.drain_rate
        } else {
            self.rate.max(1.0)
        };
        let mut steps = 0;
        while steps < max_steps {
            let more = self.spend(
                rate,
                usize::MAX,
                10,
                start,
                rec,
                drift,
                pipe,
                engine,
                sl,
                n_px,
            );
            if steps % 64 == 0 {
                sl.mark_all_due();
            }
            sl.step(budget).unwrap();
            steps += 1;
            if steps % 64 == 0 {
                engine.set_library(sl.finalize().unwrap()).unwrap();
            }
            if !more {
                break;
            }
        }
        // `--lookback-settle-all N`: then about N frames spread evenly over
        // the recording go to every cell (untargeted, so the forgetting
        // clock advances and old statistics are replaced), with the same
        // step, visit and publish cadence as the drain above.
        let t_len = rec.total as usize;
        if let Some(stride) = t_len.checked_div(self.settle_all) {
            let stride = stride.max(1);
            let mut pre = pipe.pre.clone();
            self.block = None;
            for (i, f) in (0..t_len).step_by(stride).enumerate() {
                self.frame(
                    f, &mut pre, None, start, rec, drift, pipe, engine, sl, n_px, 10,
                );
                if i % 2 == 1 {
                    let st = i / 2;
                    if st % 64 == 0 {
                        sl.mark_all_due();
                    }
                    sl.step(budget).unwrap();
                    if st % 64 == 63 {
                        engine.set_library(sl.finalize().unwrap()).unwrap();
                    }
                }
            }
        }
        // A last round of visits on everything the look-back fed.
        sl.mark_all_due();
        for _ in 0..256 {
            sl.step(budget).unwrap();
        }
        engine.set_library(sl.finalize().unwrap()).unwrap();
        self.drain_steps = steps;
        self.drain_frames = self.frames - f0;
        self.drain_wall_s = t0.elapsed().as_secs_f64();
        self.wall_s += self.drain_wall_s;
        (steps, self.frames - f0)
    }

    /// `--settle-frames N`: the end-of-Discover settle (after the drain,
    /// cell set frozen). Frames of the recording are re-read in rounds
    /// (each round about `round` frames in whole `LB_BLOCK` blocks spread
    /// evenly over the recording, later rounds on other blocks) and fed to
    /// every cell, `batch` frames per request (the library the look-back
    /// engine solves with is fixed within a request) followed by the
    /// slow-loop steps those frames earn. At every checkpoint the footprint
    /// change since the last one is compared with the cells' split-half
    /// noise (`settle_checks.tsv`); with a stop rule the settle ends there.
    /// Returns the frames fed.
    #[allow(clippy::too_many_arguments)]
    fn settle(
        &mut self,
        t_len: usize,
        budget: u64,
        start: usize,
        rec: &mut Recording,
        drift: Option<&Drift>,
        pipe: &mut Pipeline,
        engine: &mut TraceEngine,
        sl: &mut SlowLoop,
        n_px: usize,
    ) -> usize {
        let cfg = self.settle.clone();
        let t0 = Instant::now();
        // The frames Discover read (`--frames` may stop short of the file).
        let t_len = t_len.min(rec.total as usize);
        sl.set_edit_scope(EditScope::Refine);
        engine.set_library(sl.finalize().unwrap()).unwrap();
        self.full_observe = cfg.observe != SettleObserve::Stats;
        sl.set_reservoir_frozen(cfg.observe == SettleObserve::Frozen);
        let n_blocks = t_len.div_ceil(LB_BLOCK);
        let round = if cfg.round == 0 { t_len } else { cfg.round };
        // Every `stride`-th block per round; round r starts at block r % stride.
        let stride = (t_len as f64 / round as f64).round().max(1.0) as usize;
        let s0 = sl.stats();
        let w0 = sl.work();
        let mut prev = SettleSnap::take(engine.library(), sl);
        self.settle_out = String::from(
            "check\tframes\twall_s\tcells\trel_l2_med\tshape_med\tnoise_med\tratio_med\tratio_p75\tratio_p90\tshare_gt1\tshare_gt1p5\tshare_gt2\tshare_gt3\tvisits\trefines\tcommits\twork\tstop\n",
        );
        if cfg.libs {
            self.settle_libs.push((0, engine.library().clone()));
        }
        let (mut fed, mut steps_owed, mut check, mut in_batch) = (0usize, 0.0f64, 0usize, 0usize);
        let (mut next_due, mut next_pub, mut next_check) =
            (cfg.due_every, cfg.publish_every, cfg.check);
        let mut pre = pipe.pre.clone();
        let mut expect = usize::MAX;
        self.block = None;
        let mut stopped = false;
        let mut below = 0usize;
        let mut r = 0usize;
        'rounds: while fed < cfg.frames {
            let first = r % stride;
            r += 1;
            for b in (first..n_blocks).step_by(stride) {
                let lo = b * LB_BLOCK;
                let hi = (lo + LB_BLOCK).min(t_len);
                for f in lo..hi {
                    if f != expect {
                        // A block that does not follow the last one starts
                        // from the live preprocessor's state, as a look-back
                        // block does.
                        pre = pipe.pre.clone();
                    }
                    expect = f + 1;
                    self.frame(
                        f, &mut pre, None, start, rec, drift, pipe, engine, sl, n_px, 10,
                    );
                    fed += 1;
                    in_batch += 1;
                    steps_owed += cfg.steps_per_frame;
                    if fed.is_multiple_of(200) {
                        // On `--settle-source factors` the preprocessor copy
                        // does not run forward, so this sets the noise
                        // Discover ended with each time. Intended: the
                        // factors carry each frame's own live preprocessing.
                        sl.set_noise(pre.noise().sigma()).unwrap();
                    }
                    if in_batch < cfg.batch && fed < cfg.frames {
                        continue;
                    }
                    in_batch = 0;
                    if cfg.due_every > 0 && fed >= next_due {
                        sl.mark_all_due();
                        next_due += cfg.due_every;
                    }
                    // The steps this request's frames earn, as one visit
                    // round at their summed budget.
                    let n = steps_owed.floor();
                    steps_owed -= n;
                    if n >= 1.0 {
                        let got = sl.step(budget.saturating_mul(n as u64)).unwrap();
                        if let Some(l) = got {
                            engine.set_library(l).unwrap();
                        }
                    }
                    if cfg.publish_every > 0 && fed >= next_pub {
                        engine.set_library(sl.finalize().unwrap()).unwrap();
                        next_pub += cfg.publish_every;
                    }
                    if fed >= next_check || fed >= cfg.frames {
                        next_check += cfg.check;
                        check += 1;
                        engine.set_library(sl.finalize().unwrap()).unwrap();
                        let now = SettleSnap::take(engine.library(), sl);
                        let m = now.change_from(&prev);
                        // The stop rule: the share of cells that moved by
                        // more than `stop_k` times their own split-half
                        // noise since the last checkpoint is at most
                        // `stop_share`, at `stop_checks` checkpoints in a row.
                        let hit =
                            cfg.stop_share > 0.0 && m.share_above(cfg.stop_k) <= cfg.stop_share;
                        below = if hit { below + 1 } else { 0 };
                        let stop = hit && below >= cfg.stop_checks && fed >= cfg.min_frames;
                        let st = sl.stats();
                        let _ = writeln!(
                            self.settle_out,
                            "{check}\t{fed}\t{:.1}\t{}\t{:.5}\t{:.6}\t{:.5}\t{:.4}\t{:.4}\t{:.4}\t{:.4}\t{:.4}\t{:.4}\t{:.4}\t{}\t{}\t{}\t{}\t{}",
                            t0.elapsed().as_secs_f64(),
                            m.ratio.len(),
                            m.rel_med,
                            m.shape_med,
                            m.noise_med,
                            m.q(0.5),
                            m.q(0.75),
                            m.q(0.9),
                            m.share_above(1.0),
                            m.share_above(1.5),
                            m.share_above(2.0),
                            m.share_above(3.0),
                            st.visits - s0.visits,
                            st.refines - s0.refines,
                            st.commits - s0.commits,
                            sl.work() - w0,
                            u8::from(stop)
                        );
                        if cfg.libs {
                            self.settle_libs.push((check, engine.library().clone()));
                        }
                        prev = now;
                        if stop {
                            stopped = true;
                            break 'rounds;
                        }
                    }
                    if fed >= cfg.frames {
                        break 'rounds;
                    }
                }
            }
        }
        // A last round of visits on what the settle fed.
        sl.mark_all_due();
        sl.step(budget.saturating_mul(64)).unwrap();
        engine.set_library(sl.finalize().unwrap()).unwrap();
        sl.set_reservoir_frozen(false);
        self.full_observe = false;
        let wall = t0.elapsed().as_secs_f64();
        self.wall_s += wall;
        let st = sl.stats();
        println!(
            "settle source: {}, {} raw frames read",
            match &self.settle_src {
                Some(s) => format!("factors ({} window files read)", s.reads()),
                None => "raw".into(),
            },
            self.settle_raw
        );
        println!(
            "settle: {fed} frames in {wall:.1} s ({:.0} frames/s), {} visits, {} refines, {} publishes, work {:.3e}{}",
            fed as f64 / wall.max(1e-9),
            st.visits - s0.visits,
            st.refines - s0.refines,
            st.commits - s0.commits,
            (sl.work() - w0) as f64,
            if stopped { ", stopped by the rule" } else { ", stopped at the frame cap" }
        );
        fed
    }

    /// Re-read, preprocess and (unless held out in precision mode) solve
    /// and observe recording frame `f`: `None` when passed over (held out,
    /// precision mode), else whether it was pushed.
    #[allow(clippy::too_many_arguments)]
    fn frame(
        &mut self,
        f: usize,
        pre: &mut Preprocessor,
        only: Option<&[u64]>,
        start: usize,
        rec: &mut Recording,
        drift: Option<&Drift>,
        pipe: &mut Pipeline,
        live: &TraceEngine,
        sl: &mut SlowLoop,
        n_px: usize,
        tenth: usize,
    ) -> Option<bool> {
        let from_factors = self.full_observe && self.settle_src.is_some();
        if !from_factors && (f < self.raw_start || f >= self.raw_start + self.raw_n) {
            let lo = f - f % LB_BLOCK;
            let cnt = LB_BLOCK.min(rec.total as usize - lo);
            self.raw = rec.read(lo as u32, cnt as u32);
            if let Some(d) = drift {
                for (k, fr) in self.raw.chunks_exact_mut(n_px).enumerate() {
                    d.apply(fr, lo + k);
                }
            }
            self.raw_start = lo;
            self.raw_n = cnt;
        }
        // The frame's slow-loop index in Discover (all batches forwarded):
        // a held-out frame stays held out. Warm-up frames, never in the
        // slow loop, get their own range.
        let idx = match (f >= start, self.slow_of.is_empty()) {
            (true, true) => (f - start) as u64,
            (true, false) => match self.slow_of.get(f - start) {
                Some(&i) if i != u32::MAX => u64::from(i),
                // Never seen by the slow loop: a side of its own, as
                // `HeldOutRecord` gives it.
                _ => u64::MAX - f as u64,
            },
            _ => u64::MAX - f as u64,
        };
        // Precision mode: a held-out frame is still preprocessed (the block's
        // preprocessor copy runs forward) but not solved.
        let cs_skip = self.cs_jobs && self.cs_now.is_some() && sl.is_test(idx);
        self.cs_skipped += u64::from(cs_skip);
        let skip = cs_skip || self.target > 0.0 && sl.is_test(idx);
        if from_factors {
            // The frame as Discover compressed it: no re-read, no
            // preprocessing (the block's preprocessor copy does not run).
            let src = self.settle_src.as_mut().unwrap();
            src.frame(f, &mut self.y)
                .unwrap_or_else(|m| panic!("settle on factors: {m}"));
        } else {
            if self.full_observe {
                self.settle_raw += 1;
            }
            let o = (f - self.raw_start) * n_px;
            let raw = &self.raw[o..o + n_px];
            pre.front(raw, &mut self.buf).unwrap();
            if let Some(w) = pipe.warp_at(f) {
                let mut tmp = Vec::new();
                w.apply_in_place(&mut self.buf, &mut tmp).unwrap();
            }
            // The live corrector's `apply`/`validity` only warp by a stored
            // record (scratch buffers, no estimation state), as a replay does.
            if let Some(mc) = pipe.mc.as_mut() {
                let r = &pipe.records[f];
                mc.apply(Frame::F32(&self.buf), r, &mut self.y, None)
                    .unwrap();
                mc.validity(r, pipe.src.as_ref().unwrap(), &mut self.valid)
                    .unwrap();
                pre.back_masked(&mut self.y, &self.valid).unwrap();
            } else {
                self.y.copy_from_slice(&self.buf);
                pre.back(&mut self.y).unwrap();
            }
        }
        if skip {
            return None;
        }
        let lib = live.library();
        let eng = self.engine.get_or_insert_with(|| live.clone());
        if eng.library().version() != lib.version() {
            eng.set_library(lib.clone()).unwrap();
        }
        let tr = eng.process(&self.y).unwrap();
        let lib = eng.library().clone();
        let n_cells = only.map_or(lib.len(), <[u64]>::len) as u64;
        if let Some(reservoir) = self.cs_now {
            let held = sl.is_test(idx);
            sl.observe_settle(&self.y, &lib, &tr, idx, held, reservoir)
                .unwrap();
            return Some(!held);
        }
        let pushed = if self.full_observe {
            sl.observe(&self.y, &lib, &tr).unwrap();
            true
        } else {
            sl.observe_lookback(&self.y, &lib, &tr, idx, only).unwrap()
        };
        if pushed {
            self.pushed += 1;
        }
        self.frames += 1;
        self.cell_frames += n_cells;
        self.by_tenth[tenth].0 += 1;
        self.by_tenth[tenth].1 += n_cells;
        if tenth < 10 {
            let tw =
                (20 * self.sched.seen().saturating_sub(1) / (rec.total as usize).max(1)).min(19);
            self.by_twentieth[tw] += 1;
        }
        Some(pushed)
    }
}

/// Preprocessing (and optionally motion correction) of raw frames.
struct Pipeline {
    pre: Preprocessor,
    mc: Option<MotionCorrector>,
    buf: Vec<f32>,
    /// Registered frames: the sensor FOV mask as the warp's source, and the
    /// per-frame validity (samples moved in from outside the mask are missing).
    src: Option<calab_cala::motion::SourceMask>,
    valid: Vec<u8>,
    /// Motion records of every frame processed, kept when `keep_records`
    /// (repeated passes replay them).
    keep_records: bool,
    records: Vec<MotionRecord>,
    /// `--boundary-log`: the last frame's preprocessing and motion records
    /// (read-only copies; nothing downstream uses them).
    /// input mean, glow mean, flicker offset, flicker gain, flicker kept share
    last_front: [f32; 5],
    /// floor mean, share of the floor lowered
    last_back: [f32; 2],
    last_motion: (f32, u32),
    /// `--sessions`: the session-level warp in force (None = identity) and
    /// the FOV mask it moves (the corrector's validity source).
    session_warp: Option<calab_cala::motion::SessionWarp>,
    fov_mask: Vec<u8>,
    /// Per-frame session warps for replays (frame where each starts).
    session_warps: Vec<(usize, Option<calab_cala::motion::SessionWarp>)>,
    /// Mean of the registered frames before the next boundary (the
    /// session re-registration's reference).
    reference: calab_cala::motion::session::ReferenceMean,
    /// Frames already through front + motion whose back half waits (a
    /// boundary's first frames, see `prefetch_session`):
    /// (registered frame, validity, record, front record).
    prepared: std::collections::VecDeque<PreparedFrame>,
    /// Add this frame's registered image to `reference`.
    collect_reference: bool,
    /// `--sessions` with re-registration: the boundary correlation's
    /// within-session null (as the app's `SessionAligner.nullSample`): a
    /// block of `null_ref` registered frames, then the mean of the next
    /// `null_fit` front frames (after the session warp) scored against it.
    null_on: bool,
    null_ref: usize,
    null_fit: usize,
    null_block: calab_cala::motion::session::ReferenceMean,
    null_moving: calab_cala::motion::session::ReferenceMean,
    /// The sample the last frame completed (taken by the caller).
    null_last: Option<f32>,
}

/// A frame through front + motion whose back half waits: registered frame,
/// validity, motion record, front record (`Pipeline::last_front`).
type PreparedFrame = (Vec<f32>, Vec<u8>, MotionRecord, [f32; 5]);

/// `--sessions` / `--session-fix`: the session-boundary fixes in force.
#[derive(Debug, Clone, Copy, Default)]
struct SessionFix {
    register: bool,
    floor: bool,
    flicker: bool,
    noise: bool,
}

impl SessionFix {
    fn parse(s: &str) -> SessionFix {
        let mut f = SessionFix::default();
        for k in s.split(',').filter(|k| !k.is_empty()) {
            match k {
                "all" => {
                    f = SessionFix {
                        register: true,
                        floor: true,
                        flicker: true,
                        noise: true,
                    }
                }
                "none" => f = SessionFix::default(),
                "reg" => f.register = true,
                "floor" => f.floor = true,
                "flicker" => f.flicker = true,
                "noise" => f.noise = true,
                _ => {
                    panic!("--session-fix: unknown fix {k} (all, none, reg, floor, flicker, noise)")
                }
            }
        }
        f
    }

    fn any(&self) -> bool {
        self.register || self.floor || self.flicker || self.noise
    }
}

impl Pipeline {
    fn new(
        rec: &mut Recording,
        pre: Preprocessor,
        cal: &Calibration,
        motion: bool,
        warm: u32,
    ) -> Pipeline {
        let dims = rec.dims;
        let n_px = dims.pixels();
        let mut pre = pre;
        let mc = if motion {
            let raw = rec.read(0, warm.min(rec.total));
            let mut frames = vec![0.0f32; raw.len()];
            for (r, o) in raw.chunks_exact(n_px).zip(frames.chunks_exact_mut(n_px)) {
                pre.front(r, o).unwrap();
            }
            let cfg = MotionConfig {
                nonrigid: Some(NonRigidConfig::default()),
                ..MotionConfig::default()
            };
            let mut mc = MotionCorrector::new(dims.height, dims.width, cfg).unwrap();
            mc.set_fov_mask(cal.fov().mask()).unwrap();
            mc.initialize(Frames::F32(&frames)).unwrap();
            Some(mc)
        } else {
            None
        };
        let src = mc.as_ref().map(|_| {
            calab_cala::motion::SourceMask::new(
                dims.height,
                dims.width,
                cal.fov().mask(),
                calab_cala::motion::Interpolation::Bicubic,
            )
            .unwrap()
        });
        Pipeline {
            pre,
            mc,
            buf: vec![0.0; n_px],
            src,
            valid: vec![0; n_px],
            keep_records: false,
            records: Vec::new(),
            last_front: [f32::NAN; 5],
            last_back: [f32::NAN; 2],
            last_motion: (f32::NAN, 0),
            session_warp: None,
            fov_mask: cal.fov().mask().to_vec(),
            session_warps: Vec::new(),
            reference: calab_cala::motion::session::ReferenceMean::new(),
            prepared: std::collections::VecDeque::new(),
            collect_reference: false,
            null_on: false,
            null_ref: 100,
            null_fit: 8,
            null_block: calab_cala::motion::session::ReferenceMean::new(),
            null_moving: calab_cala::motion::session::ReferenceMean::new(),
            null_last: None,
        }
    }

    /// Install a session warp (None = identity) from frame `t` on.
    fn set_session_warp(&mut self, t: usize, warp: Option<calab_cala::motion::SessionWarp>) {
        let d = self.pre.dims();
        let mask = match &warp {
            Some(w) => w.source_mask(&self.fov_mask).unwrap(),
            None => self.fov_mask.clone(),
        };
        if self.src.is_some() {
            self.src = Some(
                calab_cala::motion::SourceMask::new(
                    d.height,
                    d.width,
                    &mask,
                    calab_cala::motion::Interpolation::Bicubic,
                )
                .unwrap(),
            );
        }
        self.session_warps.push((t, warp.clone()));
        self.session_warp = warp;
    }

    /// The translation of the session warp of recording frame `t`.
    fn session_shift_at(&self, t: usize) -> (f32, f32) {
        self.warp_at(t).map_or((0.0, 0.0), |w| {
            let tr = w.transform();
            (tr.dy, tr.dx)
        })
    }

    /// The session warp of recording frame `t` (replays).
    fn warp_at(&self, t: usize) -> Option<&calab_cala::motion::SessionWarp> {
        self.session_warps
            .iter()
            .rev()
            .find(|(s, _)| *s <= t)
            .and_then(|(_, w)| w.as_ref())
    }

    /// The within-session null after a frame: `registered` is its
    /// registered image, `self.buf` its front (after the session warp).
    fn observe_null(&mut self, registered: &[f32]) {
        if !self.null_on {
            return;
        }
        let px = registered.len();
        if (self.null_block.frames() as usize) < self.null_ref {
            self.null_block.push(registered, px);
            return;
        }
        self.null_moving.push(&self.buf, px);
        if (self.null_moving.frames() as usize) < self.null_fit {
            return;
        }
        let (Some(r), Some(m)) = (self.null_block.mean(), self.null_moving.mean()) else {
            return;
        };
        let d = self.pre.dims();
        self.null_last = calab_cala::motion::session::block_ncc(
            &r,
            &m,
            d.height,
            d.width,
            &self.fov_mask,
            &calab_cala::motion::SessionAlignConfig::default(),
        )
        .unwrap();
        self.null_block.clear();
        self.null_moving.clear();
    }

    /// Front half, session warp and motion of `raw` into `out` (registered,
    /// before the back half) and `self.valid`.
    fn front_motion(&mut self, raw: &[u8], out: &mut [f32]) -> (MotionRecord, [f32; 5]) {
        let fr = self.pre.front(raw, &mut self.buf).unwrap();
        let front = [
            fr.input_mean,
            fr.lowpass_mean,
            fr.flicker.offset,
            fr.flicker.gain,
            fr.flicker.kept_fraction,
        ];
        if let Some(w) = &self.session_warp {
            let mut tmp = Vec::new();
            w.apply_in_place(&mut self.buf, &mut tmp).unwrap();
        }
        let mc = self.mc.as_mut().expect("sessions need --motion");
        let rec = mc.process(Frame::F32(&self.buf), out).unwrap();
        let m = self.src.as_ref().unwrap();
        mc.validity(&rec, m, &mut self.valid).unwrap();
        if self.collect_reference {
            self.reference.push(out, out.len());
        }
        self.observe_null(out);
        (rec, front)
    }

    /// A session starts at the next frame: run the front half, session warp
    /// and motion of its first frames `raws` now (as the app's stages do a
    /// batch before the back half sees it), let the back half fit the new
    /// session on them, and keep them for `frame`.
    fn prefetch_session(
        &mut self,
        raws: &[u8],
        cfg: &calab_cala::preprocess::session::SessionBackConfig,
    ) -> calab_cala::preprocess::session::SessionBackFit {
        let px = self.pre.dims().pixels();
        let mut frames = Vec::with_capacity(raws.len());
        let mut valid = Vec::with_capacity(raws.len());
        for r in raws.chunks_exact(px) {
            let mut out = vec![0.0f32; px];
            let (rec, front) = self.front_motion(r, &mut out);
            frames.extend_from_slice(&out);
            valid.extend_from_slice(&self.valid);
            self.prepared
                .push_back((out, self.valid.clone(), rec, front));
        }
        self.pre
            .begin_session_back(&frames, Some(&valid), cfg)
            .unwrap()
    }

    /// Like `frame`, but a motion run warps by the stored record of frame
    /// `t` (no estimation, the corrector's state is unchanged).
    fn frame_replay(&mut self, raw: &[u8], out: &mut [f32], t: usize) -> Option<(f32, f32)> {
        self.pre.front(raw, &mut self.buf).unwrap();
        if let Some(w) = self.warp_at(t).cloned() {
            let mut tmp = Vec::new();
            w.apply_in_place(&mut self.buf, &mut tmp).unwrap();
        }
        match &mut self.mc {
            Some(mc) => {
                let rec = &self.records[t];
                mc.apply(Frame::F32(&self.buf), rec, out, None).unwrap();
                let m = self.src.as_ref().unwrap();
                mc.validity(rec, m, &mut self.valid).unwrap();
                self.pre.back_masked(out, &self.valid).unwrap();
                Some((rec.dy, rec.dx))
            }
            None => {
                out.copy_from_slice(&self.buf);
                self.pre.back(out).unwrap();
                None
            }
        }
    }

    /// Returns the rigid shift of the frame (motion runs).
    fn frame(&mut self, raw: &[u8], out: &mut [f32]) -> Option<(f32, f32)> {
        if self.mc.is_some() && (self.session_warp.is_some() || !self.prepared.is_empty()) {
            let (rec, front) = match self.prepared.pop_front() {
                Some((f, v, rec, front)) => {
                    out.copy_from_slice(&f);
                    self.valid.copy_from_slice(&v);
                    (rec, front)
                }
                None => self.front_motion(raw, out),
            };
            self.last_front = front;
            let b = self.pre.back_masked(out, &self.valid).unwrap();
            self.last_back = [b.floor_mean, b.floor_lowered_fraction];
            self.last_motion = (rec.quality, rec.flags);
            let shift = Some((rec.dy, rec.dx));
            if self.keep_records {
                self.records.push(rec);
            }
            return shift;
        }
        let fr = self.pre.front(raw, &mut self.buf).unwrap();
        self.last_front = [
            fr.input_mean,
            fr.lowpass_mean,
            fr.flicker.offset,
            fr.flicker.gain,
            fr.flicker.kept_fraction,
        ];
        match &mut self.mc {
            Some(mc) => {
                let rec = mc.process(Frame::F32(&self.buf), out).unwrap();
                let m = self.src.as_ref().unwrap();
                mc.validity(&rec, m, &mut self.valid).unwrap();
                if self.collect_reference {
                    self.reference.push(out, out.len());
                }
                self.observe_null(out);
                let b = self.pre.back_masked(out, &self.valid).unwrap();
                self.last_back = [b.floor_mean, b.floor_lowered_fraction];
                self.last_motion = (rec.quality, rec.flags);
                let shift = Some((rec.dy, rec.dx));
                if self.keep_records {
                    self.records.push(rec);
                }
                shift
            }
            None => {
                out.copy_from_slice(&self.buf);
                let b = self.pre.back(out).unwrap();
                self.last_back = [b.floor_mean, b.floor_lowered_fraction];
                None
            }
        }
    }
}

/// `--boundary-log` (built with `--features diagnostics`): per-frame
/// preprocessing state and every cell's online trace and ring-background
/// level, for the session-boundary study
/// (`tools/cala-eval/results/2026-11-13-session-boundary.md`). Read-only:
/// it copies values the loop already computed.
struct BoundaryLog {
    /// `boundary_pre.tsv` rows.
    pre: String,
    /// id -> (first frame, traces, ring-background levels); NaN where the
    /// id was absent.
    cells: HashMap<u64, (usize, Vec<f32>, Vec<f32>)>,
}

impl BoundaryLog {
    fn new() -> BoundaryLog {
        BoundaryLog {
            pre: String::from(
                "frame\tinput_mean\tlowpass_mean\tflicker_offset\tflicker_gain\tflicker_kept\tfloor_mean\tfloor_lowered\tnoise_mean\tnoise_p50\tmotion_quality\tmotion_flags\n",
            ),
            cells: HashMap::new(),
        }
    }

    fn frame(&mut self, t: usize, pipe: &Pipeline, ids: &[u64], tr: &FrameTraces) {
        let f = &pipe.last_front;
        let b = &pipe.last_back;
        // The noise map every 10 frames (it allocates a frame).
        let (nm, np) = if t.is_multiple_of(10) {
            let mut s: Vec<f32> = pipe
                .pre
                .noise()
                .sigma()
                .into_iter()
                .filter(|v| v.is_finite() && *v > 0.0)
                .collect();
            let mean = s.iter().map(|&v| f64::from(v)).sum::<f64>() / s.len().max(1) as f64;
            let mid = s.len() / 2;
            let p50 = if s.is_empty() {
                f32::NAN
            } else {
                *s.select_nth_unstable_by(mid, f32::total_cmp).1
            };
            (mean as f32, p50)
        } else {
            (f32::NAN, f32::NAN)
        };
        let _ = writeln!(
            self.pre,
            "{t}\t{:.4}\t{:.4}\t{:.4}\t{:.5}\t{:.3}\t{:.4}\t{:.5}\t{nm:.4}\t{np:.4}\t{:.4}\t{}",
            f[0], f[1], f[2], f[3], f[4], b[0], b[1], pipe.last_motion.0, pipe.last_motion.1
        );
        for (k, &id) in ids.iter().enumerate() {
            let e = self
                .cells
                .entry(id)
                .or_insert_with(|| (t, Vec::new(), Vec::new()));
            let gap = t - e.0 - e.1.len();
            e.1.extend(std::iter::repeat_n(f32::NAN, gap));
            e.2.extend(std::iter::repeat_n(f32::NAN, gap));
            e.1.push(tr.traces[k]);
            e.2.push(tr.background.get(k).copied().unwrap_or(f32::NAN));
        }
    }

    /// `boundary_pre.tsv` and `boundary_traces.bin` (`CALABTL1`, u32 cells,
    /// then per cell: u64 id, u32 first frame, u32 length, f32 traces,
    /// f32 ring levels; little endian).
    fn write(&self, dir: &Path) {
        std::fs::write(dir.join("boundary_pre.tsv"), &self.pre).unwrap();
        let mut f = BufWriter::new(File::create(dir.join("boundary_traces.bin")).unwrap());
        f.write_all(b"CALABTL1").unwrap();
        let mut ids: Vec<&u64> = self.cells.keys().collect();
        ids.sort_unstable();
        f.write_all(&(ids.len() as u32).to_le_bytes()).unwrap();
        for id in ids {
            let (t0, c, bg) = &self.cells[id];
            f.write_all(&id.to_le_bytes()).unwrap();
            f.write_all(&(*t0 as u32).to_le_bytes()).unwrap();
            f.write_all(&(c.len() as u32).to_le_bytes()).unwrap();
            write_f32s(&mut f, c);
            write_f32s(&mut f, bg);
        }
    }
}

/// A cell's filtered footprint as `(pixel, value)` pairs, shifted by `off`.
fn columns(lib: &Library, dims: Dims, off: (i32, i32)) -> Vec<Vec<(u32, f32)>> {
    (0..lib.len())
        .map(|s| {
            let (p, v) = lib.filtered(s);
            p.iter()
                .zip(v)
                .filter_map(|(&q, &a)| {
                    let (y, x) = (
                        (q as usize / dims.width) as i32 + off.0,
                        (q as usize % dims.width) as i32 + off.1,
                    );
                    (y >= 0 && x >= 0 && (y as usize) < dims.height && (x as usize) < dims.width)
                        .then(|| ((y as usize * dims.width + x as usize) as u32, a))
                })
                .collect()
        })
        .collect()
}

/// Pearson correlation of two sparse images over the union of their pixels.
fn sparse_corr(a: &[(u32, f32)], b: &[(u32, f32)], scratch: &mut [f32]) -> f64 {
    for &(p, v) in a {
        scratch[p as usize] = v;
    }
    let mut union: Vec<(f64, f64)> = a
        .iter()
        .map(|&(_, v)| (f64::from(v), 0.0))
        .collect::<Vec<_>>();
    let mut ia: std::collections::HashMap<u32, usize> = std::collections::HashMap::new();
    for (i, &(p, _)) in a.iter().enumerate() {
        ia.insert(p, i);
    }
    for &(p, v) in b {
        match ia.get(&p) {
            Some(&i) => union[i].1 = f64::from(v),
            None => union.push((0.0, f64::from(v))),
        }
    }
    for &(p, _) in a {
        scratch[p as usize] = 0.0;
    }
    let n = union.len() as f64;
    let ma = union.iter().map(|u| u.0).sum::<f64>() / n;
    let mb = union.iter().map(|u| u.1).sum::<f64>() / n;
    let (mut sab, mut saa, mut sbb) = (0.0, 0.0, 0.0);
    for &(x, y) in &union {
        sab += (x - ma) * (y - mb);
        saa += (x - ma) * (x - ma);
        sbb += (y - mb) * (y - mb);
    }
    if saa <= 0.0 || sbb <= 0.0 {
        0.0
    } else {
        sab / (saa * sbb).sqrt()
    }
}

fn centroid(col: &[(u32, f32)], width: usize) -> (f32, f32) {
    let (mut s, mut sy, mut sx) = (0.0f32, 0.0f32, 0.0f32);
    for &(p, v) in col {
        if v > 0.0 {
            s += v;
            sy += v * (p as usize / width) as f32;
            sx += v * (p as usize % width) as f32;
        }
    }
    (sy / s.max(1e-12), sx / s.max(1e-12))
}

/// Minimum-cost assignment (rows <= cols), e-maxx Hungarian. Returns the
/// column of each row.
fn hungarian(cost: &[f64], n: usize, m: usize) -> Vec<usize> {
    assert!(n <= m);
    let inf = f64::INFINITY;
    let (mut u, mut v) = (vec![0.0; n + 1], vec![0.0; m + 1]);
    let (mut p, mut way) = (vec![0usize; m + 1], vec![0usize; m + 1]);
    for i in 1..=n {
        p[0] = i;
        let mut j0 = 0;
        let mut minv = vec![inf; m + 1];
        let mut used = vec![false; m + 1];
        loop {
            used[j0] = true;
            let i0 = p[j0];
            let mut delta = inf;
            let mut j1 = 0;
            for j in 1..=m {
                if !used[j] {
                    let cur = cost[(i0 - 1) * m + j - 1] - u[i0] - v[j];
                    if cur < minv[j] {
                        minv[j] = cur;
                        way[j] = j0;
                    }
                    if minv[j] < delta {
                        delta = minv[j];
                        j1 = j;
                    }
                }
            }
            for j in 0..=m {
                if used[j] {
                    u[p[j]] += delta;
                    v[j] -= delta;
                } else {
                    minv[j] -= delta;
                }
            }
            j0 = j1;
            if p[j0] == 0 {
                break;
            }
        }
        loop {
            let j1 = way[j0];
            p[j0] = p[j1];
            j0 = j1;
            if j0 == 0 {
                break;
            }
        }
    }
    let mut out = vec![0usize; n];
    for j in 1..=m {
        if p[j] > 0 {
            out[p[j] - 1] = j - 1;
        }
    }
    out
}

const NO: f64 = 1e3;

type Matches = (Vec<Option<(usize, f64)>>, Vec<(usize, f64)>);

/// Match detected to GT footprints: Hungarian on 1 − r over pairs with
/// centres within 15 px and r ≥ `thr`. Returns per detected cell the GT
/// index and r, plus every detected cell's best r against any GT cell.
fn match_cells(det: &[Vec<(u32, f32)>], gt: &[Vec<(u32, f32)>], dims: Dims, thr: f64) -> Matches {
    let w = dims.width;
    let dc: Vec<(f32, f32)> = det.iter().map(|c| centroid(c, w)).collect();
    let gc: Vec<(f32, f32)> = gt.iter().map(|c| centroid(c, w)).collect();
    let mut scratch = vec![0.0f32; dims.pixels()];
    let mut pairs: Vec<Vec<(usize, f64)>> = vec![Vec::new(); det.len()];
    for (i, a) in det.iter().enumerate() {
        for (j, b) in gt.iter().enumerate() {
            let (dy, dx) = (dc[i].0 - gc[j].0, dc[i].1 - gc[j].1);
            if dy * dy + dx * dx <= 225.0 {
                pairs[i].push((j, sparse_corr(a, b, &mut scratch)));
            }
        }
    }
    let best: Vec<(usize, f64)> = pairs
        .iter()
        .map(|p| {
            p.iter()
                .copied()
                .fold((usize::MAX, -1.0), |b, x| if x.1 > b.1 { x } else { b })
        })
        .collect();
    let (n, m) = (det.len(), gt.len());
    let mut out = vec![None; n];
    if n == 0 || m == 0 {
        return (out, best);
    }
    // Rows must not outnumber columns: transpose when needed.
    let transpose = n > m;
    let (r, c) = if transpose { (m, n) } else { (n, m) };
    let mut cost = vec![NO; r * c];
    for (i, p) in pairs.iter().enumerate() {
        for &(j, v) in p {
            if v >= thr {
                let (ri, ci) = if transpose { (j, i) } else { (i, j) };
                cost[ri * c + ci] = 1.0 - v;
            }
        }
    }
    let asg = hungarian(&cost, r, c);
    for (ri, &ci) in asg.iter().enumerate() {
        if cost[ri * c + ci] < NO {
            let (i, j) = if transpose { (ci, ri) } else { (ri, ci) };
            out[i] = Some((j, 1.0 - cost[ri * c + ci]));
        }
    }
    (out, best)
}

/// Offset of cala's registered frame from the simulator's tissue frame,
/// estimated from what both did: cala's rigid motion records `s_t` against
/// the sim's true rigid content motion `m_t` (minisim `shifts`).
///
/// A record registers its frame onto the template, `corrected(p) =
/// frame(p - s)`, and the frame shows the tissue moved by `m`, so the
/// registered frame is the tissue moved by `s_t + m_t`. That sum is the same
/// for every frame (the template's position: the warm-up template is the
/// mean of the first frames, wherever the tissue sat then, and the running
/// template is pinned to it) up to registration error, so its per-axis
/// median is the offset and its spread is the registration error. GT
/// footprints moved by the offset are in cala's frame.
#[derive(Clone, Copy, Debug, PartialEq)]
struct FrameOffset {
    /// Frames used.
    n: usize,
    dy: f64,
    dx: f64,
    /// Robust sd (1.4826 MAD) of `s_t + m_t` per axis.
    sd_dy: f64,
    sd_dx: f64,
}

impl FrameOffset {
    const ZERO: FrameOffset = FrameOffset {
        n: 0,
        dy: 0.0,
        dx: 0.0,
        sd_dy: 0.0,
        sd_dx: 0.0,
    };

    /// From records `rec[t]` and true content shifts `truth[t]` of the same
    /// frames (the shorter length is used).
    fn estimate(rec: &[(f32, f32)], truth: &[(f64, f64)]) -> FrameOffset {
        let n = rec.len().min(truth.len());
        if n == 0 {
            return FrameOffset::ZERO;
        }
        let axis = |k: usize| {
            let v: Vec<f64> = rec[..n]
                .iter()
                .zip(&truth[..n])
                .map(|(r, m)| {
                    if k == 0 {
                        f64::from(r.0) + m.0
                    } else {
                        f64::from(r.1) + m.1
                    }
                })
                .collect();
            let med = quantile(&v, 0.5);
            let dev: Vec<f64> = v.iter().map(|x| (x - med).abs()).collect();
            (med, 1.4826 * quantile(&dev, 0.5))
        };
        let ((dy, sd_dy), (dx, sd_dx)) = (axis(0), axis(1));
        FrameOffset {
            n,
            dy,
            dx,
            sd_dy,
            sd_dx,
        }
    }

    fn is_zero(&self) -> bool {
        self.dy == 0.0 && self.dx == 0.0
    }
}

/// Keys cubic convolution kernel (a = -0.5), the bicubic of the warp.
fn keys(t: f64) -> f64 {
    let t = t.abs();
    if t < 1.0 {
        (1.5 * t - 2.5) * t * t + 1.0
    } else if t < 2.0 {
        ((-0.5 * t + 2.5) * t - 4.0) * t + 2.0
    } else {
        0.0
    }
}

/// `fp` with its content moved by `(dy, dx)` px (bicubic, sub-pixel):
/// `out(p) = fp(p - d)`, zero outside the patch, clipped to `dims` and to
/// non-negative values (light; the kernel's lobes undershoot at edges).
fn translate_footprint(fp: &Footprint, dy: f64, dx: f64, dims: Dims) -> Footprint {
    if fp.values.is_empty() || (dy == 0.0 && dx == 0.0) {
        return fp.clone();
    }
    let (h, w) = (fp.height as i64, fp.width as i64);
    let at = |y: i64, x: i64| -> f64 {
        if y < 0 || x < 0 || y >= h || x >= w {
            0.0
        } else {
            f64::from(fp.values[(y * w + x) as usize])
        }
    };
    // Output window: the moved patch plus the kernel's 2 px reach.
    let lo = |o: usize, d: f64| ((o as f64 + d).floor() as i64 - 2).max(0);
    let hi = |o: usize, n: i64, d: f64, lim: usize| {
        ((o as f64 + (n - 1) as f64 + d).ceil() as i64 + 2).min(lim as i64 - 1)
    };
    let (y0, y1) = (lo(fp.y0, dy), hi(fp.y0, h, dy, dims.height));
    let (x0, x1) = (lo(fp.x0, dx), hi(fp.x0, w, dx, dims.width));
    if y1 < y0 || x1 < x0 {
        return Footprint {
            id: fp.id,
            y0: 0,
            x0: 0,
            height: 0,
            width: 0,
            values: Vec::new(),
        };
    }
    // The shift is the same everywhere: one set of 4 taps per axis.
    let taps = |d: f64| {
        // Source coordinate of output pixel u (patch coords): u - d.
        let base = (-d).floor();
        let t = -d - base;
        (
            base as i64,
            [keys(t + 1.0), keys(t), keys(1.0 - t), keys(2.0 - t)],
        )
    };
    let ((by, wy), (bx, wx)) = (taps(dy), taps(dx));
    let (oh, ow) = ((y1 - y0 + 1) as usize, (x1 - x0 + 1) as usize);
    let mut values = vec![0.0f32; oh * ow];
    for oy in 0..oh {
        // Output row in patch coordinates of `fp`.
        let py = y0 + oy as i64 - fp.y0 as i64 + by;
        for ox in 0..ow {
            let px = x0 + ox as i64 - fp.x0 as i64 + bx;
            let mut v = 0.0f64;
            for (i, &cy) in wy.iter().enumerate() {
                let row: f64 = wx
                    .iter()
                    .enumerate()
                    .map(|(j, &cx)| cx * at(py - 1 + i as i64, px - 1 + j as i64))
                    .sum();
                v += cy * row;
            }
            values[oy * ow + ox] = v.max(0.0) as f32;
        }
    }
    Footprint {
        id: fp.id,
        y0: y0 as usize,
        x0: x0 as usize,
        height: oh,
        width: ow,
        values,
    }
}

impl Oracle {
    /// The GT moved into a frame offset by `off` (footprints and centres;
    /// traces unchanged). A centre is the peak of the moved core footprint
    /// clipped to the frame, `make_trace_sim.py`'s definition, so a cell
    /// cut by the frame edge keeps its centre on the edge as in a static
    /// sim (moving the old centre would push such cells out of the GT).
    fn translate(&mut self, off: &FrameOffset) {
        if off.is_zero() {
            return;
        }
        let dims = self.dims;
        for u in &mut self.units {
            u.full = translate_footprint(&u.full, off.dy, off.dx, dims);
            u.core = translate_footprint(&u.core, off.dy, off.dx, dims);
            let c = &u.core;
            u.center = match c
                .values
                .iter()
                .enumerate()
                .filter(|e| *e.1 > 0.0)
                .max_by(|a, b| a.1.total_cmp(b.1))
            {
                Some((k, _)) => ((c.y0 + k / c.width) as f32, (c.x0 + k % c.width) as f32),
                None => (-1.0, -1.0),
            };
        }
    }
}

/// The sim's true rigid content motion: `<sim>/shifts.npy`, `(frames, 2)`
/// f64 (dy, dx) px, minisim's ground-truth `shifts`
/// (`tools/cala-eval/export_gt_motion.py`; `make_trace_sim.py` writes it).
fn read_gt_shifts(path: &Path) -> Vec<(f64, f64)> {
    let npy = Npy::read(path).unwrap_or_else(|e| panic!("{e}"));
    assert!(
        npy.shape.len() == 2 && npy.shape[1] == 2,
        "{path:?}: shape {:?}, want (frames, 2)",
        npy.shape
    );
    npy.into_f64()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|&[y, x]| (y, x))
        .collect()
}

/// P / R / median matched r of footprint columns `det` against `g`
/// (`match_cells` at r >= 0.7, true positives = matches to detectable units;
/// the numbers of `global.tsv` and `summarize.py`'s `r_fp`).
fn score(det: &[Vec<(u32, f32)>], g: &Gt, dims: Dims) -> (f64, f64, f64) {
    let (mt, _) = match_cells(det, &g.cols, dims, 0.7);
    let r: Vec<f64> = mt
        .iter()
        .flatten()
        .filter(|m| g.detectable[m.0])
        .map(|m| m.1)
        .collect();
    let n_det = g.detectable.iter().filter(|&&d| d).count();
    (
        r.len() as f64 / det.len().max(1) as f64,
        r.len() as f64 / n_det.max(1) as f64,
        quantile(&r, 0.5),
    )
}

/// `--rescore RUN`: score an earlier run's checkpoint footprints
/// (`RUN/fp_history.bin`, `--churn-log`) against the GT in the tissue frame
/// and moved into cala's frame, without running the loops. Motion runs
/// re-register frames `0..=start` to measure the offset (the records are a
/// function of the video and the motion settings only). Writes
/// `rescore.tsv` and `motion_offset.tsv`.
#[allow(clippy::too_many_arguments)]
fn rescore(
    run: &Path,
    rec: &mut Recording,
    pre0: &Preprocessor,
    cal: &Calibration,
    motion: bool,
    start: usize,
    mut o: Oracle,
    shifts: Option<&[(f64, f64)]>,
    flat: &mut GlowFlattener,
    out_dir: &Path,
) {
    let dims = rec.dims;
    let fov = cal.fov().mask().to_vec();
    let noise = vec![1.0f32; dims.pixels()];
    let mut off = FrameOffset::ZERO;
    if let (true, Some(m)) = (motion, shifts) {
        let mut pipe = Pipeline::new(rec, pre0.clone(), cal, true, 200);
        let mut y = vec![0.0f32; dims.pixels()];
        let raw = rec.read(0, start as u32 + 1);
        let rigid: Vec<(f32, f32)> = raw
            .chunks_exact(dims.pixels())
            .map(|f| pipe.frame(f, &mut y).unwrap())
            .collect();
        off = FrameOffset::estimate(&rigid, m);
        std::fs::write(
            out_dir.join("motion_offset.tsv"),
            format!(
                "window\tframe0\tframe1\tn\tdy\tdx\tsd_dy\tsd_dx\napplied\t0\t{}\t{}\t{:.4}\t{:.4}\t{:.4}\t{:.4}\n",
                off.n, off.n, off.dy, off.dx, off.sd_dy, off.sd_dx
            ),
        )
        .unwrap();
    }
    let (g0, _) = build_gt(&o, dims, &fov, &noise, flat);
    o.translate(&off);
    let (g1, _) = build_gt(&o, dims, &fov, &noise, flat);
    println!(
        "rescore {}: offset ({:.3}, {:.3}) px from {} frames",
        run.display(),
        off.dy,
        off.dx,
        off.n
    );
    let path = run.join("fp_history.bin");
    let mut r = BufReader::new(File::open(&path).unwrap_or_else(|e| panic!("{path:?}: {e}")));
    let mut magic = [0u8; 8];
    r.read_exact(&mut magic).unwrap();
    assert_eq!(&magic, b"CALAFH01");
    let mut t = String::from("frame\tcells\tP_tissue\tR_tissue\tr_fp_tissue\tP\tR\tr_fp\n");
    let mut b8 = [0u8; 8];
    while r.read_exact(&mut b8).is_ok() {
        let frame = u64::from_le_bytes(b8);
        let n = read_u32(&mut r) as usize;
        let mut det = Vec::with_capacity(n);
        for _ in 0..n {
            let mut skip = [0u8; 24]; // id, birth, noise
            r.read_exact(&mut skip).unwrap();
            for k in 0..2 {
                let c = read_u32(&mut r) as usize;
                let mut pb = vec![0u8; 4 * c];
                r.read_exact(&mut pb).unwrap();
                let v = read_f32s(&mut r, c);
                if k == 0 {
                    let pix = pb.as_chunks::<4>().0.iter().map(|b| u32::from_le_bytes(*b));
                    det.push(pix.zip(v).collect::<Vec<_>>());
                }
            }
        }
        let (a, b) = (score(&det, &g0, dims), score(&det, &g1, dims));
        let _ = writeln!(
            t,
            "{frame}\t{n}\t{:.4}\t{:.4}\t{:.4}\t{:.4}\t{:.4}\t{:.4}",
            a.0, a.1, a.2, b.0, b.1, b.2
        );
    }
    print!(
        "{}",
        t.lines().last().map_or(String::new(), |l| format!("{l}\n"))
    );
    std::fs::write(out_dir.join("rescore.tsv"), t).unwrap();
}

impl Pipeline {
    /// Like `frame`, also returning the registered frame before the floor.
    fn frame_split(&mut self, raw: &[u8], pre: &mut [f32], out: &mut [f32]) {
        self.pre.front(raw, &mut self.buf).unwrap();
        match &mut self.mc {
            Some(mc) => {
                mc.process(Frame::F32(&self.buf), pre).unwrap();
            }
            None => pre.copy_from_slice(&self.buf),
        }
        out.copy_from_slice(pre);
        self.pre.back(out).unwrap();
    }
}

/// Trace history of every cell id seen: (first frame, values).
#[derive(Default)]
struct History {
    map: HashMap<u64, (usize, Vec<f32>)>,
}

impl History {
    fn push(&mut self, t: usize, ids: &[u64], traces: &[f32]) {
        for (&id, &c) in ids.iter().zip(traces) {
            let e = self.map.entry(id).or_insert((t, Vec::new()));
            e.1.push(c);
        }
    }

    /// The last `len` values of `id` ending at frame `t_end` (exclusive).
    fn window(&self, id: u64, len: usize, t_end: usize) -> Option<(usize, &[f32])> {
        let (start, v) = self.map.get(&id)?;
        let end = start + v.len();
        if end != t_end || len > v.len() {
            return None;
        }
        Some((t_end - len, &v[v.len() - len..]))
    }
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// Least squares of `y` on centred columns (with intercept); coefficients.
fn lstsq(cols: &[&[f32]], y: &[f32]) -> Option<Vec<f64>> {
    let k = cols.len();
    let n = y.len();
    let mean = |v: &[f32]| v.iter().map(|&x| f64::from(x)).sum::<f64>() / n as f64;
    let mc: Vec<f64> = cols.iter().map(|c| mean(c)).collect();
    let my = mean(y);
    let mut a = vec![0.0f64; k * k];
    let mut b = vec![0.0f64; k];
    for t in 0..n {
        let yt = f64::from(y[t]) - my;
        for i in 0..k {
            let xi = f64::from(cols[i][t]) - mc[i];
            b[i] += xi * yt;
            for j in i..k {
                a[i * k + j] += xi * (f64::from(cols[j][t]) - mc[j]);
            }
        }
    }
    for i in 0..k {
        for j in 0..i {
            a[i * k + j] = a[j * k + i];
        }
        a[i * k + i] *= 1.0 + 1e-9;
    }
    // Gaussian elimination with partial pivoting.
    let mut m = a;
    let mut x = b;
    for c in 0..k {
        let p = (c..k).max_by(|&r, &s| m[r * k + c].abs().total_cmp(&m[s * k + c].abs()))?;
        if m[p * k + c].abs() < 1e-12 {
            return None;
        }
        for j in 0..k {
            m.swap(p * k + j, c * k + j);
        }
        x.swap(p, c);
        for r in (c + 1)..k {
            let f = m[r * k + c] / m[c * k + c];
            for j in c..k {
                m[r * k + j] -= f * m[c * k + j];
            }
            x[r] -= f * x[c];
        }
    }
    for c in (0..k).rev() {
        let mut s = x[c];
        for j in (c + 1)..k {
            s -= m[c * k + j] * x[j];
        }
        x[c] = s / m[c * k + c];
    }
    Some(x)
}

fn sd(v: &[f32]) -> f64 {
    let n = v.len() as f64;
    let m = v.iter().map(|&x| f64::from(x)).sum::<f64>() / n;
    (v.iter().map(|&x| (f64::from(x) - m).powi(2)).sum::<f64>() / n).sqrt()
}

/// True crosstalk of a trace: regress it on its own GT trace and the GT
/// traces of `nbs`. Returns (neighbours' variance share, largest neighbour
/// coefficient x sd relative to own, largest |r| with a neighbour's GT trace).
fn crosstalk(trace: &[f32], own: &[f32], nbs: &[&[f32]]) -> (f64, f64, f64) {
    let r_nb = nbs
        .iter()
        .map(|c| pearson(trace, c))
        .fold(
            f64::NAN,
            |a: f64, b| if a.is_nan() || b > a { b } else { a },
        );
    if nbs.is_empty() {
        return (0.0, 0.0, f64::NAN);
    }
    let mut cols: Vec<&[f32]> = vec![own];
    cols.extend_from_slice(nbs);
    // Drop constant columns (silent neighbours in the window).
    let keep: Vec<usize> = (0..cols.len()).filter(|&i| sd(cols[i]) > 0.0).collect();
    if keep.first() != Some(&0) || keep.len() < 2 {
        return (0.0, 0.0, r_nb);
    }
    let cols: Vec<&[f32]> = keep.iter().map(|&i| cols[i]).collect();
    let Some(b) = lstsq(&cols, trace) else {
        return (f64::NAN, f64::NAN, r_nb);
    };
    let n = trace.len();
    let means: Vec<f64> = cols
        .iter()
        .map(|c| c.iter().map(|&x| f64::from(x)).sum::<f64>() / n as f64)
        .collect();
    let mut leak = vec![0.0f64; n];
    for (i, c) in cols.iter().enumerate().skip(1) {
        for t in 0..n {
            leak[t] += b[i] * (f64::from(c[t]) - means[i]);
        }
    }
    let var_leak = leak.iter().map(|v| v * v).sum::<f64>() / n as f64;
    let var_tr = sd(trace).powi(2);
    let own_amp = (b[0] * sd(cols[0])).abs();
    let max_rel = (1..cols.len())
        .map(|i| (b[i] * sd(cols[i])).abs() / own_amp.max(1e-12))
        .fold(0.0f64, f64::max);
    (var_leak / var_tr.max(1e-12), max_rel, r_nb)
}

struct Gt {
    kept: Vec<usize>,
    cols: Vec<Vec<(u32, f32)>>,
    centers: Vec<(f32, f32)>,
    detectable: Vec<bool>,
    snr: Vec<f64>,
    t_gt: usize,
    /// Distance in px from each pixel to the nearest masked-out pixel (or
    /// the image border), capped at [`EDGE_CAP`].
    edge: Vec<f32>,
}

/// Cap of the edge-distance map (px).
const EDGE_CAP: f32 = 40.0;

/// Distance from every pixel to the nearest pixel outside the sensor mask
/// (the image border counts as outside), capped at [`EDGE_CAP`]. Two-pass
/// chamfer (3-4) transform: within a few percent of the Euclidean distance,
/// which is plenty against a 10 px threshold.
fn edge_distance(fov: &[u8], dims: Dims) -> Vec<f32> {
    let (h, w) = (dims.height as i32, dims.width as i32);
    let at = |d: &Vec<f32>, y: i32, x: i32| -> f32 {
        if y < 0 || x < 0 || y >= h || x >= w {
            0.0
        } else {
            d[(y * w + x) as usize]
        }
    };
    let mut d: Vec<f32> = fov
        .iter()
        .map(|&m| if m != 0 { EDGE_CAP + 10.0 } else { 0.0 })
        .collect();
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) as usize;
            let v = d[i]
                .min(at(&d, y - 1, x) + 1.0)
                .min(at(&d, y, x - 1) + 1.0)
                .min(at(&d, y - 1, x - 1) + std::f32::consts::SQRT_2)
                .min(at(&d, y - 1, x + 1) + std::f32::consts::SQRT_2);
            d[i] = v;
        }
    }
    for y in (0..h).rev() {
        for x in (0..w).rev() {
            let i = (y * w + x) as usize;
            let v = d[i]
                .min(at(&d, y + 1, x) + 1.0)
                .min(at(&d, y, x + 1) + 1.0)
                .min(at(&d, y + 1, x + 1) + std::f32::consts::SQRT_2)
                .min(at(&d, y + 1, x - 1) + std::f32::consts::SQRT_2);
            d[i] = v;
        }
    }
    for v in &mut d {
        *v = v.min(EDGE_CAP);
    }
    d
}

impl Gt {
    fn c<'a>(&self, o: &'a Oracle, j: usize) -> &'a [f32] {
        let u = self.kept[j];
        &o.c[u * self.t_gt..(u + 1) * self.t_gt]
    }

    /// GT units (other than `j`) within `d` px of `p`.
    fn near(&self, p: (f32, f32), d: f32, skip: &[usize]) -> Vec<usize> {
        let mut v: Vec<(f32, usize)> = self
            .centers
            .iter()
            .enumerate()
            .filter(|(k, _)| !skip.contains(k))
            .map(|(k, c)| ((c.0 - p.0).powi(2) + (c.1 - p.1).powi(2), k))
            .filter(|e| e.0 <= d * d)
            .collect();
        v.sort_by(|a, b| a.0.total_cmp(&b.0));
        v.into_iter().take(8).map(|e| e.1).collect()
    }
}

fn build_gt(
    o: &Oracle,
    dims: Dims,
    fov: &[u8],
    noise: &[f32],
    flat: &mut GlowFlattener,
) -> (Gt, Library) {
    let mut b = LibraryBuilder::new(dims).fov(fov.to_vec());
    let mut kept = Vec::new();
    for (u, un) in o.units.iter().enumerate() {
        let (cy, cx) = (un.center.0.round(), un.center.1.round());
        let inside = cy >= 0.0
            && cx >= 0.0
            && (cy as usize) < dims.height
            && (cx as usize) < dims.width
            && fov[cy as usize * dims.width + cx as usize] != 0;
        if inside && un.full.values.iter().any(|&v| v > 0.0) {
            b.push(un.full.clone());
            kept.push(u);
        }
    }
    let lib = b.build(flat).unwrap();
    let cols = columns(&lib, dims, (0, 0));
    let centers = cols.iter().map(|c| centroid(c, dims.width)).collect();
    let snr = (0..kept.len())
        .map(|j| {
            let c = &o.c[kept[j] * o.n_frames..(kept[j] + 1) * o.n_frames];
            let mut s: Vec<f32> = c.to_vec();
            s.sort_by(f32::total_cmp);
            let amp = s[s.len() - 1] - s[s.len() / 2];
            let (p, v) = lib.filtered(j);
            let (k, peak) =
                v.iter()
                    .enumerate()
                    .fold((0, f32::MIN), |b, (i, &x)| if x > b.1 { (i, x) } else { b });
            f64::from(amp * peak / noise[p[k] as usize].max(1e-6))
        })
        .collect();
    let detectable = kept.iter().map(|&u| o.units[u].detectable).collect();
    (
        Gt {
            kept,
            cols,
            centers,
            detectable,
            snr,
            t_gt: o.n_frames,
            edge: edge_distance(fov, dims),
        },
        lib,
    )
}

const LABELS: &str =
    "frame\tslot\tmatched\ttp\tdup\tfp_r\tgt\tgt_snr\ttrue_r\ttrue_r_any\txt_var\txt_rel\txt_r\tperturb\tfp_class\tedge_px";

/// Per-cell labels of `lib`'s cells at frame `t_end`. `own` maps a cell to
/// its GT units when known (oracle); otherwise footprints are matched.
///
/// `t_end` is the (virtual) checkpoint frame, `rec_off` the virtual frame of
/// the current pass's recording frame 0 (0 without repeated passes): trace
/// correlations with GT use the current pass's frames only.
#[allow(clippy::too_many_arguments)]
fn label_rows(
    t_end: usize,
    rec_off: usize,
    lib: &Library,
    qc: &QcMonitor,
    hist: &History,
    gt: &Gt,
    o: &Oracle,
    dims: Dims,
    own: Option<&HashMap<u64, (Vec<usize>, u32)>>,
    out: &mut String,
    summary: &mut Vec<f64>,
) {
    let det = columns(lib, dims, (0, 0));
    let (mt, best) = match own {
        Some(_) => (vec![None; det.len()], vec![(usize::MAX, 0.0); det.len()]),
        None => match_cells(&det, &gt.cols, dims, 0.7),
    };
    let mut gt_hit = vec![false; gt.kept.len()];
    for m in mt.iter().flatten() {
        gt_hit[m.0] = true;
    }
    let (mut tp_n, mut r_tp) = (0usize, Vec::new());
    for (s, q) in qc.cells().enumerate() {
        let id = lib.ids()[s];
        let row = q.to_row();
        let len = (q.frames as usize).min(t_end - rec_off);
        let (units, perturb): (Vec<usize>, u32) = match own {
            Some(m) => m.get(&id).cloned().unwrap_or((Vec::new(), 0)),
            None => (mt[s].map(|m| vec![m.0]).unwrap_or_default(), 0),
        };
        let matched = !units.is_empty();
        let tp = matched && units.iter().any(|&j| gt.detectable[j]);
        if tp {
            tp_n += 1;
        }
        let dup = !matched && best[s].0 != usize::MAX && best[s].1 >= 0.5 && gt_hit[best[s].0];
        let fp_r = mt[s].map_or(best[s].1, |m| m.1);
        let ctr0 = centroid(&det[s], dims.width);
        let fp_class = if tp {
            "tp"
        } else if matched {
            // Matched only non-detectable GT units: not a real error of the
            // pipeline, reported apart from the other FP classes.
            "nondetectable"
        } else if dup {
            "dup"
        } else if best[s].0 != usize::MAX && best[s].1 >= 0.5 {
            "partial"
        } else if !gt.near(ctr0, 10.0, &[]).is_empty() {
            "adjacent"
        } else {
            "noise"
        };
        let edge_px = {
            let (cy, cx) = (
                (ctr0.0.round() as i64).clamp(0, dims.height as i64 - 1) as usize,
                (ctr0.1.round() as i64).clamp(0, dims.width as i64 - 1) as usize,
            );
            gt.edge[cy * dims.width + cx]
        };
        let mut vals = [f64::NAN; 8];
        if len >= qc.config().min_frames {
            if let Some((t0, w)) = hist.window(id, len, t_end) {
                let (t0, t_end) = (t0 - rec_off, t_end - rec_off);
                let ctr = centroid(&det[s], dims.width);
                if matched {
                    // Own unit: the best-correlated of the cell's units.
                    let (j, r) = units
                        .iter()
                        .map(|&j| (j, pearson(w, &gt.c(o, j)[t0..t_end])))
                        .fold((usize::MAX, f64::NAN), |b, x| {
                            if b.1.is_nan() || x.1 > b.1 {
                                x
                            } else {
                                b
                            }
                        });
                    vals[0] = j as f64;
                    vals[1] = gt.snr[j];
                    vals[2] = r;
                    if tp && r.is_finite() {
                        r_tp.push(r);
                    }
                    let nbs: Vec<&[f32]> = gt
                        .near(gt.centers[j], 20.0, &units)
                        .into_iter()
                        .map(|k| &gt.c(o, k)[t0..t_end])
                        .collect();
                    let (xv, xr, xn) = crosstalk(w, &gt.c(o, j)[t0..t_end], &nbs);
                    vals[4] = xv;
                    vals[5] = xr;
                    vals[6] = xn;
                }
                vals[3] = gt
                    .near(ctr, 15.0, &[])
                    .into_iter()
                    .map(|k| pearson(w, &gt.c(o, k)[t0..t_end]))
                    .fold(
                        f64::NAN,
                        |a: f64, b| if a.is_nan() || b > a { b } else { a },
                    );
            }
        }
        let _ = write!(
            out,
            "{t_end}\t{s}\t{}\t{}\t{}\t{:.4}\t{}\t{:.3}\t{:.4}\t{:.4}\t{:.4}\t{:.4}\t{:.4}\t{perturb}\t{fp_class}\t{edge_px:.1}",
            u8::from(matched),
            u8::from(tp),
            u8::from(dup),
            fp_r,
            if vals[0].is_nan() { -1 } else { vals[0] as i64 },
            vals[1],
            vals[2],
            vals[3],
            vals[4],
            vals[5],
            vals[6],
        );
        for v in row {
            let _ = write!(out, "\t{v:.5}");
        }
        out.push('\n');
    }
    let det_total = gt.detectable.iter().filter(|&&d| d).count();
    summary.clear();
    summary.push(tp_n as f64 / lib.len().max(1) as f64);
    summary.push(tp_n as f64 / det_total.max(1) as f64);
    summary.push(quantile(&r_tp, 0.5));
}

/// The oracle library: GT footprints of detectable units, a share perturbed.
/// Returns the library and, per id, its GT units and perturbation code
/// (0 none, 1 shifted, 2 merged, 3 split half, 4 neighbour of a deleted unit).
#[allow(clippy::too_many_arguments)]
fn oracle_library(
    o: &Oracle,
    gt: &Gt,
    dims: Dims,
    fov: &[u8],
    noise: &[f32],
    flat: &mut GlowFlattener,
    frac: f64,
    seed: u64,
) -> (Library, HashMap<u64, (Vec<usize>, u32)>) {
    let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let n = gt.kept.len();
    let mut code = vec![0u32; n];
    let mut partner = vec![usize::MAX; n];
    let mut gone = vec![false; n];
    let fp = |j: usize| o.units[gt.kept[j]].full.clone();
    for j in 0..n {
        if !gt.detectable[j] || code[j] != 0 || gone[j] || rng.unit() >= frac {
            continue;
        }
        let kind = 1 + (rng.next() % 4) as u32;
        // Nearest overlapping (≤ 12 px) unperturbed detectable neighbour.
        let nb = gt
            .near(gt.centers[j], 12.0, &[j])
            .into_iter()
            .find(|&k| gt.detectable[k] && code[k] == 0 && !gone[k]);
        match kind {
            2 | 4 if nb.is_none() => continue,
            2 => {
                let k = nb.unwrap();
                code[j] = 2;
                code[k] = 2;
                partner[j] = k;
                partner[k] = j;
            }
            4 => {
                gone[j] = true;
                for k in gt.near(gt.centers[j], 12.0, &[j]) {
                    if code[k] == 0 && !gone[k] {
                        code[k] = 4;
                    }
                }
            }
            k => code[j] = k,
        }
    }
    let mut b = LibraryBuilder::new(dims)
        .fov(fov.to_vec())
        .noise(noise.to_vec())
        .background(BackgroundModel::Ring {
            inner_px: 12.0,
            outer_px: 20.0,
        });
    let mut own: HashMap<u64, (Vec<usize>, u32)> = HashMap::new();
    for j in 0..n {
        if !gt.detectable[j] || gone[j] {
            continue;
        }
        let f = fp(j);
        match code[j] {
            1 => {
                let a = rng.unit() * std::f64::consts::TAU;
                let (dy, dx) = (
                    (3.0 * a.sin()).round() as i64,
                    (3.0 * a.cos()).round() as i64,
                );
                let y0 = (f.y0 as i64 + dy).clamp(0, (dims.height - f.height) as i64) as usize;
                let x0 = (f.x0 as i64 + dx).clamp(0, (dims.width - f.width) as i64) as usize;
                b.push(Footprint {
                    id: j as u64,
                    y0,
                    x0,
                    ..f
                });
                own.insert(j as u64, (vec![j], 1));
            }
            2 => {
                let k = partner[j];
                if k < j {
                    continue;
                }
                let g = fp(k);
                let y0 = f.y0.min(g.y0);
                let x0 = f.x0.min(g.x0);
                let y1 = (f.y0 + f.height).max(g.y0 + g.height);
                let x1 = (f.x0 + f.width).max(g.x0 + g.width);
                let (h, w) = (y1 - y0, x1 - x0);
                let mut v = vec![0.0f32; h * w];
                for p in [&f, &g] {
                    let pk = p.values.iter().copied().fold(0.0f32, f32::max);
                    for yy in 0..p.height {
                        for xx in 0..p.width {
                            v[(p.y0 + yy - y0) * w + p.x0 + xx - x0] +=
                                p.values[yy * p.width + xx] / pk;
                        }
                    }
                }
                let id = 100_000 + j as u64;
                b.push(Footprint {
                    id,
                    y0,
                    x0,
                    height: h,
                    width: w,
                    values: v,
                });
                own.insert(id, (vec![j, k], 2));
            }
            3 => {
                let a = rng.unit() * std::f64::consts::PI;
                let (sa, ca) = (a.sin() as f32, a.cos() as f32);
                let (mut sw, mut sy, mut sx) = (0.0f32, 0.0f32, 0.0f32);
                for yy in 0..f.height {
                    for xx in 0..f.width {
                        let v = f.values[yy * f.width + xx];
                        sw += v;
                        sy += v * yy as f32;
                        sx += v * xx as f32;
                    }
                }
                let (cy, cx) = (sy / sw, sx / sw);
                for half in 0..2u64 {
                    let mut v = f.values.clone();
                    for yy in 0..f.height {
                        for xx in 0..f.width {
                            let side = (yy as f32 - cy) * sa + (xx as f32 - cx) * ca >= 0.0;
                            if side != (half == 0) {
                                v[yy * f.width + xx] = 0.0;
                            }
                        }
                    }
                    if v.iter().all(|&x| x <= 0.0) {
                        continue;
                    }
                    let id = 200_000 + 2 * j as u64 + half;
                    b.push(Footprint {
                        id,
                        values: v,
                        ..f.clone()
                    });
                    own.insert(id, (vec![j], 3));
                }
            }
            c => {
                b.push(Footprint { id: j as u64, ..f });
                own.insert(j as u64, (vec![j], c));
            }
        }
    }
    (b.build(flat).unwrap(), own)
}

fn qc_header() -> String {
    let mut h = String::from(LABELS);
    for f in CellQc::FIELDS {
        h.push('\t');
        h.push_str(f);
    }
    h.push('\n');
    h
}

fn global_line(g: &GlobalQc, extra: &[f64]) -> String {
    let mut s = String::new();
    for v in g.to_row(0).iter().take(GlobalQc::FIELDS.len() - 1) {
        let _ = write!(s, "{v:.5}\t");
    }
    for v in extra {
        let _ = write!(s, "{v:.4}\t");
    }
    s.pop();
    s.push('\n');
    s
}

/// A batch forwarded to the slow loop: frames with their traces, library
/// and recording frame, and a new noise map when one was due.
type Batch = (
    Vec<(Vec<f32>, FrameTraces, Arc<Library>, usize)>,
    Option<Vec<f32>>,
);

enum Msg {
    Batch(Batch),
    /// A visit result and the worker it came from.
    Result(Box<VisitResult>, usize),
    /// Owner time (ms) for look-back frames it was handed (`--csettle`).
    Charge(f64),
    /// The look-back worker's answer to a settle request (`--csettle` with
    /// visit workers): a chunk of re-read frames.
    Settle,
    /// The rest of a settle answer the owner handles in pieces
    /// (`--csettle-yield`): this many frames are left.
    SettleRest(usize),
    /// Owner time (ms) with nothing done in it (`--owner-load`).
    Load(f64),
    /// `--lb-gate`: the look-back worker's answer to a need-driven
    /// request, with the owner's time (ms) for its frames. The frames went
    /// into the statistics when they were taken; this message holds the
    /// worker until the owner has handled the answer, as in the app.
    NeedAnswer(f64),
}

/// `--visit-diag`: where the ordinary visits go on the virtual clock. Per
/// job a row of `visit_diag.tsv`; the sums go to `visit_diag.txt`.
struct VisitDiag {
    due: u32,
    /// Per tile, when it was first seen due (NaN: not due) and the scratch
    /// copies of the tiles' counters and of the tiles in flight.
    stamp: Vec<f64>,
    fresh: Vec<u32>,
    flying: Vec<usize>,
    rows: String,
    /// Owner time and inbox wait (sum, longest) by message kind: batch,
    /// result, look-back charge, settle answer, load.
    owner_ms: [f64; 5],
    queue_ms: [f64; 5],
    queue_max: [f64; 5],
    msgs: [u64; 5],
    /// Per worker: the time up to which its idle time is booked, why it
    /// got no visit at the last hand-out (0: nothing due, 1: every due
    /// tile's zone was held), and whether a result of its own is waiting
    /// for the owner.
    acct: Vec<f64>,
    reason: Vec<u8>,
    /// Worker idle time: nothing due, due but zones held, result waiting
    /// for the owner (by the kind of message the owner was on).
    idle_nodue: f64,
    idle_blocked: f64,
    idle_owner: [f64; 5],
    /// Hand-outs, their waits since due (sum), slot counts at hand-out
    /// (sum), and the waits and counts of the visits made by the owner
    /// because they would do nothing.
    jobs: u64,
    wait_sum: f64,
    fresh_sum: u64,
    idle_visits: u64,
    idle_wait_sum: f64,
    /// Tiles seen coming due.
    due_events: u64,
}

impl VisitDiag {
    fn new(sl: &SlowLoop, workers: usize) -> VisitDiag {
        let mut fresh = Vec::new();
        sl.tile_fresh(&mut fresh);
        VisitDiag {
            due: sl.due_slots(),
            stamp: vec![f64::NAN; fresh.len()],
            fresh,
            flying: Vec::new(),
            rows: String::from(
                "t_ms\tframe\tkind\ttile\tworker\tdue_ms\twait_ms\tslots\tstart_ms\tdur_ms\twork\twork_load\twork_refine\twork_merge\twork_add\twork_keep\twork_split\tzone_cells\trefines\tadds\tmerges\tsplits\tdeletes\tproposals\n",
            ),
            owner_ms: [0.0; 5],
            queue_ms: [0.0; 5],
            queue_max: [0.0; 5],
            msgs: [0; 5],
            acct: vec![0.0; workers],
            reason: vec![0; workers],
            idle_nodue: 0.0,
            idle_blocked: 0.0,
            idle_owner: [0.0; 5],
            jobs: 0,
            wait_sum: 0.0,
            fresh_sum: 0,
            idle_visits: 0,
            idle_wait_sum: 0.0,
            due_events: 0,
        }
    }

    /// Stamp the tiles that are due now and were not before.
    fn scan(&mut self, sl: &SlowLoop, now: f64) {
        sl.tile_fresh(&mut self.fresh);
        for (st, &f) in self.stamp.iter_mut().zip(&self.fresh) {
            if f >= self.due && st.is_nan() {
                *st = now;
                self.due_events += 1;
            }
        }
    }

    /// After a hand-out round at `now`: due tiles that are no longer due
    /// and not in flight were visited by the owner as visits that do
    /// nothing. Returns whether a due tile is left that is not in flight.
    fn after_handout(&mut self, sl: &SlowLoop, now: f64) -> bool {
        sl.tile_fresh(&mut self.fresh);
        sl.tiles_in_flight(&mut self.flying);
        let mut left = false;
        for ti in 0..self.stamp.len() {
            let flying = self.flying.contains(&ti);
            if self.fresh[ti] >= self.due {
                left |= !flying;
            } else if !self.stamp[ti].is_nan() {
                if !flying {
                    self.idle_visits += 1;
                    self.idle_wait_sum += now - self.stamp[ti];
                }
                self.stamp[ti] = f64::NAN;
            }
        }
        left
    }
}

/// The app's slow-loop workers on a virtual clock (`--offered-fps`).
///
/// The fast loop reads `fps` frames per second of wall time and offers the
/// slow loop a batch of frames whenever one is full. A batch is forwarded
/// when one of `pool` buffers is free (a buffer is busy from forwarding
/// until the owner has handled the batch) and dropped otherwise, as in
/// `ForwardPool`. The owner (the slow worker) handles its messages one at
/// a time in arrival order: a batch costs its work (observe, and with no
/// visit workers `step(budget)` per frame, as the app's single slow worker
/// does); a visit result costs applying it. With `k` visit workers the owner
/// hands out a tile visit to every idle worker after each message
/// (`SlowLoop::take_job`); a visit costs its work on the worker, and each
/// hand-out and result costs `job_ms` on the owner (encode, copy, decode).
/// Work converts to time at `units_per_ms` (calibrated on the app's WASM
/// build). Visits are computed at hand-out (they are pure functions of the
/// job) and applied when their virtual time is up, so the run is
/// deterministic.
struct Timed {
    fps: f64,
    units_per_ms: f64,
    observe_ms: Option<f64>,
    job_ms: f64,
    pool: usize,
    budget: u64,
    inbox: std::collections::VecDeque<(f64, Msg)>,
    owner_free: f64,
    /// Release time of each forwarded buffer (infinite until handled).
    bufs: Vec<f64>,
    /// Each visit worker, when it is free, and its visits not yet applied.
    runners: Vec<(VisitRunner, f64, usize)>,
    /// Visits handed to a worker before its last one has come back.
    depth: usize,
    libs: std::collections::VecDeque<(f64, Arc<Library>)>,
    pub forwarded: u64,
    pub dropped: u64,
    pub jobs: u64,
    pub owner_busy: f64,
    pub runner_busy: f64,
    pub last_ms: f64,
    /// The recording ended: no more hand-outs.
    pub ending: bool,
    /// `--csettle`: the share of the owner's idle time the concurrent
    /// settle uses (0: off), the time a re-read frame takes to arrive from
    /// the look-back worker, the earliest start of the next settle unit,
    /// and the owner's time spent on the settle and on look-back frames.
    pub cs_share: f64,
    pub lb_ms: f64,
    cs_next: f64,
    /// `--csettle-guard G` (0: off): no settle unit starts when it would
    /// not be done, at G times the running mean unit time, before the
    /// next batch is expected (batches arrive every `batch_ms`; the last
    /// came at `last_arr`). `cs_mean`: the running mean unit time.
    pub cs_guard: f64,
    pub batch_ms: f64,
    last_arr: f64,
    cs_mean: f64,
    pub cs_busy: f64,
    pub cs_units: u64,
    pub lb_busy: f64,
    /// `--csettle` with visit workers: re-read frames earned per observed
    /// live frame (0: off) and the frames per request; the frames owed; a
    /// request is out; when the look-back worker is free, and its busy
    /// time; settle requests and settle jobs; the longest wait of a batch
    /// for the owner.
    pub cs_rate: f64,
    pub cs_chunk: usize,
    cs_owed: f64,
    lb_out: bool,
    lb_free: f64,
    pub lb_worker_busy: f64,
    pub cs_reqs: u64,
    pub cs_jobs: u64,
    pub max_wait: f64,
    /// `--visit-diag`.
    diag: Option<VisitDiag>,
    /// `--cs-answer-scale X` (diagnosis): the owner's time for a settle
    /// answer is X times its work (0: the statistics update is free).
    pub cs_answer_scale: f64,
    /// `--csettle-yield N` (0: off): the owner handles a settle answer N
    /// frames at a time and goes back to its inbox in between (messages
    /// that arrived meanwhile come first, and visits are handed out).
    pub cs_yield: usize,
    /// `--owner-load MS:PERIOD` (diagnosis): the owner loses MS ms every
    /// PERIOD ms, with nothing done in it. The next one is due at
    /// `load_next`.
    pub load: Option<(f64, f64)>,
    load_next: f64,
    /// `--visit-units-per-ms` (calibration): work per ms on a visit
    /// worker (default: `units_per_ms`, the owner's).
    pub visit_units_per_ms: f64,
    /// `--lb-gate` (calibration): need-driven look-back goes through the
    /// look-back worker as in the app (one request out at a time, taking
    /// turns with the settle's); `cs_turn`: the settle asks next when both
    /// want the worker; `need_pending`: need-driven look-back wants frames.
    pub lb_gate: bool,
    pub cs_turn: bool,
    pub need_pending: bool,
    /// `--lb-gate`: need-driven frames re-read, and requests.
    pub need_frames: u64,
    pub need_reqs: u64,
    /// `--lb-ms-per-cell` (calibration): the look-back worker's time per
    /// re-read frame grows by this much per cell of the newest library
    /// (`lib_cells`): `lb_ms + lb_ms_cell x cells`.
    pub lb_ms_cell: f64,
    lib_cells: usize,
    /// `--offered-burst B` (calibration): frames arrive B at a time (0, 1:
    /// evenly), see [`Timed::at`].
    pub burst: usize,
    /// `--ack-lag-ms P` (calibration): see [`Timed::has_buffer`] (0: off).
    pub ack_lag: f64,
    /// `--result-first` (calibration): the owner takes a waiting visit
    /// result before the other messages waiting (0: arrival order).
    pub result_first: bool,
}

impl Timed {
    #[allow(clippy::too_many_arguments)]
    fn new(
        fps: f64,
        units_per_ms: f64,
        observe_ms: Option<f64>,
        job_ms: f64,
        pool: usize,
        budget: u64,
        runners: Vec<VisitRunner>,
        depth: usize,
    ) -> Timed {
        Timed {
            fps,
            units_per_ms,
            observe_ms,
            job_ms,
            pool,
            budget,
            inbox: Default::default(),
            owner_free: 0.0,
            bufs: Vec::new(),
            runners: runners.into_iter().map(|r| (r, 0.0, 0)).collect(),
            depth: depth.max(1),
            libs: Default::default(),
            forwarded: 0,
            dropped: 0,
            jobs: 0,
            owner_busy: 0.0,
            runner_busy: 0.0,
            last_ms: 0.0,
            ending: false,
            cs_share: 0.0,
            lb_ms: 10.0,
            cs_next: 0.0,
            cs_guard: 0.0,
            batch_ms: 0.0,
            last_arr: 0.0,
            cs_mean: 0.0,
            cs_busy: 0.0,
            cs_units: 0,
            lb_busy: 0.0,
            cs_rate: 0.0,
            cs_chunk: 16,
            cs_owed: 0.0,
            lb_out: false,
            lb_free: 0.0,
            lb_worker_busy: 0.0,
            cs_reqs: 0,
            cs_jobs: 0,
            max_wait: 0.0,
            diag: None,
            cs_answer_scale: 1.0,
            cs_yield: 0,
            load: None,
            load_next: 0.0,
            visit_units_per_ms: units_per_ms,
            lb_gate: false,
            cs_turn: false,
            need_pending: false,
            need_frames: 0,
            need_reqs: 0,
            lb_ms_cell: 0.0,
            lib_cells: 0,
            burst: 0,
            ack_lag: 0.0,
            result_first: false,
        }
    }

    /// `--lb-gate`: the look-back worker is free at `now` for a need-driven
    /// request (no request out, and not the settle's turn while it is owed
    /// a chunk).
    fn need_may_ask(&self, now: f64) -> bool {
        let settle_waits = self.cs_rate > 0.0 && self.cs_owed >= self.cs_chunk as f64;
        !self.lb_out && self.lb_free <= now && !(self.cs_turn && settle_waits)
    }

    /// The owner is idle until `limit` (the next message, or now): it
    /// spends `cs_share` of that time on settle units (`unit` runs one and
    /// returns its work). A unit is not interrupted, so one started just
    /// before a batch arrives makes the batch wait, as in the app.
    fn settle_idle(
        &mut self,
        limit: f64,
        sl: &mut SlowLoop,
        unit: &mut dyn FnMut(&mut SlowLoop) -> Option<u64>,
    ) {
        if self.cs_share <= 0.0 || self.ending {
            return;
        }
        loop {
            let t = self.owner_free.max(self.cs_next);
            if t >= limit {
                break;
            }
            if self.cs_guard > 0.0
                && t + self.cs_guard * self.cs_mean > self.last_arr + self.batch_ms
            {
                // Too close to the next batch: wait for it.
                self.cs_next = self.last_arr + self.batch_ms;
                break;
            }
            let Some(units) = unit(sl) else { break };
            let dur = units as f64 / self.units_per_ms;
            self.cs_mean = if self.cs_units == 0 {
                dur
            } else {
                0.9 * self.cs_mean + 0.1 * dur
            };
            self.owner_free = t + dur;
            self.owner_busy += dur;
            self.cs_busy += dur;
            self.cs_units += 1;
            self.last_ms = self.last_ms.max(t + dur);
            self.cs_next = (t + dur / self.cs_share).max(t + self.lb_ms);
        }
    }

    /// The owner took look-back frames worth `units` of work at `now`.
    fn charge(&mut self, now: f64, units: u64) {
        if units == 0 {
            return;
        }
        // A message of its own, so the owner's idle time before `now`
        // stays available to the settle.
        self.push(now, Msg::Charge(units as f64 / self.units_per_ms));
    }

    /// The look-back worker re-read `n` need-driven frames from `now`:
    /// they come before the settle's requests on that worker.
    fn lb_note(&mut self, now: f64, n: u64) {
        let dur = n as f64 * self.lb_frame_ms();
        self.lb_free = self.lb_free.max(now) + dur;
        self.lb_worker_busy += dur;
    }

    /// `--lb-gate`: a need-driven request of `n` frames went to the
    /// look-back worker at `now`; its answer (owner work `units`) reaches the
    /// owner when the worker is done, and no other request goes out before
    /// the owner has handled it.
    fn need_answer(&mut self, now: f64, n: u64, units: u64) {
        let dur = n as f64 * self.lb_frame_ms();
        self.lb_free = self.lb_free.max(now) + dur;
        self.lb_worker_busy += dur;
        self.lb_out = true;
        let at = self.lb_free;
        self.push(at, Msg::NeedAnswer(units as f64 / self.units_per_ms));
    }

    /// The look-back worker's time per re-read frame now.
    fn lb_frame_ms(&self) -> f64 {
        self.lb_ms + self.lb_ms_cell * self.lib_cells as f64
    }

    /// Wall time (ms) at which frame `t` has been read. With
    /// `--offered-burst B` the frames come B at a time: frames `kB..(k+1)B`
    /// are all read at `kB / fps` (the app's pacer before #455).
    fn at(&self, t: usize) -> f64 {
        if self.burst > 1 && t > 0 {
            return ((t - 1) / self.burst * self.burst) as f64 * 1e3 / self.fps;
        }
        t as f64 * 1e3 / self.fps
    }

    /// A forward buffer is free at `now`. With `--ack-lag-ms P` a buffer
    /// the owner gave back less than P ms ago is not free yet: the fast
    /// loop (the app's trace worker) handles the slow worker's `ack` only
    /// after the batch it is processing, and decides on forwarding at the
    /// end of that batch, before the ack.
    fn has_buffer(&mut self, now: f64) -> bool {
        let seen = now - self.ack_lag;
        self.bufs.retain(|&r| r > seen);
        self.bufs.len() < self.pool
    }

    /// Forward a full batch at `now` (after `has_buffer`).
    fn forward(&mut self, now: f64, batch: Batch) {
        self.bufs.push(f64::INFINITY);
        self.last_arr = now;
        self.forwarded += batch.0.len() as u64;
        self.push(now, Msg::Batch(batch));
        if let Some((ms, period)) = self.load {
            while self.load_next <= now {
                let at = self.load_next;
                self.push(at, Msg::Load(ms));
                self.load_next += period;
            }
        }
    }

    fn push(&mut self, at: f64, m: Msg) {
        let i = self.inbox.partition_point(|(a, _)| *a <= at);
        self.inbox.insert(i, (at, m));
    }

    /// Handle every message the owner starts by `until` (all of them with
    /// `f64::INFINITY`). `log` gets each handled batch's frames (recording
    /// frame of each slow-loop frame).
    fn advance(
        &mut self,
        until: f64,
        sl: &mut SlowLoop,
        slow_rec: &mut Vec<u32>,
        unit: &mut dyn FnMut(&mut SlowLoop) -> Option<u64>,
    ) {
        loop {
            let Some(&(arr, _)) = self.inbox.front() else {
                if until.is_finite() {
                    self.settle_idle(until, sl, unit);
                }
                break;
            };
            self.settle_idle(arr.min(until), sl, unit);
            let start = arr.max(self.owner_free);
            if start > until {
                break;
            }
            // `--result-first`: a visit result already waiting goes before
            // the batches and answers waiting with it.
            let pick = if self.result_first {
                self.inbox
                    .iter()
                    .take_while(|(a, _)| *a <= start)
                    .position(|(_, m)| matches!(m, Msg::Result(..)))
                    .unwrap_or(0)
            } else {
                0
            };
            let (arr, msg) = self.inbox.remove(pick).unwrap();
            let start = arr.max(self.owner_free);
            let w0 = sl.work();
            let mut extra = 0.0;
            let mut lib = None;
            let is_batch = matches!(msg, Msg::Batch(_));
            let is_settle = matches!(msg, Msg::Settle | Msg::SettleRest(_));
            let kind = match msg {
                Msg::Batch(_) => 0,
                Msg::Result(..) => 1,
                Msg::Charge(_) | Msg::NeedAnswer(_) => 2,
                Msg::Settle | Msg::SettleRest(_) => 3,
                Msg::Load(_) => 4,
            };
            // The worker whose result this is: it waited for the owner.
            let res_of = match &msg {
                Msg::Result(_, i) => Some(*i),
                _ => None,
            };
            if is_batch {
                self.max_wait = self.max_wait.max(start - arr);
            }
            let mut rest = 0;
            match msg {
                Msg::Settle | Msg::SettleRest(_) => {
                    // One message, as `SlowRunner.handleLookback`: every
                    // frame of the answer before anything else. With
                    // `--csettle-yield N`: N frames, and the rest as a new
                    // message behind those that arrived meanwhile.
                    let left = match msg {
                        Msg::SettleRest(n) => n,
                        _ => self.cs_chunk,
                    };
                    let n = if self.cs_yield > 0 {
                        self.cs_yield.min(left)
                    } else {
                        left
                    };
                    let wu = sl.work();
                    let done = unit(sl).is_some();
                    if done {
                        self.cs_units += n as u64;
                        rest = left - n;
                    }
                    if rest == 0 {
                        self.lb_out = false;
                    }
                    extra -=
                        (1.0 - self.cs_answer_scale) * (sl.work() - wu) as f64 / self.units_per_ms;
                }
                Msg::Load(ms) => extra += ms,
                Msg::Batch((frames, noise)) => {
                    self.cs_owed = (self.cs_owed + frames.len() as f64 * self.cs_rate)
                        .min(4.0 * self.cs_chunk as f64);
                    if let Some(n) = noise {
                        sl.set_noise(n.clone()).unwrap();
                        for (r, ..) in &mut self.runners {
                            r.set_noise(n.clone()).unwrap();
                        }
                    }
                    for (y, tr, l, tf) in &frames {
                        let o = sl.work();
                        sl.observe(y, l, tr).unwrap();
                        if let Some(ms) = self.observe_ms {
                            extra += ms - (sl.work() - o) as f64 / self.units_per_ms;
                        }
                        slow_rec.push(*tf as u32);
                        if self.runners.is_empty() {
                            if let Some(l) = sl.step(self.budget).unwrap() {
                                lib = Some(l);
                            }
                        }
                    }
                }
                Msg::Charge(ms) => {
                    extra += ms;
                    self.lb_busy += ms;
                }
                Msg::NeedAnswer(ms) => {
                    extra += ms;
                    self.lb_busy += ms;
                    self.lb_out = false;
                }
                Msg::Result(r, i) => {
                    // The visit's work was done by its worker; `apply_job`
                    // adds it to the loop's total.
                    extra -= r.work() as f64 / self.units_per_ms;
                    sl.apply_job(*r).unwrap();
                    // Half the owner's cost of a job is the hand-out.
                    extra += 0.5 * self.job_ms;
                    self.runners[i].2 -= 1;
                }
            }
            if !self.runners.is_empty() {
                if let Some(l) = sl.housekeep().unwrap() {
                    lib = Some(l);
                }
            }
            let mut end = start + (sl.work() - w0) as f64 / self.units_per_ms + extra;
            if rest > 0 {
                self.push(end, Msg::SettleRest(rest));
            }
            if is_batch {
                // The batch's buffer goes back now.
                if let Some(b) = self.bufs.iter_mut().find(|b| b.is_infinite()) {
                    *b = end;
                }
            }
            if let Some(d) = self.diag.as_mut() {
                d.msgs[kind] += 1;
                d.queue_ms[kind] += start - arr;
                d.queue_max[kind] = d.queue_max[kind].max(start - arr);
                // Idle time of the workers up to the hand-out below. A
                // worker whose result waited for the owner (this message,
                // or one still in the inbox) was idle for the owner; one
                // with nothing out stays with the reason of the last
                // hand-out.
                for (w, r) in self.runners.iter().enumerate() {
                    let waiting = r.2 > 0 || res_of == Some(w);
                    let t0 = d.acct[w].max(r.1);
                    if t0 >= end {
                        continue;
                    }
                    if waiting {
                        d.idle_owner[kind] += end - t0;
                    } else if d.reason[w] == 1 {
                        d.idle_blocked += end - t0;
                    } else {
                        d.idle_nodue += end - t0;
                    }
                    d.acct[w] = end;
                }
                d.scan(sl, end);
            }
            let end0 = end;
            if let Some(l) = lib {
                self.lib_cells = l.len();
                self.libs.push_back((end, l));
            }
            // Hand out visits to workers with fewer than `depth` out (as
            // `SlowRunner.dispatch`; a worker runs its visits in turn).
            'hand: for _ in 0..self.depth {
                for i in 0..self.runners.len() {
                    if self.ending || self.runners[i].2 >= self.depth {
                        continue;
                    }
                    let job = match sl.take_job() {
                        Some(j) => j,
                        // No ordinary visit to run: a settle visit.
                        None => match (self.cs_rate > 0.0).then(|| sl.take_settle_job()) {
                            Some(Some(j)) => {
                                self.cs_jobs += 1;
                                j
                            }
                            _ => break 'hand,
                        },
                    };
                    end += 0.5 * self.job_ms;
                    let (jt, jc, js) = (job.tile_index(), job.zone_cells(), job.is_settle());
                    let res = self.runners[i].0.run(job).unwrap();
                    let dur = res.work() as f64 / self.visit_units_per_ms + self.job_ms;
                    self.runner_busy += dur;
                    self.jobs += 1;
                    let done = end.max(self.runners[i].1) + dur;
                    if let Some(d) = self.diag.as_mut() {
                        let due_at = if js { f64::NAN } else { d.stamp[jt] };
                        let slots = if js { 0 } else { d.fresh[jt] };
                        if !js {
                            d.jobs += 1;
                            d.wait_sum += end - due_at;
                            d.fresh_sum += u64::from(slots);
                            d.stamp[jt] = f64::NAN;
                        }
                        let s = res.stats();
                        let _ = writeln!(
                            d.rows,
                            "{:.2}\t{}\t{}\t{}\t{}\t{:.2}\t{:.2}\t{}\t{:.2}\t{:.2}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
                            end,
                            sl.frames(),
                            if js { "settle" } else { "visit" },
                            jt,
                            i,
                            due_at,
                            end - due_at,
                            slots,
                            end.max(self.runners[i].1),
                            dur,
                            res.work(),
                            s.work_load,
                            s.work_refine,
                            s.work_merge,
                            s.work_add,
                            s.work_keep,
                            s.work_split,
                            jc,
                            s.refines,
                            s.adds,
                            s.merges,
                            s.splits,
                            s.deletes,
                            s.proposals,
                        );
                        d.acct[i] = done;
                    }
                    self.runners[i].1 = done;
                    self.runners[i].2 += 1;
                    self.push(done, Msg::Result(Box::new(res), i));
                }
            }
            if let Some(d) = self.diag.as_mut() {
                let left = d.after_handout(sl, end0);
                for (w, r) in self.runners.iter().enumerate() {
                    if r.2 == 0 {
                        d.reason[w] = u8::from(left);
                    }
                }
                d.owner_ms[kind] += end - start;
            }
            // The next settle request, with none out (the look-back
            // worker reads and solves it while the owner goes on).
            if self.cs_rate > 0.0
                && !self.lb_out
                && !self.ending
                && self.cs_owed >= self.cs_chunk as f64
                && (!self.lb_gate || (self.lb_free <= end && (self.cs_turn || !self.need_pending)))
            {
                self.cs_turn = false;
                self.cs_owed -= self.cs_chunk as f64;
                let dur = self.cs_chunk as f64 * self.lb_frame_ms();
                self.lb_free = self.lb_free.max(end) + dur;
                self.lb_worker_busy += dur;
                self.lb_out = true;
                self.cs_reqs += 1;
                let at = self.lb_free;
                self.push(at, Msg::Settle);
            }
            if is_settle {
                self.cs_busy += end - start;
            }
            self.owner_busy += end - start;
            self.owner_free = end;
            self.last_ms = self.last_ms.max(end);
        }
    }

    /// The newest library published by `now`.
    fn library(&mut self, now: f64) -> Option<Arc<Library>> {
        let mut out = None;
        while self.libs.front().is_some_and(|l| l.0 <= now) {
            out = self.libs.pop_front().map(|l| l.1);
        }
        out
    }
}

/// Move the slow loop's add and removal logs into the TSV buffers.
fn write_logs(
    sl: &mut SlowLoop,
    rf: &dyn Fn(u64) -> u32,
    add_log: &mut String,
    rem_log: &mut String,
) {
    for a in sl.take_add_log() {
        let _ = writeln!(
            add_log,
            "{}\t{}\t{}\t{}\t{:.1}\t{:.1}\t{:.4}\t{:.2}\t{}",
            a.frame,
            rf(a.frame),
            a.id,
            a.class.as_str(),
            a.center.0,
            a.center.1,
            a.cos,
            a.dist,
            a.since as i64
        );
    }
    for r in sl.take_removal_log() {
        let _ = writeln!(
            rem_log,
            "{}\t{}\t{}\t{}\t{:.1}\t{:.1}\t{}\t{}\t{}\t{}",
            r.frame,
            rf(r.frame),
            r.id,
            r.kind.as_str(),
            r.center.0,
            r.center.1,
            r.born,
            rf(r.born),
            r.class.map_or("none", |c| c.as_str()),
            u8::from(r.churned)
        );
    }
}

/// Move the slow loop's structural edits (and, with `diagnostics`, its
/// held-out edit tests) into the `--churn-log` TSV buffers.
fn write_churn_logs(
    sl: &mut SlowLoop,
    rf: &dyn Fn(u64) -> u32,
    edit_log: &mut String,
    test_log: &mut String,
) {
    for e in sl.take_edit_log() {
        let _ = writeln!(
            edit_log,
            "{}\t{}\t{}\t{}\t{}\t{:.1}\t{:.1}\t{:.3}",
            e.frame,
            rf(e.frame),
            e.kind.as_str(),
            e.id,
            e.other,
            e.center.0,
            e.center.1,
            e.margin
        );
    }
    #[cfg(feature = "diagnostics")]
    for e in sl.take_test_log() {
        let _ = writeln!(
            test_log,
            "{}\t{}\t{}\t{}\t{}\t{}\t{:.3}",
            e.frame,
            rf(e.frame),
            e.kind.as_str(),
            e.id,
            e.other,
            u8::from(e.accepted),
            e.z
        );
    }
    #[cfg(not(feature = "diagnostics"))]
    let _ = test_log;
}

/// Append one checkpoint to `fp_history.bin` (`--churn-log`): `CALAFH01`
/// once, then per checkpoint the recording frame (u64) and cell count
/// (u32), and per cell its id (u64), birth (recording frame, u64),
/// split-half noise (f64, NaN when none), then the filtered footprint
/// (pixel count u32, pixels u32, values f32) and the unfiltered one (the
/// same layout). Little endian.
fn write_fp_history(
    out: &mut BufWriter<File>,
    frame: u64,
    lib: &calab_cala::trace::Library,
    births: &HashMap<u64, u64>,
    noise: &dyn Fn(u64, &[u32]) -> Option<f64>,
) {
    out.write_all(&frame.to_le_bytes()).unwrap();
    out.write_all(&(lib.len() as u32).to_le_bytes()).unwrap();
    for slot in 0..lib.len() {
        let id = lib.ids()[slot];
        let (fpix, fval) = lib.filtered(slot);
        let (rpix, rval) = lib.unfiltered(slot);
        out.write_all(&id.to_le_bytes()).unwrap();
        out.write_all(&births.get(&id).copied().unwrap_or(0).to_le_bytes())
            .unwrap();
        out.write_all(&noise(id, fpix).unwrap_or(f64::NAN).to_le_bytes())
            .unwrap();
        for (pix, val) in [(fpix, fval), (rpix, rval)] {
            out.write_all(&(pix.len() as u32).to_le_bytes()).unwrap();
            for &p in pix {
                out.write_all(&p.to_le_bytes()).unwrap();
            }
            for &v in val {
                out.write_all(&v.to_le_bytes()).unwrap();
            }
        }
    }
}

/// A fixed library from a `footprints.bin` (`CALAFP01`: height, width, n;
/// per cell id, pixel count, pixels, unfiltered values, filtered values),
/// built with this run's filter, noise map and background.
fn read_footprints(
    path: &Path,
    dims: Dims,
    fov: &[u8],
    noise: &[f32],
    scfg: &SlowLoopConfig,
    flat: &mut GlowFlattener,
) -> Library {
    let mut f = BufReader::new(File::open(path).unwrap());
    let mut magic = [0u8; 8];
    f.read_exact(&mut magic).unwrap();
    assert_eq!(
        &magic,
        b"CALAFP01",
        "{}: not a footprints.bin",
        path.display()
    );
    let (h, w, n) = (read_u32(&mut f), read_u32(&mut f), read_u32(&mut f));
    assert_eq!((h as usize, w as usize), (dims.height, dims.width));
    let mut b = LibraryBuilder::new(dims)
        .fov(fov.to_vec())
        .noise(noise.to_vec())
        .background(scfg.background.clone());
    let wd = dims.width;
    for _ in 0..n {
        let id = u64::from(read_u32(&mut f));
        let np = read_u32(&mut f) as usize;
        let pix: Vec<u32> = (0..np).map(|_| read_u32(&mut f)).collect();
        let a = read_f32s(&mut f, np);
        let _ = read_f32s(&mut f, np);
        if !a.iter().any(|&v| v > 0.0) {
            continue;
        }
        let y0 = pix.iter().map(|&q| q as usize / wd).min().unwrap();
        let y1 = pix.iter().map(|&q| q as usize / wd).max().unwrap();
        let x0 = pix.iter().map(|&q| q as usize % wd).min().unwrap();
        let x1 = pix.iter().map(|&q| q as usize % wd).max().unwrap();
        let (fh, fw) = (y1 - y0 + 1, x1 - x0 + 1);
        let mut values = vec![0.0f32; fh * fw];
        for (&q, &v) in pix.iter().zip(&a) {
            values[(q as usize / wd - y0) * fw + (q as usize % wd - x0)] = v.max(0.0);
        }
        b.push(Footprint {
            id,
            y0,
            x0,
            height: fh,
            width: fw,
            values,
        });
    }
    b.build(flat).unwrap()
}

/// Candidate footprints for `--label-bundle`: `(cy, cx)` per tsv row and the
/// sparse footprint (pixel, weight) of the same row in the sidecar `.bin`.
type Candidates = (Vec<(f32, f32)>, Vec<(Vec<u32>, Vec<f32>)>);

fn read_candidates(tsv: &Path) -> Candidates {
    let text = std::fs::read_to_string(tsv).unwrap_or_else(|e| panic!("{tsv:?}: {e}"));
    let centres: Vec<(f32, f32)> = text
        .lines()
        .skip(1)
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let f: Vec<&str> = l.split('\t').collect();
            (f[1].parse().unwrap(), f[2].parse().unwrap())
        })
        .collect();
    let bin = tsv.with_extension("bin");
    let mut r = BufReader::new(File::open(&bin).unwrap_or_else(|e| panic!("{bin:?}: {e}")));
    let mut magic = [0u8; 8];
    r.read_exact(&mut magic).unwrap();
    assert_eq!(&magic, b"CALAFP01");
    let _h = read_u32(&mut r);
    let _w = read_u32(&mut r);
    let n = read_u32(&mut r) as usize;
    assert_eq!(n, centres.len(), "candidates tsv and bin disagree");
    let mut fps = Vec::with_capacity(n);
    for _ in 0..n {
        let _id = read_u32(&mut r);
        let m = read_u32(&mut r) as usize;
        let px: Vec<u32> = (0..m).map(|_| read_u32(&mut r)).collect();
        let a = read_f32s(&mut r, m);
        let _filtered = read_f32s(&mut r, m);
        fps.push((px, a));
    }
    (centres, fps)
}

fn f32_le_bytes(src: &[f32], dst: &mut [u8]) {
    for (v, b) in src.iter().zip(dst.chunks_mut(4)) {
        b.copy_from_slice(&v.to_le_bytes());
    }
}

/// Raw material of the blind labelling bundle (`tools/cala-label`).
///
/// Pass 1 runs the preprocessing (and motion correction) over the recording
/// and projects every candidate footprint on the floored frame, `aᵀy / aᵀa`,
/// the same trace for every candidate whatever its origin; the three highest
/// peaks, a window apart (22 s), are its events. Pass 2 runs the preprocessing
/// again and cuts a `crop`-pixel window around the candidate centroid out of
/// the registered frame before the floor (`pre`) and after it (`y`) for the 441
/// frames around each event (180 before the peak, 260 after), plus the whole-recording mean of both. Outputs in
/// `out_dir`: `peaks.tsv`, `crops.tsv`, `traces.f32` (`[cand][t]`),
/// `snip_y.f32` / `snip_pre.f32` (`[cand][event][441][crop][crop]`) and
/// `mean_y.f32` / `mean_pre.f32` (`[cand][crop][crop]`). Nothing is rescaled:
/// the values are the grey levels the model sees.
#[allow(clippy::too_many_arguments)]
fn label_bundle(
    rec: &mut Recording,
    pre0: &Preprocessor,
    cal: &Calibration,
    motion: bool,
    cand_tsv: &Path,
    crop: usize,
    frames: u32,
    out_dir: &Path,
) {
    use std::os::unix::fs::FileExt;
    const PRE: usize = 180;
    const POST: usize = 260;
    const EVENTS: usize = 3;
    const SPAN: usize = PRE + POST + 1;
    let dims = rec.dims;
    let n_px = dims.pixels();
    let t_len = frames as usize;
    let (centres, fps) = read_candidates(cand_tsv);
    let n = centres.len();
    let norms: Vec<f32> = fps
        .iter()
        .map(|(_, a)| a.iter().map(|v| v * v).sum::<f32>().max(1e-12))
        .collect();
    let mut y = vec![0.0f32; n_px];
    let mut pre = vec![0.0f32; n_px];

    let mut pipe = Pipeline::new(rec, pre0.clone(), cal, motion, 200);
    let mut traces = vec![0.0f32; n * t_len];
    let mut s = 0u32;
    while s < frames {
        let cnt = 64.min(frames - s);
        let raw = rec.read(s, cnt);
        for (k, f) in raw.chunks_exact(n_px).enumerate() {
            let t = s as usize + k;
            pipe.frame_split(f, &mut pre, &mut y);
            for (i, (px, a)) in fps.iter().enumerate() {
                let d: f32 = px.iter().zip(a).map(|(&q, &w)| w * y[q as usize]).sum();
                traces[i * t_len + t] = d / norms[i];
            }
        }
        s += cnt;
    }
    println!("label bundle pass 1: {n} candidates x {t_len} frames");

    // Events: highest peaks of the 5-frame running mean, a window apart.
    let mut peaks = vec![[usize::MAX; EVENTS]; n];
    for (i, found) in peaks.iter_mut().enumerate() {
        let tr = &traces[i * t_len..(i + 1) * t_len];
        let sm: Vec<f32> = (0..t_len)
            .map(|t| {
                let (a, b) = (t.saturating_sub(2), (t + 3).min(t_len));
                tr[a..b].iter().sum::<f32>() / (b - a) as f32
            })
            .collect();
        let mut taken: Vec<bool> = (0..t_len).map(|t| t < PRE || t + POST >= t_len).collect();
        for slot in found.iter_mut() {
            let best = (0..t_len)
                .filter(|&t| !taken[t])
                .max_by(|&a, &b| sm[a].total_cmp(&sm[b]));
            let Some(t) = best else { break };
            *slot = t;
            taken[t.saturating_sub(SPAN - 1)..(t + SPAN).min(t_len)].fill(true);
        }
        found.sort_unstable();
    }
    let mut pk = String::from("cand\tevent\tframe\n");
    for (i, p) in peaks.iter().enumerate() {
        for (e, &t) in p.iter().enumerate() {
            let t = if t == usize::MAX { -1 } else { t as i64 };
            let _ = writeln!(pk, "{i}\t{e}\t{t}");
        }
    }
    std::fs::write(out_dir.join("peaks.tsv"), pk).unwrap();
    {
        let mut f = BufWriter::new(File::create(out_dir.join("traces.f32")).unwrap());
        write_f32s(&mut f, &traces);
    }

    // Crop origins (top-left, may lie outside the image; outside reads as 0).
    let origin: Vec<(i64, i64)> = centres
        .iter()
        .map(|&(cy, cx)| {
            (
                cy.round() as i64 - (crop / 2) as i64,
                cx.round() as i64 - (crop / 2) as i64,
            )
        })
        .collect();
    let mut cr = String::from("cand\ty0\tx0\tcrop\n");
    for (i, (y0, x0)) in origin.iter().enumerate() {
        let _ = writeln!(cr, "{i}\t{y0}\t{x0}\t{crop}");
    }
    std::fs::write(out_dir.join("crops.tsv"), cr).unwrap();

    // Event windows by frame: the (candidate, event, offset) that want it.
    let mut wants: HashMap<usize, Vec<(usize, usize, usize)>> = HashMap::new();
    for (i, p) in peaks.iter().enumerate() {
        for (e, &t) in p.iter().enumerate() {
            if t == usize::MAX {
                continue;
            }
            for off in 0..SPAN {
                wants.entry(t + off - PRE).or_default().push((i, e, off));
            }
        }
    }
    let cc = crop * crop;
    let size = (n * EVENTS * SPAN * cc * 4) as u64;
    let f_y = File::create(out_dir.join("snip_y.f32")).unwrap();
    let f_pre = File::create(out_dir.join("snip_pre.f32")).unwrap();
    f_y.set_len(size).unwrap();
    f_pre.set_len(size).unwrap();
    let mut sum_y = vec![0.0f64; n * cc];
    let mut sum_pre = vec![0.0f64; n * cc];
    let mut buf_y = vec![0.0f32; cc];
    let mut buf_pre = vec![0.0f32; cc];
    let mut bytes = vec![0u8; cc * 4];
    let (h, w) = (dims.height as i64, dims.width as i64);
    let cut = |src: &[f32], o: (i64, i64), dst: &mut [f32]| {
        for r in 0..crop {
            for c in 0..crop {
                let (yy, xx) = (o.0 + r as i64, o.1 + c as i64);
                dst[r * crop + c] = if yy >= 0 && xx >= 0 && yy < h && xx < w {
                    src[(yy * w + xx) as usize]
                } else {
                    0.0
                };
            }
        }
    };
    let mut pipe = Pipeline::new(rec, pre0.clone(), cal, motion, 200);
    let mut s = 0u32;
    while s < frames {
        let cnt = 64.min(frames - s);
        let raw = rec.read(s, cnt);
        for (k, f) in raw.chunks_exact(n_px).enumerate() {
            let t = s as usize + k;
            pipe.frame_split(f, &mut pre, &mut y);
            for i in 0..n {
                cut(&y, origin[i], &mut buf_y);
                cut(&pre, origin[i], &mut buf_pre);
                for j in 0..cc {
                    sum_y[i * cc + j] += f64::from(buf_y[j]);
                    sum_pre[i * cc + j] += f64::from(buf_pre[j]);
                }
                let Some(wv) = wants.get(&t) else { continue };
                for &(_, e, off) in wv.iter().filter(|x| x.0 == i) {
                    let pos = (((i * EVENTS + e) * SPAN + off) * cc * 4) as u64;
                    f32_le_bytes(&buf_y, &mut bytes);
                    f_y.write_all_at(&bytes, pos).unwrap();
                    f32_le_bytes(&buf_pre, &mut bytes);
                    f_pre.write_all_at(&bytes, pos).unwrap();
                }
            }
        }
        s += cnt;
    }
    for (name, sum) in [("mean_y.f32", &sum_y), ("mean_pre.f32", &sum_pre)] {
        let mut f = BufWriter::new(File::create(out_dir.join(name)).unwrap());
        let m: Vec<f32> = sum.iter().map(|v| (v / t_len as f64) as f32).collect();
        write_f32s(&mut f, &m);
    }
    println!("label bundle pass 2: crops written to {out_dir:?}");
}

/// `final{suffix}.tsv` (each cell: centroid, footprint match, the slow
/// loop's evidence record, held-out marginal) and `footprints{suffix}.bin`
/// (`CALAFP01`) of `lib`.
fn write_library(
    out_dir: &Path,
    suffix: &str,
    lib: &Library,
    dims: Dims,
    gt: Option<&Gt>,
    ho: Option<&HeldOutScore>,
    slow: Option<&SlowLoop>,
) {
    {
        // Final cells: centroid and footprint match (GT runs).
        let det = columns(lib, dims, (0, 0));
        let mut t = String::from(
            "slot\tid\tcy\tcx\tmatched\tbest_gt\tbest_r\tstatus\ttransients\tpasses\tfails\tredundant\tpeak_z\tho_marginal\tho_frames\tho_marginal_z\n",
        );
        let (mt, best) = match gt {
            Some(g) => match_cells(&det, &g.cols, dims, 0.7),
            None => (
                vec![None; det.len()],
                vec![(usize::MAX, f64::NAN); det.len()],
            ),
        };
        let hc = ho.map(|h| h.cells(lib.ids()));
        for s in 0..lib.len() {
            let c = centroid(&det[s], dims.width);
            let hs = hc.as_ref().map_or("nan\t0\tnan".to_string(), |v| {
                format!(
                    "{:.4}\t{}\t{:.3}",
                    v[s].marginal, v[s].frames, v[s].marginal_z
                )
            });
            let (bg, br) = mt[s].unwrap_or(best[s]);
            let info = slow.and_then(|sl| sl.cell_info(lib.ids()[s]));
            let ev = info.map_or("na\t-1\t-1\t-1\t-1\tnan".to_string(), |i| {
                format!(
                    "{}\t{}\t{}\t{}\t{}\t{:.2}",
                    i.status.as_str(),
                    i.transients,
                    i.passes,
                    i.fails,
                    i.redundant,
                    i.peak_z
                )
            });
            let _ = writeln!(
                t,
                "{s}\t{}\t{:.2}\t{:.2}\t{}\t{}\t{:.4}\t{ev}\t{hs}",
                lib.ids()[s],
                c.0,
                c.1,
                u8::from(mt[s].is_some()),
                if bg == usize::MAX { -1 } else { bg as i64 },
                br
            );
        }
        std::fs::write(out_dir.join(format!("final{suffix}.tsv")), t).unwrap();
    }
    {
        let mut f =
            BufWriter::new(File::create(out_dir.join(format!("footprints{suffix}.bin"))).unwrap());
        f.write_all(b"CALAFP01").unwrap();
        for v in [dims.height as u32, dims.width as u32, lib.len() as u32] {
            f.write_all(&v.to_le_bytes()).unwrap();
        }
        for s in 0..lib.len() {
            let (p, a) = lib.unfiltered(s);
            let (_, h) = lib.filtered(s);
            f.write_all(&(lib.ids()[s] as u32).to_le_bytes()).unwrap();
            f.write_all(&(p.len() as u32).to_le_bytes()).unwrap();
            for q in p {
                f.write_all(&q.to_le_bytes()).unwrap();
            }
            write_f32s(&mut f, a);
            write_f32s(&mut f, h);
        }
    }
}

/// Frames per factor window (`--factors-out`; the app's compressor uses the same).
const FACTOR_WINDOW: usize = 600;

/// Whether the run keeps a `LookBack`: look-back or catch-up, or an
/// end-of-Discover settle (`--settle-frames N`), which needs one even with
/// `--lookback 0` (rate 0: it never asks for a frame during Discover).
fn lookback_wanted(rate: f64, catchup: usize, settle_frames: usize) -> bool {
    rate > 0.0 || catchup > 0 || settle_frames > 0
}

/// Where the end-of-Discover settle gets its frames (`--settle-source`).
enum SettleSource {
    /// Re-read from the recording and preprocessed (the default).
    Raw,
    /// Rebuilt from Discover's factor windows in this folder (`--factors-out`).
    Factors(PathBuf),
}

fn settle_source(args: &[String]) -> Result<SettleSource, String> {
    match arg_value(args, "--settle-source").as_deref() {
        None | Some("raw") => Ok(SettleSource::Raw),
        Some("factors") => {
            let dir = arg_value(args, "--factors-out")
                .ok_or("--settle-source factors needs --factors-out DIR")?;
            let n: usize = arg_value(args, "--settle-frames").map_or(0, |s| s.parse().unwrap_or(0));
            if n == 0 {
                return Err("--settle-source factors needs --settle-frames N".into());
            }
            Ok(SettleSource::Factors(PathBuf::from(dir)))
        }
        Some(o) => Err(format!("--settle-source: raw or factors, not {o:?}")),
    }
}

/// `--factors-out`: compresses the preprocessed frames of Discover window by
/// window and writes each window's factors (format v2, `CALAFAC2`, cut by
/// `--factors-tiling`) to `dir/w<start frame>.fac`.
struct FactorDump {
    dir: PathBuf,
    wc: calab_cala::compress::WindowCompressor,
    /// Frames pushed, and the seconds spent in the compressor (speed report).
    frames: u64,
    secs: f64,
    /// The speed line was printed (once, at the first `finish`).
    reported: bool,
}

impl FactorDump {
    fn new(dir: &Path, dims: Dims, tiling: Tiling) -> FactorDump {
        std::fs::create_dir_all(dir).unwrap();
        let cfg = calab_cala::compress::CompressConfig {
            window: FACTOR_WINDOW,
            tiling,
            ..calab_cala::compress::CompressConfig::default()
        };
        FactorDump {
            dir: dir.to_path_buf(),
            wc: calab_cala::compress::WindowCompressor::new(dims, cfg),
            frames: 0,
            secs: 0.0,
            reported: false,
        }
    }

    fn write(&self, wf: calab_cala::compress::WindowFactors) {
        let name = format!("w{:07}.fac", wf.start);
        std::fs::write(self.dir.join(name), wf.to_bytes()).unwrap();
    }

    fn push(&mut self, frame: &[f32]) {
        let t0 = Instant::now();
        let done = self.wc.push(frame);
        self.secs += t0.elapsed().as_secs_f64();
        self.frames += 1;
        if let Some(wf) = done {
            self.write(wf);
        }
    }

    /// Write the last, shorter window (none when no frame is buffered: a
    /// second call, or a recording of whole windows) and, the first time,
    /// print the compressor's time.
    fn finish(&mut self) {
        let t0 = Instant::now();
        let done = self.wc.flush();
        self.secs += t0.elapsed().as_secs_f64();
        if let Some(wf) = done {
            self.write(wf);
        }
        if !self.reported {
            self.reported = true;
            println!(
                "factors: {} frames, {:.2} ms per frame in the compressor (one thread)",
                self.frames,
                1e3 * self.secs / self.frames.max(1) as f64
            );
        }
    }
}

/// Pixels with no valid sample in any frame of `wf` (valid share 0 in
/// every tile that covers them).
fn never_valid(wf: &WindowFactors) -> Vec<bool> {
    let width = wf.dims.width;
    let mut never = vec![true; wf.dims.pixels()];
    for tf in &wf.tiles {
        for y in 0..tf.h {
            let row = (tf.y0 + y) * width + tf.x0;
            for x in 0..tf.w {
                if tf.valid[y * tf.w + x] > 0.0 {
                    never[row + x] = false;
                }
            }
        }
    }
    never
}

/// Windows `FactorFrames` keeps decoded: the settle reads in plan order, so
/// the current and the next window are enough.
const FACTOR_CACHE: usize = 2;

/// A decoded factor window: its factors, its blend layout (none for a plain
/// tiling) and its never-valid pixels.
type FactorWindow = (WindowFactors, Option<BlendLayout>, Vec<bool>);

/// `--settle-source factors`: the frames Discover compressed, read back from
/// the factor windows of a `FactorDump`. A frame is the live frame as
/// compressed: pixels never valid in its window are missing (NaN), as in the
/// live frame; nothing is preprocessed, warped or masked again. A pixel that
/// became valid partway through its window reads its window mean before that
/// point (a small difference from the live frame).
struct FactorFrames {
    dir: PathBuf,
    window: usize,
    cache: std::collections::VecDeque<FactorWindow>,
    reads: u64,
}

impl FactorFrames {
    fn new(dir: &Path, window: usize) -> FactorFrames {
        FactorFrames {
            dir: dir.to_path_buf(),
            window,
            cache: Default::default(),
            reads: 0,
        }
    }

    /// Window files read (each cache miss).
    fn reads(&self) -> u64 {
        self.reads
    }

    /// Write stream frame `f`, rebuilt from its window, to `y`.
    fn frame(&mut self, f: usize, y: &mut [f32]) -> Result<(), String> {
        let start = (f / self.window) * self.window;
        let at = match self
            .cache
            .iter()
            .position(|(wf, _, _)| wf.start as usize == start)
        {
            Some(i) => i,
            None => {
                let path = self.dir.join(format!("w{start:07}.fac"));
                let bytes = std::fs::read(&path)
                    .map_err(|e| format!("frame {f}: {} cannot be read ({e})", path.display()))?;
                let wf = WindowFactors::from_bytes(&bytes)
                    .ok_or_else(|| format!("{}: not a factor file", path.display()))?;
                let layout = (wf.tiling != Tiling::Plain).then(|| wf.layout());
                let never = never_valid(&wf);
                if self.cache.len() == FACTOR_CACHE {
                    self.cache.pop_front();
                }
                self.cache.push_back((wf, layout, never));
                self.reads += 1;
                self.cache.len() - 1
            }
        };
        let (wf, layout, never) = &self.cache[at];
        if f - start >= wf.frames {
            return Err(format!(
                "frame {f} is past the {} frames of window {start}",
                wf.frames
            ));
        }
        if y.len() != wf.dims.pixels() {
            return Err(format!(
                "frame {f}: {} pixels, the window has {}",
                y.len(),
                wf.dims.pixels()
            ));
        }
        match layout {
            Some(l) => l.reconstruct(wf, f - start, y),
            None => wf.reconstruct(f - start, y),
        }
        for (v, &nv) in y.iter_mut().zip(never) {
            if nv {
                *v = f32::NAN;
            }
        }
        Ok(())
    }
}

/// DIAG (`CALA_DIVERGE_DIR`): per-frame solver log (sweeps, largest
/// |trace|) and, at the first frames that hit the sweep cap or go
/// non-finite, the library bytes, the frame and the warm start.
struct DivergeProbe {
    dir: PathBuf,
    log: BufWriter<File>,
    dumps: usize,
    last_ver: u64,
}

impl DivergeProbe {
    fn new(dir: PathBuf) -> DivergeProbe {
        std::fs::create_dir_all(&dir).unwrap();
        let mut log = BufWriter::new(File::create(dir.join("solver.tsv")).unwrap());
        writeln!(log, "t\tlib\tcells\tsweeps\tmax_abs\tnonfinite").unwrap();
        DivergeProbe {
            dir,
            log,
            dumps: 0,
            last_ver: u64::MAX,
        }
    }
    fn frame(
        &mut self,
        t: usize,
        y: &[f32],
        engine: &TraceEngine,
        warm: &calab_cala::trace::TraceState,
        tr: &FrameTraces,
    ) {
        let lib = engine.library();
        let mx = tr.traces.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        let nf = tr.traces.iter().filter(|v| !v.is_finite()).count();
        writeln!(
            self.log,
            "{t}\t{}\t{}\t{}\t{mx:e}\t{nf}",
            lib.version(),
            lib.len(),
            tr.sweeps
        )
        .unwrap();
        let at = std::env::var("CALA_DIVERGE_AT")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            == Some(t);
        let bad = mx > 1e6 || nf > 0 || at;
        if bad && self.dumps < 6 && lib.version() != self.last_ver {
            self.last_ver = lib.version();
            self.dumps += 1;
            let d = self.dir.join(format!("dump_t{t}_v{}", lib.version()));
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("library.bin"), lib.to_bytes()).unwrap();
            let mut b = Vec::with_capacity(y.len() * 4);
            y.iter().for_each(|v| b.extend_from_slice(&v.to_le_bytes()));
            std::fs::write(d.join("frame.f32"), b).unwrap();
            let mut w = String::new();
            for (id, v) in warm.ids.iter().zip(&warm.traces) {
                let _ = writeln!(w, "{id}\t{v:e}");
            }
            std::fs::write(d.join("warm.tsv"), w).unwrap();
            let mut o = String::new();
            for (id, v) in lib.ids().iter().zip(&tr.traces) {
                let _ = writeln!(o, "{id}\t{v:e}");
            }
            std::fs::write(d.join("out.tsv"), o).unwrap();
            self.log.flush().unwrap();
        }
    }
}

/// Per cell of the pass-2 dump (frame-major `clipped` and `signed`, `t_len`
/// frames): its best GT unit by the clipped trace's correlation, and both
/// traces' correlation with that unit, over all frames and over the unit's
/// active frames (GT above 5% of its range over its minimum); and on its
/// quiet frames (GT within 1% of its range of its minimum) each trace's mean in units of the signed trace's
/// sd there: the baseline bias clipping adds (`traces_signed_gt.tsv`,
/// summary printed).
fn signed_vs_gt(
    lib: &Library,
    clipped: &[f32],
    signed: &[f32],
    t_len: usize,
    g: &Gt,
    o: &Oracle,
    out_dir: &Path,
) {
    let n = lib.len();
    let t = t_len.min(g.t_gt);
    let col = |m: &[f32], i: usize| -> Vec<f32> { (0..t).map(|k| m[k * n + i]).collect() };
    let mut out = String::from(
        "id\tgt\tr_clipped\tr_signed\tr_active_clipped\tr_active_signed\tquiet_frames\tquiet_mean_clipped_sd\tquiet_mean_signed_sd\tzero_frac\tneg_frac\n",
    );
    let (mut rc, mut rs) = (Vec::new(), Vec::new());
    let (mut ac, mut as_) = (Vec::new(), Vec::new());
    let (mut qc, mut qs) = (Vec::new(), Vec::new());
    for (i, &id) in lib.ids().iter().enumerate() {
        let (c, sg) = (col(clipped, i), col(signed, i));
        let (mut bj, mut br) = (usize::MAX, f64::NEG_INFINITY);
        for j in 0..g.kept.len() {
            let r = pearson(&c, &g.c(o, j)[..t]);
            if r > br {
                (bj, br) = (j, r);
            }
        }
        if bj == usize::MAX {
            continue;
        }
        let gj = &g.c(o, bj)[..t];
        let r_s = pearson(&sg, gj);
        let zero = c.iter().filter(|&&v| v == 0.0).count() as f64 / t as f64;
        let neg = sg.iter().filter(|&&v| v < 0.0).count() as f64 / t as f64;
        // GT may sit on a baseline: levels are relative to its range.
        let lo = gj.iter().fold(f32::INFINITY, |a, &v| a.min(v));
        let peak = gj.iter().fold(f32::NEG_INFINITY, |a, &v| a.max(v)) - lo;
        let pick = |m: &[f32], keep: &dyn Fn(f32) -> bool| -> (Vec<f32>, Vec<f32>) {
            m.iter()
                .zip(gj)
                .filter(|(_, &gv)| keep(gv))
                .map(|(&v, &gv)| (v, gv))
                .unzip()
        };
        let active = |gv: f32| gv - lo > 0.05 * peak;
        let quiet = |gv: f32| gv - lo <= 0.01 * peak;
        let (ca, ga) = pick(&c, &active);
        let (sa, _) = pick(&sg, &active);
        let (r_ac, r_as) = (pearson(&ca, &ga), pearson(&sa, &ga));
        let (cq, _) = pick(&c, &quiet);
        let (sq, _) = pick(&sg, &quiet);
        let nq = sq.len().max(1) as f64;
        let ms = sq.iter().map(|&v| f64::from(v)).sum::<f64>() / nq;
        let mc = cq.iter().map(|&v| f64::from(v)).sum::<f64>() / nq;
        let sd = (sq.iter().map(|&v| (f64::from(v) - ms).powi(2)).sum::<f64>() / nq).sqrt();
        let (bq_c, bq_s) = (mc / sd, ms / sd);
        let _ = writeln!(
            out,
            "{id}\t{bj}\t{br:.4}\t{r_s:.4}\t{r_ac:.4}\t{r_as:.4}\t{}\t{bq_c:.3}\t{bq_s:.3}\t{zero:.3}\t{neg:.3}",
            sq.len()
        );
        if br.is_finite() && r_s.is_finite() {
            rc.push(br);
            rs.push(r_s);
        }
        if r_ac.is_finite() && r_as.is_finite() && ca.len() >= 50 {
            ac.push(r_ac);
            as_.push(r_as);
        }
        if sq.len() >= 200 && bq_c.is_finite() && bq_s.is_finite() {
            qc.push(bq_c);
            qs.push(bq_s);
        }
    }
    std::fs::write(out_dir.join("traces_signed_gt.tsv"), out).unwrap();
    let med = |v: &[f64]| {
        let mut v = v.to_vec();
        v.sort_by(f64::total_cmp);
        v.get(v.len() / 2).copied().unwrap_or(f64::NAN)
    };
    let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len().max(1) as f64;
    let better = rc.iter().zip(&rs).filter(|(a, b)| b >= a).count();
    println!(
        "signed vs GT: {} cells, r clipped median {:.4} mean {:.4}; r signed median {:.4} mean {:.4}; signed >= clipped for {better}",
        rc.len(),
        med(&rc),
        mean(&rc),
        med(&rs),
        mean(&rs),
    );
    println!(
        "signed vs GT, active frames: {} cells, r clipped median {:.4}, r signed median {:.4}; quiet frames: {} cells, mean / sd clipped median {:.3}, signed median {:.3}",
        ac.len(),
        med(&ac),
        med(&as_),
        qc.len(),
        med(&qc),
        med(&qs),
    );
}

/// The options that act only AFTER Discover's last frame (later passes, the
/// look-back drain and its settle step). They are the only options a branch
/// (`--branch`) may change; add a new tail option here and in [`TAIL_FLAGS`].
#[derive(Clone)]
struct Tail {
    passes: usize,
    later_scope: EditScope,
    drain: usize,
    drain_rate: f64,
    settle_all: usize,
    /// `--settle-*`: the end-of-Discover settle, run after the drain (and
    /// after the `drain` branch point).
    settle: SettleCfg,
}

/// Flags [`Tail::parse`] reads. `drain` ones act inside the drain, so a
/// `--branch-after drain` branch cannot set them.
const TAIL_FLAGS: &[&str] = &[
    "--passes",
    "--later-passes",
    "--lookback-drain",
    "--lookback-drain-rate",
    "--lookback-settle-all",
    "--settle-frames",
    "--settle-round",
    "--settle-observe",
    "--settle-steps",
    "--settle-batch",
    "--settle-due",
    "--settle-publish",
    "--settle-check",
    "--settle-stop-k",
    "--settle-stop-share",
    "--settle-stop-checks",
    "--settle-min-frames",
    "--settle-libs",
];
const DRAIN_FLAGS: &[&str] = &[
    "--lookback-drain",
    "--lookback-drain-rate",
    "--lookback-settle-all",
];

impl Tail {
    /// The tail options of an argument list (first occurrence of a flag wins).
    fn parse(args: &[String]) -> Tail {
        let passes: usize = arg_value(args, "--passes").map_or(1, |s| s.parse().unwrap());
        assert!(passes >= 1, "--passes must be at least 1");
        let later_scope = match arg_value(args, "--later-passes").as_deref() {
            None => EditScope::All,
            Some(m) => EditScope::from_name(m)
                .unwrap_or_else(|| panic!("--later-passes: unknown mode {m}")),
        };
        let drain_rate: f64 =
            arg_value(args, "--lookback-drain-rate").map_or(0.0, |s| s.parse().unwrap());
        assert!(drain_rate >= 0.0, "--lookback-drain-rate must be >= 0");
        Tail {
            passes,
            later_scope,
            drain: arg_value(args, "--lookback-drain").map_or(0, |s| s.parse().unwrap()),
            drain_rate,
            settle_all: arg_value(args, "--lookback-settle-all").map_or(0, |s| s.parse().unwrap()),
            settle: SettleCfg::parse(args),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum BranchPoint {
    /// End of Discover (pass 1), before the look-back drain.
    Discover,
    /// After the look-back drain, before any later pass.
    Drain,
}

/// `--branch-after POINT --branch 'NAME:FLAGS'` (repeatable): run to POINT
/// once, then fork the whole process once per branch (copy-on-write: the
/// state is bit-for-bit what an unbranched run has there), one after another.
/// Each child applies its tail flags, runs on and writes its normal outputs
/// to `<out>/NAME/`.
struct Branching {
    point: BranchPoint,
    /// (name, flag tokens)
    branches: Vec<(String, Vec<String>)>,
}

extern "C" {
    fn fork() -> i32;
    fn waitpid(pid: i32, status: *mut i32, options: i32) -> i32;
}

/// What a forked branch changes about the run.
struct BranchChild {
    tail: Tail,
    out_dir: PathBuf,
}

impl Branching {
    fn parse(args: &[String]) -> Option<Branching> {
        let point = match arg_value(args, "--branch-after").as_deref() {
            None => {
                assert!(
                    !args.iter().any(|a| a == "--branch"),
                    "--branch needs --branch-after discover|drain"
                );
                return None;
            }
            Some("discover") => BranchPoint::Discover,
            Some("drain") => BranchPoint::Drain,
            Some(p) => panic!("--branch-after: unknown point {p} (discover | drain)"),
        };
        let mut branches = Vec::new();
        for (i, a) in args.iter().enumerate() {
            if a != "--branch" {
                continue;
            }
            let spec = args.get(i + 1).expect("--branch NAME:FLAGS");
            let (name, flags) = spec.split_once(':').unwrap_or((spec, ""));
            assert!(
                !name.is_empty() && !name.contains('/') && name != "..",
                "--branch: bad name {name:?}"
            );
            let toks: Vec<String> = flags.split_whitespace().map(String::from).collect();
            for t in toks.iter().filter(|t| t.starts_with("--")) {
                assert!(
                    TAIL_FLAGS.contains(&t.as_str()),
                    "--branch {name}: {t} is not a tail flag (allowed: {TAIL_FLAGS:?})"
                );
                assert!(
                    !(point == BranchPoint::Drain && DRAIN_FLAGS.contains(&t.as_str())),
                    "--branch {name}: {t} acts before `--branch-after drain`"
                );
            }
            assert!(
                !branches.iter().any(|(n, _)| n == name),
                "--branch: duplicate name {name}"
            );
            branches.push((name.to_string(), toks));
        }
        assert!(
            !branches.is_empty(),
            "--branch-after needs --branch NAME:FLAGS"
        );
        // State the children would share on disk or in a global.
        // (`--visit-workers`: only with `--csettle`, which has the slow
        // worker finish every visit out before the branch point.)
        for f in [
            "--churn-log",
            "--merge-log",
            "--factors-out",
            "--visit-workers",
        ] {
            assert!(
                !args.iter().any(|a| a == f)
                    || f == "--visit-workers" && args.iter().any(|a| a == "--csettle"),
                "{f} cannot be combined with --branch-after"
            );
        }
        Some(Branching { point, branches })
    }

    /// Branch args first: the first occurrence of a flag wins in `arg_value`.
    fn branch_args(&self, args: &[String], toks: &[String]) -> Vec<String> {
        toks.iter().chain(args.iter()).cloned().collect()
    }

    fn max_passes(&self, args: &[String]) -> usize {
        self.branches
            .iter()
            .map(|(_, t)| Tail::parse(&self.branch_args(args, t)).passes)
            .max()
            .unwrap_or(1)
    }

    /// In the parent: run every branch as a child process in turn, then exit
    /// (never returns). In a child: its [`BranchChild`].
    fn fork(&self, args: &[String], out_dir: &Path) -> Option<BranchChild> {
        let mut failed = 0;
        for (name, toks) in &self.branches {
            let tail = Tail::parse(&self.branch_args(args, toks));
            let dir = out_dir.join(name);
            std::fs::create_dir_all(&dir).unwrap();
            // Files the prefix already wrote (e.g. `--lib-at` libraries).
            for e in std::fs::read_dir(out_dir).unwrap().flatten() {
                if e.file_type().is_ok_and(|t| t.is_file()) {
                    std::fs::copy(e.path(), dir.join(e.file_name())).unwrap();
                }
            }
            let _ = std::io::stdout().flush();
            // SAFETY: the process is single-threaded here (the crate's
            // scoped worker threads are joined), so the child may run on.
            let pid = unsafe { fork() };
            assert!(pid >= 0, "fork failed");
            if pid == 0 {
                println!("branch {name}: {toks:?}");
                return Some(BranchChild { tail, out_dir: dir });
            }
            let mut status = 0i32;
            // SAFETY: `pid` is our child.
            unsafe { waitpid(pid, &mut status, 0) };
            if status != 0 {
                eprintln!("branch {name} failed (wait status {status})");
                failed += 1;
            }
        }
        std::process::exit(i32::from(failed > 0));
    }
}

impl BranchChild {
    fn apply(
        self,
        tail: &mut Tail,
        out_dir: &mut PathBuf,
        lookback: Option<&mut LookBack>,
        passes: &mut usize,
        later_scope: &mut EditScope,
        lb_drain: &mut usize,
    ) {
        *passes = self.tail.passes;
        *later_scope = self.tail.later_scope;
        *lb_drain = self.tail.drain;
        if let Some(l) = lookback {
            l.drain_rate = self.tail.drain_rate;
            l.settle_all = self.tail.settle_all;
            l.settle = self.tail.settle.clone();
        }
        *tail = self.tail;
        *out_dir = self.out_dir;
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).expect("mode: sim | oracle | real").clone();
    let input = PathBuf::from(args.get(2).expect("input dir"));
    let mut out_dir = PathBuf::from(args.get(3).expect("out dir"));
    std::fs::create_dir_all(&out_dir).unwrap();
    // DIAG: per-candidate merge log (no decision changes).
    if args.iter().any(|a| a == "--merge-log") {
        #[cfg(not(feature = "diagnostics"))]
        panic!("--merge-log needs --features diagnostics");
        #[cfg(feature = "diagnostics")]
        if std::env::var_os("CALA_MERGE_LOG").is_none() {
            std::env::set_var("CALA_MERGE_LOG", out_dir.join("merges.jsonl"));
        }
    }
    let has_gt = mode == "sim" || mode == "oracle";
    let oracle_mode = mode == "oracle";
    let motion = args.iter().any(|a| a == "--motion");
    let dump = args.iter().any(|a| a == "--dump");
    let dump_signed = !args.iter().any(|a| a == "--no-signed");
    let budget: u64 = arg_value(&args, "--budget").map_or(30_000_000, |s| s.parse().unwrap());
    let start: usize = arg_value(&args, "--start").map_or(50, |s| s.parse().unwrap());
    let every: usize = arg_value(&args, "--every").map_or(300, |s| s.parse().unwrap());
    let frac: f64 = arg_value(&args, "--perturb-frac").map_or(0.3, |s| s.parse().unwrap());
    let seed: u64 = arg_value(&args, "--seed").map_or(1, |s| s.parse().unwrap());
    let batch_n: usize = arg_value(&args, "--batch").map_or(1, |s| s.parse().unwrap());
    let keep: f64 = arg_value(&args, "--slow-keep").map_or(1.0, |s| s.parse().unwrap());
    let score_mode = arg_value(&args, "--drop-mode").is_some_and(|m| m == "score");
    let drop_step = args.iter().any(|a| a == "--drop-step");
    let no_bg_levels = args.iter().any(|a| a == "--no-bg-levels");
    let via_jobs = args.iter().any(|a| a == "--via-jobs");
    let offered_fps: Option<f64> = arg_value(&args, "--offered-fps").map(|s| s.parse().unwrap());
    let visit_workers: usize =
        arg_value(&args, "--visit-workers").map_or(0, |s| s.parse().unwrap());
    let units_per_ms: f64 =
        arg_value(&args, "--units-per-ms").map_or(2.0e6, |s| s.parse().unwrap());
    let observe_ms: Option<f64> = arg_value(&args, "--observe-ms").map(|s| s.parse().unwrap());
    let depth: usize = arg_value(&args, "--visit-depth").map_or(1, |s| s.parse().unwrap());
    let job_ms: f64 = arg_value(&args, "--job-ms").map_or(1.0, |s| s.parse().unwrap());
    let pool: usize = arg_value(&args, "--pool").map_or(2, |s| s.parse().unwrap());
    let heldout_on = !args.iter().any(|a| a == "--no-heldout");
    let branching = Branching::parse(&args);
    let mut tail = Tail::parse(&args);
    if let Some(b) = &branching {
        // The shared prefix must record whatever any branch's tail replays.
        tail.passes = tail.passes.max(b.max_passes(&args));
    }
    let mut passes = tail.passes;
    let mut later_scope = tail.later_scope;
    let churn_log = args.iter().any(|a| a == "--churn-log");
    let wrap_libs = args.iter().any(|a| a == "--wrap-libs");
    let lib_at: Vec<f64> = arg_value(&args, "--lib-at").map_or(Vec::new(), |s| {
        s.split(',')
            .map(|v| {
                let f: f64 = v
                    .parse()
                    .unwrap_or_else(|_| panic!("--lib-at: bad number {v}"));
                assert!(f > 0.0 && f < 1.0, "--lib-at: fractions must be in (0, 1)");
                f
            })
            .collect()
    });
    let boundary_flag = args.iter().any(|a| a == "--boundary-log");
    assert!(
        !boundary_flag || cfg!(feature = "diagnostics"),
        "--boundary-log needs a build with --features diagnostics"
    );
    let mut boundary = boundary_flag.then(BoundaryLog::new);
    // `--probe-bg-reset F` (diagnostics builds): a what-if probe for the
    // session-boundary study, not a fix: before recording frame F of pass 1
    // the preprocessor's background floor is replaced by a fresh one, which
    // re-warms from frame F as at the start of a recording.
    let probe_bg_reset: Option<usize> =
        arg_value(&args, "--probe-bg-reset").map(|s| s.parse().unwrap());
    assert!(
        probe_bg_reset.is_none() || cfg!(feature = "diagnostics"),
        "--probe-bg-reset needs a build with --features diagnostics"
    );
    // `--sessions F1,F2,..`: first frames of sessions 2.. (a Joint run's
    // boundaries); `--session-fix` picks the boundary fixes (default none:
    // the boundaries change nothing).
    let sessions: Vec<usize> = arg_value(&args, "--sessions").map_or(Vec::new(), |s| {
        s.split(',')
            .filter(|v| !v.is_empty())
            .map(|v| v.parse().unwrap())
            .collect()
    });
    let session_fix = SessionFix::parse(&arg_value(&args, "--session-fix").unwrap_or_default());
    assert!(
        !session_fix.any() || !sessions.is_empty(),
        "--session-fix needs --sessions"
    );
    assert!(!session_fix.any() || motion, "--session-fix needs --motion");
    let session_fit_frames: usize =
        arg_value(&args, "--session-fit-frames").map_or(8, |s| s.parse().unwrap());
    let session_ref_frames: usize =
        arg_value(&args, "--session-ref-frames").map_or(100, |s| s.parse().unwrap());
    assert!(session_fit_frames >= 1 && session_ref_frames >= 1);
    let mut session_log = String::from(
        "frame\tfit_rot_deg\tfit_dy\tfit_dx\tncc\tncc_unrotated\trot_deg\tdy\tdx\tchance_ncc\tpinned_rot\tpinned_shift\tfloor_gain\tfloor_offset\tfloor_kept\tnoise_ratio\n",
    );
    // The boundary correlation's within-session null (`Pipeline::observe_null`).
    let mut null_log = String::from("frame\tncc\n");
    let fixed_lib: Option<PathBuf> = arg_value(&args, "--library").map(PathBuf::from);
    assert!(
        fixed_lib.is_none() || !oracle_mode,
        "--library and oracle mode both set the library"
    );
    assert!(batch_n >= 1 && keep > 0.0 && keep <= 1.0);

    let avi_dir = if has_gt {
        input.join("daq/Miniscope")
    } else {
        input.clone()
    };
    let bin: usize = arg_value(&args, "--bin").map_or(1, |s| s.parse().unwrap());
    assert!(bin == 1 || mode == "real", "--bin is for `real` only");
    let mut rec = Recording::open(&avi_dir, bin);
    if bin > 1 {
        println!(
            "binned {bin}x{bin}: {}x{} px",
            rec.dims.width, rec.dims.height
        );
    }
    let dims = rec.dims;
    let n_px = dims.pixels();
    let mut oracle = has_gt.then(|| read_oracle(&input.join("oracle.bin")));
    // GT frame alignment (motion runs): cala registers to its warm-up
    // template, not to the sim's tissue frame; see [`FrameOffset`].
    let gt_offset = arg_value(&args, "--gt-offset").unwrap_or_else(|| "auto".into());
    assert!(
        gt_offset == "auto" || gt_offset == "none",
        "--gt-offset auto | none"
    );
    let gt_shifts: Option<Vec<(f64, f64)>> = (has_gt && motion)
        .then(|| input.join("shifts.npy"))
        .and_then(|p| {
            if p.exists() {
                Some(read_gt_shifts(&p))
            } else {
                assert!(
                    gt_offset == "none",
                    "{p:?} missing: a motion run needs the sim's true shifts to put the GT \
                     in cala's registered frame (python tools/cala-eval/export_gt_motion.py \
                     <sim dir>), or --gt-offset none to score without it"
                );
                None
            }
        });
    let mut gt_offset_applied = FrameOffset::ZERO;
    let mut frames = arg_value(&args, "--frames")
        .map_or(rec.total, |s| s.parse().unwrap())
        .min(rec.total);
    if let Some(o) = &oracle {
        frames = frames.min(o.n_frames as u32);
    }
    let t_len = frames as usize;
    // `--fps R`: the recording's frame rate for the time-based preprocessing
    // and flat-field settings (default 20, the sims'; Miniscope V4 runs at 30).
    let fps: f32 = arg_value(&args, "--fps").map_or(20.0, |s| s.parse().unwrap());
    let mut cfg = PreprocessConfig::for_fps(fps);
    if let Some(v) = arg_value(&args, "--cell-diameter") {
        cfg.flatten.cell_diameter_px = v.parse().unwrap();
    }
    if let Some(v) = arg_value(&args, "--flatten-sigma") {
        cfg.flatten.sigma_px = Some(v.parse().unwrap());
    }
    let mut scfg = SlowLoopConfig {
        cell_diameter_px: cfg.flatten.cell_diameter_px,
        ..SlowLoopConfig::default()
    };
    if let Some(v) = arg_value(&args, "--psf-sigma") {
        scfg.psf_sigma_px = v.parse().unwrap();
    }
    if let Some(v) = arg_value(&args, "--tile-px") {
        scfg.tile_px = v.parse().unwrap();
    }
    if let Some(v) = arg_value(&args, "--margin-px") {
        scfg.margin_px = v.parse().unwrap();
    }
    let scales_set = [
        "--cell-diameter",
        "--flatten-sigma",
        "--psf-sigma",
        "--tile-px",
        "--margin-px",
    ]
    .iter()
    .any(|f| args.iter().any(|a| a == f));
    if scales_set {
        println!(
            "scales: cell diameter {} px, flatten sigma {} px, psf sigma {} px, tile {} / margin {} px",
            scfg.cell_diameter_px,
            cfg.flatten.sigma(),
            scfg.psf_sigma_px,
            scfg.tile_px,
            scfg.margin_px
        );
    }
    if let Some(v) = arg_value(&args, "--slow-seed") {
        scfg.seed = v.parse().unwrap();
    }
    if let Some(v) = arg_value(&args, "--accept-z") {
        scfg.accept_z = v.parse().unwrap();
    }
    if let Some(v) = arg_value(&args, "--core-test") {
        scfg.core_test = match v.as_str() {
            "off" => CoreTest::Off,
            "report" => CoreTest::Report,
            "trim" => CoreTest::Trim,
            "delete" => CoreTest::Delete,
            other => panic!("--core-test: off|report|trim|delete, not {other}"),
        };
    }
    if args.iter().any(|a| a == "--basin-trim") {
        scfg.basin_trim = true;
    }
    if let Some(v) = arg_value(&args, "--support-rule") {
        scfg.support_rule = match v.as_str() {
            "rings" => SupportRule::Rings,
            "basin" => SupportRule::Basin,
            "basin-skirt" => SupportRule::BasinSkirt,
            other => panic!("--support-rule: rings|basin|basin-skirt, not {other}"),
        };
    }
    if let Some(v) = arg_value(&args, "--support-alpha") {
        scfg.support_alpha = v.parse().unwrap();
    }
    if let Some(v) = arg_value(&args, "--refine-gate") {
        scfg.refine_gate = match v.as_str() {
            "legacy" => RefineGate::Legacy,
            "split-half" => RefineGate::SplitHalf,
            other => panic!("--refine-gate: legacy|split-half, not {other}"),
        };
    }
    if let Some(v) = arg_value(&args, "--refine-z") {
        scfg.refine_z = v.parse().unwrap();
        println!("refine z: {}", scfg.refine_z);
    }
    if let Some(v) = arg_value(&args, "--joint-update") {
        scfg.joint_update = match v.as_str() {
            "off" => JointUpdate::Off,
            "refine" => JointUpdate::Refine,
            "all" => JointUpdate::All,
            other => panic!("--joint-update: off|refine|all, not {other}"),
        };
    }
    if let Some(v) = arg_value(&args, "--cluster-rho-min") {
        scfg.cluster_rho_min = v.parse().unwrap();
    }
    if let Some(v) = arg_value(&args, "--cluster-max") {
        scfg.cluster_max = v.parse().unwrap();
    }
    if scfg.joint_update != JointUpdate::Off {
        println!(
            "joint update: {:?}, cluster rho >= {}, at most {} cells",
            scfg.joint_update, scfg.cluster_rho_min, scfg.cluster_max
        );
    }
    if let Some(v) = arg_value(&args, "--joint-sign") {
        scfg.joint_sign_rule = match v.as_str() {
            "off" => JointSign::Off,
            "own" => JointSign::Own,
            "all" => JointSign::All,
            other => panic!("--joint-sign: off|own|all, not {other}"),
        };
        println!("joint update: sign rule {:?}", scfg.joint_sign_rule);
    }
    if let Some(v) = arg_value(&args, "--bg") {
        scfg.background = match v.as_str() {
            "none" => calab_cala::trace::BackgroundModel::None,
            "ring" => scfg.background.clone(),
            other => panic!("--bg: none|ring, not {other}"),
        };
        println!("slow-loop background model: {:?}", scfg.background);
    }
    if let Some(v) = arg_value(&args, "--joint-admit") {
        scfg.joint_admit = match v.as_str() {
            "cluster" => JointAdmit::Cluster,
            "member" => JointAdmit::Member,
            other => panic!("--joint-admit: cluster|member, not {other}"),
        };
        println!("joint update: admission {:?}", scfg.joint_admit);
    }
    if args.iter().any(|a| a == "--joint-carry") {
        scfg.joint_carry = true;
        println!("joint update: the store carries its own estimate across replays");
    }
    if let Some(v) = arg_value(&args, "--joint-l1") {
        scfg.joint_l1 = v.parse().unwrap();
        println!("joint update: trace-step L1 weight {}", scfg.joint_l1);
    }
    if let Some(v) = arg_value(&args, "--joint-iters") {
        scfg.joint_iters = v.parse().unwrap();
        println!("joint update: {} alternations per replay", scfg.joint_iters);
    }
    let cluster_census = args.iter().any(|a| a == "--cluster-census");
    if let Some(v) = arg_value(&args, "--merge-rule") {
        scfg.merge_rule = match v.as_str() {
            "legacy" => MergeRule::Legacy,
            "split-half" => MergeRule::SplitHalf,
            other => panic!("--merge-rule: legacy|split-half, not {other}"),
        };
    }
    if let Some(v) = arg_value(&args, "--merge-guard-max-ovl") {
        scfg.merge_guard_max_ovl = v.parse().unwrap();
        scfg.merge_refit_max_ovl = scfg.merge_guard_max_ovl;
        println!("merge guards up to overlap {}", scfg.merge_guard_max_ovl);
    }
    if let Some(v) = arg_value(&args, "--merge-refit-max-ovl") {
        scfg.merge_refit_max_ovl = v.parse().unwrap();
        println!(
            "merge refit baseline up to overlap {}",
            scfg.merge_refit_max_ovl
        );
    }
    if let Some(v) = arg_value(&args, "--merge-guard-sep") {
        scfg.merge_guard_min_sep = v.parse().unwrap();
        println!(
            "merge shape gate for centres >= {} cell diameters apart",
            scfg.merge_guard_min_sep
        );
    }
    if scfg.merge_rule != MergeRule::SplitHalf {
        println!("merge rule: {:?}", scfg.merge_rule);
    }
    if scfg.refine_gate != RefineGate::SplitHalf {
        println!("refine gate: {:?}", scfg.refine_gate);
    }
    assert!(
        scfg.support_rule == SupportRule::Rings
            || (scfg.core_test == CoreTest::Off && !scfg.basin_trim),
        "--core-test and --basin-trim need --support-rule rings"
    );
    if scfg.support_rule != SupportRule::Rings {
        println!(
            "support rule: {:?}, alpha {}",
            scfg.support_rule, scfg.support_alpha
        );
    }
    if args.iter().any(|a| a == "--joint") {
        scfg.joint_neighbours = true;
    }
    if let Some(v) = arg_value(&args, "--stats-half-life") {
        scfg.stats_half_life_frames = v.parse().unwrap();
    }
    if let Some(v) = arg_value(&args, "--frames-per-tile") {
        scfg.frames_per_tile = v.parse().unwrap();
    }
    if let Some(v) = arg_value(&args, "--reservoir-max-mb") {
        scfg.reservoir_max_bytes = v.parse::<usize>().unwrap() << 20;
    }
    if let Some(v) = arg_value(&args, "--readd-window") {
        scfg.churn.readd_window_frames = v.parse().unwrap();
    }
    if let Some(v) = arg_value(&args, "--churn-frames") {
        scfg.churn.churn_frames = v.parse().unwrap();
    }
    let warm = rec.read(0, (cfg.warmup_frames as u32).min(frames));
    let mut acc = WarmupAccumulator::new(dims);
    for f in warm.chunks_exact(n_px) {
        acc.push(f).unwrap();
    }
    drop(warm);
    let cal = Calibration::from_warmup(&acc, &cfg).unwrap();
    let fov = cal.fov().mask().to_vec();
    let mut pre0 = Preprocessor::new(cal.clone(), &cfg).unwrap();
    let mut online_ff: Option<OnlineFlatField> = None;
    let drift = arg_value(&args, "--inject-drift").map(|d| Drift::parse(&d, dims, frames));
    if let Some(d) = &drift {
        let mut o = BufWriter::new(File::create(out_dir.join("drift_pattern.f32")).unwrap());
        write_f32s(&mut o, &d.p);
        let mut o = BufWriter::new(File::create(out_dir.join("drift_columns.f32")).unwrap());
        write_f32s(&mut o, &d.c);
    }
    let mut ff_log = String::from(
        "frame\toutcome\tfirst\tbins\tframes_used\tgain_sd\ttissue_sd\tresidual\tdark\tchange_median\tchange_p99\tchange_max\tsolve_s\n",
    );
    // Default: the online flat field (what the app runs) with motion, off without.
    let ff_mode = arg_value(&args, "--flat-field")
        .unwrap_or_else(|| if motion { "online" } else { "off" }.into());
    if ff_mode == "off" {
        println!("flat field: off");
    } else if ff_mode == "online" {
        assert!(motion, "--flat-field online needs --motion");
        let secs = |k: &str, d: f32| arg_value(&args, k).map_or(d, |s| s.parse().unwrap());
        let mut c = OnlineFlatFieldConfig::for_fps(fps);
        let fr = |s: f32| (s * fps).round();
        c.estimator.half_life_frames = f64::from(fr(secs("--ff-gain-half-life", GAIN_HALF_LIFE_S)));
        c.estimator.offset_half_life_frames =
            f64::from(fr(secs("--ff-offset-half-life", OFFSET_HALF_LIFE_S)));
        c.first_frames = fr(secs("--ff-first", FIRST_MAP_S)).max(1.0) as u64;
        c.refine_every_frames = fr(secs("--ff-refine", REFINE_EVERY_S)).max(1.0) as u64;
        let seed = arg_value(&args, "--ff-seed").map(|f| FlatFieldSeed {
            gain: read_f32_file(&f),
            offset: None,
            dark: 0.0,
            frames: arg_value(&args, "--ff-seed-frames").map_or(3000.0, |s| s.parse().unwrap()),
        });
        if let Some(sd) = &seed {
            FlatField {
                gain: sd.gain.clone(),
                ..FlatField::identity(dims)
            }
            .apply(&mut pre0)
            .unwrap();
        }
        println!("flat field: online {c:?}, seed {}", seed.is_some());
        online_ff = Some(OnlineFlatField::new(dims, &fov, c, seed).unwrap());
    } else if let Some(f) = Some(ff_mode.clone()) {
        let g: Vec<f32> = if let Some(k) = f.strip_prefix("auto") {
            // Dither flat field from a first pass over the opening frames.
            assert!(motion, "--flat-field auto needs --motion");
            let k: u32 = k.strip_prefix(':').map_or(3000, |s| s.parse().unwrap());
            let k = k.min(frames);
            let t0 = Instant::now();
            let mut est = DitherFlatField::new(dims, &fov, FlatFieldConfig::default()).unwrap();
            let mut pipe = Pipeline::new(&mut rec, pre0.clone(), &cal, true, 200);
            let mut out = vec![0.0f32; n_px];
            let mut s = 0u32;
            while s < k {
                let cnt = 64.min(k - s);
                let raw = rec.read(s, cnt);
                for f in raw.chunks_exact(n_px) {
                    let d = pipe.frame(f, &mut out).unwrap();
                    est.push(f, d).unwrap();
                }
                s += cnt;
            }
            let ff = match est.solve() {
                Ok(ff) => ff,
                Err(e) => {
                    println!("flat field auto: {e}; running without");
                    FlatField::identity(dims)
                }
            };
            println!(
                "flat field auto: {k} frames, {} bins ({} frames), gain sd {:.4}, tissue sd {:.4}, misfit {:.2e}, dark {:.2}; {:.1} s",
                ff.bins_used,
                ff.frames_used,
                ff.gain_sd,
                ff.tissue_sd,
                ff.residual,
                ff.dark,
                t0.elapsed().as_secs_f64()
            );
            let mut o = BufWriter::new(File::create(out_dir.join("flat_field.f32")).unwrap());
            write_f32s(&mut o, &ff.gain);
            ff.gain
        } else {
            read_f32_file(&f)
        };
        pre0.set_flat_field(Some(&g)).unwrap();
        println!("flat field {f}: {} px", g.len());
    }
    if let Some(c) = arg_value(&args, "--label-bundle") {
        assert!(mode == "real", "--label-bundle needs the real mode");
        let crop = arg_value(&args, "--crop").map_or(60, |s| s.parse().unwrap());
        label_bundle(
            &mut rec,
            &pre0,
            &cal,
            motion,
            Path::new(&c),
            crop,
            frames,
            &out_dir,
        );
        return;
    }
    let mut flat = GlowFlattener::new(cal.fov(), &cfg.flatten).unwrap();
    if let Some(run) = arg_value(&args, "--rescore") {
        let o = oracle.take().expect("--rescore needs `sim` (GT)");
        rescore(
            Path::new(&run),
            &mut rec,
            &pre0,
            &cal,
            motion,
            start,
            o,
            gt_shifts.as_deref(),
            &mut flat,
            &out_dir,
        );
        return;
    }
    println!(
        "{mode} {}: {}x{}, {t_len} frames, motion {motion}",
        input.display(),
        dims.width,
        dims.height
    );

    let mut pipe = Pipeline::new(&mut rec, pre0.clone(), &cal, motion, 200);
    // `--lookback R` / `--catchup X` (concurrent Refine, pass 1 only).
    let lb_rate: f64 = arg_value(&args, "--lookback").map_or(0.0, |s| s.parse().unwrap());
    let lb_catchup: usize = arg_value(&args, "--catchup").map_or(0, |s| s.parse().unwrap());
    let lb_double = args.iter().any(|a| a == "--catchup-double");
    let lb_newest = match arg_value(&args, "--lookback-order").as_deref() {
        None | Some("shared") => false,
        Some("newest") => true,
        Some(m) => panic!("--lookback-order: unknown mode {m}"),
    };
    // `--lookback-reservoir test|all` (experimental, default off): look-back
    // frames are also offered to the reservoir (`LookbackReservoir`);
    // `--lookback-reservoir-share S` offers that share of them.
    let lb_res = match arg_value(&args, "--lookback-reservoir").as_deref() {
        None | Some("off") => LookbackReservoir::Off,
        Some("test") => LookbackReservoir::Test,
        Some("all") => LookbackReservoir::All,
        Some(m) => panic!("--lookback-reservoir: unknown mode {m} (off | test | all)"),
    };
    let lb_res_share: f32 =
        arg_value(&args, "--lookback-reservoir-share").map_or(1.0, |s| s.parse().unwrap());
    assert!(
        lb_res_share > 0.0 && lb_res_share <= 1.0,
        "--lookback-reservoir-share must be in (0, 1]"
    );
    if lb_res != LookbackReservoir::Off {
        println!("lookback reservoir: {lb_res:?}, share {lb_res_share}");
    }
    let cs_cfg = CsCfg::parse(&args);
    let lb_ms: f64 = arg_value(&args, "--lb-ms").map_or(10.0, |s| s.parse().unwrap());
    // `--lb-gate` (with `--offered-fps` and `--csettle`): need-driven
    // look-back through the modelled look-back worker, in requests of at
    // most `--lb-take` frames (the app's `LOOKBACK.takeMax`).
    let lb_gate = args.iter().any(|a| a == "--lb-gate");
    let lb_take: usize = arg_value(&args, "--lb-take").map_or(16, |s| s.parse().unwrap());
    let mut lb_fwd_seen: u64 = 0;
    let mut lb_drain: usize = tail.drain;
    let lb_frames: usize =
        arg_value(&args, "--lookback-frames").map_or(3000, |s| s.parse().unwrap());
    assert!(lb_rate >= 0.0, "--lookback must be >= 0");
    let lb_target: f64 = arg_value(&args, "--lookback-target").map_or(0.0, |s| s.parse().unwrap());
    assert!(
        lb_target >= 0.0 && (lb_target == 0.0 || lb_rate > 0.0),
        "--lookback-target needs --lookback R"
    );
    let noise_dump = args.iter().any(|a| a == "--noise-dump") || lb_target > 0.0;
    let settle_src = settle_source(&args).unwrap_or_else(|m| panic!("{m}"));
    let mut lookback = lookback_wanted(lb_rate, lb_catchup, tail.settle.frames).then(|| {
        LookBack::new(
            lb_rate, lb_frames, lb_newest, lb_catchup, lb_double, lb_target, n_px,
        )
    });
    assert!(
        cs_cfg.is_none() || lookback.is_some(),
        "--csettle needs --lookback"
    );
    if let Some(l) = lookback.as_mut() {
        if let Some(c) = &cs_cfg {
            l.cs_sched = SettleSched::new(c.share, c.chunk);
            l.cs = cs_cfg.clone();
        }
        l.drain_rate = tail.drain_rate;
        l.settle_all = tail.settle_all;
        l.settle = tail.settle.clone();
        if let SettleSource::Factors(d) = &settle_src {
            l.settle_src = Some(FactorFrames::new(d, FACTOR_WINDOW));
        }
    }
    if lookback.is_some() && lb_rate == 0.0 && lb_catchup == 0 {
        println!("lookback: off (settle only)");
    } else if lookback.is_some() {
        println!(
            "lookback: rate {lb_rate} frames per Discover frame, at most {lb_frames} per job, catchup every {lb_catchup} frames{}, noise target {lb_target}",
            if lb_double { " (doubling)" } else { "" }
        );
    }
    pipe.keep_records = passes > 1 || lookback.is_some();
    pipe.null_on = session_fix.register && !sessions.is_empty();
    pipe.null_ref = session_ref_frames;
    pipe.null_fit = session_fit_frames;
    // Pass 1's rigid shift of every frame (motion runs).
    let mut rigid: Vec<(f32, f32)> = Vec::new();
    let empty = LibraryBuilder::new(dims)
        .fov(fov.clone())
        .background(scfg.background.clone())
        .build(&mut flat)
        .unwrap();
    let mut engine = TraceEngine::new(Arc::new(empty), SolverConfig::default()).unwrap();
    let mut diverge = std::env::var_os("CALA_DIVERGE_DIR").map(|d| DivergeProbe::new(d.into()));
    let mut slow: Option<SlowLoop> = None;
    let mut timed: Option<Timed> = None;
    let mut timed_noise: Option<Vec<f32>> = None;
    // `--via-jobs`: every visit through the parallel protocol, one at a time.
    let mut via: Option<VisitRunner> = None;
    let mut qc: Option<QcMonitor> = None;
    let mut gt: Option<Gt> = None;
    let mut own: Option<HashMap<u64, (Vec<usize>, u32)>> = None;
    let mut hist = History::default();
    let mut y = vec![0.0f32; n_px];
    let mut cells_out = qc_header();
    let mut global = String::new();
    for f in GlobalQc::FIELDS.iter().take(GlobalQc::FIELDS.len() - 1) {
        let _ = write!(global, "{f}\t");
    }
    global.push_str("gt_precision\tgt_recall\tgt_median_true_r\t");
    global.push_str("adds_new\tadds_readd\tchurned\tchurned_readd\testablished_removals\tslow_adds\tslow_merges\tslow_deletes\tslow_splits\tslow_frames\tslow_cells\tforwarded_frames\tdropped_frames\tslow_visits\tvisit_jobs\tvirtual_ms\tho_frames\tho_gain_per_frame\tho_cells\tho_placebos\tho_mu\tho_penalty\tho_score\tho_penalty_ci\tho_signal\tho_score_frac\n");
    // Batches waiting to be forwarded: (frame, traces, library, recording frame).
    let mut pending: Vec<(Vec<f32>, FrameTraces, Arc<Library>, usize)> = Vec::new();
    let (mut n_batches, mut n_fwd, mut fwd_frames) = (0u64, 0u64, 0u64);
    let mut recent_scores: std::collections::VecDeque<f32> = std::collections::VecDeque::new();
    let mut tokens = 1.0f64;
    // Recording frame of each slow-loop frame.
    let mut slow_rec: Vec<u32> = Vec::new();
    // `--offered-fps`: recording frames forwarded to the slow loop so far.
    let mut slow_seen: usize = 0;
    let mut add_log = String::from("frame\trecording_frame\tid\tclass\tcy\tcx\tcos\tdist\tsince\n");
    let mut rem_log = String::from(
        "frame\trecording_frame\tid\tkind\tcy\tcx\tborn\tborn_recording\tclass\tchurned\n",
    );
    let mut edit_log = String::from("frame\trecording_frame\tkind\tid\tother\tcy\tcx\tmargin\n");
    let mut test_log = String::from("frame\trecording_frame\tkind\tid\tother\taccepted\tz\n");
    let mut fp_hist: Option<BufWriter<File>> = churn_log.then(|| {
        let mut f = BufWriter::new(File::create(out_dir.join("fp_history.bin")).unwrap());
        f.write_all(b"CALAFH01").unwrap();
        f
    });
    let mut qc_ms: Vec<f64> = Vec::with_capacity(t_len);
    // Wall time of the slow loop's `observe` (the per-frame part of the
    // slow worker), per pass.
    let mut slow_obs_s = 0.0f64;
    let mut slow_step_s = 0.0f64;
    let mut slow_cost = String::from("pass\tframes\tobserve_ms_per_frame\tstep_ms_per_frame\tslow_ms_per_frame\twork_stats_per_frame\twork_refine_per_frame\twork_per_frame\n");
    let mut work_prev = (0u64, 0u64, 0u64);
    let mut summary = Vec::new();
    let mut ho: Option<HeldOutScore> = None;
    let mut ho_cells_out = String::from("frame\tslot\tid\tho_marginal\tho_frames\tho_marginal_z\n");
    let mut conv = calab_cala::qc::convergence::Tracker::new();
    let mut conv_out = calab_cala::qc::convergence::header();
    let lib_at_frames: Vec<usize> = lib_at
        .iter()
        .map(|f| ((f * t_len as f64).round() as usize).clamp(1, t_len.saturating_sub(1).max(1)))
        .collect();
    let t_all = Instant::now();
    let mut passes_out = String::from(
        "pass\tframe\tcells\tslow_cells\tadds\tmerges\tdeletes\tsplits\tslow_frames\twall_s\n",
    );
    // `--factors-out`: the compressed history of pass 1.
    let factors_out: Option<PathBuf> = arg_value(&args, "--factors-out").map(PathBuf::from);
    // `--factors-tiling plain|offset` (default plain): how the dump cuts the frame.
    let factors_tiling = arg_value(&args, "--factors-tiling").map_or(Tiling::Plain, |s| {
        Tiling::parse(&s).unwrap_or_else(|| panic!("--factors-tiling: plain or offset, not {s:?}"))
    });
    assert!(
        factors_out.is_some() || arg_value(&args, "--factors-tiling").is_none(),
        "--factors-tiling needs --factors-out DIR"
    );
    let mut factors = factors_out
        .as_deref()
        .map(|d| FactorDump::new(d, dims, factors_tiling));
    for pass in 0.. {
        // `passes` can change at a branch point (the child applies its tail).
        if pass >= passes {
            break;
        }
        // Virtual frame of this pass's recording frame 0.
        let off = pass * t_len;
        if pass > 0 {
            if let Some(sl) = slow.as_mut() {
                // A refine replay is the app's Refine stage: the stage
                // before it ends with its final library (the slow loop
                // publishes what is pending) and the replay solves with it
                // from frame 0. (`all`, Discover again, keeps the old
                // behaviour: no publish at the wrap.)
                if later_scope != EditScope::All && timed.is_none() {
                    engine.set_library(sl.finalize().unwrap()).unwrap();
                    if wrap_libs {
                        write_library(
                            &out_dir,
                            &format!("_wrap{pass}"),
                            &engine.library().clone(),
                            dims,
                            gt.as_ref(),
                            ho.as_ref(),
                            Some(&*sl),
                        );
                        if noise_dump {
                            write_noise(
                                &out_dir.join(format!("fp_noise_wrap{pass}.tsv")),
                                engine.library(),
                                sl,
                            );
                        }
                    }
                }
                sl.set_edit_scope(later_scope);
            }
        }
        let t_pass = Instant::now();
        let mut s = 0u32;
        while s < frames {
            let cnt = 64.min(frames - s);
            let mut raw = rec.read(s, cnt);
            if let Some(d) = &drift {
                for (k, f) in raw.chunks_exact_mut(n_px).enumerate() {
                    d.apply(f, s as usize + k);
                }
            }
            for (k, f) in raw.chunks_exact(n_px).enumerate() {
                // `t_rec`: recording frame; `t`: virtual frame (continues across
                // passes).
                let t_rec = s as usize + k;
                let t = off + t_rec;
                let last = t_rec + 1 == t_len;
                if pass == 0 && probe_bg_reset == Some(t_rec) {
                    let cfg = *pipe.pre.background().config();
                    *pipe.pre.background_mut() =
                        calab_cala::preprocess::background::RunningMinBackground::new(dims, &cfg)
                            .unwrap();
                    println!("probe: background floor reset before frame {t_rec}");
                }
                if pass == 0 && session_fix.any() {
                    pipe.collect_reference = session_fix.register
                        && sessions
                            .iter()
                            .any(|&b| t_rec < b && t_rec + session_ref_frames >= b);
                    if sessions.contains(&t_rec) {
                        let end = sessions
                            .iter()
                            .copied()
                            .filter(|&b| b > t_rec)
                            .min()
                            .unwrap_or(t_len)
                            .min(t_len);
                        let n = session_fit_frames.min(end - t_rec);
                        let mut raws = rec.read(t_rec as u32, n as u32);
                        if let Some(d) = &drift {
                            for (k, fr) in raws.chunks_exact_mut(n_px).enumerate() {
                                d.apply(fr, t_rec + k);
                            }
                        }
                        let _ = write!(session_log, "{t_rec}");
                        // A null block never spans a boundary.
                        pipe.null_block.clear();
                        pipe.null_moving.clear();
                        if session_fix.flicker {
                            pipe.pre.begin_session_front();
                        }
                        if session_fix.register {
                            let mut fronts = vec![0.0f32; raws.len()];
                            let none = calab_cala::preprocess::flicker::FlickerRecord::default();
                            for (r, o) in raws.chunks_exact(n_px).zip(fronts.chunks_exact_mut(n_px))
                            {
                                pipe.pre.front_replay(r, o, &none).unwrap();
                            }
                            let moving = calab_cala::motion::session::frames_mean(&fronts, n_px);
                            let est = pipe.reference.mean().map(|r| {
                                calab_cala::motion::session::estimate(
                                    &r,
                                    &moving,
                                    dims.height,
                                    dims.width,
                                    &pipe.fov_mask,
                                    &calab_cala::motion::SessionAlignConfig::default(),
                                )
                                .unwrap()
                            });
                            pipe.reference.clear();
                            let warp = est.filter(|e| !e.transform.is_identity()).map(|e| {
                                calab_cala::motion::SessionWarp::new(
                                    dims.height,
                                    dims.width,
                                    e.transform,
                                )
                                .unwrap()
                            });
                            pipe.set_session_warp(t_rec, warp);
                            match est {
                                Some(e) => {
                                    let _ = write!(
                                        session_log,
                                        "\t{:.4}\t{:.3}\t{:.3}\t{:.4}\t{:.4}\t{:.4}\t{:.3}\t{:.3}\t{:.4}\t{}\t{}",
                                        e.fitted.rotation_deg,
                                        e.fitted.dy,
                                        e.fitted.dx,
                                        e.ncc,
                                        e.ncc_unrotated,
                                        e.transform.rotation_deg,
                                        e.transform.dy,
                                        e.transform.dx,
                                        e.chance_ncc,
                                        u8::from(e.pinned_rotation),
                                        u8::from(e.pinned_shift)
                                    );
                                    println!("session at frame {t_rec}: {e:?}");
                                }
                                None => session_log.push_str("\t\t\t\t\t\t\t\t\t\t\t"),
                            }
                        } else {
                            session_log.push_str("\t\t\t\t\t\t\t\t\t\t\t");
                        }
                        if session_fix.floor || session_fix.noise {
                            let cfg = calab_cala::preprocess::session::SessionBackConfig {
                                rescale_floor: session_fix.floor,
                                rescale_noise: session_fix.noise,
                            };
                            let fit = pipe.prefetch_session(&raws, &cfg);
                            println!("session at frame {t_rec}: {fit:?}");
                            let _ = writeln!(
                                session_log,
                                "\t{:.5}\t{:.4}\t{:.3}\t{:.4}",
                                fit.floor.gain,
                                fit.floor.offset,
                                fit.floor.kept_fraction,
                                fit.noise_ratio
                            );
                        } else {
                            session_log.push_str("\t\t\t\t\n");
                        }
                    }
                }
                let shift = if pass == 0 {
                    pipe.frame(f, &mut y)
                } else {
                    pipe.frame_replay(f, &mut y, t_rec)
                };
                if let Some(v) = pipe.null_last.take() {
                    let _ = writeln!(null_log, "{t_rec}\t{v:.5}");
                }
                // A session warp's translation is part of the frame's
                // registration (scoring, flat field); with a rotation the
                // flat field skips the session's frames (it models shifts).
                let shift_total = match (shift, pipe.warp_at(t_rec).is_some()) {
                    (Some(d), true) => {
                        let ss = pipe.session_shift_at(t_rec);
                        Some((d.0 + ss.0, d.1 + ss.1))
                    }
                    (d, _) => d,
                };
                let ff_ok = !pipe
                    .warp_at(t_rec)
                    .is_some_and(|w| !w.transform().is_translation());
                if let (Some(d), 0) = (shift_total, pass) {
                    rigid.push(d);
                }
                // The online flat field learns in pass 1 only; its last map
                // stays applied.
                if let (Some(o), Some(d), 0, true) = (online_ff.as_mut(), shift_total, pass, ff_ok)
                {
                    o.push(f, d).unwrap();
                    if o.due() {
                        let t0 = Instant::now();
                        let out = o.refine();
                        let dt = t0.elapsed().as_secs_f64();
                        match &out {
                            RefineOutcome::Updated(u) => {
                                let ff = o.current().unwrap();
                                ff.apply(&mut pipe.pre).unwrap();
                                if let Some((_, p)) =
                                    lookback.as_mut().and_then(|l| l.block.as_mut())
                                {
                                    ff.apply(p).unwrap();
                                }
                                let _ = writeln!(
                                ff_log,
                                "{t}\tupdated\t{}\t{}\t{}\t{:.5}\t{:.5}\t{:.3e}\t{:.3}\t{:.4}\t{:.4}\t{:.4}\t{dt:.2}",
                                u8::from(u.first),
                                ff.bins_used,
                                ff.frames_used,
                                ff.gain_sd,
                                ff.tissue_sd,
                                ff.residual,
                                ff.dark,
                                u.change_median,
                                u.change_p99,
                                u.change_max
                            );
                                if u.first {
                                    println!(
                                    "flat field: first map at frame {t} ({} bins, gain sd {:.4}, change p99 {:.2} sigma; {dt:.1} s)",
                                    ff.bins_used, ff.gain_sd, u.change_p99
                                );
                                }
                            }
                            RefineOutcome::Skipped(m) => {
                                let _ = writeln!(
                                    ff_log,
                                    "{t}\tskipped: {m}\t\t\t\t\t\t\t\t\t\t\t{dt:.2}"
                                );
                            }
                        }
                    }
                }
                if t == start {
                    let noise = pipe.pre.noise().sigma();
                    if let (Some(o), Some(m), "auto") =
                        (oracle.as_mut(), &gt_shifts, gt_offset.as_str())
                    {
                        // Frames 0..=start: the offset is the template's
                        // position, fixed from the warm-up on.
                        gt_offset_applied = FrameOffset::estimate(&rigid, m);
                        o.translate(&gt_offset_applied);
                        let g = &gt_offset_applied;
                        println!(
                            "GT offset into the registered frame: ({:.3}, {:.3}) px from {} frames (sd {:.3}, {:.3})",
                            g.dy, g.dx, g.n, g.sd_dy, g.sd_dx
                        );
                    }
                    if let Some(o) = &oracle {
                        let (g, _) = build_gt(o, dims, &fov, &noise, &mut flat);
                        let mut t = String::from("gt\tcy\tcx\tdetectable\tsnr\tunit\n");
                        for j in 0..g.kept.len() {
                            let _ = writeln!(
                                t,
                                "{j}\t{:.2}\t{:.2}\t{}\t{:.3}\t{}",
                                g.centers[j].0,
                                g.centers[j].1,
                                u8::from(g.detectable[j]),
                                g.snr[j],
                                g.kept[j]
                            );
                        }
                        std::fs::write(out_dir.join("gt.tsv"), t).unwrap();
                        #[cfg(feature = "diagnostics")]
                        calab_cala::discover::merge_log_set_gt(g.cols.clone(), dims.width);
                        if oracle_mode {
                            let (lib, m) =
                                oracle_library(o, &g, dims, &fov, &noise, &mut flat, frac, seed);
                            println!("oracle library: {} cells", lib.len());
                            engine.set_library(Arc::new(lib)).unwrap();
                            own = Some(m);
                        }
                        gt = Some(g);
                    }
                    if let Some(path) = &fixed_lib {
                        let lib = read_footprints(path, dims, &fov, &noise, &scfg, &mut flat);
                        println!("fixed library: {} cells from {}", lib.len(), path.display());
                        engine.set_library(Arc::new(lib)).unwrap();
                    }
                    if heldout_on {
                        let hcfg = HeldOutConfig {
                            cell_diameter_px: scfg.cell_diameter_px,
                            seed: scfg.seed ^ 0x5eed,
                            ..HeldOutConfig::default()
                        };
                        ho = Some(
                            HeldOutScore::new(dims, fov.clone(), noise.clone(), hcfg).unwrap(),
                        );
                    }
                    if !oracle_mode && fixed_lib.is_none() {
                        let mk = || {
                            SlowLoop::new(
                                dims,
                                fov.clone(),
                                noise.clone(),
                                flat.clone(),
                                scfg.clone(),
                            )
                            .unwrap()
                        };
                        slow = Some(mk());
                        if let Some(s) = slow.as_mut() {
                            s.set_lookback_reservoir(lb_res, lb_res_share);
                            if let Some(c) = &cs_cfg {
                                s.enable_settle(c.quiet);
                            }
                        }
                        if let Some(s) = &slow {
                            let p = s.reservoir_plan();
                            println!(
                            "reservoir: {} frames/tile ({} event + {} random, target {}), capacity {:.0} MB of {:.0} MB",
                            p.frames_per_tile,
                            p.event_slots,
                            p.random_slots,
                            p.target_frames_per_tile,
                            p.capacity_bytes as f64 / 1048576.0,
                            p.max_bytes as f64 / 1048576.0
                        );
                            if let Some(w) = p.warning() {
                                println!("reservoir warning: {w}");
                            }
                        }
                        if via_jobs {
                            via = Some(VisitRunner::new(mk()));
                        }
                        if let Some(fps) = offered_fps {
                            let runners =
                                (0..visit_workers).map(|_| VisitRunner::new(mk())).collect();
                            timed = Some(Timed::new(
                                fps,
                                units_per_ms,
                                observe_ms,
                                job_ms,
                                pool,
                                budget,
                                runners,
                                depth,
                            ));
                            if let (Some(c), Some(tm)) = (&cs_cfg, timed.as_mut()) {
                                if visit_workers > 0 {
                                    assert!(
                                        c.share == 0.0
                                            || matches!(c.mode, CsMode::Stats | CsMode::Frames),
                                        "--csettle with --visit-workers needs --csettle-mode stats or frames"
                                    );
                                    assert!(c.share < 1.0, "--csettle with --visit-workers: S < 1");
                                    tm.cs_rate = c.share / (1.0 - c.share);
                                    tm.cs_chunk = c.chunk;
                                    tm.cs_answer_scale = arg_value(&args, "--cs-answer-scale")
                                        .map_or(1.0, |s| s.parse().unwrap());
                                    tm.cs_yield = arg_value(&args, "--csettle-yield")
                                        .map_or(0, |s| s.parse().unwrap());
                                    assert!(
                                        tm.cs_yield == 0 || c.chunk.is_multiple_of(tm.cs_yield),
                                        "--csettle-yield must divide --csettle-chunk"
                                    );
                                    if let Some(l) = lookback.as_mut() {
                                        l.cs_jobs = c.share > 0.0;
                                        l.cs_step = tm.cs_yield;
                                    }
                                } else {
                                    tm.cs_share = c.share;
                                }
                                tm.lb_ms = lb_ms;
                                tm.cs_guard = arg_value(&args, "--csettle-guard")
                                    .map_or(0.0, |s| s.parse().unwrap());
                                tm.batch_ms = batch_n as f64 * 1e3 / fps;
                            }
                            if let Some(tm) = timed.as_mut() {
                                if let Some(v) = arg_value(&args, "--visit-units-per-ms") {
                                    tm.visit_units_per_ms = v.parse().unwrap();
                                }
                                tm.lb_gate = lb_gate;
                                if let Some(v) = arg_value(&args, "--lb-ms-per-cell") {
                                    tm.lb_ms_cell = v.parse().unwrap();
                                }
                                if let Some(v) = arg_value(&args, "--offered-burst") {
                                    tm.burst = v.parse().unwrap();
                                }
                                if let Some(v) = arg_value(&args, "--ack-lag-ms") {
                                    tm.ack_lag = v.parse().unwrap();
                                }
                                tm.result_first = args.iter().any(|a| a == "--result-first");
                                if let Some(v) = arg_value(&args, "--owner-load") {
                                    let (ms, period) =
                                        v.split_once(':').expect("--owner-load MS:PERIOD");
                                    let period: f64 = period.parse().unwrap();
                                    assert!(period > 0.0, "--owner-load: PERIOD > 0");
                                    tm.load = Some((ms.parse().unwrap(), period));
                                    tm.load_next = period;
                                }
                                if args.iter().any(|a| a == "--visit-diag") && visit_workers > 0 {
                                    tm.diag =
                                        Some(VisitDiag::new(slow.as_ref().unwrap(), visit_workers));
                                }
                            }
                        }
                    }
                    qc = Some(
                        QcMonitor::new(dims, fov.clone(), noise, QcConfig::default()).unwrap(),
                    );
                }
                if let (Some(tm), Some(sl)) = (timed.as_mut(), slow.as_mut()) {
                    let now = tm.at(t);
                    let mut unit = |sl: &mut SlowLoop| match (lookback.as_mut(), pass) {
                        (Some(l), 0) => l.cs_unit(
                            slow_seen,
                            budget,
                            start,
                            &mut rec,
                            drift.as_ref(),
                            &mut pipe,
                            &engine,
                            sl,
                            n_px,
                        ),
                        _ => None,
                    };
                    tm.advance(now, sl, &mut slow_rec, &mut unit);
                    if let Some(l) = tm.library(now) {
                        engine.set_library(l).unwrap();
                    }
                }
                if let (Some(fd), 0) = (factors.as_mut(), pass) {
                    fd.push(&y);
                }
                let warm = diverge.as_ref().map(|_| engine.state());
                let tr = engine.process(&y).unwrap();
                if let (Some(dv), Some(warm)) = (diverge.as_mut(), warm) {
                    dv.frame(t, &y, &engine, &warm, &tr);
                }
                let Some(q) = qc.as_mut() else { continue };
                let lib = engine.library().clone();
                if let Some(h) = ho.as_mut() {
                    if t.is_multiple_of(200) {
                        h.set_noise(pipe.pre.noise().sigma()).unwrap();
                    }
                    // The slow-loop index this frame will get when forwarded
                    // (exact with every batch forwarded; `--slow-keep` < 1 and
                    // `--offered-fps` drop batches, which shifts it).
                    let idx = match (&slow, &fixed_lib) {
                        (Some(sl), _) => Some(sl.frames() + pending.len() as u64),
                        (None, Some(_)) => Some((t - start) as u64),
                        _ => None,
                    };
                    if idx.is_some_and(|i| scfg.is_test(i)) {
                        h.frame(t as u64, &y, &lib, &tr, &mut engine, &mut flat)
                            .unwrap();
                    }
                }
                hist.push(t, lib.ids(), &tr.traces);
                if let (Some(b), 0) = (boundary.as_mut(), pass) {
                    b.frame(t, &pipe, lib.ids(), &tr);
                }
                let a = Instant::now();
                q.observe_shifted(&y, &lib, &tr, shift).unwrap();
                qc_ms.push(a.elapsed().as_secs_f64() * 1e3);
                if t.is_multiple_of(200) {
                    q.set_noise(pipe.pre.noise().sigma()).unwrap();
                }
                if let (Some(tm), Some(sl)) = (timed.as_mut(), slow.as_mut()) {
                    if t.is_multiple_of(200) {
                        timed_noise = Some(pipe.pre.noise().sigma());
                    }
                    let mut fwd_tr = tr.clone();
                    if no_bg_levels {
                        fwd_tr.background.clear();
                    }
                    pending.push((y.clone(), fwd_tr, lib.clone(), t));
                    if pending.len() >= batch_n || last {
                        n_batches += 1;
                        let now = tm.at(t + 1);
                        let n = pending.len() as u64;
                        if tm.has_buffer(now) {
                            if let Some(l) = lookback.as_mut() {
                                // The slow-loop index each frame will get.
                                if pass == 0 {
                                    for (j, p) in pending.iter().enumerate() {
                                        let i = p.3 - start;
                                        if l.slow_of.len() <= i {
                                            l.slow_of.resize(i + 1, u32::MAX);
                                        }
                                        l.slow_of[i] = (fwd_frames as usize + j) as u32;
                                    }
                                    slow_seen = t + 1;
                                }
                            }
                            let batch = (std::mem::take(&mut pending), timed_noise.take());
                            tm.forward(now, batch);
                            n_fwd += 1;
                            fwd_frames += n;
                        } else {
                            pending.clear();
                            tm.dropped += n;
                        }
                        tm.advance(now, sl, &mut slow_rec, &mut |_| None);
                        let rf = |f: u64| slow_rec.get(f as usize).copied().unwrap_or(t as u32);
                        write_logs(sl, &rf, &mut add_log, &mut rem_log);
                        if churn_log {
                            write_churn_logs(sl, &rf, &mut edit_log, &mut test_log);
                        }
                    }
                } else if let Some(sl) = slow.as_mut() {
                    if t.is_multiple_of(200) {
                        sl.set_noise(pipe.pre.noise().sigma()).unwrap();
                        if let Some(r) = via.as_mut() {
                            r.set_noise(pipe.pre.noise().sigma()).unwrap();
                        }
                    }
                    let mut fwd_tr = tr.clone();
                    if no_bg_levels {
                        fwd_tr.background.clear();
                    }
                    pending.push((y.clone(), fwd_tr, lib.clone(), t));
                    if pending.len() >= batch_n || last {
                        n_batches += 1;
                        let forward = if keep >= 1.0 {
                            true
                        } else if score_mode {
                            // Residual excursions above 4 σ, per tile the
                            // largest in the batch, summed over tiles.
                            let mut best: Vec<f32> = Vec::new();
                            for (yy, tt, ll, _) in &pending {
                                let sc = sl.tile_scores(yy, ll, tt).unwrap();
                                if best.is_empty() {
                                    best = sc;
                                } else {
                                    for (b, v) in best.iter_mut().zip(sc) {
                                        *b = b.max(v);
                                    }
                                }
                            }
                            let score: f32 = best.iter().map(|v| (v - 4.0).max(0.0)).sum();
                            let mut v: Vec<f32> = recent_scores.iter().copied().collect();
                            let busy = if v.len() < 16 {
                                true
                            } else {
                                v.sort_by(f32::total_cmp);
                                let k = ((1.0 - keep) * (v.len() - 1) as f64).round() as usize;
                                score > v[k] || score >= v[v.len() - 1]
                            };
                            // Capacity: `keep` batches' worth per batch, at most
                            // 4 banked. A busy batch goes whenever there is
                            // capacity; a quiet one only when capacity would
                            // otherwise go unused.
                            tokens = (tokens + keep).min(4.0);
                            let fwd = tokens >= 1.0 && (busy || tokens >= 3.0);
                            if fwd {
                                tokens -= 1.0;
                            }
                            recent_scores.push_back(score);
                            if recent_scores.len() > 256 {
                                recent_scores.pop_front();
                            }
                            fwd
                        } else {
                            // Evenly spaced: the k-th batch goes when the share
                            // forwarded so far falls behind `keep`.
                            (n_fwd as f64) < keep * n_batches as f64
                        };
                        if forward {
                            n_fwd += 1;
                        }
                        for (yy, tt, ll, tf) in pending.drain(..) {
                            if forward {
                                let a = Instant::now();
                                sl.observe(&yy, &ll, &tt).unwrap();
                                slow_obs_s += a.elapsed().as_secs_f64();
                                slow_rec.push(tf as u32);
                                fwd_frames += 1;
                            } else if !drop_step {
                                continue;
                            }
                            let a = Instant::now();
                            let published = match via.as_mut() {
                                Some(r) => sl.step_via(budget, r).unwrap(),
                                None => sl.step(budget).unwrap(),
                            };
                            slow_step_s += a.elapsed().as_secs_f64();
                            if let Some(l) = published {
                                engine.set_library(l).unwrap();
                            }
                        }
                        let rf = |f: u64| slow_rec.get(f as usize).copied().unwrap_or(t as u32);
                        write_logs(sl, &rf, &mut add_log, &mut rem_log);
                        if churn_log {
                            write_churn_logs(sl, &rf, &mut edit_log, &mut test_log);
                        }
                    }
                }
                if let (Some(lbk), Some(sl), 0) = (lookback.as_mut(), slow.as_mut(), pass) {
                    // On the virtual clock (`--offered-fps`) the look-back
                    // runs only with the concurrent settle (before it the
                    // combination ran no look-back at all), and the owner
                    // is charged the frames' slow-loop work.
                    let w0 = sl.work();
                    let lb0 = lbk.frames;
                    if let (true, Some(tm), true) = (lb_gate, timed.as_mut(), lbk.cs.is_some()) {
                        // Budget per frame forwarded to the slow loop, as
                        // `lookbackNote(seen, observed)`.
                        let now = tm.at(t + 1);
                        let add = lbk.rate * (fwd_frames - lb_fwd_seen) as f64;
                        lb_fwd_seen = fwd_frames;
                        let max = if tm.need_may_ask(now) { lb_take } else { 0 };
                        let n = lbk.after_frame_gated(
                            t_rec,
                            t_len,
                            add,
                            max,
                            start,
                            &mut rec,
                            drift.as_ref(),
                            &mut pipe,
                            &engine,
                            sl,
                            n_px,
                        );
                        if n > 0 {
                            tm.cs_turn = true;
                            tm.need_frames += n;
                            tm.need_reqs += 1;
                        }
                        tm.need_pending = lbk.need_pending();
                    } else if timed.is_none() || lbk.cs.is_some() {
                        lbk.after_frame(
                            t_rec,
                            t_len,
                            start,
                            &mut rec,
                            drift.as_ref(),
                            &mut pipe,
                            &engine,
                            sl,
                            n_px,
                        );
                    }
                    match timed.as_mut() {
                        Some(tm) if lb_gate && lbk.cs.is_some() => {
                            let n = lbk.frames - lb0;
                            if n > 0 {
                                tm.need_answer(tm.at(t + 1), n, sl.work() - w0);
                            }
                        }
                        Some(tm) => {
                            let now = tm.at(t + 1);
                            tm.lb_note(now, lbk.frames - lb0);
                            tm.charge(now, sl.work() - w0);
                        }
                        None => lbk.cs_after_frame(
                            t_rec,
                            t_len,
                            budget,
                            start,
                            &mut rec,
                            drift.as_ref(),
                            &mut pipe,
                            &engine,
                            sl,
                            n_px,
                        ),
                    }
                }
                // The stream ended: the slow worker finishes what it has
                // before any end-of-stream settle.
                if let (true, 0, Some(tm), Some(sl), Some(lbk)) =
                    (last, pass, timed.as_mut(), slow.as_mut(), lookback.as_ref())
                {
                    if lbk.cs.is_some() {
                        tm.ending = true;
                        tm.advance(f64::INFINITY, sl, &mut slow_rec, &mut |_| None);
                        engine.set_library(sl.finalize().unwrap()).unwrap();
                    }
                }
                // Branch point `discover`: Discover's last frame is done, the
                // look-back drain has not started.
                if let (true, 0, Some(b)) = (last, pass, &branching) {
                    if b.point == BranchPoint::Discover {
                        if let Some(c) = b.fork(&args, &out_dir) {
                            c.apply(
                                &mut tail,
                                &mut out_dir,
                                lookback.as_mut(),
                                &mut passes,
                                &mut later_scope,
                                &mut lb_drain,
                            );
                        }
                    }
                }
                // Discover's factors are complete before the drain and the
                // settle (`--settle-source factors` reads every window).
                if let (true, 0, Some(fd)) = (last, pass, factors.as_mut()) {
                    fd.finish();
                }
                if let (Some(lbk), Some(sl), 0, true) = (
                    lookback.as_mut(),
                    slow.as_mut(),
                    pass,
                    timed.is_none() || cs_cfg.is_some(),
                ) {
                    if last && lb_drain > 0 {
                        let (st, fr) = lbk.drain(
                            lb_drain,
                            budget,
                            start,
                            &mut rec,
                            drift.as_ref(),
                            &mut pipe,
                            &mut engine,
                            sl,
                            n_px,
                        );
                        println!(
                            "lookback drain: {st} steps, {fr} frames, {:.1} s",
                            lbk.drain_wall_s
                        );
                    }
                }
                // Branch point `drain`: the drain (if any) is done too.
                if let (true, 0, Some(b)) = (last, pass, &branching) {
                    if b.point == BranchPoint::Drain {
                        if let Some(c) = b.fork(&args, &out_dir) {
                            c.apply(
                                &mut tail,
                                &mut out_dir,
                                lookback.as_mut(),
                                &mut passes,
                                &mut later_scope,
                                &mut lb_drain,
                            );
                        }
                    }
                }
                // The end-of-Discover settle (`--settle-frames`): after the
                // drain and after the `drain` branch point, so a branch can
                // set it.
                if let (Some(lbk), Some(sl), 0, true) = (
                    lookback.as_mut(),
                    slow.as_mut(),
                    pass,
                    timed.is_none() || cs_cfg.is_some(),
                ) {
                    if last && lbk.settle.frames > 0 {
                        lbk.settle(
                            t_len,
                            budget,
                            start,
                            &mut rec,
                            drift.as_ref(),
                            &mut pipe,
                            &mut engine,
                            sl,
                            n_px,
                        );
                        std::fs::write(out_dir.join("settle_checks.tsv"), &lbk.settle_out).unwrap();
                        for (k, l) in std::mem::take(&mut lbk.settle_libs) {
                            write_library(
                                &out_dir,
                                &format!("_settle{k}"),
                                &l,
                                dims,
                                gt.as_ref(),
                                ho.as_ref(),
                                Some(&*sl),
                            );
                        }
                    }
                }
                let t_end = t + 1;
                let cp = t_end.is_multiple_of(every) || last;
                if pass == 0 && !last && lib_at_frames.contains(&t_end) {
                    write_library(
                        &out_dir,
                        &format!("_t{t_end}"),
                        &engine.library().clone(),
                        dims,
                        gt.as_ref(),
                        ho.as_ref(),
                        slow.as_ref(),
                    );
                }
                let ho_win: Option<HeldOutWindow> = if cp {
                    ho.as_mut().map(|h| {
                        for (sl_, c) in h.cells(lib.ids()).iter().enumerate() {
                            let _ = writeln!(
                                ho_cells_out,
                                "{t_end}\t{sl_}\t{}\t{:.4}\t{}\t{:.3}",
                                c.id, c.marginal, c.frames, c.marginal_z
                            );
                        }
                        h.take_window()
                    })
                } else {
                    None
                };
                if cp {
                    if let (Some(g), Some(o)) = (&gt, &oracle) {
                        label_rows(
                            t_end,
                            off,
                            &lib,
                            q,
                            &hist,
                            g,
                            o,
                            dims,
                            own.as_ref(),
                            &mut cells_out,
                            &mut summary,
                        );
                    } else {
                        // No GT: metrics only.
                        for (sl_, c) in q.cells().enumerate() {
                            let _ = write!(
                            cells_out,
                            "{t_end}\t{sl_}\t-1\t-1\t-1\tnan\t-1\tnan\tnan\tnan\tnan\tnan\tnan\t0\t-\tnan"
                        );
                            for v in c.to_row() {
                                let _ = write!(cells_out, "\t{v:.5}");
                            }
                            cells_out.push('\n');
                        }
                        summary = vec![f64::NAN; 3];
                    }
                }
                if cp {
                    // Footprint convergence: change since 1 and 4 checkpoints ago
                    // against each cell's split-half noise.
                    let births: HashMap<u64, u64> = slow
                        .as_ref()
                        .map(|sl| {
                            let rf = |f: u64| slow_rec.get(f as usize).copied().unwrap_or(t as u32);
                            sl.births()
                                .into_iter()
                                .map(|(id, b)| (id, u64::from(rf(b))))
                                .collect()
                        })
                        .unwrap_or_default();
                    let snaps: Vec<calab_cala::qc::convergence::CellSnap> = (0..lib.len())
                        .map(|slot| {
                            let (pix, val) = lib.filtered(slot);
                            let id = lib.ids()[slot];
                            calab_cala::qc::convergence::CellSnap {
                                id,
                                pix: pix.to_vec(),
                                val: val.to_vec(),
                                born: births.get(&id).copied().unwrap_or(0),
                                noise: slow.as_ref().and_then(|sl| sl.footprint_noise(id, pix)),
                            }
                        })
                        .collect();
                    if let Some(f) = fp_hist.as_mut() {
                        let noise = |id: u64, pix: &[u32]| {
                            slow.as_ref().and_then(|sl| sl.footprint_noise(id, pix))
                        };
                        write_fp_history(f, t_end as u64, &lib, &births, &noise);
                    }
                    for row in conv.checkpoint(t_end as u64, snaps) {
                        conv_out.push_str(&row.to_line());
                    }
                }
                if t_end.is_multiple_of(100) || cp {
                    let g = q.global();
                    let extra = if cp {
                        summary.clone()
                    } else {
                        vec![f64::NAN; 3]
                    };
                    let mut extra = extra;
                    let (cc, st, sf, sn) = slow
                        .as_ref()
                        .map_or((Default::default(), Default::default(), 0, 0), |sl| {
                            (sl.churn_counts(), sl.stats(), sl.frames(), sl.len())
                        });
                    let (dropped, jobs, vms) = timed
                        .as_ref()
                        .map_or((0, 0, 0.0), |tm| (tm.dropped, tm.jobs, tm.at(t_end)));
                    extra.extend(
                        [
                            cc.adds_new,
                            cc.adds_readd,
                            cc.churned,
                            cc.churned_readd,
                            cc.established_removals,
                            st.adds,
                            st.merges,
                            st.deletes,
                            st.splits,
                            sf,
                            sn as u64,
                            fwd_frames,
                            dropped,
                            st.visits,
                            jobs,
                        ]
                        .map(|v| v as f64),
                    );
                    extra.push(vms);
                    match &ho_win {
                        Some(w) => extra.extend([
                            w.frames as f64,
                            w.gain_per_frame,
                            w.cells,
                            w.placebos,
                            w.mu,
                            w.penalty,
                            w.score,
                            w.penalty_ci,
                            w.signal,
                            w.score_frac,
                        ]),
                        None => extra.extend([f64::NAN; 10]),
                    }
                    global.push_str(&global_line(&g, &extra));
                    if t_end.is_multiple_of(1200) || last {
                        println!(
                        "  frame {t_end}: {} cells, explained {:.3}, residual {:.3}, snr median {:.1}, pass {:.2}, adds/min {:.0}; GT {:?}; {:.0} s",
                        g.cells, g.explained, g.residual_excess, g.snr_median, g.pass_frac, g.adds_per_min, extra,
                        t_all.elapsed().as_secs_f64()
                    );
                    }
                }
            }
            s += cnt;
        }
        {
            let lib = engine.library().clone();
            let (st, sf, sn) = slow.as_ref().map_or((Default::default(), 0, 0), |sl| {
                (sl.stats(), sl.frames(), sl.len())
            });
            let wall = t_pass.elapsed().as_secs_f64();
            if let Some(sl) = slow.as_mut() {
                let rs = sl.replay_stats;
                sl.replay_stats.per_cell_ns = 0;
                sl.replay_stats.cluster_ns = 0;
                println!(
                    "pass {}: slow observe {:.3} ms/frame (fitting-frame statistics: per-cell {:.3}, clusters {:.3} ms/frame, diagnostics builds only); joint update {:?}",
                    pass + 1,
                    slow_obs_s * 1e3 / t_len as f64,
                    rs.per_cell_ns as f64 * 1e-6 / t_len as f64,
                    rs.cluster_ns as f64 * 1e-6 / t_len as f64,
                    rs
                );
                // Slow-loop cost of the pass (wall, and the loop's own
                // deterministic work counts), for the demixing suite.
                let st = sl.stats();
                let wk = (st.work_stats, st.work_refine, sl.work());
                let per = |x: f64| x / t_len as f64;
                let _ = writeln!(
                    slow_cost,
                    "{}\t{t_len}\t{:.4}\t{:.4}\t{:.4}\t{:.0}\t{:.0}\t{:.0}",
                    pass + 1,
                    per(slow_obs_s * 1e3),
                    per(slow_step_s * 1e3),
                    per((slow_obs_s + slow_step_s) * 1e3),
                    per(wk.0.saturating_sub(work_prev.0) as f64),
                    per(wk.1.saturating_sub(work_prev.1) as f64),
                    per(wk.2.saturating_sub(work_prev.2) as f64),
                );
                println!(
                    "pass {}: slow step {:.3} ms/frame, slow loop {:.3} ms/frame",
                    pass + 1,
                    per(slow_step_s * 1e3),
                    per((slow_obs_s + slow_step_s) * 1e3)
                );
                work_prev = wk;
                slow_obs_s = 0.0;
                slow_step_s = 0.0;
                if cluster_census {
                    print!(
                        "pass {}: {}",
                        pass + 1,
                        sl.cluster_census(&lib, &[0.03, 0.05, 0.1], 6)
                    );
                }
            }
            let _ = writeln!(
                passes_out,
                "{}\t{}\t{}\t{sn}\t{}\t{}\t{}\t{}\t{sf}\t{wall:.1}",
                pass + 1,
                off + t_len,
                lib.len(),
                st.adds,
                st.merges,
                st.deletes,
                st.splits
            );
            println!(
            "pass {} done: {} cells, adds {} merges {} deletes {} splits {} (cumulative); {wall:.0} s",
            pass + 1,
            lib.len(),
            st.adds,
            st.merges,
            st.deletes,
            st.splits
        );
            if passes > 1 {
                write_library(
                    &out_dir,
                    &format!("_pass{}", pass + 1),
                    &lib,
                    dims,
                    gt.as_ref(),
                    ho.as_ref(),
                    slow.as_ref(),
                );
            }
        }
    }
    std::fs::write(out_dir.join("passes.tsv"), &passes_out).unwrap();
    if let (Some(l), Some(sl)) = (&lookback, slow.as_ref()) {
        if let Some(c) = &l.cs {
            let st = sl.settle_stats();
            let msg = format!(
                "csettle: share {} mode {:?} ramp {} quiet {}: {} frames re-read ({} fit, {} held out), {} slots, {} visits, {} refines, {} quiet skips, work {:.4e} of {:.4e}, {:.1} s wall\n",
                c.share, c.mode, c.ramp, c.quiet, l.cs_frames, st.frames_fit, st.frames_test,
                st.slots, st.visits, st.refines, st.quiet_skips, st.work as f64, sl.work() as f64,
                l.cs_wall_s
            );
            print!("{msg}");
            std::fs::write(out_dir.join("csettle.txt"), &msg).unwrap();
        }
    }
    if let Some(l) = &lookback {
        println!(
            "lookback: {} frames ({} pushed, {} cell-frames, {} births, {} cells still in need), {:.1} s wall",
            l.frames,
            l.pushed,
            l.cell_frames,
            l.sched.births(),
            l.sched.in_need(),
            l.wall_s
        );
        if let (Some(sl), true) = (slow.as_ref(), lb_res != LookbackReservoir::Off) {
            let c = sl.lookback_reservoir_counts();
            println!(
                "lookback reservoir: {} frames scored, {} event slots and {} random slots taken",
                c[0], c[1], c[2]
            );
        }
        let mut t = format!(
            "rate\tmax_frames\tcatchup\tdouble\tframes\tpushed\tcell_frames\tbirths\tin_need\twall_s\tdrain_steps\tdrain_frames\n{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{:.3}\t{}\t{}\n\ntenth\tframes\tcell_frames\n",
            l.rate,
            l.max_frames,
            l.catchup,
            u8::from(l.catchup_double),
            l.frames,
            l.pushed,
            l.cell_frames,
            l.sched.births(),
            l.sched.window_need(),
            l.wall_s,
            l.drain_steps,
            l.drain_frames
        );
        for (k, (a, b)) in l.by_tenth.iter().enumerate() {
            let _ = writeln!(t, "{k}\t{a}\t{b}");
        }
        if l.target > 0.0 {
            let (cells, above, prio) = l.sched.precision_counts();
            let _ = write!(
                t,
                "\ntarget\tskipped\tcells\tabove_target\tprio_left\n{}\t{}\t{}\t{}\t{}\n\ntwentieth\tframes\n",
                l.target,
                l.sched.skipped(),
                cells,
                above,
                prio
            );
            for (k, a) in l.by_twentieth.iter().enumerate() {
                let _ = writeln!(t, "{k}\t{a}");
            }
        }
        std::fs::write(out_dir.join("lookback.tsv"), t).unwrap();
    }
    if let (true, Some(sl)) = (noise_dump, slow.as_ref()) {
        // Final footprint noise per cell (`--noise-dump`, precision mode).
        write_noise(&out_dir.join("fp_noise.tsv"), engine.library(), sl);
    }
    if let (Some(tm), Some(sl)) = (timed.as_mut(), slow.as_mut()) {
        tm.ending = true;
        tm.advance(f64::INFINITY, sl, &mut slow_rec, &mut |_| None);
        let wall = t_len as f64 * 1e3 / tm.fps;
        let msg = format!(
            "timed: {} visit workers, offered {} fps over {:.1} s: forwarded {} frames, dropped {}, observed {}; visits {} ({} jobs); owner busy {:.0}% , visit workers busy {:.0}%, slow loop done at {:.1} s, {:.0} observed frames/s\n",
            tm.runners.len(),
            tm.fps,
            wall / 1e3,
            tm.forwarded,
            tm.dropped,
            sl.frames(),
            sl.stats().visits,
            tm.jobs,
            100.0 * tm.owner_busy / wall,
            100.0 * tm.runner_busy / (wall * tm.runners.len().max(1) as f64),
            tm.last_ms / 1e3,
            sl.frames() as f64 / (wall / 1e3),
        );
        let msg = if tm.cs_rate > 0.0
            || (tm.cs_share == 0.0
                && !tm.runners.is_empty()
                && lookback.as_ref().is_some_and(|l| l.cs.is_some()))
        {
            let st = sl.settle_stats();
            format!(
                "{}timed settle jobs: {} frames re-read in {} requests ({:.2} per forwarded frame; {} fit, {} held out and not solved), {} settle jobs; owner busy {:.1}% on settle answers and {:.1}% on look-back frames, idle {:.1}%; look-back worker busy {:.1}%; longest batch wait {:.1} ms\n",
                msg,
                tm.cs_units,
                tm.cs_reqs,
                tm.cs_units as f64 / tm.forwarded.max(1) as f64,
                st.frames_fit,
                lookback.as_ref().map_or(0, |l| l.cs_skipped),
                tm.cs_jobs,
                100.0 * tm.cs_busy / wall,
                100.0 * tm.lb_busy / wall,
                100.0 * (1.0 - tm.owner_busy / wall),
                100.0 * tm.lb_worker_busy / wall,
                tm.max_wait,
            )
        } else if tm.cs_share > 0.0 {
            format!(
                "{}timed settle: {} units, owner busy {:.1}% on the settle and {:.1}% on look-back frames, idle {:.1}%\n",
                msg,
                tm.cs_units,
                100.0 * tm.cs_busy / wall,
                100.0 * tm.lb_busy / wall,
                100.0 * (1.0 - tm.owner_busy / wall),
            )
        } else {
            msg
        };
        let msg = if tm.lb_gate {
            format!(
                "{}timed look-back gate: {} need-driven frames in {} requests; visit units per ms {:.3e}; look-back worker {:.2} ms per frame + {:.4} ms per cell; owner {:.1}% on settle answers in {} answers ({:.1} ms per answer)\n",
                msg,
                tm.need_frames,
                tm.need_reqs,
                tm.visit_units_per_ms,
                tm.lb_ms,
                tm.lb_ms_cell,
                100.0 * tm.cs_busy / wall,
                tm.cs_reqs,
                tm.cs_busy / tm.cs_reqs.max(1) as f64
            )
        } else {
            msg
        };
        print!("{msg}");
        std::fs::write(out_dir.join("timed.txt"), &msg).unwrap();
        if let Some(d) = tm.diag.as_ref() {
            // `--visit-diag`: the sums (times in ms of the virtual clock).
            let dd = sl.due_diag();
            let st = sl.stats();
            let k = ["batch", "result", "lookback", "settle", "load"];
            let mut m = format!(
                "wall_ms\t{:.1}\nworkers\t{}\nvisits\t{}\njobs\t{}\nidle_visits\t{}\ndue_seen\t{}\ndue_by_slots\t{}\ndue_by_lookback\t{}\ndue_by_touch\t{}\ndue_by_own_visit\t{}\nwait_ms_mean_job\t{:.3}\nwait_ms_mean_idle_visit\t{:.3}\nslots_at_handout_mean\t{:.3}\nworker_busy_ms\t{:.1}\nworker_idle_nothing_due_ms\t{:.1}\nworker_idle_zone_held_ms\t{:.1}\n",
                wall,
                tm.runners.len(),
                st.visits,
                d.jobs,
                d.idle_visits,
                d.due_events,
                dd.slots,
                dd.lookback,
                dd.touch,
                dd.own,
                d.wait_sum / d.jobs.max(1) as f64,
                d.idle_wait_sum / d.idle_visits.max(1) as f64,
                d.fresh_sum as f64 / d.jobs.max(1) as f64,
                tm.runner_busy,
                d.idle_nodue,
                d.idle_blocked,
            );
            for (i, k) in k.iter().enumerate() {
                let _ = writeln!(
                    m,
                    "worker_idle_owner_on_{k}_ms\t{:.1}\nowner_{k}_ms\t{:.1}\nowner_{k}_msgs\t{}\nqueue_{k}_ms_mean\t{:.3}\nqueue_{k}_ms_max\t{:.1}",
                    d.idle_owner[i],
                    d.owner_ms[i],
                    d.msgs[i],
                    d.queue_ms[i] / d.msgs[i].max(1) as f64,
                    d.queue_max[i],
                );
            }
            std::fs::write(out_dir.join("visit_diag.txt"), &m).unwrap();
            std::fs::write(out_dir.join("visit_diag.tsv"), &d.rows).unwrap();
        }
    }
    // Each cell's best trace correlation with any GT unit (over its whole
    // life), wherever that unit is: tells light from a distant unit (a
    // dendrite, an out-of-focus blur) from signal no GT unit made.
    if let (Some(g), Some(o)) = (&gt, &oracle) {
        let lib = engine.library().clone();
        let det = columns(&lib, dims, (0, 0));
        let mut t = String::from("id\tcy\tcx\tgr\tgr_gt\tgr_dist\tgr_detectable\n");
        for (&id, col) in lib.ids().iter().zip(&det) {
            let Some((t0, w)) = hist.map.get(&id) else {
                continue;
            };
            // The last pass's frames only (recording frames from `t0`).
            let off = (passes - 1) * t_len;
            let (t0, w) = if *t0 < off {
                (0, w.get(off - t0..).unwrap_or(&[]))
            } else {
                (t0 - off, &w[..])
            };
            if w.len() < 200 || t0 + w.len() > g.t_gt {
                continue;
            }
            let (mut bj, mut br) = (usize::MAX, f64::NEG_INFINITY);
            for j in 0..g.kept.len() {
                let r = pearson(w, &g.c(o, j)[t0..t0 + w.len()]);
                if r > br {
                    (bj, br) = (j, r);
                }
            }
            let c = centroid(col, dims.width);
            let (d, det_j) = if bj == usize::MAX {
                (f32::NAN, 0)
            } else {
                let gc = g.centers[bj];
                (
                    ((gc.0 - c.0).powi(2) + (gc.1 - c.1).powi(2)).sqrt(),
                    u8::from(g.detectable[bj]),
                )
            };
            let _ = writeln!(
                t,
                "{id}\t{:.2}\t{:.2}\t{br:.4}\t{}\t{d:.1}\t{det_j}",
                c.0,
                c.1,
                if bj == usize::MAX { -1 } else { bj as i64 }
            );
        }
        std::fs::write(out_dir.join("traces_gt.tsv"), t).unwrap();
    }
    if let Some(fd) = factors.as_mut() {
        fd.finish();
    }
    std::fs::write(out_dir.join("cells.tsv"), &cells_out).unwrap();
    if let Some(b) = &boundary {
        b.write(&out_dir);
    }
    std::fs::write(out_dir.join("convergence.tsv"), &conv_out).unwrap();
    std::fs::write(out_dir.join("global.tsv"), &global).unwrap();
    if motion {
        let mut t = String::from("frame\tdy\tdx\n");
        for (k, d) in rigid.iter().enumerate() {
            let _ = writeln!(t, "{k}\t{:.4}\t{:.4}", d.0, d.1);
        }
        std::fs::write(out_dir.join("motion.tsv"), t).unwrap();
    }
    if let Some(m) = &gt_shifts {
        // The offset applied to the GT, the same estimate over the whole run
        // and per 1200-frame block (constancy check), and the true-shift
        // spread for scale.
        let mut t = String::from("window\tframe0\tframe1\tn\tdy\tdx\tsd_dy\tsd_dx\n");
        let row = |t: &mut String, name: &str, a: usize, b: usize, g: &FrameOffset| {
            let _ = writeln!(
                t,
                "{name}\t{a}\t{b}\t{}\t{:.4}\t{:.4}\t{:.4}\t{:.4}",
                g.n, g.dy, g.dx, g.sd_dy, g.sd_dx
            );
        };
        let n = rigid.len().min(m.len());
        row(
            &mut t,
            "applied",
            0,
            gt_offset_applied.n,
            &gt_offset_applied,
        );
        row(&mut t, "run", 0, n, &FrameOffset::estimate(&rigid, m));
        for a in (0..n).step_by(1200) {
            let b = (a + 1200).min(n);
            row(
                &mut t,
                "block",
                a,
                b,
                &FrameOffset::estimate(&rigid[a..b], &m[a..b]),
            );
        }
        let zero = vec![(0.0f32, 0.0f32); n];
        row(&mut t, "truth", 0, n, &FrameOffset::estimate(&zero, m));
        std::fs::write(out_dir.join("motion_offset.tsv"), t).unwrap();
    }
    if let Some(o) = &online_ff {
        std::fs::write(out_dir.join("flat_field_updates.tsv"), &ff_log).unwrap();
        if let Some(ff) = o.current() {
            let mut w = BufWriter::new(File::create(out_dir.join("flat_field.f32")).unwrap());
            write_f32s(&mut w, &ff.gain);
            if let Some(off) = &ff.offset {
                let mut w =
                    BufWriter::new(File::create(out_dir.join("flat_field_offset.f32")).unwrap());
                write_f32s(&mut w, off);
            }
        }
        println!("flat field: {} updates", o.updates());
    }
    if session_fix.any() {
        std::fs::write(out_dir.join("session_boundaries.tsv"), &session_log).unwrap();
        std::fs::write(out_dir.join("boundary_null.tsv"), &null_log).unwrap();
    }
    std::fs::write(out_dir.join("adds.tsv"), &add_log).unwrap();
    #[cfg(feature = "diagnostics")]
    calab_cala::discover::merge_log_flush();
    std::fs::write(out_dir.join("removals.tsv"), &rem_log).unwrap();
    if churn_log {
        std::fs::write(out_dir.join("edits.tsv"), &edit_log).unwrap();
        if cfg!(feature = "diagnostics") {
            std::fs::write(out_dir.join("tests.tsv"), &test_log).unwrap();
        }
        if let Some(mut f) = fp_hist.take() {
            f.flush().unwrap();
        }
    }
    println!("slow loop: {n_fwd} of {n_batches} batches forwarded ({fwd_frames} frames)");
    if let Some(sl) = &slow {
        if sl.config().core_test != CoreTest::Off {
            let (fp, ff, fd) = sl.fast_diag;
            println!("fast: proposals with core {fp}, without {ff}, nocore deletions {fd}");
            std::fs::write(out_dir.join("split.tsv"), sl.split_report()).unwrap();
            std::fs::write(out_dir.join("fast.tsv"), sl.fast_report()).unwrap();
        }
        if sl.config().basin_trim || sl.config().support_rule != SupportRule::Rings {
            let (c, f, s2) = sl.basin_diag;
            println!(
                "basin: {c} trims, mean light cut {:.3}, second peaks {s2}",
                if c > 0 { f / c as f64 } else { 0.0 }
            );
        }
    }
    let q = qc.expect("QC started");
    let mut sorted = qc_ms.clone();
    sorted.sort_by(f64::total_cmp);
    let mean = qc_ms.iter().sum::<f64>() / qc_ms.len() as f64;
    let msg = format!(
        "QC cost per frame: mean {:.3} ms, p50 {:.3}, p99 {:.3}, max {:.1} ms; state {:.1} MB; cells {}\n",
        mean,
        sorted[sorted.len() / 2],
        sorted[(sorted.len() - 1) * 99 / 100],
        sorted[sorted.len() - 1],
        q.state_bytes() as f64 / 1048576.0,
        engine.library().len()
    );
    let mut msg = msg;
    if let Some(h) = &ho {
        let wall = t_all.elapsed().as_secs_f64();
        let (asked, placed) = h.placebo_counts;
        let _ = writeln!(
            msg,
            "held-out score: {:.1} s of {:.1} s wall ({:.1} %), {} held-out frames, placebos placed {placed} of {asked}; stages (gain, drop-one, placebo builds, placebo solve, placebo gains) {:.1?} s",
            h.seconds,
            wall,
            100.0 * h.seconds / wall,
            h.scored(),
            h.split
        );
        let mut t = String::from("version\tfirst\tlast\tho_frames\tho_gain_per_frame\tho_cells\tho_placebos\tho_mu\tho_penalty\tho_score\tho_penalty_ci\tho_signal\tho_score_frac\n");
        for v in h.versions(true) {
            let _ = writeln!(
                t,
                "{}\t{}\t{}\t{}\t{:.4}\t{:.1}\t{:.1}\t{:.5}\t{:.4}\t{:.4}\t{:.4}\t{:.4}\t{:.5}",
                v.version,
                v.first,
                v.last,
                v.frames,
                v.gain_per_frame,
                v.cells,
                v.placebos,
                v.mu,
                v.penalty,
                v.score,
                v.penalty_ci,
                v.signal,
                v.score_frac
            );
        }
        std::fs::write(out_dir.join("heldout.tsv"), t).unwrap();
        std::fs::write(out_dir.join("ho_cells.tsv"), &ho_cells_out).unwrap();
    }
    print!("{msg}");
    std::fs::write(out_dir.join("cost.txt"), &msg).unwrap();
    if slow_cost.lines().count() > 1 {
        std::fs::write(out_dir.join("slow_cost.tsv"), &slow_cost).unwrap();
    }

    // Final library (finalize publishes pending edits).
    let lib = match slow.as_mut() {
        Some(sl) => sl.finalize().unwrap(),
        None => engine.library().clone(),
    };
    write_library(
        &out_dir,
        "",
        &lib,
        dims,
        gt.as_ref(),
        ho.as_ref(),
        slow.as_ref(),
    );
    if !dump {
        return;
    }
    // Pass 2: re-extract with the final library; per cell the trace, its ring
    // background, and the footprint projection ã_iᵀ y / ã_iᵀ ã_i of the frame
    // before and after the floor.
    // Online flat field: pass 2 corrects from frame 0 with the final map, as the
    // app does (pass 1 only had it from the first map on).
    let mut pre2 = pre0.clone();
    if let Some(ff) = online_ff.as_ref().and_then(|o| o.current()) {
        ff.apply(&mut pre2).unwrap();
    }
    let mut pipe = Pipeline::new(&mut rec, pre2, &cal, motion, 200);
    let mut eng = TraceEngine::new(lib.clone(), SolverConfig::default()).unwrap();
    eng.set_signed(dump_signed);
    eng.set_consolidated_ring_gradient(true);
    let mut q2 = QcMonitor::new(
        dims,
        fov.clone(),
        pipe.pre.noise().sigma(),
        QcConfig::default(),
    )
    .unwrap();
    let n = lib.len();
    let norms: Vec<f32> = (0..n)
        .map(|s| lib.filtered(s).1.iter().map(|a| a * a).sum())
        .collect();
    let mut files: Vec<BufWriter<File>> = ["trace", "ring", "pre", "post", "signed"]
        .iter()
        .take(if dump_signed { 5 } else { 4 })
        .map(|k| BufWriter::new(File::create(out_dir.join(format!("dump_{k}.f32"))).unwrap()))
        .collect();
    let mut pre = vec![0.0f32; n_px];
    let mut tr = FrameTraces::default();
    let mut proj = vec![0.0f32; n];
    let mut hist2 = History::default();
    // Frame-major clipped and signed traces, for the GT comparison.
    let mut all_clipped: Vec<f32> = Vec::new();
    let mut all_signed: Vec<f32> = Vec::new();
    let mut solve_s = 0.0f64;
    let mut s = 0u32;
    while s < frames {
        let cnt = 64.min(frames - s);
        let mut raw = rec.read(s, cnt);
        if let Some(d) = &drift {
            for (k, f) in raw.chunks_exact_mut(n_px).enumerate() {
                d.apply(f, s as usize + k);
            }
        }
        for (k, f) in raw.chunks_exact(n_px).enumerate() {
            let t = s as usize + k;
            pipe.frame_split(f, &mut pre, &mut y);
            let t_solve = Instant::now();
            eng.process_into(&y, &mut tr).unwrap();
            solve_s += t_solve.elapsed().as_secs_f64();
            if dump_signed {
                write_f32s(&mut files[4], &tr.signed);
                all_clipped.extend_from_slice(&tr.traces);
                all_signed.extend_from_slice(&tr.signed);
            }
            if t.is_multiple_of(200) {
                q2.set_noise(pipe.pre.noise().sigma()).unwrap();
            }
            q2.observe(&y, &lib, &tr).unwrap();
            hist2.push(t, lib.ids(), &tr.traces);
            write_f32s(&mut files[0], &tr.traces);
            write_f32s(&mut files[1], &tr.background);
            for (img, file) in [(&pre, 2usize), (&y, 3usize)] {
                for (sl_, pr) in proj.iter_mut().enumerate() {
                    let (p, v) = lib.filtered(sl_);
                    let d: f32 = p.iter().zip(v).map(|(&qq, &a)| a * img[qq as usize]).sum();
                    *pr = d / norms[sl_];
                }
                write_f32s(&mut files[file], &proj);
            }
        }
        s += cnt;
    }
    drop(files);
    println!(
        "pass 2 solve: {:.3} s for {t_len} frames ({:.1} us/frame, signed traces {})",
        solve_s,
        solve_s * 1e6 / t_len.max(1) as f64,
        if dump_signed { "on" } else { "off" }
    );
    if let (true, Some(g), Some(o)) = (dump_signed, &gt, &oracle) {
        signed_vs_gt(&lib, &all_clipped, &all_signed, t_len, g, o, &out_dir);
    }
    let mut out = qc_header();
    if let (Some(g), Some(o)) = (&gt, &oracle) {
        label_rows(
            t_len,
            0,
            &lib,
            &q2,
            &hist2,
            g,
            o,
            dims,
            own.as_ref(),
            &mut out,
            &mut summary,
        );
    } else {
        for (sl_, c) in q2.cells().enumerate() {
            let _ = write!(
                out,
                "{t_len}\t{sl_}\t-1\t-1\t-1\tnan\t-1\tnan\tnan\tnan\tnan\tnan\tnan\t0\t-\tnan"
            );
            for v in c.to_row() {
                let _ = write!(out, "\t{v:.5}");
            }
            out.push('\n');
        }
    }
    std::fs::write(out_dir.join("cells_pass2.tsv"), out).unwrap();
    println!("pass 2 dump: {n} cells x {t_len} frames");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh scratch folder for a test's files.
    fn scratch_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("qc_eval-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// `n` frames of a smooth moving pattern (deterministic).
    fn pattern_frames(dims: Dims, n: usize) -> Vec<Vec<f32>> {
        (0..n)
            .map(|t| {
                (0..dims.pixels())
                    .map(|p| {
                        let (y, x) = ((p / dims.width) as f32, (p % dims.width) as f32);
                        20.0 + 4.0 * (0.05 * t as f32 + 0.11 * x).sin()
                            + 3.0 * (0.07 * y - 0.03 * t as f32).cos()
                    })
                    .collect()
            })
            .collect()
    }

    #[test]
    fn factor_frames_rebuild_the_dumped_window_and_mark_never_valid_pixels() {
        let dims = Dims::new(96, 80).unwrap();
        let dir = scratch_dir("frames");
        let mut fd = FactorDump::new(&dir, dims, Tiling::Offset);
        for mut fr in pattern_frames(dims, 650) {
            fr[5] = f32::NAN; // never valid
            fd.push(&fr);
        }
        fd.finish();
        let wf =
            WindowFactors::from_bytes(&std::fs::read(dir.join("w0000600.fac")).unwrap()).unwrap();
        let mut want = vec![0.0f32; dims.pixels()];
        wf.layout().reconstruct(&wf, 10, &mut want);
        let mut ff = FactorFrames::new(&dir, FACTOR_WINDOW);
        let mut got = vec![0.0f32; dims.pixels()];
        ff.frame(610, &mut got).unwrap();
        assert!(got[5].is_nan());
        for p in (0..dims.pixels()).filter(|&p| p != 5) {
            assert_eq!(got[p].to_bits(), want[p].to_bits(), "pixel {p}");
        }
        // Read once, served from the cache after.
        ff.frame(611, &mut got).unwrap();
        assert_eq!(ff.reads(), 1);
        // Past the last frame of its window, and a window not on disk.
        assert!(ff.frame(650, &mut got).unwrap_err().contains("past"));
        assert!(ff
            .frame(1300, &mut got)
            .unwrap_err()
            .contains("w0001200.fac"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn settle_source_needs_the_factor_dump_and_a_settle() {
        let a = |s: &str| s.split_whitespace().map(String::from).collect::<Vec<_>>();
        assert!(matches!(settle_source(&a("x")), Ok(SettleSource::Raw)));
        assert!(matches!(
            settle_source(&a("x --settle-source raw")),
            Ok(SettleSource::Raw)
        ));
        let ok = settle_source(&a(
            "x --settle-source factors --factors-out d --settle-frames 600",
        ));
        assert!(matches!(ok, Ok(SettleSource::Factors(p)) if p == Path::new("d")));
        let e = settle_source(&a("x --settle-source factors --settle-frames 600"))
            .err()
            .unwrap();
        assert!(e.contains("--factors-out"), "{e}");
        let e = settle_source(&a("x --settle-source factors --factors-out d"))
            .err()
            .unwrap();
        assert!(e.contains("--settle-frames"), "{e}");
        let e = settle_source(&a("x --settle-source frames")).err().unwrap();
        assert!(e.contains("raw or factors"), "{e}");
    }

    #[test]
    fn a_settle_alone_keeps_a_lookback_without_look_back() {
        assert!(!lookback_wanted(0.0, 0, 0));
        assert!(lookback_wanted(2.0, 0, 0));
        assert!(lookback_wanted(0.0, 500, 0));
        assert!(lookback_wanted(0.0, 0, 18_000));
    }

    #[test]
    fn factor_dump_writes_v2_windows_with_its_tiling_and_finishes_once() {
        let dims = Dims::new(96, 80).unwrap();
        let dir = scratch_dir("dump");
        let mut fd = FactorDump::new(&dir, dims, Tiling::Offset);
        for fr in pattern_frames(dims, 1250) {
            fd.push(&fr);
        }
        fd.finish();
        fd.finish();
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, ["w0000000.fac", "w0000600.fac", "w0001200.fac"]);
        for (name, frames) in [("w0000000.fac", 600), ("w0001200.fac", 50)] {
            let wf = WindowFactors::from_bytes(&std::fs::read(dir.join(name)).unwrap()).unwrap();
            assert_eq!(wf.frames, frames, "{name}");
            assert_eq!(wf.tiling, Tiling::Offset, "{name}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A Gaussian blob of sd `sd` centred at `(cy, cx)` (sub-pixel), on a
    /// patch reaching 4 sd.
    fn blob(id: u64, cy: f64, cx: f64, sd: f64, dims: Dims) -> Footprint {
        let r = (4.0 * sd).ceil() as i64;
        let (y0, x0) = (
            (cy.round() as i64 - r).max(0),
            (cx.round() as i64 - r).max(0),
        );
        let y1 = (cy.round() as i64 + r).min(dims.height as i64 - 1);
        let x1 = (cx.round() as i64 + r).min(dims.width as i64 - 1);
        let (h, w) = ((y1 - y0 + 1) as usize, (x1 - x0 + 1) as usize);
        let mut values = vec![0.0f32; h * w];
        for y in 0..h {
            for x in 0..w {
                let (py, px) = ((y0 + y as i64) as f64, (x0 + x as i64) as f64);
                let d2 = (py - cy).powi(2) + (px - cx).powi(2);
                values[y * w + x] = (-d2 / (2.0 * sd * sd)).exp() as f32;
            }
        }
        Footprint {
            id,
            y0: y0 as usize,
            x0: x0 as usize,
            height: h,
            width: w,
            values,
        }
    }

    fn col(fp: &Footprint, dims: Dims) -> Vec<(u32, f32)> {
        let mut v = Vec::new();
        for y in 0..fp.height {
            for x in 0..fp.width {
                let a = fp.values[y * fp.width + x];
                if a > 0.0 {
                    v.push((((fp.y0 + y) * dims.width + fp.x0 + x) as u32, a));
                }
            }
        }
        v
    }

    fn corr(a: &Footprint, b: &Footprint, dims: Dims) -> f64 {
        let mut scratch = vec![0.0f32; dims.pixels()];
        sparse_corr(&col(a, dims), &col(b, dims), &mut scratch)
    }

    #[test]
    fn translate_footprint_moves_content_sub_pixel() {
        let dims = Dims::new(120, 100).unwrap();
        let fp = blob(1, 40.3, 55.6, 1.5, dims);
        // Zero shift: unchanged. Integer shift: the same values, moved.
        assert_eq!(translate_footprint(&fp, 0.0, 0.0, dims).values, fp.values);
        let int = translate_footprint(&fp, 3.0, -2.0, dims);
        assert!(corr(&int, &blob(1, 43.3, 53.6, 1.5, dims), dims) > 0.9999);
        // Sub-pixel: against the blob rendered at the moved centre.
        for &(dy, dx) in &[(-3.07, -0.76), (1.0, -0.69), (0.5, 0.5), (-0.25, 2.8)] {
            let moved = translate_footprint(&fp, dy, dx, dims);
            let want = blob(1, 40.3 + dy, 55.6 + dx, 1.5, dims);
            let r = corr(&moved, &want, dims);
            assert!(r > 0.999, "({dy}, {dx}): r {r}");
            let (cy, cx) = centroid(&col(&moved, dims), dims.width);
            assert!((f64::from(cy) - (40.3 + dy)).abs() < 0.02, "cy {cy}");
            assert!((f64::from(cx) - (55.6 + dx)).abs() < 0.02, "cx {cx}");
            assert!(moved.values.iter().all(|&v| v >= 0.0));
        }
        // Clipped at the image border.
        let edge = translate_footprint(&blob(2, 3.0, 3.0, 1.5, dims), -2.5, -2.5, dims);
        assert_eq!((edge.y0, edge.x0), (0, 0));
    }

    /// Rigid records of a run whose template sits at `c` in the tissue
    /// frame: `s_t = c - m_t` plus registration noise and a few outliers.
    fn records(c: (f64, f64), truth: &[(f64, f64)], rng: &mut Rng) -> Vec<(f32, f32)> {
        truth
            .iter()
            .enumerate()
            .map(|(t, m)| {
                let mut e = (0.2 * (rng.unit() - 0.5), 0.2 * (rng.unit() - 0.5));
                if t % 17 == 0 {
                    e = (4.0, -5.0);
                }
                ((c.0 - m.0 + e.0) as f32, (c.1 - m.1 + e.1) as f32)
            })
            .collect()
    }

    #[test]
    fn frame_offset_recovers_template_position() {
        let mut rng = Rng(7);
        let (mut y, mut x) = (0.0, 0.0);
        let truth: Vec<(f64, f64)> = (0..400)
            .map(|_| {
                y += rng.unit() - 0.5;
                x += rng.unit() - 0.5;
                (y, x)
            })
            .collect();
        let c = (-3.07, 0.69);
        let est = FrameOffset::estimate(&records(c, &truth, &mut rng), &truth);
        assert_eq!(est.n, 400);
        assert!((est.dy - c.0).abs() < 0.03, "{est:?}");
        assert!((est.dx - c.1).abs() < 0.03, "{est:?}");
        assert!(est.sd_dy < 0.2 && est.sd_dx < 0.2, "{est:?}");
        // Shorter of the two, and nothing.
        assert_eq!(FrameOffset::estimate(&[(0.0, 0.0); 3], &truth).n, 3);
        assert_eq!(FrameOffset::estimate(&[], &truth), FrameOffset::ZERO);
    }

    /// End to end: 6 px cells, cala's frame offset from the tissue by a
    /// sub-pixel shift. Unaligned GT scores the offset; aligned GT recovers
    /// every cell.
    #[test]
    fn aligned_gt_scores_an_offset_run() {
        let dims = Dims::new(200, 200).unwrap();
        let sd = 6.0 / 2.355; // 6 px half-max diameter
        let c = (-3.07, -0.76);
        let mut units = Vec::new();
        let mut det = Vec::new();
        for (k, (cy, cx)) in (0..6)
            .flat_map(|i| (0..6).map(move |j| (30.0 + 25.0 * i as f64, 30.0 + 25.0 * j as f64)))
            .enumerate()
        {
            let fp = blob(k as u64, cy, cx, sd, dims);
            units.push(Unit {
                detectable: true,
                in_focus: true,
                center: (cy as f32, cx as f32),
                full: fp.clone(),
                core: fp,
            });
            det.push(col(&blob(k as u64, cy + c.0, cx + c.1, sd, dims), dims));
        }
        let mut o = Oracle {
            dims,
            units,
            n_frames: 0,
            c: Vec::new(),
        };
        let score = |o: &Oracle| {
            let gt: Vec<_> = o.units.iter().map(|u| col(&u.full, dims)).collect();
            let (m, _) = match_cells(&det, &gt, dims, 0.8);
            m.iter().filter(|x| x.is_some()).count() as f64 / det.len() as f64
        };
        assert!(score(&o) < 0.1, "unaligned P8 {}", score(&o));
        let mut rng = Rng(11);
        let truth: Vec<(f64, f64)> = (0..51)
            .map(|_| (4.0 * (rng.unit() - 0.5), 4.0 * (rng.unit() - 0.5)))
            .collect();
        let est = FrameOffset::estimate(&records(c, &truth, &mut rng), &truth);
        o.translate(&est);
        // Centres: the moved core's peak pixel.
        assert_eq!(o.units[0].center, (27.0, 29.0));
        assert_eq!(score(&o), 1.0);
        let gt: Vec<_> = o.units.iter().map(|u| col(&u.full, dims)).collect();
        let (m, _) = match_cells(&det, &gt, dims, 0.8);
        for (i, x) in m.iter().enumerate() {
            let (j, r) = x.unwrap();
            assert_eq!(i, j);
            assert!(r > 0.99, "cell {i}: r {r}");
        }
    }

    fn argv(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn branch_tail_overrides_base_and_other_flags_are_rejected() {
        let base = argv("sim in out --passes 1 --lookback-drain 100 --branch-after discover");
        let mut full = base.clone();
        full.extend(argv("--branch"));
        full.push("r:--passes 2 --later-passes refine --lookback-drain 0".into());
        let b = Branching::parse(&full).unwrap();
        assert!(b.point == BranchPoint::Discover);
        let toks = &b.branches[0].1;
        let t = Tail::parse(&b.branch_args(&full, toks));
        assert_eq!((t.passes, t.drain), (2, 0));
        assert!(t.later_scope == EditScope::Refine);
        // The shared prefix records for the deepest branch.
        assert_eq!(b.max_passes(&full), 2);
        // A branch that sets nothing keeps the base tail.
        let t0 = Tail::parse(&b.branch_args(&full, &[]));
        assert_eq!((t0.passes, t0.drain), (1, 100));
    }

    #[test]
    fn settle_flags_are_tail_flags_at_both_branch_points() {
        for point in ["discover", "drain"] {
            let mut full = argv("sim in out --passes 1 --lookback-drain 100 --branch-after");
            full.push(point.into());
            full.extend(argv("--branch"));
            full.push("s:--settle-frames 9600 --settle-batch 16 --settle-libs".into());
            full.extend(argv("--branch plain:"));
            let b = Branching::parse(&full).unwrap();
            let t = Tail::parse(&b.branch_args(&full, &b.branches[0].1));
            assert_eq!(
                (t.settle.frames, t.settle.batch, t.settle.libs),
                (9600, 16, true)
            );
            let t0 = Tail::parse(&b.branch_args(&full, &b.branches[1].1));
            assert_eq!(t0.settle.frames, 0);
        }
    }

    #[test]
    #[should_panic(expected = "not a tail flag")]
    fn branch_rejects_a_prefix_flag() {
        let mut a = argv("sim in out --branch-after discover --branch");
        a.push("x:--budget 5".into());
        Branching::parse(&a);
    }

    #[test]
    #[should_panic(expected = "acts before")]
    fn drain_point_rejects_drain_flags() {
        let mut a = argv("sim in out --branch-after drain --branch");
        a.push("x:--lookback-drain 5".into());
        Branching::parse(&a);
    }
}
