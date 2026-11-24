# Visit budget sweep: does quality depend on visits per frame? (24 Nov 2026)

Question (PI): in the app, tile visits fill whatever time the slow worker has spare, so visits per frame vary with the
machine and with scheduling (two runs of one sim gave 390 against 401 cells). Is quality flat over that range? If it is,
no user-visible visit budget is needed; if not, one is.

## Method (written before the main sweep was read)

- **Knob: qc_eval's existing `--budget`** (no code change). In the lock-step (untimed) mode each Discover frame earns
  `--budget` work units and each Final-settle frame `--settle-steps` x `--budget`; `SlowLoop::step` spends them on due
  tiles, most-fresh first, and drops credit when nothing is due. For a given `--slow-seed` the run is deterministic.
  The calibration runs below show that the budget binds in both stages (visits per frame scale almost linearly with it).
- **Calibration to the app.** Chrome (`runs/csdelta/chrome-final`, headed, Max, `sim3k` = the first 3000 frames of
  `v3_motion_s5`; `csdelta_chrome_final.py --discover`): **0.216 visit jobs per observed Discover frame** (0.27 on the
  first 1000 frames). Final settle: about **0.7-1.1 visits per settle frame** (PI's Chrome readings). The same clip in
  qc_eval (seed 1): budget 9e6 gives 0.147 per Discover frame and 0.52 per settle frame; 3e7 gives 0.439 and 1.45.
  So **1x = `--budget 1.3e7` with `--settle-steps 1.2`** (about 0.21 and 0.9). qc_eval's long-standing default
  (`--budget 3e7`, steps 1) is about 2x the app in Discover and 1.6x in the settle.
- **Arms:** budget 0.5x, 0.71x, 1x, 1.41x, 2x (6.5e6, 9.2e6, 1.3e7, 1.84e7, 2.6e7), settle steps 1.2 throughout, so
  Discover and the Final settle move together.
- **Sims:** `v3_motion_s5` (motion, `--motion`), `v3_static_s6`, `v3_static_s7`; the first 3000 frames each (the clip
  the Chrome numbers come from); slow seeds 1 and 2. 30 runs.
- **Flags** (the app's recording path in qc_eval, as `csdelta_final.sh`): `--batch 8 --passes 1 --joint-update all
  --joint-sign all --lookback 2 --merge-guard-sep 0.6 --lookback-drain 0 --settle-frames 3000 --settle-batch 16`
  (look-back on, the Thorough Final settle over all 3000 frames), plus `--dump --no-signed --no-heldout`.
- **Metrics** (`demix_metrics.py`, then `visit_budget_summary.py`): cells; matched (Hungarian on footprint r >= 0.7,
  detectable GT units); false; precision = matched / cells; recall = matched / detectable units; mean footprint r of
  matched cells, all and those whose nearest GT neighbour is < 1 soma diameter away; median trace r; bitten share
  (matched neighbour pairs whose estimated footprint at the neighbour's centre is < 0.5 of the truth's); qc_eval's own
  GT precision / recall / trace r; wall seconds of Discover and of the settle; peak RSS.
- **Rule for "flat".** Per metric, an OLS slope on log2(budget scale) with one intercept per sim, over the 30 runs.
  Flat if the fitted change over the app's range (0.5x -> 2x, two doublings) is smaller than the seed SD (pooled over
  all 15 same-arm seed pairs) for every quality metric, and the 95 % CI of the slope includes 0 for recall, precision
  and footprint r. Otherwise not flat, and the per-arm table says where it saturates (the lowest arm within one seed SD
  of 2x).
- **If not flat:** a stage split (Discover 0.5x / 2x with the settle at 1x, and the reverse, via `--settle-steps`), and
  full-length runs (9600 frames) of `v3_static_s6` at 0.5x / 1x / 2x to see whether the effect shrinks with length.

Caveats known up front:

- The match is per observed frame. Chrome at Max also misses about 25 % of frames on the slow loop and runs four
  visit workers in parallel; lock-step observes every frame and visits in order.
- Recall uses the full recording's detectable flags on a 3000-frame clip, so it is low in every arm by the same amount.
- Two runs at a time: wall seconds carry some contention; the visit counts are exact.
