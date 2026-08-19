# @calab/io

File parsers, data validation, cell ranking, and JSON export for the CaLab monorepo.

Depends on `@calab/core`. External dependencies: `fflate` (zip decompression for .npz, zlib inflate for .mat), `valibot` (export schema validation).

```
@calab/core
  ↑
@calab/io
  ↑
apps/catune, apps/carank
```

## Exports

| Export                                             | Source            | Description                                                          |
| -------------------------------------------------- | ----------------- | -------------------------------------------------------------------- |
| `parseNpy`                                         | `npy-parser.ts`   | Parse NumPy `.npy` binary format into typed arrays                   |
| `parseNpz`                                         | `npz-parser.ts`   | Parse NumPy `.npz` archives (zip of .npy files) via fflate           |
| `parseMat`                                         | `mat-parser.ts`   | Parse MATLAB Level-5 `.mat` files (v5/v6/v7); v7.3 HDF5 unsupported  |
| `validateTraceData`                                | `validation.ts`   | Validate trace data (NaN/Inf checks, shape validation, statistics)   |
| `extractCellTrace`, `processNpyResult`             | `array-utils.ts`  | Extract single-cell traces from multi-cell arrays, transpose support |
| `rankCellsByActivity`, `sampleRandomCells`         | `cell-ranking.ts` | Rank cells by activity level (variance-based), random cell sampling  |
| `buildExportData`, `downloadExport`, `parseExport` | `export.ts`       | Build, download, and parse CaTune JSON export files                  |
