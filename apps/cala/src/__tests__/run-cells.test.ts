import { describe, expect, it } from 'vitest';
import { compressFeedOptions, fastLoopOptions, normalizeRunCells } from '../lib/run-cells.ts';

const SETUP = { width: 4, height: 3, batchSize: 8, cellDiameterPx: 10, flattenSigmaPx: 0, fps: 20 };

describe('normalizeRunCells', () => {
  it('keeps look-back options only with look-back', () => {
    const asked = {
      factorFile: true,
      csettle: true,
      csettleYield: 4,
      csettleNeedFirst: true,
      settleFraction: 0.5,
      sessionStarts: [100],
    };
    expect(normalizeRunCells(asked)).toEqual({});
    expect(normalizeRunCells({ ...asked, lookback: true })).toEqual({ lookback: true, ...asked });
  });

  it('settles on factors only without look-back', () => {
    expect(normalizeRunCells({ factorSettle: true, settleFraction: 0.5 })).toEqual({
      factorSettle: true,
      settleFraction: 0.5,
    });
    expect(normalizeRunCells({ factorSettle: true, lookback: true })).toEqual({ lookback: true });
  });

  it('drops values at their default or out of range', () => {
    expect(
      normalizeRunCells({
        lookback: true,
        csettle: true,
        csettleYield: 0,
        settleFraction: 1,
        sessionStarts: [],
        settleVisitRate: 0,
      }),
    ).toEqual({ lookback: true, csettle: true });
    expect(normalizeRunCells({ settleVisitRate: Infinity })).toEqual({});
    expect(normalizeRunCells({ visitSchedule: 'auto', settleVisitRate: 0.4 })).toEqual({
      visitSchedule: 'auto',
      settleVisitRate: 0.4,
    });
  });

  it('is idempotent and copies the session starts', () => {
    const starts = [10, 20];
    const once = normalizeRunCells({ lookback: true, sessionStarts: starts, factorFile: true });
    expect(normalizeRunCells(once)).toEqual(once);
    expect(once.sessionStarts).not.toBe(starts);
  });
});

describe('fastLoopOptions', () => {
  it('passes a Discover run its normalized options and the plan boundaries', () => {
    const o = fastLoopOptions(
      SETUP,
      { session: 2, discover: true, lookback: true, factorSettle: true, forwardBuffers: 3 },
      [50],
      true,
    );
    expect(o).toEqual({
      ...SETUP,
      session: 2,
      discover: true,
      qc: true,
      residual: false,
      signed: false,
      lookback: true,
      sessionStarts: [50],
      poolSize: 3,
    });
  });

  it('gives Extract its library and no slow-loop options', () => {
    const library = new Uint8Array([1]);
    const o = fastLoopOptions(
      SETUP,
      { session: 0, discover: false, library, lookback: true, signed: true },
      [50],
      true,
    );
    expect(o).toEqual({
      ...SETUP,
      session: 0,
      discover: false,
      qc: true,
      residual: false,
      signed: true,
      initialLibrary: library,
    });
  });

  it('does not discover without the slow worker', () => {
    expect(fastLoopOptions(SETUP, { session: 1, discover: true }, undefined, false).discover).toBe(
      false,
    );
    expect(fastLoopOptions(SETUP, undefined, undefined, true)).toMatchObject({
      session: 0,
      discover: true,
    });
  });
});

describe('compressFeedOptions', () => {
  it('maps the compress settings, leaving defaults absent', () => {
    expect(compressFeedOptions({ session: 1, discover: true, compress: true }, 4, 3)).toEqual({
      width: 4,
      height: 3,
      session: 1,
    });
    expect(
      compressFeedOptions(
        {
          session: 1,
          discover: true,
          compress: true,
          compressTiling: 'offset',
          compressPool: { discover: 2, after: 3 },
          compressBacklogCap: 0,
          compressFrameExtract: true,
          compressGpu: true,
          compressGpuCheck: 2,
        },
        4,
        3,
      ),
    ).toEqual({
      width: 4,
      height: 3,
      session: 1,
      tiling: 'offset',
      pool: { discover: 2, after: 3 },
      backlogCap: 0,
      frameExtract: true,
      gpu: true,
      gpuCheck: 2,
    });
  });
});
