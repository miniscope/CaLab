# S2.3 probe: repeated pass 1 (12 Nov 2026)

Question (PI): if pass 1 runs again over the same recording, keeping the
footprint library and the slow loop's state, do footprints settle, and how many
false cells does that cost? This is intervention (b) from the S1.7 PR-2
follow-up: traces solved earlier under wrong footprints bias the footprint
statistics, and a second pass re-solves them. This is the cheap early probe in
PLAN S2.3. It has no evidence accounting: later passes test candidates again on
frames they have already seen, and nothing corrects for the extra looks (that
is S2.1, `m(n_looks)`). The numbers show the raw effect.

## Setup

- `qc_eval --passes N` (this PR). After the last frame the loop restarts at
  frame 0.
  - **Carried over:** the fast loop's library, the trace engine state (traces
    continue across the wrap), and the whole slow loop: footprints, fpstats,
    ledger, probation and frame counter. The QC monitor, held-out score and
    convergence tracker also carry over.
  - **Frame counters continue.** Running statistics with half-lives see pass 2
    as more time.
  - **Fixed after pass 1:** the calibration and FOV mask, and the motion
    corrector (later passes replay pass 1's motion records, as pass 2 does, with
    no re-registration). The online flat field also stays fixed: its last
    pass-1 map stays applied and gets no more updates.
  - **Continues:** the preprocessor's running noise and background state.
- **Virtual frames.** Output frames are virtual: `pass * frames + t`, so the E7
  curves continue across passes. `split_passes.py` cuts a run into one run
  directory per pass, and `summarize.py` reads those as ordinary runs.
- **End-of-pass libraries.** Each pass end writes `footprints_pass{k}.bin` and
  `final_pass{k}.tsv`. These hold the fast loop's library before
  `SlowLoop::finalize`.
- **Pass 1 is unchanged.** With `--passes 3`, the pass-1 slice is byte-identical
  to a `--passes 1` run (`global.tsv`, `cells.tsv`, `convergence.tsv`).
- **Binary.** Experiments used `origin/main` 6b1debf plus a local merge of
  `origin/feat/cala-flat-field-default` 3c1a269 (#330, the online flat field
  that `qc_eval` uses by default with `--motion`; it was not merged then). The
  `--passes` code is the same as the code now in this PR on `main` 9bf3e56,
  where #330 has since landed. The PR was re-checked on that base: the pass-1
  slice is byte-identical to `--passes 1`, including the flat-field update
  log, and the flat field makes no updates after pass 1.
- **Run settings.** `--batch 8 --budget 30000000 --slow-seed 1`. Sims: `motion`
  and `static` arms, seeds 5–9, 9600 frames. Real data: the workshop recording,
  `--motion --frames 18000`, slow seeds 1 and 2.
- **Matched compute.** Single passes at budget ×2 and ×3, same binary. The older
  ×4 runs in E6 used a different binary (81f041c, no online flat field), so they
  were not used.
- **Held out in pass 1 only.** `S8` and `ho_marginal_z` are held out in pass 1
  only. In passes 2 and 3 they score frames the slow loop has already fitted
  on, so they appear below only as labelled, non-held-out values.

## Sims: per pass, mean over seeds 5–9

`R2` in pass k is recall 2400 frames into that pass, so it is not comparable
with the single-pass `R2`. Pass k uses about k× the frame work of one pass.

### motion

| run               | P8    | R8    | cells | fp_noise | fp_adjacent | r_fp  | adds/min (last 4 min) | conv_big1 | conv_big4 | conv_share4 |
| ----------------- | ----- | ----- | ----- | -------- | ----------- | ----- | --------------------- | --------- | --------- | ----------- |
| 1 pass, 1×        | 0.929 | 0.751 | 519.0 | 5.4      | 7.0         | 0.945 | 22.7                  | 0.038     | 0.140     | 0.115       |
| pass 2            | 0.919 | 0.792 | 552.8 | 8.8      | 10.8        | 0.953 | 9.6                   | 0.019     | 0.069     | 0.064       |
| pass 3            | 0.906 | 0.804 | 569.6 | 12.0     | 15.8        | 0.955 | 8.1                   | 0.019     | 0.057     | 0.047       |
| 1 pass, budget 2× | 0.913 | 0.788 | 553.8 | 8.4      | 11.6        | 0.949 | 23.6                  | 0.042     | 0.167     | 0.128       |
| 1 pass, budget 3× | 0.894 | 0.793 | 569.8 | 13.6     | 17.6        | 0.951 | 24.4                  | 0.052     | 0.182     | 0.134       |

### static

| run               | P8    | R8    | cells | fp_noise | fp_adjacent | r_fp  | adds/min (last 4 min) | conv_big1 | conv_big4 | conv_share4 |
| ----------------- | ----- | ----- | ----- | -------- | ----------- | ----- | --------------------- | --------- | --------- | ----------- |
| 1 pass, 1×        | 0.953 | 0.781 | 501.2 | 7.2      | 4.0         | 0.973 | 20.9                  | 0.031     | 0.135     | 0.110       |
| pass 2            | 0.945 | 0.819 | 529.8 | 11.4     | 6.2         | 0.979 | 8.8                   | 0.022     | 0.072     | 0.058       |
| pass 3            | 0.936 | 0.832 | 543.6 | 14.0     | 8.4         | 0.981 | 6.8                   | 0.015     | 0.053     | 0.047       |
| 1 pass, budget 2× | 0.945 | 0.814 | 526.6 | 10.8     | 4.8         | 0.976 | 19.1                  | 0.053     | 0.163     | 0.122       |
| 1 pass, budget 3× | 0.935 | 0.824 | 539.0 | 15.2     | 6.4         | 0.978 | 20.1                  | 0.055     | 0.173     | 0.125       |

### Paired differences

Mean ± 95 % t-CI over 5 seeds, with sign counts.

| comparison            | arm    | P8                 | R8                 | fp_noise         | r_fp                   | conv_big4              |
| --------------------- | ------ | ------------------ | ------------------ | ---------------- | ---------------------- | ---------------------- |
| pass 2 − pass 1       | motion | −.009 ± .013 (0/5) | +.041 ± .019 (5/0) | +3.4 ± 3.4       | +.008 ± .002 (5/0)     | −.071 ± .011 (0/5)     |
| pass 2 − pass 1       | static | −.008 ± .011 (1/4) | +.037 ± .015 (5/0) | +4.2 ± 2.4 (5/0) | +.007 ± .002 (5/0)     | −.063 ± .023 (0/5)     |
| pass 3 − pass 1       | motion | −.023 ± .026 (1/4) | +.053 ± .009 (5/0) | +6.6 ± 1.9 (5/0) | +.010 ± .003 (5/0)     | −.083 ± .022 (0/5)     |
| pass 3 − pass 1       | static | −.017 ± .011 (0/5) | +.051 ± .007 (5/0) | +6.8 ± 5.4 (5/0) | +.008 ± .003 (5/0)     | −.083 ± .019 (0/5)     |
| pass 2 − 1 pass at 2× | motion | +.006 ± .011 (4/1) | +.004 ± .014       | +0.4 ± 4.7       | **+.004 ± .001 (5/0)** | **−.098 ± .037 (0/5)** |
| pass 2 − 1 pass at 2× | static | −.001 ± .009       | +.004 ± .011       | +0.6 ± 3.9       | **+.003 ± .001 (5/0)** | **−.091 ± .008 (0/5)** |
| pass 3 − 1 pass at 3× | motion | +.012 ± .028 (3/2) | +.011 ± .010 (4/0) | −1.6 ± 6.3       | **+.003 ± .002 (5/0)** | **−.126 ± .011 (0/5)** |
| pass 3 − 1 pass at 3× | static | +.001 ± .010       | +.008 ± .013       | −1.2 ± 5.2       | **+.003 ± .001 (5/0)** | **−.121 ± .016 (0/5)** |

Full reports: `pass{2,3}_vs_pass1`, `pass{2,3}_vs_x{2,3}` and
`x{2,3}_vs_pass1`, in the session scratchpad (`s23/reports/`).

**Wall time per sim run:** pass 1 306 s, pass 2 333 s, pass 3 369 s, so three
passes take 1016 s. One pass at budget 2× takes 436 s, and at 3× 523 s. "Matched
budget" is therefore not matched wall time: the slow loop does not spend all of
a larger budget, while a repeated pass pays the full frame cost again.

## Real data: workshop recording, 18000 frames per pass

"Share >10 %/min" is E7 `share_big` at lag 4 (one minute) at the last
checkpoint of the pass. "Adds", "merges", "deletes" and "splits" count events
within the pass. The late rates are per minute over the pass's last 4 minutes.

| seed | pass | cells | share >10 %/min | share > noise (lag 4) | adds | merges | deletes | splits | late adds/min | late removals/min | texture | Minian r ≥ .5 | Minian r ≥ .7 | S8              |
| ---- | ---- | ----- | --------------- | --------------------- | ---- | ------ | ------- | ------ | ------------- | ----------------- | ------- | ------------- | ------------- | --------------- |
| 1    | 1    | 663   | 0.136           | 0.097                 | 889  | 252    | 10      | 37     | 24.5          | 16.2              | 2       | 503           | 410           | 21883           |
| 1    | 2    | 699   | 0.068           | 0.049                 | 221  | 196    | 4       | 14     | 13.8          | 8.5               | 2       | 527           | 429           | (22736, not HO) |
| 1    | 3    | 768   | 0.030           | 0.021                 | 215  | 155    | 2       | 11     | 14.8          | 7.5               | 7       | 569           | 441           | (24571, not HO) |
| 2    | 1    | 696   | 0.107           | 0.066                 | 889  | 226    | 7       | 40     | 22.0          | 15.5              | 5       | 525           | 411           | 22485           |
| 2    | 2    | 754   | 0.071           | 0.043                 | 243  | 195    | 4       | 14     | 12.8          | 10.8              | 9       | 535           | 410           | (23792, not HO) |
| 2    | 3    | 765   | 0.034           | 0.020                 | 138  | 135    | 1       | 8      | 9.8           | 4.5               | 9       | 550           | 423           | (24664, not HO) |

- **Seed-to-seed Jaccard** (`seed_jaccard.py`, cos ≥ .5): pass 1 .678, pass 2
  .672, pass 3 .675.
- **Cells with `ho_marginal_z` < 2:** 159 / 147 / 193 (seed 1) and 178 / 204 /
  204 (seed 2). After pass 1 these are not held out either.
- **Wall time per pass on real data:** 690–770 s (pass 3: 880–905 s, while
  another agent's run shared the machine). Peak RSS was 1.34 GB with 3 passes.
- **Pass 1 reproduces earlier runs.** Pass 1 matches the S1.7 PR-2 residual
  runs on the same base (main plus #330). Those runs gave S8 21883 / 22485,
  texture 2 / 5, Minian 503 / 412 for seed 1 and a seed-to-seed Jaccard of
  .677. Pass 1 here gives S8 21883 / 22485, texture 2 / 5, Minian 503 / 410
  and Jaccard .678.
- **Minian is a reference with missing and wrong cells.** Its rows show
  agreement, not recall.

## Answers

1. **Does convergence improve with passes?** Yes, clearly, on sims and on real
   data.
   - On real data, the share of cells changing by more than 10 % in a minute at
     the end of a pass goes .136 / .107 (pass 1) → .068 / .071 → .030 / .034
     (seeds 1 / 2). The share above split-half noise goes .10 / .07 → .05 / .04
     → .02 / .02.
   - On sims, `conv_big4` halves by pass 2 and is at about 40 % of pass 1 by
     pass 3. Late adds per minute fall from about 22 to about 9 on sims and 13
     on real data.
   - This is not a compute effect. A single pass with 2× or 3× budget converges
     _worse_ than 1× (`conv_big4` .17–.18 against .14), because more budget
     means more edits. Pass 2 against 2× is −.09 to −.10, and pass 3 against 3×
     is −.12 (5/5 seeds both arms).
   - Edits do not fall to 0 by pass 3. Real data still has 140–215 adds and
     135–155 merges in pass 3, so most of the late activity is merge/re-add
     churn, about 10–15 adds/min. Hypothesis (a), decision churn, remains for
     what is left.
2. **Do false cells grow?** Yes, about as much as with the same extra compute.
   - On sims, `fp_noise` goes 5.4 → 8.8 → 12.0 (motion) and 7.2 → 11.4 → 14.0
     (static). P8 falls .929 → .919 → .906 (motion) and .953 → .945 → .936
     (static). The static fall from pass 1 to pass 3 is −.017 ± .011, 0/5
     seeds. The motion CI covers 0.
   - A single pass at 2× or 3× budget loses the same precision: P8 .913 / .894
     on motion and .945 / .935 on static. It also adds the same number of cells
     and the same false-cell classes. Paired, pass k against budget k× gives P8
     +.006 / +.012 (motion) and −.001 / +.001 (static), all covering 0.
   - So extra passes do not pass the S2.3 gate ("extra passes must not lower
     P8"), but neither does extra budget. Without the correction for repeated
     looks, more opportunities to test weak candidates admit more false cells,
     however the opportunities arise.
   - On real data cells grow +36 / +58 in pass 2 and +69 / +11 in pass 3.
     Textured cells go 2 → 2 → 7 and 5 → 9 → 9, and cells with
     `ho_marginal_z` < 2 grow. Minian agreement also rises (r ≥ .5: 503 → 569
     and 525 → 550; r ≥ .7: 410 → 441 and 411 → 423), so part of the growth is
     cells Minian also has. Seed-to-seed Jaccard is flat (.68 / .67 / .68).
3. **Does footprint accuracy (`r_fp`) improve beyond matched compute?** Yes, by
   a small but consistent amount.
   - Against pass 1, `r_fp` gains +.008 / +.010 (motion) and +.007 / +.008
     (static).
   - Against a single pass at the same budget multiple, the gain is +.003 to
     +.004, 5/5 seeds in every comparison, with CIs excluding 0.
   - Re-solving the early traces under better footprints does sharpen the
     footprints (hypothesis b), but it is a small part of `r_fp`, and most of
     the gain over pass 1 is plain compute. The large effect of re-seeing frames
     is on settling, not on accuracy.

**What this means for S2.3.** A second pass is the effective lever on
convergence. Pass 2 already removes about half of the late footprint change. The
false-cell cost matches the cost of the same compute in one pass, so it belongs
to S2.1 (`m(n_looks)` and evidence accounting), not to the pass mechanism. A
sensible next step is a refinement pass that only updates footprints: no adds,
or adds held to a stricter margin, in passes ≥ 2. That would keep the
convergence and `r_fp` gain without the extra looks, and is a cheap
experiment on this flag.

**Limits:**

- The flat field is frozen at its pass-1 end map, so early frames in pass 2 see
  a different map than they did in pass 1.
- Traces carry over the wrap from the last frame to frame 0, which causes a
  short transient.
- S8 after pass 1 is not held out.
- Compute matching is by budget, not wall time.
- Real data has 2 seeds.
