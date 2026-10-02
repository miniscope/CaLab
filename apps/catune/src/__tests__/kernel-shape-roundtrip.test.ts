import { describe, it, expect } from 'vitest';
import { shapeToTau, tauToShape } from '@calab/compute';

// App-level smoke: the kernel shape ↔ tau transforms that the CaTune UI
// round-trips on every slider change are importable and invertible.
describe('catune smoke', () => {
  it('round-trips tau ↔ shape through @calab/compute', () => {
    const tauIn = { tauRise: 0.02, tauDecay: 0.4 };
    const shape = tauToShape(tauIn.tauRise, tauIn.tauDecay);
    expect(shape).not.toBeNull();
    const tauOut = shapeToTau(shape!.tPeak, shape!.fwhm);
    expect(tauOut).not.toBeNull();
    // The shape ↔ tau mapping is table-interpolated, so tolerate small drift.
    expect(Math.abs(tauOut!.tauRise - tauIn.tauRise) / tauIn.tauRise).toBeLessThan(1e-3);
    expect(Math.abs(tauOut!.tauDecay - tauIn.tauDecay) / tauIn.tauDecay).toBeLessThan(1e-3);
  });
});
