/**
 * AR(2) coefficient derivation from tau parameters.
 *
 * TypeScript port of `tau_to_ar2` from wasm/catune-solver/src/kernel.rs (lines 40-49).
 *
 * The AR(2) process: c[t] = g1*c[t-1] + g2*c[t-2] + s[t]
 * Characteristic roots: decayRoot = exp(-dt/tau_decay), riseRoot = exp(-dt/tau_rise)
 * g1 = decayRoot + riseRoot (sum of roots), g2 = -(decayRoot * riseRoot) (negative product of roots)
 */

export interface AR2Coefficients {
  g1: number; // decayRoot + riseRoot (sum of AR2 roots)
  g2: number; // -(decayRoot * riseRoot) (negative product of roots)
  decayRoot: number; // exp(-dt/tau_decay) decay eigenvalue
  riseRoot: number; // exp(-dt/tau_rise) rise eigenvalue
  dt: number; // 1/fs sampling interval in seconds
}

export function computeAR2(tauRise: number, tauDecay: number, fs: number): AR2Coefficients {
  const dt = 1 / fs;
  const decayRoot = Math.exp(-dt / tauDecay);
  const riseRoot = Math.exp(-dt / tauRise);
  return { g1: decayRoot + riseRoot, g2: -(decayRoot * riseRoot), decayRoot, riseRoot, dt };
}
