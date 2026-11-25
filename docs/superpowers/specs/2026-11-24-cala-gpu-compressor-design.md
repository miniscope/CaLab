# cala: a recording's factors from a GPU compressor (design, 24 Nov 2026)

## Goal

A saved recording finishes sooner on its factors than on the file, with results no worse, measured from opening the
recording to Extract done (owner, 24 Nov: "single run faster"). Discover never waits for the compressor.

## Why a new architecture

Measured on the slice 7 build (`tools/cala-eval/results/2026-11-24-recording-factors-gate.md`,
`2026-11-24-compress-cost.md`):

- Today Discover's preprocessed frames are written to OPFS as `i16` window files and compressed by a CPU pool. Discover
  reads faster than the pool compresses (V4 600 px: Discover 87 frames/s, the compressor almost without CPU; wl24
  200 px: 1,200 against 130 frames/s). The window files pass the 5 GB cap during Discover and the run falls back to
  the file, on both recordings.
- The file path after Discover: V4 1 h settle 7.1 min + Extract 15.8 min = 22.9 min. Extract on factors (slice 6)
  solves about 2,500 frames/s on 6 helpers. The settle on factors ran at 25 frames/s (look-back worker 0 alone) against
  42 on the file (the settle pool).
- A compressor built after Discover from the file costs about as much as Extract on the file (both re-preprocess every
  frame), so it cannot make a single run faster. Making Discover wait for the CPU compressor was rejected (owner):
  Discover is the stage the user watches and its slow loop and look-back are tuned to its pace.

## Probes (throwaway code, 24 Nov)

- **Single-pass sketch (no second look at the window): ruled out.** On the same windows, a single-pass sketch (Tropp et
  al. 2017) kept about half today's components even at six times today's sketch size (wl24: rank 13.6 against 21.9,
  loss 0.34 against a noise floor of 0.047; V4: rank 4.5 against 7.6). These tiles' spectra decay slowly; the power
  iterations are needed, so the GPU must hold the window.
- **The window held on the GPU, today's algorithm, WebGPU in Chrome (Apple M1 Max): about 0.5 s per 600-frame window
  at 600 px** (145 tiles of the two offset grids; the matrix products 0.19 s, the rest the probe's plain-JS small
  steps). Discover needs about 7 s to read that window. The top singular values match numpy's exact SVD to 0.1.
- **GPU contention with Discover's motion correction** (10,000 V4 frames, one run each): Discover 60.6 s alone, 62.7 s
  (+3.5 %) beside the GPU compressor at one window per 6.5 s, 93.0 s (+54 %) beside it back to back. Cells 605, 596, 627. Runs: `runs/recording-factors-20261124/gpu_contention/` on the evaluation SSD.

## Decisions

1. **The compressor of a recording runs on the GPU, in the compress worker.** The compress worker already receives a
   copy of every batch after the back half (`FastToCompress` `chunk`, `compress-feed.ts`). For a recording with a
   WebGPU device it uploads the batch (quantized to `i16`, about 60 MB/s at 600 px and 87 frames/s) into a ring buffer
   on the GPU instead of writing a window file. No window files, no backlog on disk.
2. **Same algorithm, same factor files.** Per tile and window: the mean, today's adaptive start (`k0_after`), `k + 10`
   sketch columns, two power iterations, the lag-1 rank cut, the doubling rule, both offset grids, factor format v2.
   The settle reader, `FactorExtractor` and Extract read the files unchanged. The GPU's random draws differ from the
   CPU's, so the bytes differ; equivalence is statistical (decision 9).
3. **Memory is fixed per run, not per recording length:** the ring holds `W + S` frames of `i16` (`W` the window,
   `S = W / 4` slack while a window compresses) plus work buffers for one batch of `B = 24` tiles. At `W = 600`:
   about 540 MB + 55 MB at 600 px, 60 MB + 55 MB at 200 px.
4. **The window length adapts to the GPU:** the compress worker allocates for `W = 600`, then 300, then 150, inside an
   `out-of-memory` error scope; the first that fits is the run's window. The floor of that ladder is set by Task 1 (if
   150 loses too much, the ladder stops at 300). No allocation fits: the recording runs on the file, as without
   factors. The window length is recorded (Run panel, export `compress_window`).
5. **The CPU does the small steps in WASM:** per tile the `l x l` Cholesky of CholeskyQR2, the eigen step of `B Bᵀ`
   and the lag-1 cut, with the crate's `linalg` (a new binding). Large products stay on the GPU: `A Ω`, `Aᵀ Q`, `A Z`,
   the Gram matrices, `Q R⁻¹`, `B = Qᵀ A`, `U = Q E_keep`, the per-pixel sums of squares for the discarded variance.
6. **Never block Discover:** window `N` is compressed while window `N + 1` fills the slack. If the slack would
   overflow (the GPU is behind), the run gives up its factors: the settle and Extract read the file and the compressor
   stops (slice 7's `stop`). A device loss does the same.
7. **The settle on factors runs on the whole settle pool** (look-back workers 0..S, as the file settle does), each with
   a `FactorReader`, so it is no slower than the file's settle.
8. **Streams are unchanged** (CPU compress pool) in this spec. A stream may use the GPU compressor later, after its own
   measurement.
9. **The default switches only after the gate** (Task 7): recordings settle and extract on factors by default only
   if, on the 1 h V4 recording and on `wl24_20251201`, Discover's end to Extract done is shorter, Discover is at most
   5 % longer, and quality holds (below). Until then the GPU compressor runs behind `?factors=gpu`.

## Quality bar

- GPU factors against the CPU compressor's on the same windows: loss `‖Ŷ − Ŷ_ref‖² / ‖Ŷ_ref‖²` below the CPU
  compressor's own noise floor (two seeds), mean kept rank within 0.3.
- Slice 1's settle evaluation (`SET-F` against `SET-R`) on the real recording passes its lines, or the owner accepts
  the gap.
- Extract's traces on factors against the file's, per cell: median and largest difference in sd, reported.
- Cells found: two runs per arm, since one run each varied by about 3 % (605 / 596 / 627 above).

## Components

| unit                   | where                                   | does                                                                                                                                     | depends on                    |
| ---------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `GpuWindowCompressor`  | `apps/cala/src/lib/gpu-compress.ts`     | ring buffer, upload, the WGSL kernels, one window to `TileFactors` bytes                                                                 | WebGPU device, `TileFinisher` |
| `TileFinisher` (WASM)  | `crates/cala/src/compress/` + `js.rs`   | Cholesky of a batch of Gram matrices, eigen step + lag-1 cut + doubling decision per tile, tile bytes from arrays                        | `linalg`                      |
| allocation ladder      | `gpu-compress.ts`                       | picks `W` (600 / 300 / 150) or none                                                                                                      | error scopes                  |
| compress worker        | `compress-runner.ts`                    | routes a recording's chunks to the GPU compressor when it has one, writes the factor files as today, gives up on overflow or device loss | the above                     |
| settle pool on factors | `lookback-client.ts`, look-back workers | every look-back worker serves the settle from factors                                                                                    | `FactorReader`                |
| flag and default       | `factor-run.ts`, `App.tsx`              | `?factors=gpu` until the gate; then the default for recordings, `?factors=0` off                                                         | -                             |

## Error handling

- No `navigator.gpu` in the worker, no adapter or device, or no window length fits: the recording runs as today
  without factors; the Run panel says why.
- Slack overflow or device loss during the run: factors given up, the compressor stops, settle and Extract read the
  file; one line in the run history with the reason.
- A tile whose Cholesky fails (a rank-deficient sketch): retried with a small diagonal shift, as the probe does; if
  it still fails, that tile is compressed on the CPU from its frames read back (rare; counted in the export).
- Missing samples (`-32768`) count as the pixel's mean, as on the CPU; the valid share is counted on the GPU.

## Testing

The owner's rule: unit tests only for logic that can hang, lose data or change an export, plus the e2e and the
measurements.

- Unit: the allocation ladder (fake device: OOM at 600 gives 300; at every length gives no factors); the overflow
  guard (a fake GPU that never finishes gives up, never blocks the feed); a device loss mid-window ends in the file
  path; `TileFinisher` against `compress_tile` on the same `B` (Rust).
- e2e: CI's Chromium has no WebGPU, so the e2e checks the fallback (a recording with `?factors=gpu` and no GPU runs on
  the file and says so).
- Measurements, local Chrome on the evaluation SSD: GPU against CPU factors (quality bar), then Task 7.

## Tasks

1. **Window length check** (numpy, measurement only): the same 1,200 frames of V4 and wl24 compressed as 2 x 600,
   4 x 300 and 8 x 150: kept rank, error against the frames, storage. Sets the ladder's floor. Report.
2. `TileFinisher` in the crate and its binding.
3. `GpuWindowCompressor`: kernels, ring buffer, batches of tiles, the ladder; behind `?factors=gpu`.
4. The compress worker's routing, the overflow guard, device loss, export fields (`compress_window`,
   `compress_backend`).
5. GPU against CPU factors on V4 and wl24 windows (quality bar); report.
6. The settle on factors over the settle pool.
7. The gate: 1 h V4 and wl24, file against `?factors=gpu`, two runs each; report; the default switch if it passes.

## Not in scope

- Single-pass sketching (ruled out above), Discover waiting for the compressor (rejected), the CPU pool's backlog cap
  (stays for streams), streams on the GPU compressor, factors kept as a file next to the recording for later runs.

## Risks

- Only an Apple M1 Max was measured. A discrete GPU adds the upload over PCIe (60 MB/s is small) but may have less
  memory; an integrated Intel GPU may be slower. The ladder and the overflow guard keep such machines on the file path.
- Two GPU users (motion correction and the compressor) in different workers: the probe ran them in different
  browsers; the app's are in one. Measured again in Task 5.
- The settle on factors over the pool is inferred to be at least as fast as the file's; Task 6 measures it.
