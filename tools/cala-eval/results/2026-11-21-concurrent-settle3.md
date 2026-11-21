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

## Results

(below, after the runs)
