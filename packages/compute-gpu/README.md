# @calab/compute-gpu (spike)

A batched WebGPU (WGSL) implementation of the CaLab solver's banded-AR(2)
FISTA (`ConvMode::BandedAR2` in `crates/solver`). It solves every cell at
once and is meant as a drop-in alternative to the per-cell Rust/WASM path.
The WASM solver is the reference. Nothing in the apps uses this package yet.

## Layout

| File                        | What                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `src/banded-params.ts`      | Pure TS port of `clamp_tau_rise`, `build_kernel` (for the DC gain), `compute_impulse_peak`, `compute_banded_lipschitz`, step / threshold. |
| `src/scan-reference.ts`     | Plain-TS chunked scan that mirrors the GPU dispatch structure, plus a serial f32 port of the Rust forward/adjoint recursions.             |
| `src/fista-reference.ts`    | CPU model of one GPU iteration (same scan, same f32 reduction tree). Tested against the real WASM solver in Node.                         |
| `src/shaders/fista-wgsl.ts` | The WGSL, as an exported template string (no Vite/Vitest plugins needed).                                                                 |
| `src/gpu-fista.ts`          | `requestGpuDevice`, `createGpuFista` (load / step / solve / readSolutions), group splitting.                                              |
| `harness/`                  | Vite page that runs WASM vs GPU equivalence and the benchmark.                                                                            |
| `gpu-tests/`                | Playwright specs that drive the harness.                                                                                                  |

```ts
const device = await requestGpuDevice(); // null without WebGPU
const gpu = await createGpuFista(device!);
gpu.load(traces, nCells, T, {
  tauRise: 0.02,
  tauDecay: 0.4,
  fs: 30,
  lambda: 0.5,
  constraint: 'nonneg',
  tol: 1e-4,
  maxIters: 2000,
  filtered: true,
});
const { solutions, iterations, converged } = await gpu.solve(50); // or: await gpu.step(n)
```

## Design

### The AR(2) as two first-order scans

`c[t] = g1 c[t-1] + g2 c[t-2] + s[t-1]/peak` factors as two cascaded
first-order IIRs with roots d (decay) and r (rise):

- forward: `x[t] = (t ≥ 1 ? s[t-1] : 0) / peak`, `u[t] = d u[t-1] + x[t]`, `c[t] = r c[t-1] + u[t]`.
- adjoint: `v[t] = d v[t+1] + s[t]/peak` (reverse), `a[t] = r a[t+1] + v[t]`,
  `out[t-1] = a[t]`, `out[T-1] = 0`.

Rust casts `g1`, `g2` to f32. The GPU uses the roots of the f32-rounded
polynomial `z² - g1f z - g2f`, cast to f32. That reproduces the operator Rust
actually applies more closely than `exp(-dt/tau)`. At fs = 300 Hz with
tauDecay = 1 s the error drops from 1.1e-5 to 8.9e-6.

A first-order recurrence with constant coefficient `a` is a chunked prefix
scan. A block is `C = WG·K = 256·4 = 1024` samples and belongs to one
workgroup:

1. **Local pass** (one workgroup per (block, cell)). Each thread runs the
   recursion over its K samples with zero carry-in. A Hillis-Steele scan over
   the 256 thread end values (hop coefficient `a^(K·o)`) gives each thread its
   carry. The thread folds it back as `a^(k+1)·carry`. The pass writes
   block-local values and the block's end value.
2. **Carry pass** (one thread per cell, sequential over blocks):
   `carry_in[j] = a^C carry_in[j-1] + end[j-1]`.
3. **Fix-up**: `value[p] += a^(p+1) carry_in[block]`. This is fused into the
   next dispatch's load.

The powers `a^0..a^C` (for d and r) come from a host table computed in f64
and uploaded as f32. The adjoint uses the same code on the reversed logical
index `l = T-1-t`.

### Dispatches per iteration

| #   | Entry    | Grid              | Work                                                                                                             |
| --- | -------- | ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | `fwd1`   | (nBlocks, nCells) | local scan of IIR(d) on the delayed, prescaled source (`y`, or `x` after a restart)                              |
| 2   | `carryD` | ⌈nCells/64⌉       | carry pass                                                                                                       |
| 3   | `fwd2`   | (nBlocks, nCells) | fix-up IIR(d) and local scan of IIR(r)                                                                           |
| 4   | `carryR` | ⌈nCells/64⌉       | carry pass                                                                                                       |
| 4a  | `fwd3`   | (nBlocks, nCells) | _unfiltered only_: fix-up of the reconvolution in place, partial `Σ(trace − c)`                                  |
| 4b  | `bfin`   | ⌈nCells/64⌉       | _unfiltered only_: `baseline = Σ / T`                                                                            |
| 5   | `adj1`   | (nBlocks, nCells) | residual `(c + b) − trace` computed on the fly (fixes up c when filtered), reverse local scan of IIR(d)          |
| 6   | `carryD` |                   |                                                                                                                  |
| 7   | `adj2`   | (nBlocks, nCells) | fix-up and reverse local scan of IIR(r)                                                                          |
| 8   | `carryR` |                   |                                                                                                                  |
| 9   | `prox`   | (nBlocks, nCells) | gradient = fixed-up `a[i+1]` (one-sample advance), prox step, momentum, per-block partials of diff², x_old², dot |
| 10  | `fin`    | ⌈nCells/64⌉       | sum partials, `iteration++`, t_fista, adaptive restart, convergence                                              |

That is 10 dispatches per iteration when `filtered`, 12 otherwise. All
iterations of a `step()` go into a single compute pass. Each command buffer
holds at most 50 iterations.

FISTA semantics match `fista.rs` `step_batch`:

- Momentum comes from `t_fista` as it was before the update.
- Restart when `iteration > 1 && dot > 0`.
- Converged when `iteration > 5 && diff² < tol²(x_old² + 1e-20)`.
- Constraints: NonNegative uses `max(·, 0)`; Box01 uses `clamp(·, 0, 1)`.
- Initial x = y = 0, or both set to the warm start.

**Restart** is handled without a copy. `fin` sets a per-cell `useX` flag, and
the next iteration reads `x` wherever it would read `y` (the `fwd1` source and
the `prox` y). WGSL has no float atomics, so every reduction goes through
per-(cell, block) partials in a storage buffer. Every entry point returns
early for converged cells. For the workgroup kernels the flag is read with
`workgroupUniformLoad`, so barriers stay in uniform control flow.

### Buffers

All buffers are cell-major, `index = cell·T + t`, f32 everywhere.

| Binding | Buffer  | Contents                                                                                  |
| ------- | ------- | ----------------------------------------------------------------------------------------- |
| 0       | uniform | T, nBlocks, nCells, filtered, constraint, d, r, 1/peak, step, thresh, tol², 1/T, d^C, r^C |
| 1       | trace   | working traces                                                                            |
| 2, 3    | x, y    | solution and extrapolated point                                                           |
| 4, 5    | s1, s2  | scan scratch (u then v; c then a)                                                         |
| 6       | aux     | block ends/carries for d and r, plus 4 partials per (cell, block)                         |
| 7       | pows    | `d^0..d^C`, `r^0..r^C`                                                                    |
| 8       | cells   | per cell: t_fista, iteration, converged, useX, baseline                                   |

That is 8 storage buffers, the WebGPU default per-stage limit.

### Limits

`requestGpuDevice()` requests the adapter's `maxStorageBufferBindingSize` and
`maxBufferSize`. `load()` splits cells into groups of
`min(⌊min(maxBinding, maxBuffer) / (4T)⌋, maxComputeWorkgroupsPerDimension)`
cells. Each group has its own buffers and bind group, and groups are encoded
one after another. `createGpuFista(device, { maxGroupBytes })` caps one group's working set
(`estimateGpuBytes` of the group) below the device limit; the default is no
extra cap. Converged flags are read back once per `step(n)` call;
`solve(checkEvery = 50)` loops `step(checkEvery)` until every cell has
converged or `maxIters` is reached. Memory is about `20·N·T` bytes
(`estimateGpuBytes`).

## Scripts

Run these from `packages/compute-gpu`, or from the root with `-w @calab/compute-gpu`.
Run `npm run ensure-wasm` first so `crates/solver/pkg` exists.

| Script             | What                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm test`         | Node-only Vitest: scan vs serial Rust recursion, and the CPU model vs the real WASM solver. The WASM loads from bytes, because the `--target web` init() fetches by URL. |
| `npm run test:gpu` | Playwright specs (WASM vs GPU equivalence, and multi-group vs single-group, in the browser)                                                                              |
| `npm run bench`    | Playwright benchmark specs (`@bench`): the 200-iteration table and the 1024 x 270 000 converged pass                                                                     |
| `npm run harness`  | Serve the harness on :4177 by hand (`?mode=equiv`, `groups`, `bench`, `full`, `all`)                                                                                     |

The first time, install the browser with `npx playwright install chromium`.

### Browser / flags (macOS, Apple M5 Max)

| Launch                                                                                        | Result                                                          |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| default headless shell (`chromium-headless-shell`)                                            | `navigator.gpu` present, **no adapter**                         |
| headless shell + `--enable-unsafe-webgpu`                                                     | SwiftShader fallback adapter                                    |
| headless shell + `--use-angle=swiftshader --enable-unsafe-swiftshader --enable-unsafe-webgpu` | SwiftShader fallback adapter                                    |
| **`channel: 'chromium'`** (full Chromium, new headless mode), no flags                        | **real Metal adapter** (`apple / metal-3`, 4 GiB binding limit) |

The config uses `channel: 'chromium'`. `GPU_SPIKE_SWIFTSHADER=1` switches to
the headless shell with the SwiftShader flags. WebGPU needs a secure context,
so the harness is served from `http://127.0.0.1`; a `data:` URL has no
`navigator.gpu`.

## Results (Apple M5 Max, `apple / metal-3`, Chromium 153 headless)

### Equivalence (GPU vs WASM `step_batch`, `npm run test:gpu`)

Traces come from `simulate_traces` with
`buildSimulationConfig(DEFAULT_QUALITATIVE_CONFIG, { fs_hz: 30, num_timepoints: 27000, seed: 42 })`.
Each is preprocessed through the WASM `Solver` the way CaTune's pool worker
does it (banded mode, `set_params`, `set_trace`, `apply_filter`,
`subtract_baseline`, `get_trace`). Both solvers then run on that working
trace.

| Case                                                                                  | N   | T       | rel L2 (typical / worst) | max abs (worst) | iterations                                           |
| ------------------------------------------------------------------------------------- | --- | ------- | ------------------------ | --------------- | ---------------------------------------------------- |
| CaTune-like: 30 Hz, tauRise 0.02, tauDecay 0.4, λ 0.5, nonneg, tol 1e-4, filtered     | 16  | 27 000  | 1.5e-5 / 6.0e-4          | 8.3e-3          | identical in 15/16 cells; 1 cell GPU 240 vs WASM 241 |
| CaDecon-like: working trace upsampled 10×, 300 Hz, box01, λ 0, tol 1e-4, maxIters 500 | 8   | 270 000 | 4.3e-5 / 4.8e-5          | 9.0e-4          | 500 / 500 (neither converges)                        |
| Unfiltered: raw trace, baseline re-estimated every iteration, otherwise as CaTune     | 8   | 27 000  | 1.6e-5 / 5.8e-4          | 8.5e-3          | identical in 7/8 cells; 1 cell GPU 245 vs WASM 246   |

Each worst-case cell is one that stopped one iteration earlier than WASM.
f32 reductions on the GPU, against f64 accumulators in Rust, move the last
`diff² < tol²·‖x‖²` comparison by one iteration. The solution is then one
FISTA step away (rel L2 about 6e-4). Every cell that stops on the same
iteration agrees to about 1e-5. The spec asserts rel L2 ≤ 1e-3 and an
iteration difference ≤ 10 % per cell.

For the CaDecon case, `subtract_baseline()` is run on the upsampled trace so
that the WASM solver is `filtered`, matching CaDecon's `baseline_subtracted`
path. Without that call, `set_trace` clears `filtered`. The "Unfiltered" case
covers the baseline-estimating path.

Grouping (`groups.spec.ts`): the CaTune-like case with N = 8 solved once with
one group and once with `maxGroupBytes = 3 cells` (3 groups of 3, 3, 2 cells).
The two results are bitwise identical (relative L2 0, same iteration counts),
and the grouped run matches WASM under the thresholds above (worst rel L2
6.05e-4, the usual one-iteration-early cell).

Node tests (`npm test`):

- Scan vs serial Rust recursion: rel L2 ≤ 1e-5 for every tau/fs case. The
  worst is 8.9e-6 at fs = 300 with tauDecay = 1.0.
- CPU model vs WASM: 3e-6 (CaTune-like, same iteration counts) and 5e-5
  (box01 at 300 Hz, 500/500).

### Benchmark (`npm run bench`, 200 fixed iterations, convergence disabled)

WASM is timed as one cell for 200 iterations on the page's main thread. "WASM
8-worker ideal" is **an estimate**, `wasm_single × N / 8`: it assumes perfect
scaling over 8 workers and no pool overhead. GPU time is wall clock for
`step(200)`, including the final flag readback.

Adapter: apple / metal-3 (Apple M5 Max)

| N    | T      | profile              | groups | GPU ms / 200 it | WASM 1 cell ms / 200 it | WASM 8-worker ideal ms (estimate) | GPU speedup vs ideal |
| ---- | ------ | -------------------- | ------ | --------------- | ----------------------- | --------------------------------- | -------------------- |
| 8    | 27000  | CaTune 30 Hz nonneg  | 1      | 19.8            | 33.7                    | 34                                | 1.70x                |
| 64   | 27000  | CaTune 30 Hz nonneg  | 1      | 46.5            | 33.7                    | 270                               | 5.80x                |
| 256  | 27000  | CaTune 30 Hz nonneg  | 1      | 202.1           | 33.7                    | 1078                              | 5.34x                |
| 1024 | 27000  | CaTune 30 Hz nonneg  | 1      | 887.4           | 33.7                    | 4314                              | 4.86x                |
| 8    | 270000 | CaDecon 300 Hz box01 | 1      | 78.5            | 345.6                   | 346                               | 4.40x                |
| 64   | 270000 | CaDecon 300 Hz box01 | 1      | 562.4           | 345.6                   | 2765                              | 4.92x                |
| 256  | 270000 | CaDecon 300 Hz box01 | 1      | 2234.1          | 345.6                   | 11059                             | 4.95x                |
| 1024 | 270000 | CaDecon 300 Hz box01 | 1      | 8929.0          | 345.6                   | 44237                             | 4.95x                |

The N = 1024, T = 270 000 row (the full-coverage CaDecon case, 5.16 GB of
buffers) has no harness-side memory cap: the harness tries it and reports a
device out-of-memory or validation error as a failed run. On this Mac it fits
in one group (each buffer is 1.1 GB, under the 4 GiB binding limit).

**Full-coverage trace pass.** The same 1024 x 270 000 case with convergence on
(box01, lambda 0, tol 1e-4, maxIters 500, `npm run bench`): one group,
**23.2 s wall clock** for `load` + `solve(50)` + readback. No cell converged
within 500 iterations (1024/1024 stopped at the cap), so this is the cost of a
full 500-iteration pass. WASM, one cell at 345.6 ms / 200 it, would need about
1.73 s per cell per 500 iterations, or about 221 s for 1024 cells on an ideal
8 workers (estimate), roughly 9.5x slower.

At large N the GPU runs about 6 G sample-iterations/s, roughly 14 f32
accesses (about 56 B) per sample per iteration, so it is bandwidth-bound.
At N = 8, T = 27 000 it is bound by dispatch overhead: 2000 dispatches in
about 18 ms.

### Bandwidth projection for weaker GPUs

Memory traffic per sample per iteration (filtered path, from the WGSL; scalar
reads of `pows` and `aux` are negligible): `fwd1` 2 (read y, write s1), `fwd2` 2,
`adj1` 3 (read c, read trace, write s1), `adj2` 2, `prox` 5 (read a, x, y; write
x, y). That is 14 f32 accesses, **56 B**. At N = 256, T = 270 000 one iteration
moves 69.12 M samples x 56 B = 3.87 GB, so 200 iterations move 774 GB in 2.234 s:
**346 GB/s effective** on this Mac. Projection: time = 774 GB / bandwidth, for
the N = 256, T = 270 000 benchmark, against the idealized 8-worker WASM estimate
(11 059 ms).

| Class                  | GB/s | GPU ms / 200 it | Speedup vs 8-worker WASM ideal |
| ---------------------- | ---- | --------------- | ------------------------------ |
| Intel Iris Xe          | 60   | 12 900          | 0.86x                          |
| Apple M1/M2 base       | 100  | 7 740           | 1.43x                          |
| M-Pro class            | 200  | 3 870           | 2.86x                          |
| M-Max / discrete class | 400  | 1 940           | 5.7x                           |

Assumptions: the listed GB/s is the bandwidth the kernel actually achieves
(nominal peaks are higher, and this Mac sustains 346 GB/s, so real numbers will
likely be 20 to 40 % slower than the table); the kernel stays purely bandwidth
bound (no compute or dispatch limit, which flatters small-cache iGPUs); and
WASM per-core speed on those machines equals this Mac's, with a perfect
8-worker scaling. That last one flatters the WASM side on weaker laptops (fewer
or slower cores, and an iGPU shares its memory bus with the CPU workers), so
the real speedup on low-end hardware is probably better than shown. Below
roughly 100 GB/s the GPU path is not worth it for these sizes.
