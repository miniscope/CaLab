import { describe, it, expect } from 'vitest';
import { shapeToTau, tauToShape } from '@calab/compute';

// The kernel shape ↔ tau transforms that the CaTune UI round-trips on every
// slider change resolve through the @calab/compute barrel from the app and are
// invertible at the default GCaMP6f-like kernel. This is not an app smoke test:
// the transforms themselves are covered in depth by
// packages/compute/src/__tests__/kernel-shape.test.ts. It is kept because it is
// the app's only test file (vitest is configured with passWithNoTests: false)
// and it checks the app-side workspace resolution of @calab/compute.
describe('kernel shape round-trip via @calab/compute', () => {
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
