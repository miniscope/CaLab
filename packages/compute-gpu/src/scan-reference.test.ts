import { describe, expect, it } from 'vitest';
import { clampTauRise, computeBandedParams } from './banded-params.ts';
import {
  blockForward,
  blockReduce,
  buildScanTables,
  forwardAggregate,
  mv,
  relL2,
  reverseAggregate,
  scanAdjoint,
  scanForward,
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

  it('2-state carry: hop / block matrices equal repeated stepping', () => {
    for (const [d, r] of [
      [0.92, 0.2],
      [0.9917, 0.85],
      [0.99995, 0.9967],
    ]) {
      const T = 2500; // last block of 452 samples
      const tb = buildScanTables(d, r, T);
      const stepN = (n: number, s: [number, number]): [number, number] => {
        let [u, w] = s;
        for (let i = 0; i < n; i++) {
          u = d * u;
          w = r * w + u;
        }
        return [u, w];
      };
      const s0: [number, number] = [0.7, -1.3];
      const check = (slot: number, n: number) => {
        const got = mv(tb, slot, s0[0], s0[1]);
        const want = stepN(n, s0);
        expect(Math.hypot(got[0] - want[0], got[1] - want[1])).toBeLessThan(
          1e-6 * Math.max(1, Math.hypot(...want)),
        );
      };
      for (let i = 0; i < tb.logWg; i++) check(tb.HOP + i, tb.k << i);
      check(tb.AC, tb.C);
      check(tb.ALAST, tb.lastLen);
    }
  });

  it('2-state block scan with carry-in equals the serial cascade across blocks', () => {
    const x = noise(10_000, 7);
    for (const [d, r] of [
      [0.2, 0.1],
      [0.9, 0.5],
      [0.9967, 0.9],
      [0.99995, 0.99],
    ]) {
      const tb = buildScanTables(d, r, x.length);
      // serial cascade in f64: c[t] = w_{t-1}
      const serial = new Float64Array(x.length);
      let u = 0;
      let w = 0;
      for (let i = 0; i < x.length; i++) {
        serial[i] = w;
        u = d * u + x[i];
        w = r * w + u;
      }
      const got = new Float32Array(x.length);
      let s: [number, number] = [0, 0];
      for (let b = 0; b < tb.nBlocks; b++) {
        const xin = new Float32Array(tb.C);
        for (let p = 0; p < tb.C && b * tb.C + p < x.length; p++) xin[p] = x[b * tb.C + p];
        const c = blockForward(xin, s, d, r, tb);
        for (let p = 0; p < tb.C && b * tb.C + p < x.length; p++) got[b * tb.C + p] = c[p];
        const F = forwardAggregate(tb, xin);
        const m = mv(tb, tb.AC, s[0], s[1]);
        s = [m[0] + F[0], m[1] + F[1]];
      }
      expect(relL2(got, serial)).toBeLessThan(1e-5);
    }
  });

  it('residual reverse aggregate from the forward carry (G, β, O, Tr) equals the direct one', () => {
    const p = computeBandedParams(0.02, 0.4, 300, 0);
    const d = p.decayRootF32;
    const r = p.riseRootF32;
    const T = 5000; // full blocks plus a partial last block
    const tb = buildScanTables(d, r, T);
    const src = spikes(T, 11);
    const trace = noise(T, 12);
    const bl = 0.37;
    const inv = p.invPeakF32;
    const D = tb.data;
    const c = scanForward(src, p);
    let s: [number, number] = [0, 0];
    for (let b = 0; b < tb.nBlocks; b++) {
      const last = b === tb.nBlocks - 1;
      const xin = new Float32Array(tb.C);
      const z = new Float32Array(tb.C);
      const trb = new Float32Array(tb.C);
      let cDirect = 0;
      for (let q = 0; q < tb.C && b * tb.C + q < T; q++) {
        const t = b * tb.C + q;
        xin[q] = Math.fround(src[t] * inv);
        trb[q] = trace[t];
        z[q] = (c[t] + bl - trace[t]) * inv;
        cDirect += c[t];
      }
      const direct = reverseAggregate(tb, z);
      const lin = blockReduce(tb, 6, (q, o) => {
        const w1 = 4 * (tb.POS1 + q) + (last ? 2 : 0);
        const w0 = 4 * (tb.POS0 + q) + 2;
        const w2 = 4 * (tb.POS2 + q) + (last ? 1 : 0);
        o[0] += D[w1] * xin[q];
        o[1] += D[w1 + 1] * xin[q];
        o[2] += D[w0] * trb[q];
        o[3] += D[w0 + 1] * trb[q];
        o[4] += D[w2] * xin[q];
      });
      const gs = mv(tb, last ? tb.GLAST : tb.GFULL, s[0], s[1]);
      const o = 4 * tb.OSUM + (last ? 2 : 0);
      const Q0 = inv * (gs[0] + lin[0] + bl * D[o] - lin[2]);
      const Q1 = inv * (gs[1] + lin[1] + bl * D[o + 1] - lin[3]);
      const scale = Math.hypot(...direct) + 1e-3;
      expect(Math.abs(Q0 - direct[0]) / scale).toBeLessThan(1e-4);
      expect(Math.abs(Q1 - direct[1]) / scale).toBeLessThan(1e-4);
      // Σ_t c[t] over the block = γ·s_in + Σ δ_p x_p
      const g = 4 * tb.GAM + (last ? 2 : 0);
      const cSum = D[g] * s[0] + D[g + 1] * s[1] + lin[4];
      expect(Math.abs(cSum - cDirect) / (Math.abs(cDirect) + 1)).toBeLessThan(1e-4);
      const F = forwardAggregate(tb, xin);
      const m = mv(tb, tb.AC, s[0], s[1]);
      s = [m[0] + F[0], m[1] + F[1]];
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
