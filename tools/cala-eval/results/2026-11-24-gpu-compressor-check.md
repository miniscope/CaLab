# cala GPU compressor: its factors against the CPU's, in the app, 24 Nov 2026

Question: in a real `?factors=gpu` run, are the GPU compressor's factors the CPU compressor's, and what does the
GPU route do to Discover?

## Data and method

- **V4:** 2,000 frames of the V4 recording (`cafast_v4_2h` files 0-1, 600 x 600), on the evaluation SSD.
- **wl24:** the 41 plain AVIs of `wl24_20251201` (200 x 200, 40,234 frames), on the evaluation SSD.
- Local Google Chrome (Apple GPU, WebGPU), `apps/cala/scripts/live-measure.mjs --mode file`, a fresh profile per run.
- **The check** (`?debug&gpucheck=2`): the quantized frames of the first 2 GPU windows (600 frames each) stay in
  memory; after the last window each is compressed on the CPU (`TileCompressor`, the GPU's seeds and previous ranks),
  and once more with every seed + 7,000,000 (the noise floor). Per tile, `Ŷ = mean · 1ᵀ + S Tᵀ`:
  - loss = `Σ ‖Ŷ_gpu − Ŷ_cpu‖²`, floor = `Σ ‖Ŷ_cpu2 − Ŷ_cpu‖²`, ref = `Σ ‖Ŷ_cpu‖²`;
  - rankDiff = `Σ |rank_gpu − rank_cpu|`; kept diff = `Σ |kept energy_gpu − kept energy_cpu|` (what a rank
    difference is worth).
- **Quality bar:** loss/ref below floor/ref, and rankDiff per tile below 0.3.

## Two fixes the first real runs needed

1. **V4's dark corners.** A tile without variance in a window (V4's corners outside the lens) has an all-zero Gram
   matrix; CholeskyQR refused it and every window gave the run's factors up. An all-zero Gram matrix now gives a
   zero `R⁻¹`, so the tile finishes as the CPU's does (rank 1, all zero).
2. **Sketch width.** The GPU buffers held 128 sketch columns; a V4 tile grew past that and the run's factors were
   given up again. They now hold 320, the largest sketch a tile can need (`max_rank` 300 + 10).

## Results

### The check (2 windows each, after both fixes)

| data | tiles | loss/ref | floor/ref | rankDiff/tile | floor rankDiff/tile | tiles with another rank | kept diff/signal (floor) | bar                         |
| ---- | ----: | -------: | --------: | ------------: | ------------------: | ----------------------: | -----------------------: | --------------------------- |
| V4   |   400 |  7.6e-13 |    5.7e-3 |      **0.46** |                0.76 |                       8 |          3.2e-7 (3.5e-3) | loss passes, **rank fails** |
| wl24 |    64 |  1.0e-12 |    7.8e-3 |          0.02 |                0.95 |                       1 |          2.0e-7 (1.4e-2) | passes                      |

- The GPU's reconstruction is the CPU's to float rounding: loss is 10 orders of magnitude below the floor on both.
- V4's rank difference sits in 8 of 400 tiles. Those components carry 3e-7 of the kept energy: they are at the rank cut
  with almost no energy, and the CPU with other draws moves ranks more (0.76 per tile).
- Two V4 check runs gave the same numbers to the last digit.

### Discover, file against GPU, unpaced (two runs each)

| data | Discover, file (s) | Discover, `factors=gpu` (s) | GPU route            | settle, Extract (s, file / gpu) | cells (file / gpu)  |
| ---- | -----------------: | --------------------------: | -------------------- | ------------------------------- | ------------------- |
| V4   |         12.6, 12.6 |                  17.5, 13.2 | gave up: fell behind | 17, 12-13 / 17-18, 13           | 311, 313 / 333, 315 |
| wl24 |         34.3, 33.8 |                  33.7, 34.8 | gave up: fell behind | 24-27, 34-38 / 23-29, 34-38     | 85, 71 / 76, 83     |

- A file is read at about 150 frames/s (V4) and 1,100 frames/s (wl24). The ring holds a window plus 150 frames, so
  the GPU must finish each window within 1 s (V4) or 0.14 s (wl24). It does not, and every unpaced run gave its
  factors up before the first window was written; the settle and Extract then read the file.
- So there is no Discover speed-up to measure yet at file speed.

### Paced like a stream (`pacefps`: V4 at 20 frames/s, wl24 at 200)

| data            | GPU ms/frame (mean, p50, max) | settle source, s | Extract source, s | cells    |
| --------------- | ----------------------------- | ---------------- | ----------------- | -------- |
| V4, gpu         | 6.5, 4.9, 9.2                 | factors, 27      | factors, 7.0      | 561      |
| V4, file        | -                             | file, 25         | file, 18          | 542      |
| V4, gpu check   | 6.4-6.6, 5.0, 8.8-9.4         | factors, 28-29   | factors, 12       | 572, 542 |
| wl24, gpu check | 0.89, 0.82, 4.9               | factors, 33      | factors, 10       | 122      |

- Paced, no run gave up: every window was compressed on the GPU (V4: 4 windows, wl24: 68), and the settle and
  Extract read the GPU's factors.
- V4's GPU pace (6.5 ms/frame) is close to one CPU worker's (8.7 ms/frame in WASM, 24 Nov compress cost).
- Extract waits for the check (33 s on V4, 4 s on wl24), so check runs' times after Discover are not representative.

## Conclusion

- **Factors:** the GPU's factors are the CPU's (loss ~1e-12 of ref, against a floor of ~6e-3). The rank bar fails on
  V4 (0.46 per tile), from 8 tiles whose extra components hold no energy; the CPU's own seed noise is larger.
- **Speed:** at file speed the GPU falls a window behind on both recordings, so `?factors=gpu` gives no factors on an
  unpaced file run. It works when frames arrive at stream rates.
- Open for the owner: the rank bar on V4, and whether the GPU route should hold Discover back (or keep a longer ring)
  instead of giving up.
