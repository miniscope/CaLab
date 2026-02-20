# @calab/compute

Worker pool, warm-start caching, kernel math, downsampling, and synthetic data generation for the CaLab monorepo.

Depends on `@calab/core`.

```
@calab/core
  ↑
@calab/compute
  ↑
apps/catune
```

## Exports

| Export                                                                  | Source                | Description                                                                                                                    |
| ----------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `createWorkerPool`, `WorkerPool`                                        | `worker-pool.ts`      | Generic worker pool with priority queue, cooperative cancellation via MessageChannel yields, and intermediate result callbacks |
| `computePaddedWindow`, `computeSafeMargin`                              | `warm-start-cache.ts` | Windowed computation helpers — compute padded solve region with safety margins for overlap-and-discard                         |
| `shouldWarmStart`, `WarmStartCache`                                     | `warm-start-cache.ts` | 3-tier warm-start cache (lambda-only change, kernel change with momentum reset, cold start)                                    |
| `computeKernel`, `computeKernelAnnotations`                             | `kernel-math.ts`      | Double-exponential kernel computation and annotation helpers for chart display                                                 |
| `downsampleMinMax`                                                      | `downsample.ts`       | Min-max downsampling for efficient chart rendering of large traces                                                             |
| `makeTimeAxis`                                                          | `time-axis.ts`        | Time axis generation from sample count and sampling rate                                                                       |
| `DEMO_PRESETS`, `DEFAULT_PRESET_ID`, `getPresetById`, `getPresetLabels` | `demo-presets.ts`     | 6 built-in synthetic demo presets with known ground truth                                                                      |
| `generateSyntheticTrace`, `generateSyntheticDataset`                    | `mock-traces.ts`      | Synthetic calcium trace generation for demo data                                                                               |

## Design Notes

- **Worker factory injection** — `createWorkerPool(() => new Worker(...))` keeps the `new Worker(new URL(..., import.meta.url))` pattern in the app so Vite can detect and bundle the worker.
- **Raw postMessage** (not Comlink) so the event loop can process cancel messages between solver batches.
- **MessageChannel yields** (<1 ms) instead of `setTimeout(0)` (~4 ms) for cooperative multitasking.
