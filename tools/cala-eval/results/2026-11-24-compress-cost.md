# cala compressor: a cheaper sketch (slice 7, Task 1 short form), 24 Nov 2026

Question: can a tile's randomized SVD use a smaller sketch than `k0 = 40` without losing what it keeps?

## Data and method

- **V4:** 2,400 grey frames of a UCLA Miniscope V4 recording (600 x 600, `cafast_v4_3h`, file 17 on), mean-centred,
  quant 64; 4 windows of 600 frames, plain 64 px tiles (100 per window).
- **wl24:** 2,400 frames of `wl24_20251201`'s cala input (200 x 200), from frame 20,000; 4 windows, 16 tiles.
- `crates/cala/examples/compress_bench.rs` (native, one thread) and `apps/cala/scripts/compress-bench.mjs` (WASM in
  V8, Chrome's engine), `--window 600`.
- **Loss:** `‖Ŷ − Ŷ_ref‖² / ‖Ŷ_ref‖²` over the low-rank parts `W Vᵀ`, against today's settings on the same tile.
  The **noise floor** is today's settings with other random draws (`--seed-offset 7`): which components near the
  rank cut a run keeps changes with the draws alone.
- Raw V4 frames, not Discover's preprocessed ones (no motion correction or background removal): kept ranks may differ
  from an app run; the relative cost should not.

## Results

One window, native (ms per frame):

| setting                | V4 ms | V4 rank | % doubled | wl24 ms | wl24 rank | % doubled |
| ---------------------- | ----: | ------: | --------: | ------: | --------: | --------: |
| today (`k0` 40, 2 it.) |   8.3 |     7.9 |         0 |     1.7 |      20.1 |        25 |
| `k0` 24                |   7.4 |     7.8 |        14 |     1.6 |      19.8 |        62 |
| `k0` 16                |   8.3 |     7.8 |        37 |     2.6 |      20.1 |        81 |
| `k0` 12                |  11.4 |     7.8 |        97 |     2.3 |      19.9 |        94 |
| `k0` 40, 1 iteration   |   5.8 |     7.5 |         0 |     0.9 |      18.0 |        12 |

- A smaller fixed `k0` does not pay: a tile doubles its sketch (and redoes the SVD) when one of its last 10 components
  is kept, so most tiles redo the work.
- One power iteration is 30-45 % faster but keeps fewer components (wl24 20.1 to 18.0). Not taken.

**Adaptive start** (taken): from a tile's second window on, its sketch starts at
`max(previous rank + 10 + 4, 16)` (`k0_after`). Four windows:

| data | build  | today ms/frame | adaptive ms/frame | change | rank (today, adaptive) |   loss | noise floor |
| ---- | ------ | -------------: | ----------------: | -----: | ---------------------- | -----: | ----------: |
| V4   | native |            8.4 |               6.3 |  −25 % | 7.4, 7.2               | 1.5e-2 |      2.0e-2 |
| V4   | WASM   |           12.4 |               8.7 |  −30 % | 7.4, 7.2               |        |             |
| wl24 | native |            2.1 |               1.6 |  −25 % | 22.0, 20.8             | 3.5e-2 |      4.7e-2 |
| wl24 | WASM   |            2.8 |               2.1 |  −23 % | 21.9, 20.8             |        |             |

- The first window of each tile still starts at 40, so over a long run the gain is the later windows': about −39 %
  (V4, WASM) and −28 % (wl24, native).
- The loss against today is below today's own noise floor on both.
- A tighter start (`+ 2`, floor 12) was no faster (more doubling).
- The factor files stay the same bytes for any compress pool width: windows are compressed one after another, so each
  tile's previous rank is known before its next window is handed out.

## What it means for a 1 h recording (inferred, not measured)

Slice 5's 30 core-minutes per hour at 600 px become about 19. With the pool's 50 frames/s after Discover scaled by the
same factor, the factors would be ready about 15 min after Discover instead of 24 (today's file settle + Extract:
22.9 min). Whether a recording on factors then finishes sooner needs the 1 h Chrome run (Task 8).
