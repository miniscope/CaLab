import { describe, expect, it } from 'vitest';
import { clampTauRise, computeBandedParams } from './banded-params.ts';
import {
  relL2,
  scanAdjoint,
  scanForward,
  scanIir,
  serialAdjoint,
  serialForward,
} from './scan-reference.ts';

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function spikes(T: number, seed: number): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(T);
  for (let i = 0; i < T; i++) out[i] = r() < 0.02 ? r() * 2 : 0;
  return out;
}

function noise(T: number, seed: number): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(T);
  for (let i = 0; i < T; i++) out[i] = r() * 2 - 1;
  return out;
}

// [tauRise, tauDecay, fs, T]
const CASES: [number, number, number, number][] = [
  [0.02, 0.4, 30, 27000],
  [0.1, 0.6, 30, 5000],
  [0.05, 0.25, 100, 9000],
  [0.02, 1.0, 300, 30000],
  [0.01, 0.15, 300, 4097],
  [0.4, 0.4, 30, 3000], // clamp_tau_rise edge case: tau_rise == tau_decay
  [0.4 * (1 - 1e-7), 0.4, 30, 3000], // within the clamp window
  [0.02, 0.4, 30, 7], // shorter than one block
  [0.02, 0.4, 30, 1],
];

describe('scan-based AR(2) matches the serial Rust recursion', () => {
  it('clamps tau_rise like Rust', () => {
    expect(clampTauRise(0.4, 0.4)).toBe(0.2);
    expect(clampTauRise(0.1, 0.4)).toBe(0.1);
  });

  it('first-order scan equals the serial recursion across block boundaries', () => {
    const x = noise(10_000, 7);
    for (const a of [0.2, 0.9, 0.9967, 0.99995]) {
      const serial = new Float32Array(x.length);
      let acc = 0;
      for (let i = 0; i < x.length; i++) {
        acc = Math.fround(Math.fround(a * acc) + x[i]);
        serial[i] = acc;
      }
      expect(relL2(scanIir(x, a), serial)).toBeLessThan(1e-5);
    }
  });

  for (const [tr, td, fs, T] of CASES) {
    it(`forward + adjoint: tauRise=${tr} tauDecay=${td} fs=${fs} T=${T}`, () => {
      const p = computeBandedParams(tr, td, fs, 0.5);
      for (const seed of [1, 2]) {
        const s = spikes(T, seed);
        const fwd = scanForward(s, p);
        const fwdRef = serialForward(s, p);
        if (T > 1) expect(relL2(fwd, fwdRef)).toBeLessThan(1e-5);
        else expect(fwd[0]).toBe(0);

        const r = noise(T, seed + 100);
        const adj = scanAdjoint(r, p);
        const adjRef = serialAdjoint(r, p);
        if (T > 1) expect(relL2(adj, adjRef)).toBeLessThan(1e-5);
        else expect(adj[0]).toBe(0);
      }
    });
  }

  it('forward and adjoint are adjoint (<Kx,y> = <x,K^T y>)', () => {
    const p = computeBandedParams(0.02, 1.0, 300, 0);
    const x = noise(20_000, 3);
    const y = noise(20_000, 4);
    const kx = scanForward(x, p);
    const kty = scanAdjoint(y, p);
    let lhs = 0;
    let rhs = 0;
    for (let i = 0; i < x.length; i++) {
      lhs += kx[i] * y[i];
      rhs += x[i] * kty[i];
    }
    expect(Math.abs(lhs - rhs) / Math.abs(lhs)).toBeLessThan(1e-4);
  });
});
