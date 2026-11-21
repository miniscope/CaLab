# Concurrent settle, round 3: why Discover visits less, and which workshop cells go missing (21 Nov 2026)

Follow-up to [2026-11-20-concurrent-settle2.md](2026-11-20-concurrent-settle2.md) (round 2, PR #451). Round 2 left
two effects unexplained, on the `--offered-fps 30` clock with four visit workers:

1. Discover makes 10-14 % fewer of its own tile visits with the settle on, the frames-only arm `CS2F` included,
   while the visit workers are as busy as in the baseline `V30`.
2. The workshop recording ends with about 4.5 % fewer cells (904-925 against 952-956).

This round is a diagnosis: instrument, find the cause, look for a simple fix. The plan, the measures and every pass
line below were written before the runs they judge (commit order shows it). Byte-check runs on static_s5 and the
re-analysis of round 2's saved run trees are not result runs.

## What was added (all default off)

- **Engine counters** (`SlowLoop::due_diag`): how often a tile goes from "not due" to "due", by cause: a live frame
  took reservoir slots, a look-back frame took slots, an edit to a cell that overlaps the tile (made by a visit of
  another tile), the tile's own visit left it due. Read-only accessors for the tiles' slot counters and the tiles
  with a visit out. Nothing reads the counters back.
- **`qc_eval --visit-diag`** (with `--offered-fps` and `--visit-workers`): `visit_diag.tsv`, one row per visit job
  (virtual time, tile, when the tile was first seen due, how long it waited for the hand-out, the slot count at
  hand-out, work by stage, cells in the job's zone, edits), and `visit_diag.txt`:
  - due events by cause;
  - the slow worker's time by message kind (live batches, visit results, need-driven look-back frames, settle
    answers) and how long messages of each kind waited in its inbox;
  - the visit workers' idle time by cause: nothing due; a tile due but every due tile's zone held by a visit in
    flight; its own result waiting for the slow worker (by the kind of message the slow worker was on).
- **Two diagnosis knobs**: `--cs-answer-scale 0` (the statistics update of the re-read frames is applied but costs
  the slow worker no time) and `--owner-load MS:PERIOD` (the slow worker loses MS ms every PERIOD ms and nothing
  else changes).
- **One fix candidate**: `--csettle-yield N`: the slow worker handles a settle answer N frames at a time and goes
  back to its inbox in between, so waiting batches and visit results come first and visits are handed out between
  the pieces (in place of the whole 16-frame answer in one go).
- **`concsettle3_cells.py`**: the cells only one of two libraries has, against the same comparison between two
  baseline seeds.

## Candidates for the missing visits, and what each predicts

A visit worker gets a visit when a tile is due (6 new reservoir slots, or an edit to a cell that overlaps it) and
its zone (the tile plus every cell that reaches into it) overlaps no visit in flight. There is no work budget with
visit workers: every due tile is handed out as soon as a worker and its zone are free. Fewer visits therefore mean
one of:

| candidate                                              | signature in `--visit-diag`                                                              | signature in the two knob arms                         |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| a. slow worker's time on the re-read frames            | workers idle with their result waiting while the slow worker is on a settle answer       | `CS2F-free` restores the visits; `V30-load` loses them |
| b. tiles come due less often                           | fewer due events (which cause: slots, look-back slots, edits)                            | `CS2F-free` still short; `V30-load` not short          |
| c. due tiles wait longer for a hand-out                | longer wait per job, more slots at hand-out; idle time "zone held" up                    | depends on why they wait                               |
| d. the look-back worker competing                      | fewer need-driven look-back frames, fewer look-back due events                           | `CS2F-free` still short                                |
| e. accounting artefact                                 | visits = jobs + visits the slow worker makes itself; the sum moves but the jobs do not   | none                                                   |
| f. each visit costs more (not on the list I was given) | same worker-busy time, fewer jobs, more work per job (which stage; more cells per zone?) | `CS2F-free` still short; `V30-load` not short          |

Seen before any run of this round, in round 2's saved run lines: the visit work is about the same and the visits
are fewer (workshop seed 1: 39,567 jobs at 72 % worker time in `V30`, 33,449 jobs at 70 % in `CS2F`; refinement
work per live frame 43.6 M against 48.2 M units). That points at f, with the cause of f open.

## Phase A: diagnosis runs

Round 2's flags and binary behaviour (`concsettle3.sh`; binary `qc_eval-cs3-a`), all with `--visit-diag`:

| run                         | flags added to round 2's `D`            | what it answers                                                                                   |
| --------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| workshop `V30` seed 1       | `--csettle 0`                           | baseline with the instrument; must equal round 2's run                                            |
| workshop `CS2F` seed 1      | `--csettle 0.667 --csettle-mode frames` | the same for the frames-only arm                                                                  |
| workshop `CS2F-free` seed 1 | as `CS2F` with `--cs-answer-scale 0`    | the re-read frames without their cost to the slow worker                                          |
| workshop `V30-load` seed 1  | as `V30` with `--owner-load 61:267`     | the cost to the slow worker without the frames (61 ms per 267 ms: `CS2F`'s 23 % in 2,246 answers) |
| `10_43_21` `V30` seed 1     | `--csettle 0`                           | the same two on a Samara recording                                                                |
| `10_43_21` `CS2F` seed 1    | `--csettle 0.667 --csettle-mode frames` |                                                                                                   |

**A0. The instrument changes nothing.** `--visit-diag` on against off on static_s5 (4800 frames, `V30` and `CS2F`):
every other output file identical apart from wall-time fields. The two workshop runs and the two `10_43_21` runs
reproduce round 2's runs of the same arm and seed (same cell count, visits, jobs, adds, merges, and identical
`footprints_settle0.bin`). If they do, round 2's 32 runs are this round's baseline and are not rerun.

**A1. Cause of the missing visits.** Named from the table above with the numbers: due events by cause, wait per
job, slots at hand-out, work per job by stage, cells per zone, idle time of the workers by cause, and the two knob
arms. A cause is "the" cause if its knob arm or its counters account for at least two thirds of the shortfall in
jobs; otherwise the split is reported.

**A2. Which workshop cells go missing** (round 2's libraries at the end of the stream, `settle0`, three seeds;
`concsettle3_cells.py`). Reported against the null (`V30` seed against `V30` seed): how many cells only one side has,
and for those their birth time, peak z, transients, held-out marginal z, share on probation, footprint size,
overlap with neighbours, share that matches a Minian unit (agreement with a reference that has wrong and missing
cells, not recall), and what the other run did at the same place (a cell with another shape, added and merged away,
added and deleted, never added). "Likely false" is said only if the one-sided `V30` cells are below the matched
cells on held-out z and Minian agreement by more than the null's one-sided cells are; "the same marginal cells two
baseline seeds disagree on" if they equal the null's.

## Phase B: the fix, if phase A finds one

Lines (from the task; written here before any phase-B run):

- **F1. Ordinary visits within 5 % of `V30`** on each of the three recordings (mean over seeds).
- **F2. Workshop cells within 2 % of `V30`** (mean over the three seeds, at the end of the stream).
- **F3. Gap closed still at least 60 %** on each recording (round 2's measure and its `V30` denominators: live
  seed-to-seed footprint r, `lookback_settled.py`).
- **F4. 0 dropped frames** in every run.
- Seeds: workshop 1-3, Samara `10_43_21` and `14_57_02` 1-2, paired with round 2's `V30` runs of the same seed.
  Paired differences with a 95 % CI over the 7 recording-seeds for visits and cells (two seeds on a Samara
  recording: its own CI is not meaningful and is not given); the gap share as in round 2.
- **T0. Flags off = main** (binary `qc_eval-main-9ed6e4bb`): static_s5, first 4800 frames, every output file,
  wall-time fields masked: lock-step with an end settle; `V30`; `CS2`; `CS2F`.

The fix arm (at most two) is named in this file, with why phase A points at it, in a commit of its own before its
runs. If phase A shows that the visits are fewer because each one does more, or because fewer are needed, no
scheduling arm is forced: the report then says that the 5 % visits line measures the wrong thing, and F2-F4 are
read on `CS2F` as it stands.

## Results, phase A

Binary `qc_eval-cs3-a` (this branch at the commit that adds the instrument; byte-identical when rebuilt). Run trees
under `$CALA_DATA/runs/concsettle3`: `t0` (byte checks), `real` (`*_diag.md`), `cells` (the one-sided cells). Tools:
`concsettle3.sh`, `concsettle3_diag.py`, `concsettle3_cells.py`. Peak memory of a run: 1.2-1.5 GB.

Two notes on order. The cell table of A2 was first produced from round 2's saved libraries a few minutes before the
commit that carries the A2 rule (it is a re-analysis, not a run); the rule was written without changing it after.
The 4800-frame static_s5 byte-check runs were read with the instrument before the real runs finished; they showed
the same picture and are not counted as results.

### T0 and A0: pass

- Against `qc_eval-main-9ed6e4bb`, static_s5, 4800 frames: lock-step with an end settle (19 files), `V30`, `CS2` and
  `CS2F` (20 files each) are identical apart from wall-time fields.
- `--visit-diag` on against off (`V30`, `CS2F`): identical apart from wall-time fields; the two new files are extra.
- Workshop seed 1 and `10_43_21` seed 1, `V30` and `CS2F`, rerun with the instrument: `footprints_settle0.bin` is
  byte-identical to round 2's run in all four (and the settled `footprints.bin` on `10_43_21`). So round 2's runs are
  the baseline of this round.

### A correction to round 2's visit count

Round 2's "ordinary visits" were `SlowLoop::stats().visits` at the end of the run. That number also holds the
visits of the end pass after the stream (5,236 in workshop `V30` seed 1). The visits Discover makes during the stream
are the visit jobs. On jobs the shortfall of `CS2F` is about as large (round 2's runs, mean over seeds):

| recording  | `V30` visit jobs in the stream | `CS2F`                   | shortfall |
| ---------- | ------------------------------ | ------------------------ | --------- |
| workshop   | 39,567 / 38,360 / 39,913       | 33,449 / 32,972 / 34,063 | -14.7 %   |
| `10_43_21` | 72,999 / 71,215                | 61,804 / 65,207          | -11.9 %   |
| `14_57_02` | 74,189 / 73,578                | 69,887 / 68,461          | -6.4 %    |

So candidate e (an accounting artefact) is not the cause. Line F1 below is read on visit jobs in the stream.

### A1. Why Discover makes fewer visits

Seed 1, 30 fps, four visit workers (`real/ws_diag.md`, `real/10_43_21_diag.md`). Times are shares of the stream on
the virtual clock.

| measure                                                        | workshop `V30` | workshop `CS2F`   | workshop `CS2F-free` | workshop `V30-load` | `10_43_21` `V30` | `10_43_21` `CS2F` |
| -------------------------------------------------------------- | -------------- | ----------------- | -------------------- | ------------------- | ---------------- | ----------------- |
| visit jobs in the stream                                       | 39,567         | 33,449 (-15.5 %)  | 36,004 (-9.0 %)      | 37,476 (-5.3 %)     | 72,999           | 61,804 (-15.3 %)  |
| time of a visit job on its worker, mean                        | 43.9 ms        | 50.2 ms (+14.5 %) | 48.4 ms (+10.4 %)    | 43.9 ms (+0.1 %)    | 23.1 ms          | 25.5 ms (+10.4 %) |
| work per job: refinement, M units                              | 9.2            | 13.1 (+43 %)      | 12.4 (+35 %)         | 8.7 (-5 %)          | 5.4              | 7.9 (+47 %)       |
| work per job: merge tests, M units                             | 18.3           | 22.8 (+25 %)      | 21.9 (+20 %)         | 18.6 (+2 %)         | 2.8              | 3.2 (+12 %)       |
| work per job: adds, M units                                    | 36.5           | 39.2 (+7 %)       | 37.9 (+4 %)          | 36.8 (+1 %)         | 20.9             | 23.0 (+10 %)      |
| refinements accepted per job                                   | 0.28           | 0.44 (+56 %)      | 0.41 (+46 %)         | 0.28 (+1 %)         | 0.14             | 0.20 (+46 %)      |
| total work of the visit jobs, 1e12 units                       | 3.39           | 3.29 (-2.9 %)     | 3.41 (+0.6 %)        | 3.22 (-5.2 %)       | 3.22             | 3.02 (-6.2 %)     |
| visit workers busy                                             | 72.3 %         | 70.0 %            | 72.6 %               | 68.6 %              | 70.7 %           | 66.0 %            |
| idle: nothing due                                              | 0.6 %          | 0.6 %             | 0.6 %                | 0.5 %               | 2.0 %            | 1.4 %             |
| idle: a tile due, but every due tile's zone held               | 21.9 %         | 16.0 %            | 21.4 %               | 18.8 %              | 21.4 %           | 24.1 %            |
| idle: result waiting, slow worker on a settle answer (or load) | 0              | 6.5 %             | 0                    | 5.0 %               | 0                | 2.7 %             |
| idle: result waiting, slow worker on something else            | 4.3 %          | 6.2 %             | 4.6 %                | 6.5 %               | 4.2 %            | 4.3 %             |
| slow worker's time on settle answers (or load)                 | 0              | 23.2 %            | 0 (not charged)      | 22.8 %              | 0                | 8.5 %             |
| a due tile waits for its hand-out, mean                        | 0.79 s         | 1.02 s            | 0.91 s               | 0.85 s              | 0.25 s           | 0.38 s            |
| reservoir slots at hand-out (a tile is due at 6)               | 15.9           | 18.8              | 17.5                 | 16.6                | 9.9              | 11.6              |
| tiles coming due: by live-frame slots                          | 39,748         | 33,241            | 35,912               | 38,542              | 79,187           | 66,707            |
| tiles coming due: by an edit of another tile's visit           | 5,866          | 5,586             | 5,743                | 5,407               | 13,180           | 11,601            |
| need-driven look-back: tiles it made due                       | 0              | 0                 | 0                    | 0                   | 0                | 0                 |
| dropped frames; longest wait of a batch                        | 0; 1.8 ms      | 0; 43 ms          | 0; 1.5 ms            | 0; 61 ms            | 0; 1.9 ms        | 0; 1.9 ms         |

What it says:

1. **The visit workers have no slack in the baseline.** A worker is idle for want of a due tile 0.6 % of the time on
   the workshop recording (2 % on `10_43_21`). A due tile waits 0.8 s for its hand-out and has 16 new slots by then,
   against the 6 that make it due. The rest of the idle time is zones: a tile is due, but its zone overlaps a visit
   in flight (about 21 %). So the number of visits is what fits into the workers' time, and anything that takes
   worker time or makes a visit longer shows up as fewer visits.
2. **Each visit does more (the larger share).** With the re-read frames in the statistics a visit job accepts about
   50 % more refinements and costs 10-15 % more worker time (refinement +43 to +47 %, merge tests +12 to +25 %, adds
   +7 to +10 %). The total work of the visit jobs is the same within 3-6 %. This is the settle doing its work
   through the ordinary visits, which is where round 2 found the gain (its settle jobs changed almost nothing). With
   the slow worker's cost taken away altogether (`CS2F-free`) the workshop run is still 9.0 % short.
3. **The slow worker's time on the settle answers (the smaller share).** One answer is 16 frames in one message,
   61 ms on the workshop recording, and a finished visit waits for it: 6.5 % of the workers' time on the workshop
   recording, 2.7 % on `10_43_21`. `CS2F` against `CS2F-free`: 6.5 points of the 15.5.
4. **Split on the workshop recording: about 58 % dearer visits, 42 % slow-worker time.** Neither is two thirds, so
   by the rule above it is a split. On `10_43_21` there is no knob arm; the slow worker is less loaded there (8.5 % of its time on settle answers against 23 %, 2.7 % of the workers' time lost behind them against 6.5 %), so its share is smaller.
5. **Not the cause:**
   - tiles coming due less often: due events equal jobs one for one and fall because a tile that waits longer
     collects more slots per visit (15.9 to 18.8);
   - the look-back worker: it delivered the 2.00 frames per live frame asked for, and need-driven look-back frames
     made no tile due in any arm;
   - accounting: see the correction above.
6. `V30-load` (the slow worker loses 61 ms every 267 ms, no re-read frames) is a rough cross-check only: its load
   lands in front of the live batches (a batch waits 32 ms on average, 0.4 ms in `CS2F`). It loses 5.3 % of the
   jobs with no change in the cost of a job.

**The ceiling of any scheduling fix on the slow worker is `CS2F-free`: -9.0 % visit jobs** (workshop seed 1). A
priority, a cap on the statistics time or smaller messages can only move `CS2F` towards it. So no such fix can meet
a 5 % line on visits on the workshop recording.

### A2. Which workshop cells go missing

Round 2's libraries at the end of the stream, three seeds (`cells/ws_settle0.md`, `.tsv`). A match is Hungarian on
footprint r >= 0.7.

| group (cells per run)                                        | born, frame (median) | peak z | held-out marginal z | on probation | footprint area, px | matches a Minian unit | most common finding at the same place in the other run |
| ------------------------------------------------------------ | -------------------- | ------ | ------------------- | ------------ | ------------------ | --------------------- | ------------------------------------------------------ |
| null: `V30` cells matched in another `V30` seed (785)        | 1,690                | 21.9   | 3.55                | 4 %          | 418                | 64 %                  |                                                        |
| null: `V30` cells with no match in another `V30` seed (169)  | 5,210                | 15.9   | 0.83                | 15 %         | 332                | 28 %                  | never added, a neighbour holds its light: 41 %         |
| matched `V30` / `CS2F`, `V30` side (784)                     | 1,650                | 22.0   | 3.77                | 4 %          | 423                | 65 %                  |                                                        |
| matched `V30` / `CS2F`, `CS2F` side (784)                    | 1,700                | 22.1   | 3.46                | 4 %          | 583                | 66 %                  |                                                        |
| `V30` only (170)                                             | 6,820                | 15.5   | 0.60                | 15 %         | 316                | 25 %                  | never added, a neighbour holds its light: 47 %         |
| `CS2F` only (137)                                            | 4,620                | 15.9   | 0.94                | 13 %         | 545                | 30 %                  | never added, a neighbour holds its light: 37 %         |
| core `V30` only: in >= 2 `V30` seeds, in no `CS2F` seed (31) | 7,470                | 14.7   | 0.43                | 11 %         | 313                | 18 %                  | never added, a neighbour holds its light: 53 %         |
| core `CS2F` only (22)                                        | 3,090                | 14.6   | 0.71                | 5 %          | 628                | 27 %                  | never added, a neighbour holds its light: 42 %         |

`CS2` against `V30` reads the same (171 `V30` only, 128 `CS2` only; core 30 against 17). On the Samara recordings
the one-sided counts are symmetric (`10_43_21`: 43 `V30` only, 54 `CS2F` only; `14_57_02`: 37 and 31).

- **There are not 30-45 identifiable missing cells.** Two baseline runs with different seeds already disagree on
  169 cells each. `V30` against `CS2F` of the same seed: 170 only in `V30`, 137 only in `CS2F`. The difference in
  cell count is the difference of those two pools.
- **The cells only `V30` has are the marginal ones two baseline seeds also disagree on**: born late (median frame
  6,800 of 18,000 against 1,700 for matched cells), peak z 15.5 against 22, held-out marginal z 0.60 against 3.8,
  15 % on probation, a Minian unit matched for 25 % against 65 %. The null's one-sided cells read 0.83 and 28 %. By
  the rule above that is "the same marginal population", not "likely false cells" as a group.
- **The core set is weaker still, and small.** 31 cells per run are in at least two `V30` seeds and in no `CS2F`
  seed: held-out z 0.43, Minian 18 %. 22 per run are the reverse. Net: about 9 cells per run that the baseline
  finds repeatably and the settle arm does not.
- **How they go missing: mostly never added.** For 47-53 % of the `V30`-only cells the other run has no cell and no
  add at that place and a neighbour's footprint correlates with the missing one at r >= 0.3 (null: 41 %). Added and
  merged away: 10-11 % (null: 15 %). The `CS2F` ledger agrees: 9 % fewer adds and 26 % fewer merges than `V30`.
- **The footprints of the settle arm are larger from early on**: median area 392 px against 319 at frame 2250, 597
  against 395 at the end of the stream (a settled baseline library: 640). A larger footprint leaves less light
  around a cell for a candidate to form on. That is the likely reason for fewer marginal adds; it was not tested by
  an arm of its own.
- **The cell deficit does not follow the visit deficit in time.** Workshop, three seeds, `CS2F` minus `V30` cells at
  the checkpoints (every 2250 frames): -26, -27, -28, -43, -30, -39, -49, -33 (end), while the cumulative shortfall
  in visit jobs goes from -1.9 % to -15.5 % (seed 1). The deficit is there after 75 s, when hardly a visit is
  missing. The single-seed knob arms end at 911 (`CS2F-free`) and 926 (`V30-load`) cells against 952; one seed each,
  inside the spread of the settle arms (904-925), so nothing is read from them on cells.

## Phase B, registered before its runs

Phase A says a scheduling fix on the slow worker cannot meet F1: the ceiling is -9.0 % on the workshop recording.
What can still be done simply, and what is still open:

| arm         | flags                             | seeds                 | why                                                                                                 |
| ----------- | --------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------- |
| `CS2F-Y1`   | `CS2F` with `--csettle-yield 1`   | all 7 recording-seeds | the app design: the slow worker takes an answer one frame at a time and serves its inbox in between |
| `CS2F-free` | `CS2F` with `--cs-answer-scale 0` | workshop 2 and 3      | the ceiling and the split on three paired seeds (seed 1 is in phase A)                              |
| `V30-W3`    | `V30` with three visit workers    | workshop 1-3          | control: does the workshop cell count depend on how many visits fit, with no change in content?     |

**Predictions, written before the runs.** `CS2F-Y1` recovers most of the 6.5 % (workshop) and 2.7 % (`10_43_21`) of
worker time lost behind settle answers: visit jobs about -9 to -10 % on the workshop recording, about -8 to -10 %
on `10_43_21`, about -5 % on `14_57_02`. So **F1 is expected to be missed** on at least the workshop recording; the
arm is run as the way the app would be built, not as a candidate to pass F1. F2 (workshop cells within 2 %) is
expected to be missed too if the cell deficit is a matter of content (phase A2). F3 and F4 are expected to hold;
the longest wait of a batch should fall from 43-53 ms to a few ms. `V30-W3`: if the cell count follows capacity it
loses clearly more than 2 % of its cells with about a fifth fewer visits; if it stays within 2 % the cell deficit
of the settle arms is not a matter of visit count.

Checks on `CS2F-Y1`: every run must still deliver 2.00 re-read frames per live frame (if the pieces slow the
requests down, a lower share of the gap would be a matter of dose). On static_s5, `--csettle-yield 16` (a whole
answer per piece) must equal `CS2F` byte for byte.

Lines F1-F4 as written above, F1 on visit jobs in the stream against round 2's `V30` runs of the same seed.

## Results, phase B

(below, after the runs)
