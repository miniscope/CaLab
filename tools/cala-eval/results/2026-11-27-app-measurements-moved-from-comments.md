# Measurements moved out of code comments (cala app library sweep, 27 Nov 2026)

The comment policy (`/CLAUDE.md`) keeps measured numbers out of code comments. These are the
measurements the comments in `apps/cala/src/lib` and `apps/cala/src/workers` carried before the
sweep, verbatim, grouped by the file they documented. Fragments are quoted as they stood;
`git log -p` on the file gives the full context.

## `apps/cala/src/lib/bg-settle-driver.ts`

> An answer of Background settle. Whole (the default, as qc_eval
> measured it): the next request goes out first

## `apps/cala/src/lib/cell-store.ts`

> at 8 h of 30 fps video (108k batches) the nine timing summaries took
> ~170 ms per tick.

## `apps/cala/src/lib/donation-runner.ts`

> Lossless compression measured on miniscope video (docs/data-donation.md, Codec).

## `apps/cala/src/lib/fov-display.ts`

> Measured on minisim motion_s6 (8-bit, 1000 frames): the mean spans -14 .. 54
> (1st-99th percentile -7 .. 20), the max 0 .. 108 (99th percentile 40).

## `apps/cala/src/lib/fast-loop.ts`

> The bytes
> carry the solver's precomputed terms, so the swap is a copy (a few ms at
> hundreds of cells), not a rebuild.

## `apps/cala/src/lib/frame-display.ts`

> White-level headroom for background-removed views: the fitted white level
> is about 6 on real 1p recordings, where about 20 shows the cells without
> saturating them (PI, 22 Nov 2026).

## `apps/cala/src/lib/frame-source.ts`

> Header reads are throttled: ~7.8k files for a three-day recording, and
> each is a few small reads that a network drive answers slowly.

## `apps/cala/src/lib/gpu-compress.ts`

> At 128, real V4 tiles
> grew past it and every window gave the run's factors up (24 Nov check).

## `apps/cala/src/lib/imaging-stats.ts`

> which costs about a millisecond at 600 x 600.

## `apps/cala/src/lib/memory-telemetry.ts`

> main thread alone, which held ~1% of the tab's footprint in a real run, and
> workers have none (see the PR description for the measurements).

## `apps/cala/src/lib/qc.ts`

> Cell discovery never stops on long
> recordings (batch tools find nearly twice the cells in 30-120 min as in
> 10-30 min), so converged means ...

> Validated against minisim ground truth (PR body: the rule says converged
> once GT precision has plateaued).

## `apps/cala/src/lib/review-runner.ts`

> A
> 600-frame window of a real 600 x 600 recording is 15-30 MB, so this is
> 1-2 h at 20 fps

## `apps/cala/src/lib/session-export.ts`

> (one 10-minute session is ~65 MB)

## `apps/cala/src/lib/settle.ts`

> (before, a visit worker got its
> next visit whenever the slow worker got round to its result: 0.64-0.75 per frame with one
> look-back worker on the workshop recording, 0.21 with two). 0.4: at the low end of the
> settle visit rates measured without a change in cells or footprints (0.39-1.81 per frame),
> and below what one look-back worker gave at Max, so the settle spends less slow-worker time
> on visits (hand-out, apply and library builds, about 1.5 ms per frame between 0.21 and 0.65).

> (a frame
> takes about 5.5 ms on the workshop recording)

> 4 % separated settled from unsettled libraries on sims and
> the workshop recording

> One worker is enough: with it the Final
> settle on factors is bound by the slow worker (98 % busy in #518's X1), so a
> second would add memory, not speed. The 12-core line is kept as decided:
> below it the end settle's threads (slow worker, two look-back workers and
> the visit workers) would outnumber the cores, and that was not measured.

## `apps/cala/src/lib/slow-runner.ts`

> Its stalls (a tile visit or a library rebuild can take 50-160 ms) only
> delay this worker;

## `apps/cala/src/lib/slow-client.ts`

> two buffers
> still dropped a third of the batches on real data, because a buffer comes
> back only once the trace worker reads the ack between its own batches and
> library rebuilds stall the slow worker for a batch or two. Four drop about
> a tenth.

> on the GT sims (timed harness,
> 250 fps) six workers sat 53-55 % busy against 66-67 % for four, and
> recall at 8 min was no better (0.734-0.746 vs 0.754-0.760).

## `apps/cala/src/lib/speed-floor.ts`

> Leaving the term out instead would let the slow-worker term set a floor about twice too high.

## `apps/cala/src/lib/window-store.ts`

> Chrome (seen with 158) never settles the
> promise of a pending `createSyncAccessHandle()` once its file handle is
> garbage collected: with collections forced during the call, 19 of 20 opens
> of `(await dir.getFileHandle(name)).createSyncAccessHandle()` were lost and
> none with the handle kept.

## `apps/cala/src/lib/visit-rate.ts`

> (`tools/cala-eval/results/2026-11-24-visit-budget-sweep.md`). Before
> the fixed rate, the rate was whatever time was spare: about 0.2 visits per
> frame at Max (the slow worker saturated) and about 4.7 paced at 30 fps.

> A run at Max drops batches for the slow loop (about 25 % of the
> frames on the 3k sim)

> Chosen from constant-rate qc_eval runs (PR #500): on full-length sims
> recall saturates by about 0.2 while false cells (late second copies of found cells) keep growing.
> At 0.15 the motion sim has the most matched-minus-false cells of the rates tried (677 against 660
> at 0.25, 35 false cells against 58) and the static sim the same (739 / 737); on real data 0.15
> gives the same QC-pass cells as 0.25. Only early in a recording (the first ~2000 frames) do more
> visits find cells sooner (recall 4-5 points lower at 0.15 than at 0.25 there).

> seen on a 3 h v4
> recording held at 5 fps for minutes.
