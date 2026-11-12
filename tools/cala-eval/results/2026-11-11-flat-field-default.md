# Online flat field as the default (PR #330), 11 Nov 2026

Real workshop recording, default online flat field (gain half-life 2 h, offset half-life 120 s), seeds s1/s2. Base is no flat field, auto3 is the #327 offline pre-pass.

The standalone example `flatfield_eval.rs` was removed after a64cd09, along with `qc_eval --ff-dump-maps` and `--no-flat-field` (use `--flat-field off`): reproduce at a64cd09.

## Real data

| metric                  | base        | auto3       | online      |
| ----------------------- | ----------- | ----------- | ----------- |
| texture-flagged (s1/s2) | 28/28       | 0/1         | 2/5         |
| S8                      | 13524/12866 | 22451/21100 | 21883/22485 |
| ho_marginal_z median    | 4.36/4.24   | 5.46/5.75   | 6.91/6.58   |
| seed Jaccard            | .634        | .677        | .677        |
| Minian r ≥ .7           | 399/390     | n/a         | 412/411     |
| motion R² > .2 (s1)     | 49          | n/a         | 0           |

Online gets nearly all of the offline pre-pass benefit, although frames before 3000 are seen uncorrected.

## Map updates and stability

- The first map lands at frame 2999 and changes the image by .81 σ median, 3.7 σ p99. Later updates are at most .1 σ p99 and shrink over time (median .06 to .01).
- Thirds 1 and 2 of the recording agree at the noise floor (rms .004, corr .997).
- Third 0 is off by about 8 % of the map SD. The dark level falls 2.8 to 1.1 grey over the first 5 minutes and fewer shift bins are filled. The early map is biased by limited dither coverage, not by noise.
- Map error is about .31/√N beyond 6000 frames.

## Drift and trace jumps

- Gain tracking is unbiased (fitted/predicted 1.06).
- The offset injection test is clipped at u8 0, so the offset lag is unmeasured.
- No trace jumps at map updates (median-ratio statistic against a null): 0/12 above the null p99 on the default run.

## Sims (E1)

Neutral on motion, halo, oof and 4x arms (P8 change within ±.013). The fpn arm (sensor pattern) raises S8 by 30 % (27 337 to 35 595, 3/3 seeds). Details in the PR body.

## Browser throughput

About 9 % lower offline throughput after the first map, from estimator worker CPU (233-247 vs 263-265 fps). No effect before the first map (500-3000: 338/321 vs 332/341 fps).

## Recommendation and caveats

Keep the defaults. Gain half-life 1-4 h is fine, not below 30 min. Offset half-life 120-300 s. Gain stability beyond 15 minutes is untested on real data, and the PI needs multi-day recordings. A cached seed map should avoid the first-switch cost (untested).

## Follow-ups

- Feed the estimator a frame subsample to cut the throughput cost.
- Rebuild the motion template after the first map.
- Validate the motion R² flag against the labels before using it in the fail mask.
- Multi-day gain stability is untested.
