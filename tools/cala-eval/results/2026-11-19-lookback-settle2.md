# Look-back settle, part 2: replay off, reservoir fed during Discover, more recordings (19 Nov 2026)

Follow-up to [2026-11-19-lookback-settle.md](2026-11-19-lookback-settle.md). Targets written before any result run of
this study (commit order shows it); byte checks and builds do not count as results. Results go below them.

## Questions

1. The settled look-back library (`SETTLE`) uses the cluster replay (`--joint-update all --joint-sign all`). On the
   workshop recording that setting costs about 65 cells, and it makes the settle run at about 0.6 x speed. Does the
   same path with the replay off keep the quality, recover the cells and halve the settle cost?
2. A live stream has no end-of-recording pass. Does letting the look-back frames read during Discover renew the
   reservoir (the held-out test frames) bring the Discover-only library towards the settled one?
3. Do the workshop findings hold on other real recordings?

## Arms

Common: `--batch 8 --budget 30000000 --slow-seed 1` (sims: the suite's `--dump --no-heldout --no-signed`). `S` = the
settle, `--settle-frames N --settle-batch 16` with N = one pass (9600 on sims, 18,000 on the recordings). `R` = a
Refine pass (`--passes 2 --later-passes refine`). Tails branch after the drain from one Discover per sim/seed
(`--branch-after drain`), once the byte check of the branching has passed.

| arm                          | Discover flags                                                                                                             | tail       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `DR-main`                    | none (plain Discover)                                                                                                      | R          |
| `COMBO`, `COMBO+R`, `SETTLE` | `--joint-update all --joint-sign all --lookback 2 --lookback-drain 4800 --merge-guard-sep 0.6`                             | none, R, S |
| `OFF`, `OFF+R`, `OFF+S`      | `--lookback 2 --lookback-drain 4800 --merge-guard-sep 0.6` (joint update off, the default)                                 | none, R, S |
| `REF+S`                      | as `COMBO` with `--joint-update refine`: the replay runs only once the cell set is frozen (in the settle), not in Discover | S          |

`SETTLE`, `COMBO+R`, `COMBO`, `DR-main` on the sims are reused from `lbsettle-full` if this study's binary reproduces
`SETTLE/static_s5` byte for byte; otherwise they are re-run. `REF+S` separates the two things "off" removes (the
replay in Discover, where the cells go; the replay in the settle, where the time goes). It is run on the quick tier,
and on the full tier and the recording only if `OFF+S` misses a quality line.

## Targets

Suite rules: paired differences per sim, 95 % CI over sims; footprint r is the suite's median footprint r with ground
truth.

**P1. Quality without the replay (full tier, 14 sims).** `OFF+S` against `SETTLE`:

- Go: footprint r (all, isolated, close pairs) not lower by more than 0.001 (point estimate); born second half not
  lower by more than 0.005; born last 20 % with a CI that includes 0 or is better; crosstalk headline not higher by
  more than 0.01; bitten footprints (0.75-1 D) not higher by more than 0.03; matched cells within 1 %; false cells
  within noise (CI includes 0) or lower. And against `DR-main`: no footprint group worse with a CI that excludes 0.
- No-go: footprint r for all cells or for close pairs lower by more than 0.002 with a CI that excludes 0, or bitten
  footprints higher by more than 0.06 with a CI that excludes 0, or crosstalk higher by more than 0.03 with a CI that
  excludes 0.
- In between: partial. The rows that miss are named with their size, and `REF+S` says whether the replay in the
  settle alone brings them back.

**P2. Cells and quality on the workshop recording (3 slow seeds).** Reference numbers (settle study): Discover and
D + R 831 / 838 / 811 cells (mean 827), 530-535 Minian units matched; `SETTLE` 751 / 760 / 738 (mean 750), 512-515
matched, seed-to-seed r 0.975-0.978, Minian r 0.949-0.950, split-half noise 13.1-13.2 %.

- Cells recovered, go: `OFF+S` mean cell count at least 790 (at least 40 of the about 77 back) and at least 522 Minian
  units matched on average (half of the about 18 back). No recovery: fewer than 770 cells.
- Quality, go: seed-to-seed median footprint r at least 0.970 and not below `SETTLE` by more than 0.004 (mean over
  the three pairs); matched share at least 84 %; Minian-matched median r at least 0.945. No-go: seed-to-seed r below
  0.965.
- Split-half noise: reported, no line. The settle study could not explain why replay libraries read 13 % against
  D + R's 10 %; this arm tests whether the replay is the reason.
- Reported: the same for `OFF+R` and `OFF`, cells found by one seed only, adds and merges.

**P3. Settle cost.** The settle pass of `OFF+S` against that of `SETTLE`, both timed by qc_eval's own settle line
(frames per second), same binary, same session, same number of runs in parallel:

- Go ("halves the cost"): frames per second at least 1.6 x `SETTLE`'s, as the mean ratio over the sims and on the
  workshop recording. No gain: below 1.25 x.
- Reported with it: slow-loop work units and tile visits per settle frame, since the visit budget is per frame and a
  cost can show as fewer visits instead of fewer frames per second. These are qc_eval (native) numbers, not app
  numbers.

**Decision for question 1.** Replay off in the app config when P1 go, P2 cells go and quality go, and P3 go. If P1 is
partial, the answer is per part: what is lost, how much, and whether `REF+S` keeps it at what cost.

**P4. Reservoir fed during Discover (streaming).** New default-off library switch: look-back frames read during
Discover are also offered to the reservoir (arms and shares defined with the code; each arm is listed with its flags
before it runs). Base = the Discover configuration chosen by question 1 (`COMBO` or `OFF`). Each arm's Discover is
branched after Discover into: no drain (the library a live stream has), drain, drain + S.

- Measure: the no-drain library of the arm against the no-drain library of the base, as the share of the gap from
  base (no drain) to base + drain + S that it closes.
- Go: at least half of the gap closed on footprint r for all cells, with a CI of (arm minus base) that excludes 0;
  born second half not lower (CI includes 0 or better); bitten footprints (0.75-1 D) not higher (CI includes 0 or
  better); matched cells within 1 %; false cells not higher (CI includes 0 or lower); crosstalk not higher by more
  than 0.01.
- No-go: less than a quarter of the gap closed on footprint r for all cells, or false cells higher with a CI that
  excludes 0, or matched cells lower by more than 1 %.
- Screen: quick tier (5 sims). An arm is stopped after the first 3 sims when it closes less than a quarter of the gap
  on all of them or adds more than 5 false cells per sim. Only the best arm goes to the full tier.
- Reported: slow-loop work per Discover frame against the base (the look-back frames now also pay for residual
  scoring); visits, adds, refine accept rate; whether drain + S after the arm still equals the base's settled
  library (the arm must not make the settled result worse: footprint r for all cells not lower by more than 0.001).
- Held-out leakage, required before any run: a look-back frame keeps the held-out decision it had as a live frame
  (`is_test` of its slow-loop index, or the app's `HeldOutRecord`). A held-out frame may enter the reservoir only as
  a test frame and never reaches the footprint statistics; a fitting frame never becomes a test frame. Unit tests
  assert both. The same recording frame is never held twice by one tile. With the switch off the binary's outputs
  are byte-identical to the build before it.
- Fast loop: qc_eval is single-threaded and cannot measure blocking. The change is confined to the slow loop's
  look-back entry point (called by the slow worker with frames from the look-back worker); this is argued from the
  code and stated as not measured.

**P5. More real recordings.** Two sessions of the Samara data (animal 1560, Miniscope V4, 600 x 600, 30 fps, 18,000
frames; read-only): `10_43_21` (ewl -50) and `14_57_02` (ewl -30); spare `14_30_33`. No Minian, no ground truth.
Arms: D + R (with a second Refine as the null), `SETTLE` and/or `OFF+S` as decided by question 1, each followed by a
Refine; 3 slow seeds; `--fps 30 --motion`.

- Consistent with the workshop when, per session: seed-to-seed median footprint r of the settled library is not
  below D + R's by more than 0.005 and its matched share not below D + R's by more than 2 points; a Refine after the
  settle moves footprints by at most 1.5 x the second-Refine null. Not consistent: seed-to-seed r below D + R's by
  more than 0.01, or the Refine after it moves footprints more than 2 x the null.
- Reported: cell counts, split-half noise, and the replay-on against replay-off cell difference if both are run.

## Decided before the runs (after the targets, before any result)

- **Run slots.** A branched run shows two qc_eval processes while a branch runs (the waiting parent and the branch),
  and both count against the machine-wide cap of 6. To keep the study inside a day: on the sims the `OFF` Discover is
  branched after the drain into `OFF` and `OFF+S` only (`OFF+R` is not run); on the workshop recording each seed is one
  run, `OFF` + S + a Refine pass with `--settle-libs --wrap-libs --noise-dump` (library at the start of the settle =
  `OFF`, at the wrap = `OFF+S`, final = `OFF+S+R`), and `SETTLE` seed 1 is re-run beside them for the timing.
- **Timing reference on the sims.** `SETTLE` is re-run on the quick tier (5 sims) in the same batch as `OFF+S`; the
  speed ratio of P3 is the mean over those 5 sims. The other 9 sims use the settle study's `SETTLE` runs for quality
  only.
- **P4 arms** (binary `qc_eval-lbs2-b`; new switch `SlowLoop::set_lookback_reservoir`, qc_eval `--lookback-reservoir`):

  | arm        | added to the base's Discover flags                        | what it does                                                         |
  | ---------- | --------------------------------------------------------- | -------------------------------------------------------------------- |
  | `LBR-test` | `--lookback-reservoir test`                               | held-out look-back frames are offered to the reservoir (test side)   |
  | `LBR-all`  | `--lookback-reservoir all`                                | every look-back frame is offered, on the side it had as a live frame |
  | `LBR-half` | `--lookback-reservoir all --lookback-reservoir-share 0.5` | half of them (only if `LBR-all` passes the screen; cost arm)         |

  How a look-back frame enters the reservoir: it is scored by the current library's residual, as a live frame is; its
  slot keeps the frame's own index (so "events after a deletion" and the no-duplicate rule read the true frame) and is
  dated now for the age-fading priority; a frame a tile already holds is passed over; no probes, no ledger, no frame
  counter. Feeding look-back frames through the full `observe` during Discover is not run: it would give each frame a
  new held-out draw (a fitted frame could become a test frame) and count the same transients twice in the evidence
  ledger that add decisions use.

- **P5.** The Samara sessions have 17,880 and 17,876 frames (timestamps); all frames are read (no `--frames`), the
  settle is one pass of 17,856 frames (279 blocks of 64).
