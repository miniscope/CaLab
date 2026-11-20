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

## Results (19 Nov 2026)

Binaries: `qc_eval-lbs2-a` (settle flags as tail flags) and `qc_eval-lbs2-b` (`a` plus the default-off look-back
reservoir switch); `b` was used for every result run. Run trees under `$CALA_DATA`: `demix-suite/lbs2-full` (`OFF`,
`OFF+S`, links to the settle study's `SETTLE`, `COMBO+R`, `DR-main`), `demix-suite/lbs2-q` (`SETTLE`, `REF+S`, quick
tier), `demix-suite/lbs2-p4{a,t,c}` and `lbs2-p4` (streaming screen), `runs/lbs2/real` (workshop), `runs/lbs2/samara`
(Samara sessions), `runs/lbs2/bytecheck`.

### In plain language

- **Dropping the replay does not keep the quality on the sims.** Without it the settled library falls back to
  Discover + Refine level for overlapping cells: close-pair footprints, late-born cells, crosstalk and bitten
  footprints all lose what the replay gave. Isolated cells are unchanged. P1: no-go.
- **It does recover the cells on real data, and the real-data measures see no loss.** Workshop: 818 cells on average
  against 750, 536 Minian units matched against 514, the same seed-to-seed agreement, and split-half noise back at
  10 %. The two Samara sessions show the same, smaller (3-4 % more cells). These measures have no ground truth: they
  measure whether a footprint reproduces, and a bitten footprint reproduces.
- **It does not halve the settle cost in qc_eval.** Sims: 1.01 x the frames per second. Workshop: 1.3 x. Samara:
  1.07 x. qc_eval gives the slow loop a fixed work budget per frame, so the replay's cost shows mostly as fewer tile
  visits (1.1-1.5 x more visits without it). The 0.6 x is an app number and was not re-measured here.
- **The two things the replay does can be separated.** With the replay only in the settle (`--joint-update refine`)
  Discover is the replay-off Discover, so the workshop cells are all back (812 / 829 / 813), and on the quick tier
  the sims keep most of the quality (close-pair r 0.0009 lower, bitten share 0.04 higher with a CI that includes 0).
  The settle is as slow as with the replay on. The full tier of this arm was not run (see below).
- **Feeding look-back frames to the reservoir during Discover does not help.** Neither arm closes any of the gap to
  the settled library; the test-frames-only arm adds false cells and bites. P4: no-go, stopped at the screen.
- **The settle holds on two more recordings.** On both Samara sessions the settled library agrees between seeds as
  well as Discover + Refine does, and a Refine after it moves footprints no more than a second Refine does.

### Task 1. Settle flags as branch flags

`--settle-*` are in `Tail`/`TAIL_FLAGS` (qc_eval) and `run_arms.TAIL_FLAGS`; the settle now runs after the `drain`
branch point. Check on static_s5 (`runs/lbs2/bytecheck`, `cmpruns.py`: every output file, wall-time fields masked):
three separate runs (`COMBO`, `SETTLE`, `COMBO+R`) against one run branched after `discover` and one branched after
`drain`, each into the same three tails: all six branch directories are byte-identical to the separate runs. The
separate `COMBO` and `SETTLE` runs are byte-identical to the settle study's (`COMBO+R` too, apart from the files its
`--wrap-libs --noise-dump` add), and `b` with the reservoir switch off reproduces `a`.

One thing found on the way: `demix_suite.py --branch-after` keeps its temporary directory at `<root>/_branched/<sim>`,
so two suites must not share a root while they run (three of mine collided and were re-run in separate roots).

### P1. Replay off, full tier (14 sims)

| measure                          | `DR-main`    | `SETTLE` (replay on) | `OFF+S` (replay off) | `OFF+S` minus `SETTLE`     | `OFF+S` minus `DR-main`   |
| -------------------------------- | ------------ | -------------------- | -------------------- | -------------------------- | ------------------------- |
| footprint r, all cells           | 0.9879       | 0.9928               | 0.9886               | -0.0042 [-0.0048, -0.0037] | +0.0006 [-0.0001, 0.0013] |
| footprint r, isolated            | 0.9922       | 0.9922               | 0.9921               | -0.0001 [-0.0010, 0.0009]  | -0.0001 [-0.0009, 0.0013] |
| footprint r, close pairs         | 0.9843       | 0.9927               | 0.9850               | -0.0077 [-0.0087, -0.0071] | +0.0007 [-0.0005, 0.0017] |
| footprint r, born in second half | 0.9560       | 0.9773               | 0.9495               | -0.028 [-0.034, -0.019]    | -0.007 [-0.014, 0.003]    |
| footprint r, born in last 20 %   | 0.9306       | 0.9670               | 0.9272               | -0.040 [-0.051, -0.023]    | -0.003 [-0.021, 0.013]    |
| crosstalk (corr excess < 1 D)    | +0.150       | +0.074               | +0.141               | +0.067 [0.058, 0.076]      | -0.008 [-0.018, 0.001]    |
| bitten footprints, 0.75-1 D      | 0.486        | 0.168                | 0.461                | +0.293 [0.262, 0.323]      | -0.025 [-0.059, 0.008]    |
| matched / false cells per sim    | 400.1 / 21.9 | 401.9 / 17.1         | 401.5 / 21.9         | -0.4 / +4.8 [0.4, 9.2]     | +1.4 / 0.0                |

**No-go** (all-cell r, close-pair r, bitten share and crosstalk each pass their no-go line with a CI that excludes 0).
Against `DR-main` no group is worse. So look-back + settle without the replay is Discover + Refine on the sims; the
gain of the look-back path over Discover + Refine is the replay's, and it sits in overlapping cells (close pairs,
late-born cells next to older ones). Isolated cells do not need it.

Which replay matters, quick tier (5 sims), `REF+S` (replay only once the cell set is frozen) against `SETTLE`:

| measure                          | `SETTLE`     | `REF+S`      | difference                          |
| -------------------------------- | ------------ | ------------ | ----------------------------------- |
| footprint r, all cells           | 0.9934       | 0.9929       | -0.0005 [-0.0011, 0.0001]           |
| footprint r, isolated            | 0.9922       | 0.9923       | +0.0001 [-0.0013, 0.0018]           |
| footprint r, close pairs         | 0.9937       | 0.9928       | -0.0009 [-0.0017, -0.0001]          |
| footprint r, born in second half | 0.9816       | 0.9754       | -0.006 [-0.013, 0.002]              |
| crosstalk                        | +0.060       | +0.069       | +0.009 [-0.008, 0.027]              |
| bitten footprints, 0.75-1 D      | 0.148        | 0.190        | +0.042 [-0.005, 0.088]              |
| matched / false cells per sim    | 349.4 / 10.4 | 347.2 / 12.4 | -2.2 [-6.3, 1.9] / +2.0 [-2.7, 6.7] |

The replay in the settle carries most of the gain (about 0.007 of the 0.0077 on close pairs, 0.25 of the 0.29 on
bitten share, taking the full-tier gap as the scale); the replay during Discover adds the rest. By the P1 lines
`REF+S` is "partial" on five sims: close pairs miss by 0.0009 against a line of 0.001 with a CI that excludes 0,
bitten share misses the 0.03 line with a CI that includes 0. **The full tier of `REF+S` (9 more sims) was not run:**
its launch was refused by the session's permission system and is held for the PI's decision.

### P2. Workshop recording, three slow seeds (`runs/lbs2/real/off_agreement.md`, `ref_agreement.md`)

`SETTLE`, D + R: the settle study's runs. All settled libraries are followed by a Refine pass to measure what a
Refine would still do. Seed pairs 1-2, 1-3, 2-3.

| library                        | cells           | adds / merges (seed 1) | same cells found by two seeds: share; median r | Minian units matched; median r         | split-half noise | Refine after it moves (median) |
| ------------------------------ | --------------- | ---------------------- | ---------------------------------------------- | -------------------------------------- | ---------------- | ------------------------------ |
| D + R                          | 831 / 838 / 811 | 929 / 125              | 85-87 %; 0.976 / 0.971 / 0.974                 | 535 / 531 / 530; 0.953 / 0.958 / 0.957 | 9.9-10.7 %       | 10.0 / 9.8 / 10.9 % (the null) |
| `SETTLE` (replay on)           | 751 / 760 / 738 | 820 / 104              | 85-86 %; 0.978 / 0.975 / 0.977                 | 514 / 515 / 512; 0.949 / 0.950 / 0.949 | 13.1-13.2 %      | 11.8 / 11.2 / 11.3 %           |
| `OFF` (look-back, no replay)   | 812 / 829 / 813 | 851 / 70               | 83-85 %; 0.968 / 0.969 / 0.970                 | 525 / 531 / 530; 0.948 / 0.947 / 0.945 | -                | -                              |
| **`OFF+S`** (replay off)       | 812 / 829 / 813 | 851 / 70               | 84-87 %; 0.978 / 0.977 / 0.978                 | 535 / 538 / 534; 0.955 / 0.954 / 0.952 | 9.6-9.8 %        | 9.8 / 9.1 / 9.8 %              |
| **`REF+S`** (replay in settle) | 812 / 829 / 813 | 851 / 70               | 85-87 %; 0.976 / 0.973 / 0.976                 | 538 / 540 / 522; 0.947 / 0.949 / 0.949 | 12.2-12.9 %      | 12.0 / 11.6 / 11.2 %           |

- **Cells: go.** 818 on average (line 790), 536 Minian units matched (line 522). The replay during Discover is what
  costs the cells; with it off in Discover both arms have Discover + Refine's count within its seed range.
- **Quality: go** for `OFF+S` (seed-to-seed r 0.977-0.978, line 0.970; matched share 84-87 %; Minian r 0.952-0.955,
  line 0.945) and for `REF+S` (0.973-0.976; 85-87 %; 0.947-0.949).
- **Split-half noise follows the replay.** 9.6-9.8 % without it, 12-13 % whenever the settle uses it, at the same
  seed-to-seed agreement. That is the 13 % row the settle study could not explain. The replay's footprints share
  less between the two halves of the statistics the estimate is built from; the estimate is not comparable between
  replay and non-replay libraries, so it should not gate one against the other.
- Sims and recording disagree about the replay, and the reason is what each can see. The sims score bias against
  ground truth (a footprint bitten by its neighbour); the recording's measures score reproducibility. Minian r is
  slightly higher without the replay (0.954 against 0.949), which may only say that Minian's footprints are closer
  to the non-replay kind.

### P3. Settle cost (qc_eval, native; frames per second of the settle pass)

| data                             | `SETTLE` (replay on)   | replay off | ratio  | visits per settle frame, on / off |
| -------------------------------- | ---------------------- | ---------- | ------ | --------------------------------- |
| quick-tier sims (5), same batch  | 56-80 (mean of ratios) | 58-84      | 1.01 x | 1.81 / 2.03 (1.14 x more)         |
| workshop, seed 1 against 3 seeds | 33                     | 43-44      | 1.31 x | 0.41 / 0.56 (1.36 x)              |
| Samara, 2 sessions x 3 seeds     | 47-49                  | 51-52      | 1.07 x | 1.09 / 1.66 (1.52 x)              |

`REF+S` settles at `SETTLE`'s speed (sims 1.00 x; workshop 33-34 frames per second). The Samara arms ran in separate
batches under different load, so their ratio is rough. Work units per settle frame are within 5 % everywhere, by
construction of the budget. **Sims: no gain (line 1.25 x). Workshop: between the lines (1.6 x to go).** qc_eval
cannot confirm or refute the app's 0.6 x; that needs a headed-Chrome measurement.

### P4. Reservoir fed during Discover (quick tier, 5 sims; `demix-suite/lbs2-p4`)

Base = `COMBO` Discover (replay on, as P1 keeps it). `-nd` = the library at the end of Discover with no drain, which
is what a live stream has.

| measure                          | `COMBO-nd`   | `COMBO` + drain | `SETTLE`     | `LBR-all` no drain: minus `COMBO-nd` | `LBR-test` no drain: minus `COMBO-nd` |
| -------------------------------- | ------------ | --------------- | ------------ | ------------------------------------ | ------------------------------------- |
| footprint r, all cells           | 0.9906       | 0.9911          | 0.9934       | -0.0005 [-0.0013, 0.0005]            | -0.0007 [-0.0016, 0.0003]             |
| footprint r, close pairs         | 0.9905       | 0.9911          | 0.9937       | -0.0006 [-0.0021, 0.0007]            | -0.0010 [-0.0027, 0.0005]             |
| footprint r, born in second half | 0.9422       | 0.9556          | 0.9816       | -0.006 [-0.039, 0.024]               | -0.001 [-0.022, 0.026]                |
| footprint r, born in last 20 %   | 0.842        | 0.921           | 0.974        | -0.039 [-0.086, 0.045]               | -0.001 [-0.049, 0.063]                |
| bitten footprints, 0.75-1 D      | 0.271        | 0.253           | 0.148        | +0.025 [-0.032, 0.082]               | +0.084 [0.028, 0.140]                 |
| matched / false cells per sim    | 346.2 / 13.6 | 348.8 / 11.0    | 349.4 / 10.4 | +8.0 / +1.0                          | +8.0 / +5.8                           |

- The gap from `COMBO-nd` to `SETTLE` is +0.0028 on all-cell r and -0.12 on bitten share. **Both arms close none of
  it** (the point estimates go the wrong way). `LBR-test` also adds false cells and bites. **No-go**; `LBR-half` and
  the full tier were not run.
- The switch does what it says: on static_s5 18,507 look-back frames were scored during Discover and took 341,000
  event slots (`LBR-all`); 6,217 frames and 200,000 slots (`LBR-test`). Slow-loop work per Discover frame rose from
  3.95e7 to 4.76e7 (+20 %) and 4.23e7 (+7 %). With drain + settle after them the arms equal `SETTLE` (all-cell r
  -0.0000 and -0.0002).
- Why it does not help, as far as the counters go (not tested further): during Discover the slow loop spends about
  6 % of its work on refinement (2.3e6 of 3.95e7 units per frame); the rest goes to finding cells. Fresher test
  frames do not buy more refinement there. In the settle the cell set is frozen and all of the budget refines; that,
  with the renewed frames, is what the settle adds. The extra reservoir turnover instead feeds the add tests (more
  cells, matched and false).
- Held-out frames: a look-back frame keeps the side it had as a live frame; unit test
  `lookback_reservoir_keeps_the_held_out_side_and_stores_no_frame_twice` asserts that held-out frames only become
  test slots and leave the footprint statistics bit-for-bit unchanged, that fitting frames only become fitting slots,
  and that no tile stores a frame twice. Fast loop: the change is inside `SlowLoop::observe_lookback`, called by the
  slow worker; nothing was added to the fast loop. Not measured in the app.

### P5. Samara sessions (animal 1560; `runs/lbs2/samara/*_agreement.md`)

600 x 600, 30 fps (`--fps 30 --motion`), 17,879 and 17,875 frames, motion within about 4 px, 310-380 cells; neither
session needed the spare. Three slow seeds per arm; seed pairs 1-2, 1-3, 2-3. No Minian, no ground truth.

| session (ewl)  | library  | cells           | same cells found by two seeds: share; median r | split-half noise | a Refine after it moves (median) |
| -------------- | -------- | --------------- | ---------------------------------------------- | ---------------- | -------------------------------- |
| 10_43_21 (-50) | Discover | 370 / 360 / 377 | 88 %; 0.979 / 0.978 / 0.981                    | 16.1-17.0 %      | 18.2 / 14.6 / 15.0 %             |
|                | D + R    | 370 / 360 / 377 | 90 %; 0.989 / 0.987 / 0.989                    | 11.2-12.7 %      | 6.6 / 6.6 / 9.4 % (the null)     |
|                | `SETTLE` | 358 / 353 / 349 | 91 %; 0.991 / 0.992 / 0.990                    | 11.7-12.3 %      | 6.4 / 7.1 / 7.4 %                |
|                | `OFF+S`  | 376 / 368 / 363 | 91 %; 0.993 / 0.993 / 0.992                    | 10.9-11.2 %      | 5.4 / 5.3 / 6.0 %                |
| 14_57_02 (-30) | Discover | 329 / 311 / 328 | 87 %; 0.978 / 0.978 / 0.977                    | 16.2-17.4 %      | 16.8 / 17.7 / 16.4 %             |
|                | D + R    | 329 / 311 / 328 | 89 %; 0.989 / 0.988 / 0.989                    | 11.2-12.7 %      | 6.8 / 8.0 / 8.9 % (the null)     |
|                | `SETTLE` | 308 / 319 / 312 | 90 %; 0.989 / 0.989 / 0.990                    | 12.3-13.5 %      | 8.2 / 8.0 / 8.1 %                |
|                | `OFF+S`  | 321 / 327 / 325 | 91 %; 0.990 / 0.991 / 0.989                    | 10.8-11.3 %      | 5.8 / 6.4 / 6.0 %                |

- **Consistent with the workshop, both sessions, both settle arms**: seed-to-seed r is at or above D + R's (line: not
  more than 0.005 below), the matched share is 1-2 points above it, and a Refine after the settle moves footprints
  0.7-1.0 x the second-Refine null (line 1.5 x).
- The replay costs cells here too, fewer than on the workshop recording: 353 against 369 (-4 %) and 313 against 324
  (-3 %); workshop 750 against 818 (-9 %). The split-half noise reading is again higher with the replay.
- The settle check interval differs from the settle study's workshop runs (1200 frames here, 1800 there), which
  moves visit counts by about 1 % and nothing else.

### Decision

- **Question 1.** P1 no-go, P2 go, P3 no gain on sims and between the lines on the workshop recording. By the rule
  the replay is not dropped. Per part: the replay matters for overlapping cells (close-pair r +0.008, bitten share
  -0.29, crosstalk -0.07, late-born r +0.03 on the sims) and for nothing else measured; its cost is 3-9 % of the
  cells on real recordings, taken during Discover, and 0-25 % of the settle's frames per second in qc_eval. Most of
  the quality comes from the replay in the settle, and all of the cell loss from the replay in Discover, so the
  candidate that keeps both is the replay in the settle only (`REF+S`): go on the workshop recording, partial on five
  sims, full tier not run.
- **Question 2.** No-go. A live stream keeps the Discover-only library (`COMBO-nd`: all-cell r 0.9906 against 0.9934
  settled; bitten share 0.27 against 0.15), which is still better than Discover + Refine on overlapping cells
  (bitten share 0.49) because the replay runs during Discover.
- **Question 3.** The settle result holds on both Samara sessions.

### Not done

- `REF+S` on the full tier (held, see P1) and on the Samara sessions.
- `OFF+R`, and `OFF`'s metrics on the workshop Refine reference (dropped for run slots before the runs).
- `LBR-half`; any app build or headed-Chrome timing; the settle study's open items (every-fourth-frame arm, the stop
  rule acting, "extend when not settled").
