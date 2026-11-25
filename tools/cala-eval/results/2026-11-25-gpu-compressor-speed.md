# cala GPU compressor at file speed, V4 and wl24, 25 Nov 2026

Question: after CholeskyQR moved to the GPU and the batches grew, does `?factors=gpu` keep up with Discover reading a
saved recording at full speed, so the settle and Extract read the GPU's factors?

## What changed

- **Ring:** two windows (1,200 frames: 864 MB at 600 px, 96 MB at 200 px), falling back to a window and a quarter
  (750) where that does not allocate. The export records `compress_ring`.
- **Lever 1, Cholesky on the GPU:** a WGSL kernel (one workgroup of 256 per tile, the Gram block in a storage buffer)
  computes CholeskyQR's `R⁻¹` in f32, with the CPU rule (all-zero Gram → zero `R⁻¹`; shifts 0 to 1e-2 x trace). A
  batch is now one submission and one readback (`Q`, `Bᵀ`, a per-tile failure flag) instead of 10 Gram round trips.
- **Lever 2, bigger batches:** the work buffers fill WebGPU's default 128 MB binding (or a lower device limit), and
  tiles of similar sketch size go together: V4's 200 tiles take 2 batches at stride 64 instead of 17.
- Levers 3 (overlapping batches) and 4 (the finish on the GPU) were not done (owner, 25 Nov: keep the handoff simple
  for a wide range of laptops).

## Data and method

As on 24 Nov (`2026-11-24-gpu-compressor-check.md`): V4 2,000 frames (600 x 600), wl24 41 AVIs (200 x 200, 40,234
frames), local Chrome on an M1 Max, `live-measure.mjs --mode file`, fresh profile per run. Runs:
`/Volumes/Extreme SSD/runs/gpu-compressor-speed-20261125/` (`summary.txt`).

## Results

### One V4 window, standalone (real GPU, no Discover; 200 tiles, cold = no previous ranks)

| version                 | cold (s)  | warm (s)  | WASM finish, cold / warm (s) |
| ----------------------- | --------- | --------- | ---------------------------- |
| before (24 Nov)         | 2.1-2.2   | 1.3-1.6   | 0.80 / 0.33                  |
| lever 1 (batches of 12) | 1.76-1.88 | 1.19-1.20 | 0.80 / 0.33                  |
| levers 1 + 2            | 1.37-1.47 | 0.85-0.86 | 0.81 / 0.34                  |

wl24, levers 1 + 2: 0.43-0.50 s cold, 0.33-0.35 s warm (finish 0.26-0.31 / 0.17, GPU 0.14-0.19). Every tile's rank
matched the CPU's; the low-rank difference stayed at 1e-11 (relative, squared).

### In the app, unpaced (two runs each)

| data | Discover, file (s) | Discover, gpu (s) | GPU route                      | settle, Extract: file runs (s) | settle, Extract: gpu runs (s)     | cells file / gpu    |
| ---- | -----------------: | ----------------: | ------------------------------ | ------------------------------ | --------------------------------- | ------------------- |
| V4   |         12.6, 12.6 |        13.6, 13.2 | gave up at window 0 (both)     | 16, 13 / 17, 12                | file 17, 12 / file 17, 13         | 307, 305 / 309, 319 |
| wl24 |         34.3, 34.8 |        37.3, 37.3 | **kept all windows** / gave up | 31, 40 / 25, 35                | **factors 27, 7.0** / file 34, 44 | 88, 71 / 99, 90     |

- GPU ms/frame (one value per sampled window): wl24 0.55 mean, 0.49 p50, 1.57 max (kept run); 0.56, 0.56, 0.85 (gave
  up after window ~30). V4: no window finished in time.
- V4's first window (cold) took 3.8 s in the app: WASM finish 2.0 s (0.8 s standalone: the CPU is shared with
  Discover), GPU 1.1 s, Ω 0.2 s. The ring gives it 600 frames at ~160 frames/s, 3.75 s: it missed by ~30 ms.
- wl24 needs ~0.35 s per window against ~0.55 s of reading; a slow window or two (up to 1.6 ms/frame) still makes
  one run in two give up.

### Paced, with the check (`gpucheck=2`; V4 at 20 frames/s, wl24 at 200)

| data | GPU ms/frame (mean, p50, max) | windows | settle, Extract (s) | loss/ref (floor/ref) | rankDiff/tile (floor) |
| ---- | ----------------------------- | ------: | ------------------- | -------------------- | --------------------- |
| V4   | 4.27, 4.80, 5.01 (was 6.5)    |       4 | factors 27, 12      | 7.4e-13 (5.7e-3)     | 0.41 (0.73)           |
| wl24 | 0.53, 0.49, 1.66 (was 0.89)   |      67 | factors 40, 10      | 9.2e-13 (7.8e-3)     | 0.00 (0.95)           |

The f32 Cholesky left the GPU's factors the CPU's to float rounding (24 Nov: 7.6e-13 and 1.0e-12).

## Conclusion

- The GPU path is 1.5-1.8x faster per window (standalone) and 1.5-1.7x in the app, with unchanged factors.
- **Targets missed:** V4 4.3 ms/frame (target 3), wl24 0.53-0.56 (target 0.5). Unpaced, wl24 keeps its factors in
  one run of two (then Extract takes 7 s instead of 35-40); V4 still gives up on its cold first window.
- What is left is mostly the WASM finish (half to two thirds of a V4 window in the app) and the GEMMs; both belong to
  the levers not taken (3, 4) or to a faster GEMM kernel.
