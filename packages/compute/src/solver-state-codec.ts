// Encode / decode the Rust solver's warm-start state (`Solver::export_state`
// / `load_state` in crates/solver/src/lib.rs). Lets a non-WASM backend (the
// WebGPU batch solver) produce and consume the same warm-start bytes the
// worker pool caches, so a fallback mid-session keeps its warm starts.
//
// Layout, little-endian: u32 n | f64 t_fista | u32 iteration | f64 baseline |
// f32 solution[n] | f32 solution_prev[n]. Total 24 + 8n bytes.

const HEADER_BYTES = 24;

export interface DecodedSolverState {
  tFista: number;
  iteration: number;
  baseline: number;
  solution: Float32Array;
  solutionPrev: Float32Array;
}

export function solverStateByteLength(n: number): number {
  return HEADER_BYTES + 8 * n;
}

export function encodeSolverState(s: {
  solution: Float32Array;
  solutionPrev?: Float32Array;
  tFista?: number;
  iteration?: number;
  baseline?: number;
}): Uint8Array {
  const n = s.solution.length;
  const buf = new ArrayBuffer(solverStateByteLength(n));
  const view = new DataView(buf);
  view.setUint32(0, n, true);
  view.setFloat64(4, s.tFista ?? 1, true);
  view.setUint32(12, s.iteration ?? 0, true);
  view.setFloat64(16, s.baseline ?? 0, true);
  const bytes = new Uint8Array(buf);
  bytes.set(new Uint8Array(s.solution.buffer, s.solution.byteOffset, 4 * n), HEADER_BYTES);
  const prev = s.solutionPrev ?? s.solution;
  bytes.set(new Uint8Array(prev.buffer, prev.byteOffset, 4 * n), HEADER_BYTES + 4 * n);
  return bytes;
}

/** Returns null for a malformed or empty state (callers treat that as a cold start). */
export function decodeSolverState(bytes: Uint8Array): DecodedSolverState | null {
  if (bytes.byteLength < HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = view.getUint32(0, true);
  if (bytes.byteLength !== solverStateByteLength(n)) return null;
  // Copy so the result is 4-byte aligned regardless of the input offset.
  const body = bytes.slice(HEADER_BYTES);
  return {
    tFista: view.getFloat64(4, true),
    iteration: view.getUint32(12, true),
    baseline: view.getFloat64(16, true),
    solution: new Float32Array(body.buffer, 0, n),
    solutionPrev: new Float32Array(body.buffer, 4 * n, n),
  };
}
