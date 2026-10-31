# @calab/compute-gpu (spike)

A batched WebGPU (WGSL) implementation of the CaLab solver's banded-AR(2)
FISTA (`ConvMode::BandedAR2` in `crates/solver`). It solves every cell at
once and is meant as a drop-in alternative to the per-cell Rust/WASM path.
The WASM solver is the reference. Nothing in the apps uses this package yet.

## Layout

| File                        | What                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `src/banded-params.ts`      | Pure TS port of `clamp_tau_rise`, `build_kernel` (for the DC gain), `compute_impulse_peak`, `compute_banded_lipschitz`, step / threshold. |
| `src/scan-reference.ts`     | Host tables (`buildScanTables`), plain-TS block scans that mirror the WGSL, and a serial f32 port of the Rust forward/adjoint recursions. |
| `src/fista-reference.ts`    | CPU model of the GPU iteration (same passes, same f32 reduction tree). Tested against the real WASM solver in Node.                       |
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

### The AR(2) as one 2-state scan

`c[t] = g1 c[t-1] + g2 c[t-2] + s[t-1]/peak` factors as two cascaded
first-order IIRs with roots d (decay) and r (rise). With `x_j = src[j]/peak`
the cascade is one 2-state linear system:

- forward: `u_j = d u_{j-1} + x_j`, `w_j = r w_{j-1} + u_j`, i.e.
  `s_j = A s_{j-1} + e x_j` with `A = [[d, 0], [d, r]]`, `e = (1, 1)`, and
  `c[t] = w_{t-1}` (`c[0] = 0`).
- adjoint: the same system run backwards on `z_t = resid[t]/peak`,
  `q_t = (v_t, a_t) = A q_{t+1} + e z_t`, and `gradient[t] = a_{t+1}`
  (`a_T = 0`).

Rust casts `g1`, `g2` to f32. The GPU uses the roots of the f32-rounded
polynomial `z² - g1f z - g2f`, cast to f32. That reproduces the operator Rust
actually applies more closely than `exp(-dt/tau)`. At fs = 300 Hz with
tauDecay = 1 s the error drops from 1.1e-5 to 8.9e-6.

A block is `C = WG·K = 64·8 = 512` samples and belongs to one workgroup.
Inside a block each thread runs the cascade sequentially over its K samples;
a Hillis-Steele scan over the WG thread states (2-vectors, hop matrices
`A^(K·2^i)`) gives each thread its entering state, and the thread reruns its
K samples from it. The block's carry-in seeds thread 0 (thread WG-1 for the
reverse scan). Across blocks, one thread per cell walks the blocks with
`A^C` (`A^L` for a short last block). All matrix powers and block sums come
from `buildScanTables` (scan-reference.ts), computed in f64 and uploaded as
f32.

### One pass per iteration

The FISTA y is not stored. The two solution buffers ping-pong: x_k is in `xa`
for even k and in `xb` for odd k, and the pass rebuilds
`y_k = constrain(x_k + m (x_k - x_{k-1}))` (or `y_k = x_k` after a restart,
without reading x_{k-1}) and writes x_{k+1} over x_{k-1}. That is exactly the
y the previous iteration would have stored, so the arithmetic is unchanged.

The reverse scan of the residual needs, per block, the residual's reverse
aggregate `Q_b = Σ_p A^p e z_p` before the block can run. It is not computed
from the residual. `z` is linear in the block's forward carry-in `s_in`, its
inputs `x_p`, the baseline and the trace, so

`Q_b = (G s_in + Σ_p β_p x_p + baseline·O - Tr_b) / peak`

with `G = Σ_k A^k e e2ᵀ A^k`, `β_p = Σ_{k>p} A^k e h[k-1-p]`, `O = Σ_k A^k e`
(host tables, separate ones for the short last block), and the trace term
`Tr_b = Σ_p A^p e trace[p]`, computed once at load. The same trick gives
`Σ_t c[t]` over a block (`γ·s_in + Σ δ_p x_p`) for the unfiltered baseline.
Since restart is decided only after the pass, the pass emits these per-block
functionals (forward aggregate `F`, `Σβx`, `Σδx`) for both next-iteration
candidates, x_{k+1} and y_{k+1}; `fin` picks one.

| #   | Entry   | Grid              | Work                                                                                                                                                                                                                 |
| --- | ------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `sweep` | (nBlocks, nCells) | read x_k, x_{k-1}, trace; y; forward scan from `s_in`; residual in registers; reverse scan from `q_in`; prox; write x_{k+1}; per-block partials of diff², x_k², dot; per-block functionals of x_{k+1} and y_{k+1}    |
| 2   | `fin`   | ⌈nCells/64⌉       | sum partials, `iteration++`, t_fista, momentum, adaptive restart, convergence; then the next carries: forward `s_in[b]` (walk up with `A^C`), baseline (unfiltered), `Q_b`, reverse `q_in[b]` (walk down with `A^L`) |

That is 2 dispatches per iteration, filtered or not (was 10 / 12). `load()`
runs `prep` (trace terms and the x_0 candidate) and `carry` once.

Memory traffic per sample per iteration (from the WGSL; per-block records and
the cache-resident tables are negligible): read x_k, read x_{k-1}, read
trace, write x_{k+1}. That is **4 f32 accesses, 16 B** (3 after a restart),
down from 14 accesses (56 B) in the previous split-scan layout (`fwd1` 2,
`fwd2` 2, `adj1` 3, `adj2` 2, `prox` 5), a 3.5x cut. This is the floor for
this formulation: every iteration has to see x_k, x_{k-1} (or a stored y) and
the trace, and write x_{k+1}.

FISTA semantics match `fista.rs` `step_batch`:

- Momentum comes from `t_fista` as it was before the update.
- Restart when `iteration > 1 && dot > 0`.
- Converged when `iteration > 5 && diff² < tol²(x_old² + 1e-20)`.
- Constraints: NonNegative uses `max(·, 0)`; Box01 uses `clamp(·, 0, 1)`.
- Initial x = y = warm start or 0 (`useX = 1` at load, so y_0 = x_0).

WGSL has no float atomics, so every reduction goes through per-(cell, block)
partials. Every entry point returns early for converged cells; `sweep` reads
the flag with `workgroupUniformLoad`, so barriers stay in uniform control
flow. Everything is per cell and fixed-order, so results do not depend on how
cells are grouped.

**Not done: single-pass decoupled look-back.** It would not remove bytes: the
fused pass is already at the 4-access floor. It could only fold `fin` into
`sweep`, but the restart decision needs the full-trace `dot` before any block
knows which candidate the next forward scan starts from, and the reverse scan
needs every later block's forward state; both are grid-wide dependencies
inside one iteration. The remaining per-iteration cost besides the pass is one
small per-cell dispatch.

### Buffers

All buffers are cell-major, `index = cell·T + t`, f32 everywhere.

| Binding | Buffer  | Contents                                                                                        |
| ------- | ------- | ----------------------------------------------------------------------------------------------- |
| 0       | uniform | T, nBlocks, nCells, filtered, constraint, d, r, 1/peak, step, thresh, tol², 1/T                 |
| 1       | trace   | working traces                                                                                  |
| 2, 3    | xa, xb  | ping-pong solutions (x_k in `xa` for even k, `xb` for odd k)                                    |
| 4       | aux     | per (cell, block): partials, candidate functionals ×2, trace terms, carries `s_in`, `q_in` (20) |
| 5       | tab     | hop matrices, `A^C`, `A^L`, G, γ, O, and per-position `A^(C-1-p) e`, `A^p e`, β, δ              |
| 6       | cells   | per cell: t_fista, iteration, converged, useX, baseline, momentum                               |

`readSolutions()` reads the cell states, then copies each cell's row from
`xa` or `xb` by its iteration parity into one staging buffer; it changes no
state, so stepping can continue afterwards.

### Limits

`requestGpuDevice()` requests the adapter's `maxStorageBufferBindingSize` and
`maxBufferSize`. `load()` splits cells into groups of
`min(⌊min(maxBinding, maxBuffer) / (4T)⌋, maxComputeWorkgroupsPerDimension)`
cells. Each group has its own buffers and bind group, and groups are encoded
one after another. `createGpuFista(device, { maxGroupBytes })` caps one group's working set
(`estimateGpuBytes` of the group) below the device limit; the default is no
extra cap. Memory is about `12·N·T` bytes (`estimateGpuBytes`; was `20·N·T`).

Command buffers are sized by wall clock, not by a fixed iteration count:
`step()` times each submit (`queue.onSubmittedWorkDone`) and sizes the next
one to `targetSubmitMs` (option, default 75 ms; the first submit of a group
is 4 iterations, the cap is 1000), so one submission stays far below OS GPU
watchdogs (Windows TDR is about 2 s) on slow GPUs. Sizing never changes the
arithmetic. Converged flags are read back once per `step(n)` call;
`solve(checkEvery = 50)` loops `step(checkEvery)` until every cell has
converged or `maxIters` is reached.

## Scripts

Run these from `packages/compute-gpu`, or from the root with `-w @calab/compute-gpu`.
Run `npm run ensure-wasm` first so `crates/solver/pkg` exists.

| Script             | What                                                                                                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`         | Node-only Vitest: 2-state tables and block scan vs serial recursion, the analytic `Q_b`, and the CPU model vs the real WASM solver. The WASM loads from bytes, because the `--target web` init() fetches by URL. |
| `npm run test:gpu` | Playwright specs (WASM vs GPU equivalence, and multi-group vs single-group, in the browser)                                                                                                                      |
| `npm run bench`    | Playwright benchmark specs (`@bench`): the 200-iteration table and the 1024 x 270 000 converged pass                                                                                                             |
| `npm run harness`  | Serve the harness on :4177 by hand (`?mode=equiv`, `groups`, `bench`, `full`, `all`)                                                                                                                             |

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
| CaTune-like: 30 Hz, tauRise 0.02, tauDecay 0.4, λ 0.5, nonneg, tol 1e-4, filtered     | 16  | 27 000  | 1.6e-5 / 6.1e-4          | 8.3e-3          | identical in 15/16 cells; 1 cell GPU 240 vs WASM 241 |
| CaDecon-like: working trace upsampled 10×, 300 Hz, box01, λ 0, tol 1e-4, maxIters 500 | 8   | 270 000 | 4.4e-5 / 4.7e-5          | 7.3e-4          | 500 / 500 (neither converges)                        |
| Unfiltered: raw trace, baseline re-estimated every iteration, otherwise as CaTune     | 8   | 27 000  | 1.7e-5 / 2.0e-5          | 4.1e-4          | identical in 8/8 cells                               |

The worst CaTune cell stopped one iteration earlier than WASM. f32
reductions on the GPU, against f64 accumulators in Rust, move the last
`diff² < tol²·‖x‖²` comparison by one iteration. The solution is then one
FISTA step away (rel L2 about 6e-4). Every cell that stops on the same
iteration agrees to about 2e-5. The spec asserts rel L2 ≤ 1e-3 and an
iteration difference ≤ 10 % per cell. These numbers are essentially those of
the previous split-scan layout (6.0e-4 / 4.8e-5 / 5.8e-4 worst); the
unfiltered case lost its one-iteration-early cell.

For the CaDecon case, `subtract_baseline()` is run on the upsampled trace so
that the WASM solver is `filtered`, matching CaDecon's `baseline_subtracted`
path. Without that call, `set_trace` clears `filtered`. The "Unfiltered" case
covers the baseline-estimating path.

Grouping (`groups.spec.ts`): the CaTune-like case with N = 8 solved once with
one group and once with `maxGroupBytes = 3 cells` (3 groups of 3, 3, 2 cells).
The two results are bitwise identical (relative L2 0, same iteration counts),
and the grouped run matches WASM under the thresholds above (worst rel L2
6.06e-4, the usual one-iteration-early cell).

Node tests (`npm test`):

- 2-state tables: hop matrices, `A^C` and `A^L` equal repeated stepping (1e-6).
- Block scan with carry-in vs the serial cascade across blocks: rel L2 ≤ 1e-5.
- Scan-based forward / adjoint vs serial Rust recursion: rel L2 ≤ 1e-5 for
  every tau/fs case, and `<Kx, y> = <x, Kᵀy>`.
- Analytic `Q_b` and `Σc` (G, β, O, γ, δ, Tr) vs the direct reverse
  aggregate of the residual, including a short last block: ≤ 1e-4.
- CPU model vs WASM: rel L2 < 1e-4 and iterations within 10 % (CaTune-like),
  identical iterations (box01 at 300 Hz, unfiltered).

### Benchmark (`npm run bench`, 200 fixed iterations, convergence disabled)

WASM is timed as one cell for 200 iterations on the page's main thread. "WASM
8-worker ideal" is **an estimate**, `wasm_single × N / 8`: it assumes perfect
scaling over 8 workers and no pool overhead. GPU time is wall clock for
`step(200)`, including the final flag readback.

Adapter: apple / metal-3 (Apple M5 Max). WG = 64, K = 8 (a sweep of
WG ∈ {32, 64, 128, 256} × K ∈ {4, 8, 16} at N = 256, T = 270 000 ranged from
727 to 1271 ms; 64 × 8 was fastest, 256 × 4 ran 905 ms).

| N    | T      | profile              | groups | GPU ms / 200 it | before (split scans) | WASM 1 cell ms / 200 it | WASM 8-worker ideal ms (estimate) | GPU speedup vs ideal |
| ---- | ------ | -------------------- | ------ | --------------- | -------------------- | ----------------------- | --------------------------------- | -------------------- |
| 8    | 27000  | CaTune 30 Hz nonneg  | 1      | 19.3            | 19.8                 | 38.3                    | 38                                | 1.98x                |
| 64   | 27000  | CaTune 30 Hz nonneg  | 1      | 24.6            | 46.5                 | 38.3                    | 306                               | 12.5x                |
| 256  | 27000  | CaTune 30 Hz nonneg  | 1      | 76.6            | 202.1                | 38.3                    | 1226                              | 16.0x                |
| 1024 | 27000  | CaTune 30 Hz nonneg  | 1      | 278.7           | 887.4                | 38.3                    | 4902                              | 17.6x                |
| 8    | 270000 | CaDecon 300 Hz box01 | 1      | 83.6            | 78.5                 | 405.3                   | 405                               | 4.85x                |
| 64   | 270000 | CaDecon 300 Hz box01 | 1      | 255.8           | 562.4                | 405.3                   | 3242                              | 12.7x                |
| 256  | 270000 | CaDecon 300 Hz box01 | 1      | 757.5           | 2234.1               | 405.3                   | 12970                             | 17.1x                |
| 1024 | 270000 | CaDecon 300 Hz box01 | 1      | 2713.5          | 8929.0               | 405.3                   | 51878                             | 19.1x                |

The WASM column was 345.6 ms (T = 270 000) and 33.7 ms (T = 27 000) in the
previous run; this machine was busier during this one, so the speedup column
is flattered by about 15 %. The GPU columns are the comparison that matters:
2.9 to 3.3x faster at N ≥ 256. At N = 8 both layouts are bound by the
per-cell dispatch and submit overhead.

The N = 1024, T = 270 000 row (the full-coverage CaDecon case, now 3.3 GB of
buffers) has no harness-side memory cap: the harness tries it and reports a
device out-of-memory or validation error as a failed run. On this Mac it fits
in one group.

**Full-coverage trace pass.** The same 1024 x 270 000 case with convergence on
(box01, lambda 0, tol 1e-4, maxIters 500, `npm run bench`): one group,
**7.3 s wall clock** (was 23.2 s) for `load` + `solve(50)` + readback. No cell
converged within 500 iterations (1024/1024 stopped at the cap), so this is the
cost of a full 500-iteration pass. WASM, one cell at 345.6 ms / 200 it (the
quieter earlier measurement), would need about 1.73 s per cell per 500
iterations, or about 221 s for 1024 cells on an ideal 8 workers (estimate),
roughly 30x slower.

### Bandwidth projection for weaker GPUs

At 16 B per sample-iteration, N = 256, T = 270 000 moves 69.12 M samples x
16 B = 1.106 GB per iteration, 221 GB per 200 iterations, in 0.758 s:
**292 GB/s effective** on this Mac (the old layout reached 346 GB/s on 774
GB). Projection: time = 221 GB / bandwidth, against the idealized 8-worker
WASM estimate from the quieter run (11 059 ms), with the old 56 B layout for
comparison.

| Class                  | GB/s | GPU ms / 200 it              | Speedup vs 8-worker WASM ideal | old layout (56 B) |
| ---------------------- | ---- | ---------------------------- | ------------------------------ | ----------------- |
| Intel Iris Xe          | 60   | 3 690                        | 3.0x                           | 0.86x             |
| Apple M1/M2 base       | 100  | 2 210                        | 5.0x                           | 1.43x             |
| M-Pro class            | 200  | 1 110                        | 10x                            | 2.86x             |
| M-Max / discrete class | 400  | 553 (758 measured on M5 Max) | 14.6x (measured)               | 5.7x              |

Assumptions: the listed GB/s is the bandwidth the kernel actually achieves
(nominal peaks are higher); the kernel stays bandwidth bound; and WASM
per-core speed on those machines equals this Mac's, with perfect 8-worker
scaling, which flatters WASM on weaker laptops. The fused pass does more
arithmetic per byte than before (two in-block 2-state scans with 2x2 hop
matrices, ~50 workgroup barriers per block, and ten table-weighted sums per
sample for the candidate functionals, roughly 40 to 50 flops per sample per
iteration). On this Mac it no longer reaches the old 346 GB/s, so it is
partly latency or compute bound here; on a 60 GB/s iGPU with about 2 TFLOPS
f32 the compute is ~0.3 s per 200 iterations against 3.7 s of memory time,
so the bandwidth model should hold there. The 400 GB/s row is capped by that
limit (measured 758 ms, not 553).
