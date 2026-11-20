// Cells with rectified (clipped or denoised) input, for the warning banner and
// the per-cell marker: found at load by the import scan (so the warning shows
// before any run) and flagged by the solver after a run (same rule). Kept out
// of iteration-store so that store does not depend on data-store (and WASM).

import { createMemo } from 'solid-js';
import { rectifiedInputCells } from './data-store.ts';
import { rectifiedCells as solverRectifiedCells } from './iteration-store.ts';
import { mergeCellIndices } from './rectified-input.ts';

export const rectifiedCells = createMemo(() =>
  mergeCellIndices(rectifiedInputCells(), solverRectifiedCells()),
);
