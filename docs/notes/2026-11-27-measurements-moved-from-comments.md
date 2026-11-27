# Measurements moved out of code comments (non-cala apps and packages), 2026-11-27

Each entry is the number or measurement a source comment used to carry, moved verbatim when the comment was rewritten to follow the comment policy in `/CLAUDE.md`. Grouped by file.

## `apps/catune/src/lib/cell-solve-manager.ts`

- apps/catune/src/lib/cell-solve-manager.ts (QUANTUM_ITERATIONS): each iteration ~0.1-1ms depending on trace length; 200 iterations keeps quanta under ~40ms for typical traces; round-trip overhead reduced by ~13x; cancel responsiveness ~2ms via BATCH_SIZE yields.

## `apps/catune/src/lib/gpu-prep-client.ts`

- apps/catune/src/lib/gpu-prep-client.ts (header): measured in Chromium on an Apple M5 Max, demo data (20 cells, 30 Hz, 1381-sample padded windows), round trip per trace from `prepStats`: 11.4 ms (8 to 10 ms with 5 cells), so ~0.23 s before a 20-cell batch can start.

## `packages/compute/src/gpu-batch-consumer.ts`

- packages/compute/src/gpu-batch-consumer.ts (GPU_STARTUP_TIMEOUT_MS): GPU prep is ~11 ms per trace.

## `packages/core/src/metrics/dataset-overview.ts`

- packages/core/src/metrics/dataset-overview.ts (heightVerdictMinEvents): on homogeneous simulated cells (one burst distribution) the band measured 4.2× at ~6 events, 2.1× at ~19 and 1.5× at ~60.

## `packages/io/src/__tests__/mat-writer.test.ts`

- packages/io/src/**tests**/mat-writer.test.ts (header): the hand check used scipy 1.15.3 / numpy 2.1.3, 2026-08-19.
