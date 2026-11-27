/**
 * One window of Extract on factors: solved from its factors by the
 * `FactorExtractor` (the solver's functionals taken straight from the factors,
 * no frame rebuilt), or, when a pixel without data in the window lies under a
 * cell, its moat, a ring or a basis map, on frames rebuilt from the factors
 * with the same engine. The engine starts cold for
 * every window, so a window's traces do not depend on which worker solved it
 * or what it solved before. Shared by the compress worker and its helpers.
 */
import { rebuildFrames, type FactorWindowLike } from './factor-frames.ts';

/** What a window's solve needs of the WASM `FactorExtractor` (tests pass fakes). */
export interface FactorExtractorLike {
  ids(): Uint32Array;
  /** Stream index of the open window's first frame. */
  readonly start: number;
  /** Read a factor file; returns its frames. */
  open(bytes: Uint8Array): number;
  /** A pixel without data in the open window lies under a functional. */
  neverValidUnder(): boolean;
  coldStart(): void;
  /** Frames `t0..t0 + count` of the open window from its factors. */
  solve(t0: number, count: number): Float32Array;
  /** `count` frames (NaN: missing), with the engine's missing-pixel fill. */
  solveFrames(frames: Float32Array, count: number): Float32Array;
  /** The signed traces of the last solve (empty unless signed). */
  lastSigned(): Float32Array;
  free(): void;
}

/** A solved window: its stream place, the route, and `count x cells` traces. */
export interface WindowResult {
  start: number;
  count: number;
  projected: boolean;
  traces: Float32Array;
  signed?: Float32Array;
}

/** Frames solved per call. */
export const SOLVE_BATCH = 16;

/**
 * Solve the window in `bytes` on `x`, cold. `openFactors` reads it as a
 * `FactorWindow` for the rebuilt route; `px` is pixels per frame.
 */
export function solveWindow(
  x: FactorExtractorLike,
  bytes: Uint8Array,
  openFactors: (bytes: Uint8Array) => FactorWindowLike,
  px: number,
  signed: boolean,
): WindowResult {
  const frames = x.open(bytes);
  const n = x.ids().length;
  x.coldStart();
  const traces = new Float32Array(frames * n);
  const sg = signed ? new Float32Array(frames * n) : undefined;
  const keep = (t: number): void => {
    if (!sg) return;
    const s = x.lastSigned();
    if (s.length > 0) sg.set(s, t * n);
  };
  const projected = !x.neverValidUnder();
  if (projected) {
    for (let t = 0; t < frames; t += SOLVE_BATCH) {
      const k = Math.min(SOLVE_BATCH, frames - t);
      traces.set(x.solve(t, k), t * n);
      keep(t);
    }
    return { start: x.start, count: frames, projected, traces, signed: sg };
  }
  const w = openFactors(bytes);
  try {
    const never = w.neverValid?.() ?? null;
    const buf = new Float32Array(SOLVE_BATCH * px);
    for (let t = 0; t < frames; t += SOLVE_BATCH) {
      const k = Math.min(SOLVE_BATCH, frames - t);
      const view = buf.subarray(0, k * px);
      rebuildFrames(w, never, t, k, view);
      traces.set(x.solveFrames(view, k), t * n);
      keep(t);
    }
    return { start: x.start, count: frames, projected, traces, signed: sg };
  } finally {
    w.free();
  }
}
