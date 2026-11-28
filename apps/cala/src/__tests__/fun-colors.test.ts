import { describe, expect, it } from 'vitest';
import {
  activityColor,
  activityFill,
  candyColor,
  FUN_MODES,
  hsl,
  isFunMode,
  neonColor,
  rainbowColor,
} from '../lib/fun-colors.ts';
import { renderOverlay, type CellGeometry } from '../lib/cell-overlay.ts';

/** One 3x3 cell in the middle of a 9x9 field. */
function oneCell(): CellGeometry {
  const width = 9;
  const height = 9;
  const inside: number[] = [];
  const contour: number[] = [];
  for (let y = 3; y < 6; y++)
    for (let x = 3; x < 6; x++) {
      inside.push(y * width + x);
      if (x !== 4 || y !== 4) contour.push(y * width + x);
    }
  return {
    version: 1,
    width,
    height,
    label: new Int32Array(width * height).fill(-1),
    shapes: [
      {
        id: 3,
        inside: Uint32Array.from(inside),
        contour: Uint32Array.from(contour),
        y0: 3,
        x0: 3,
        y1: 6,
        x1: 6,
        peak: 1,
        support: Uint32Array.from(inside),
        rel: new Float32Array(inside.length).fill(1),
      },
    ],
  };
}

describe('display colour schemes', () => {
  it('hsl gives the primaries', () => {
    expect(hsl(0, 1, 0.5)).toEqual([255, 0, 0]);
    expect(hsl(1 / 3, 1, 0.5)).toEqual([0, 255, 0]);
  });

  it('give neighbouring IDs different colours, the same ID always the same', () => {
    for (const f of [rainbowColor, neonColor, candyColor]) {
      expect(f(4)).toEqual(f(4));
      expect(f(4)).not.toEqual(f(5));
    }
  });

  it('live activity runs quiet blue to hot, with a fill only when firing', () => {
    const q = activityColor(0);
    const h = activityColor(1);
    expect(q[2]).toBeGreaterThan(q[0]);
    expect(h[0]).toBeGreaterThan(200);
    expect(activityFill(0)).toBe(0);
    expect(activityFill(1)).toBeGreaterThan(0.3);
  });

  it('Live activity stays when the switch is off; the playful ones go', () => {
    expect(FUN_MODES.activity.playful).toBe(false);
    expect(FUN_MODES.rainbow.playful && FUN_MODES.neon.playful && FUN_MODES.candy.playful).toBe(
      true,
    );
    expect(isFunMode('neon')).toBe(true);
    expect(isFunMode('pass')).toBe(false);
  });
});

describe('overlay glow', () => {
  const style = {
    color: () => [10, 200, 30] as [number, number, number],
    fill: () => 0,
    selected: null,
  };

  it('draws a halo outside the outline only with glow, never inside the cell', () => {
    const g = oneCell();
    const plain = renderOverlay(g, style);
    const glow = renderOverlay(g, { ...style, glow: true });
    const alpha = (rgba: Uint8ClampedArray, x: number, y: number) => rgba[(y * 9 + x) * 4 + 3];
    // Outline pixels are identical; one and two pixels out glow, fading.
    expect(alpha(glow, 3, 3)).toBe(alpha(plain, 3, 3));
    expect(alpha(plain, 2, 4)).toBe(0);
    expect(alpha(glow, 2, 4)).toBeGreaterThan(alpha(glow, 1, 4));
    expect(alpha(glow, 1, 4)).toBeGreaterThan(0);
    expect(alpha(glow, 0, 4)).toBe(0);
    // The centre (inside, not on the outline) stays clear.
    expect(alpha(glow, 4, 4)).toBe(0);
  });

  it('keeps the selected cell white and unglowed', () => {
    const g = oneCell();
    const rgba = renderOverlay(g, { ...style, selected: 3, glow: true });
    expect(rgba[(3 * 9 + 3) * 4]).toBe(255);
    expect(rgba[(4 * 9 + 1) * 4 + 3]).toBe(0);
  });
});
