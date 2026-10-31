/**
 * The CPU model of the GPU iteration (fista-reference.ts) against the real
 * Rust/WASM solver in banded mode.
 *
 * The .wasm is loaded from bytes because the wasm-pack `--target web` glue's
 * default init() fetches by URL, which does not work in Node. This test
 * imports crates/solver/pkg directly; the "go through @calab/core/wasm" rule
 * is for app code, and the adapter's initWasm() cannot take bytes.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildSimulationConfig, DEFAULT_QUALITATIVE_CONFIG } from '@calab/compute';
// eslint-disable-next-line no-restricted-imports -- test-only: load the glue with bytes (see header)
import init, { Solver, simulate_traces } from '../../../crates/solver/pkg/calab_solver.js';
import { referenceFista } from './fista-reference.ts';
import { relL2 } from './scan-reference.ts';
import type { GpuFistaParams } from './types.ts';

const WASM = fileURLToPath(
  new URL('../../../crates/solver/pkg/calab_solver_bg.wasm', import.meta.url),
);

beforeAll(async () => {
  await init({ module_or_path: readFileSync(WASM) });
});

function simulate(nCells: number, T: number): Float32Array[] {
  const cfg = buildSimulationConfig(DEFAULT_QUALITATIVE_CONFIG, {
    fs_hz: 30,
    num_timepoints: T,
    num_cells: nCells,
    seed: 7,
  });
  const res = simulate_traces(cfg) as { traces: number[] };
  return Array.from({ length: nCells }, (_, c) =>
    Float32Array.from(res.traces.slice(c * T, (c + 1) * T)),
  );
}

/** CaTune preprocessing: filter + rolling-baseline subtraction, then solve. */
function wasmSolve(
  raw: Float32Array,
  p: GpuFistaParams,
  preprocess: boolean,
): { working: Float32Array; solution: Float32Array; iterations: number; converged: boolean } {
  const s = new Solver();
  s.set_conv_mode(1);
  s.set_params(p.tauRise, p.tauDecay, p.lambda, p.fs);
  s.set_constraint(p.constraint === 'box01' ? 1 : 0);
  s.set_trace(raw);
  if (preprocess) {
    s.set_filter_enabled(false);
    s.subtract_baseline();
  }
  const working = s.get_trace();
  while (!s.converged() && s.iteration_count() < p.maxIters) {
    s.step_batch(Math.min(50, p.maxIters - s.iteration_count()));
  }
  const out = {
    working,
    solution: s.get_solution(),
    iterations: s.iteration_count(),
    converged: s.converged(),
  };
  s.free();
  return out;
}

function upsample(x: Float32Array, factor: number): Float32Array {
  const out = new Float32Array(x.length * factor);
  for (let i = 0; i < out.length; i++) out[i] = x[Math.floor(i / factor)];
  return out;
}

describe('CPU model of the GPU iteration matches the WASM banded solver', () => {
  it('CaTune-like: nonneg, filtered (baseline subtracted), 30 Hz', () => {
    const p: GpuFistaParams = {
      tauRise: 0.02,
      tauDecay: 0.4,
      fs: 30,
      lambda: 0.5,
      constraint: 'nonneg',
      tol: 1e-4,
      maxIters: 2000,
      filtered: true,
    };
    for (const raw of simulate(2, 3000)) {
      const w = wasmSolve(raw, p, true);
      const r = referenceFista(w.working, p);
      expect(w.converged).toBe(true);
      expect(r.converged).toBe(true);
      expect(relL2(r.solution, w.solution)).toBeLessThan(1e-4);
      expect(Math.abs(r.iterations - w.iterations) / w.iterations).toBeLessThanOrEqual(0.1);
    }
  });

  it('CaDecon-like: box01, unfiltered (baseline estimated), 300 Hz upsampled', () => {
    const p: GpuFistaParams = {
      tauRise: 0.02,
      tauDecay: 0.4,
      fs: 300,
      lambda: 0,
      constraint: 'box01',
      tol: 1e-4,
      maxIters: 500,
      filtered: false,
    };
    for (const raw of simulate(2, 600)) {
      const up = upsample(raw, 10);
      const w = wasmSolve(up, p, false);
      const r = referenceFista(w.working, p);
      expect(r.iterations).toBe(w.iterations);
      expect(relL2(r.solution, w.solution)).toBeLessThan(1e-4);
    }
  });
});
