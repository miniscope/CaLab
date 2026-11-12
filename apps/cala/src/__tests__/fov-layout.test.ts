import { describe, expect, it } from 'vitest';
import {
  FOV_CHROME_H_PX,
  FOV_CHROME_V_PX,
  fovLayout,
  NARROW_BELOW_PX,
  SIDE_MIN_PX,
} from '../lib/fov-layout.ts';

describe('FOV layout', () => {
  it('sizes a square recording by the height on a wide window', () => {
    const l = fovLayout(1408, 830, 600, 600);
    expect(l.narrow).toBe(false);
    expect(l.fovWidth).toBe(830 - FOV_CHROME_V_PX + FOV_CHROME_H_PX);
    expect(1408 - l.fovWidth).toBeGreaterThanOrEqual(SIDE_MIN_PX);
  });

  it('keeps the column at its minimum width when the image would take it', () => {
    const l = fovLayout(1100, 1000, 752, 480);
    expect(l.narrow).toBe(false);
    expect(l.fovWidth).toBe(1100 - SIDE_MIN_PX - 8);
  });

  it('stacks on narrow or portrait windows', () => {
    expect(fovLayout(NARROW_BELOW_PX - 1, 700, 600, 600)).toEqual({
      narrow: true,
      fovWidth: NARROW_BELOW_PX - 1,
    });
    expect(fovLayout(1200, 1600, 600, 600).narrow).toBe(true);
  });
});
