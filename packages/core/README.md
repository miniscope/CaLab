# @calab/core

Shared types, pure utilities, domain math, and the WASM adapter for the CaLab monorepo.

This is a **leaf package** with no local dependencies (`valibot` is the only external dependency). All other `@calab/*` packages and both apps depend on `@calab/core`.

```
@calab/core  ← leaf (no local deps)
  ↑
@calab/compute, @calab/io, @calab/community, apps/catune, apps/carank
```

## Boundary Rule

Only `wasm-adapter.ts` may import from the WASM solver package (`wasm/catune-solver/pkg/`). All other code in the monorepo imports `{ initWasm, Solver }` from `@calab/core`. This boundary is enforced by ESLint `no-restricted-imports`.

## Exports

| Export                                                          | Source                      | Description                                                                                 |
| --------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------- |
| `initWasm`, `Solver`                                            | `wasm-adapter.ts`           | WASM initialization and solver class                                                        |
| `CaTuneExportSchema`                                            | `schemas/export-schema.ts`  | Valibot schema for JSON export validation                                                   |
| `NpyResult`, `NpzResult`, `ValidationResult`, `ImportStep`, ... | `types.ts`                  | Shared data types                                                                           |
| `SAMPLING_RATE_PRESETS`                                         | `types.ts`                  | Common sampling rate options                                                                |
| `CellSolverStatus`, `SolverParams`, `WarmStartStrategy`, ...    | `solver-types.ts`           | Worker communication protocol types                                                         |
| `computeAR2`                                                    | `ar2.ts`                    | AR(2) coefficient derivation from tau parameters                                            |
| `PARAM_RANGES`                                                  | `param-config.ts`           | Scientifically reasonable parameter ranges (rise 1–500 ms, decay 50–3000 ms, sparsity 0–10) |
| `formatDuration`                                                | `format-utils.ts`           | Duration formatting utility                                                                 |
| `computePeakSNR`, `snrToQuality`                                | `metrics/snr.ts`            | Peak signal-to-noise ratio and quality tier classification                                  |
| `computeSparsityRatio`, `computeResidualRMS`, `computeRSquared` | `metrics/solver-metrics.ts` | Solver quality metrics                                                                      |
| `computePeriodogram`                                            | `spectrum/fft.ts`           | Power spectral density computation                                                          |
