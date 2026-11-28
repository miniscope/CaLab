# Repeatable runs on real data: pinned flat field and back state, queued settle visits (28 Nov 2026)

Branch `feat/cala-repeatable-pins`, stacked on `feat/cala-repeatable-final-settle` (#579). Code at
fe3e052d for every run below unless a row names another commit. Headed Chrome, real GPU,
`memory-measure.mjs --lookback`. Recording: `ws10`, the first ten AVIs of the workshop recording
(10,000 frames), at a target of 30 fps. Evidence: `~/Projects/cala-data/runs/repeatable/p2c/`
(NOTES.md, runs/, gt-eval.jsonl, eval-stats.txt).

## Why ws10 was not repeatable

Two ON runs of #579 (49994e4e) ended Discover with different cells (Extract 632 vs 623). Their
determinism logs first differ at a visit taken at frame 7696, with no look-back answer or applied
visit differing before it. The log had no record of the live frames themselves.

The batch rows now carry hashes of the preprocessed frames, the traces and the noise map. With
them (be23fadc), the first difference is the live input itself, before anything in the slow loop:

| first difference (rA1 vs rA2) | observed frame |
| ----------------------------- | -------------- |
| `batch frames` at batch 2984  | 2936           |
| `batch traces`, same batch    | 2936           |
| `take` / `apply`              | 2944           |
| `ans need` / `ans csettle`    | 3032           |

The flat field caused it:

- Stage A applied a new flat-field map at the first batch boundary after the map arrived.
- Stage A fed the estimator only while its queue had room, so which batches made a map also depended
  on timing.

The 1,000-frame sim clips never get a map, so they could not show this.

## The change

- **Flat field (stage A).** A repeatable run that starts at a target speed feeds every batch to the
  estimator. The estimator acks each push with its newest map's sequence number. Each map takes
  effect `FLAT_APPLY_LAG` (128) frames after the end of the batch whose push made it. Stage A waits
  there if the estimator is late. After 30 s without an answer, maps apply as they arrive. At Max
  nothing changes.
- **Look-back pins.** Stage C stamps each batch with the map in force and its newest back-state
  snapshot. Look-back requests issued at that batch end name both (`LookbackPins`). The look-back
  worker preprocesses with exactly that snapshot and map, waiting for them, however much newer
  input has arrived meanwhile.
- **Settle visit slots.** Each visit worker has 2 slots in a repeatable Final settle, and its jobs
  queue. The lag is the whole pieces that let the slots make 1.25 x the visit rate: 16 frames with
  8 slots.

## Acceptance

ws10 at 30 fps, ON:

| runs               | commit    | Discover end         | final library | Extract digest (cells/ids/traces) | detlog `--settle` |
| ------------------ | --------- | -------------------- | ------------- | --------------------------------- | ----------------- |
| pA1, pA2 (detlog)  | af20aa12  | 645 ids, one library | 4a5052d8 ×2   | 646 / cbfa1951 / 2e956f9d ×2      | identical         |
| fA1, fA2 (detlog)  | fe3e052d  | same                 | 4a5052d8 ×2   | 646 / cbfa1951 / 2e956f9d ×2      | identical         |
| sA1, vI1, wA1, wA2 | 3 commits | –                    | 4a5052d8 ×4   | –                                 | –                 |

- All eight ON runs ended with the same final library, across three commits that differ only in the
  settle's slots or in logging.
- Barrier waits were 1 per run, and no batch was lost.

1,000-frame sim clips at 60 fps, with `--detlog --extract`:

| arm                  | runs | Extract digest sets | final library sets | detlog `--settle` pairs with a finding |
| -------------------- | ---- | ------------------- | ------------------ | -------------------------------------- |
| s5 default           | 3    | 1                   | 1                  | 0/3                                    |
| s6 default           | 3    | 1                   | 1                  | 0/3                                    |
| s5 `?debug&lbpool=0` | 3    | 1                   | 1                  | 0/3                                    |

## Speed of the Final settle (ws10, 30 fps, no detlog, unloaded, OFF and ON alternating)

| arm                   | settle (s)   | holds / waited             |
| --------------------- | ------------ | -------------------------- |
| OFF (`&repeatable=0`) | 65.7, 65.5   | 0                          |
| ON                    | 92.6, 92.6   | 643 / 30.3 s, 641 / 29.7 s |
| ON at #579 (47e7993b) | 102.1, 103.9 | 958 / 37.3 s, 996 / 39.5 s |

- The cost fell from +65 % to +41 %. It is still above the 15 % target.
- Settle time minus the waits equals OFF. The remaining cost is all waiting.

The waits do not depend on queue depth. Variants on ws10, one run each, waited about 30 s
whatever the setting:

| slots per worker    | lag (frames) | settle (s) | holds | of which "owed" | owed max |
| ------------------- | ------------ | ---------- | ----- | --------------- | -------- |
| 2                   | 8            | 102.6      | 970   | 0               | 3        |
| 2                   | 12           | 92.8       | 730   | 86              | 8        |
| 2                   | 16 (kept)    | 93.0       | 636   | 458             | 8        |
| 3                   | 24           | 94.8       | 639   | –               | 8        |
| 4                   | 32           | 93.9       | 685   | –               | 8        |
| 2, owed limit + lag | 16           | 92.9       | 711   | 537             | 14       |

- At a short lag the settle waits for visits not back at their due point: 8 frames of feed is
  about 50 ms.
- At a longer lag the visits owed climb to the hold threshold, and the hold applies a recent visit
  early. Raising the threshold only let the owed count climb further.
- A visit's tile and its neighbours stay out until the visit is applied. With more frames between
  hand-out and apply, fewer tiles can be visited, so hand-out falls behind the rate.
- This trade-off is built into applying at fixed frames. A due point that follows a visit's
  expected cost (for example its job size) might break it. That has not been measured.

At Max the flat-field schedule is off. Repeatable ON vs OFF ran Discover at 249 vs 251 fps
(40.2 vs 39.9 s), with no settle holds.

## Repeatable off matches main

Main (089f3803) and the branch, both OFF on s5 at 60 fps, 2 runs each:

- The Discover-end ids (2fff5a), final ids (9e0964) and Extract cells and ids (393 / 9050c3e4)
  were the same in all four runs.
- The look-back counters were identical: need 1657 / 1081, Background settle 800 / 523 / 261 / 16.
- The settle took 3.7 s in every run, with no holds.
- In detlog-diff, branch vs main shows the same kind of first difference as main vs main. The two
  pairs even land on the same visit hashes.

## Quality

### Sims: 10 clips vs ground truth

The decision rule was declared before any result was read, as for #567 and #579:

- d = ON − mean(OFF₁, OFF₂) per clip, with a 95 % t-interval over 10 clips.
- The clips are sims-v3 motion and static, s5–s9, 1,000 frames each, at 60 fps.
- Scores come from `gtscore.py`: Hungarian matching of detectable units at r ≥ 0.7.

| library      | n   | matched d (95 % CI) | unmatched d (95 % CI) | rule |
| ------------ | --- | ------------------- | --------------------- | ---- |
| Discover end | 10  | −4.3 [−11.0, +2.4]  | −0.1 [−2.6, +2.4]     | pass |
| final        | 10  | −1.6 [−8.8, +5.6]   | +0.8 [−0.9, +2.5]     | pass |

- The Discover-end scores of the ON runs equal #579's ON runs on all 10 clips. The clips have no
  flat-field map, and the pins name the same inputs there.
- The final matched count moved by −2 to +2 cells against #579, and was unchanged on 4 of the 10
  clips. That movement comes from the settle's new lag.

### ws10: ON vs OFF, agreement only

There is no ground truth for ws10. Footprints were matched by Hungarian assignment on Pearson r,
and a pair counts as matched at r ≥ 0.7.

| pair              | library      | matched   | only in first / second | median r |
| ----------------- | ------------ | --------- | ---------------------- | -------- |
| ON vs OFF₁        | final        | 568       | 78 / 72                | 0.980    |
| ON vs OFF₂        | final        | 565       | 81 / 80                | 0.980    |
| OFF₁ vs OFF₂      | final        | 579       | 61 / 66                | 0.985    |
| ON vs OFF₁ / OFF₂ | Discover end | 553 / 560 | 92/83, 85/82           | 0.977    |
| OFF₁ vs OFF₂      | Discover end | 580       | 56 / 62                | 0.986    |

- ON agrees with OFF a little less than two OFF runs agree with each other: about 12 fewer matched
  cells of about 640.
- On the sims, a different apply order acts like a different seed, and the same holds here.

## Caveats

- The measurement driver starts every run with a fresh browser profile. A user's second run of the
  same recording starts from the flat-field map cached by the first, so the two runs differ.
- A lost flat-field schedule (30 s without an estimator answer) is logged with `console.warn` only.
  It is not yet in the run record's repeatability block.
