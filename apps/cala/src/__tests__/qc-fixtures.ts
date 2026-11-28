/** Shared QC fixtures of the cala tests. */
import type { CellQcRow } from '../lib/qc.ts';

/** A measured, passing QC row with plausible metrics; `over` replaces fields. */
export function qcRow(over: Partial<CellQcRow>): CellQcRow {
  return {
    id: 1,
    slot: 0,
    ageFrames: 2000,
    frames: 1200,
    peakSnr: 10,
    eventRate: 3,
    projR: 0.9,
    vif: 1.1,
    maxOverlap: 0.2,
    maxNeighbourR: 0.1,
    maxNeighbourId: -1,
    fpError: 0.1,
    nNeighbours: 1,
    fpLastR: 1,
    slowFrac: 0.3,
    zeroFrac: 0.2,
    diffSkew: 1,
    fpRadiusPx: 4,
    motionR2: 0.01,
    flags: 0,
    pass: true,
    ...over,
  };
}
