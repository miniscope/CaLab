# @calab/io

File parsers, data validation, cell ranking, the shared import store, and the Python bridge client for the CaLab monorepo.

Depends on `@calab/core` and `@calab/compute`. External dependencies: `fflate` (zip decompression for .npz, zlib inflate for .mat), `solid-js` (the import store's signals).

```
@calab/core
  ↑
@calab/io
  ↑
apps/catune, apps/cadecon, apps/carank
```

## Exports

| Export                                                                              | Source                | Description                                                                                                                                                  |
| ----------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `parseNpy`                                                                          | `npy-parser.ts`       | Parse NumPy `.npy` binary format into typed arrays                                                                                                           |
| `parseNpz`                                                                          | `npz-parser.ts`       | Parse NumPy `.npz` archives (zip of .npy files) via fflate                                                                                                   |
| `parseMat`                                                                          | `mat-parser.ts`       | Parse MATLAB Level-5 `.mat` files (v5/v6/v7); v7.3 HDF5 unsupported                                                                                          |
| `validateTraceData`                                                                 | `validation.ts`       | Validate trace data (NaN/Inf checks, shape validation, statistics)                                                                                           |
| `extractCellTrace`, `processNpyResult`                                              | `array-utils.ts`      | Extract single-cell traces from multi-cell arrays, transpose support                                                                                         |
| `rankCellsByActivity`, `sampleRandomCells`                                          | `cell-ranking.ts`     | Rank cells by activity level (variance-based), random cell sampling                                                                                          |
| `createImportStore`, `ImportStore`                                                  | `import-store.ts`     | Reactive import pipeline (file/demo/bridge loading, array selection, dims, sampling rate, validation, ground truth, `dataSource`); each app instantiates one |
| `validateParsedData`                                                                | `validation.ts`       | Validate any imported typed array (full checks for floats, basic stats for integers)                                                                         |
| `traceCandidates`, `soleTraceCandidate`                                             | `trace-candidates.ts` | Pick the trace matrix in a multi-array .npz / .mat                                                                                                           |
| `dataIndex`                                                                         | `array-utils.ts`      | Flat index for (cell, timepoint) honouring a dimension swap                                                                                                  |
| `getBridgeUrl`, `fetchBridgeData`, `postParamsToBridge`, `postResultsToBridge`, ... | `bridge.ts`           | Client for the Python bridge server's routes; apps build their own payloads                                                                                  |
