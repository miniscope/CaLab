import { describe, expect, it } from 'vitest';
import {
  centreOn,
  clampView,
  FIT_VIEW,
  imageAt,
  MAX_ZOOM,
  oneToOneZoom,
  panBy,
  viewTransform,
  visibleRect,
  zoomAt,
} from '../lib/fov-view.ts';

describe('FOV zoom and pan', () => {
  it('keeps the image point under the cursor fixed while zooming', () => {
    const v = zoomAt(FIT_VIEW, 4, 0.25, 0.75);
    expect(v.zoom).toBe(4);
    const [x, y] = imageAt(v, 0.25, 0.75);
    expect(x).toBeCloseTo(0.25);
    expect(y).toBeCloseTo(0.75);
    // And back out again: the point stays put until the view hits the edge.
    const w = zoomAt(v, 0.5, 0.25, 0.75);
    expect(imageAt(w, 0.25, 0.75)[0]).toBeCloseTo(0.25);
  });

  it('never zooms out past Fit or in past the maximum, and never leaves the image', () => {
    expect(zoomAt(FIT_VIEW, 0.1)).toEqual(FIT_VIEW);
    expect(zoomAt(FIT_VIEW, 1e6).zoom).toBe(MAX_ZOOM);
    // Zoomed in at a corner: the centre is clamped so the corner is on the edge.
    const v = zoomAt(FIT_VIEW, 2, 0, 0);
    expect(v).toEqual({ zoom: 2, u: 0.25, v: 0.25 });
    expect(clampView({ zoom: 2, u: 0.9, v: -1 })).toEqual({ zoom: 2, u: 0.75, v: 0.25 });
    expect(clampView({ zoom: NaN, u: NaN, v: 0.5 })).toEqual(FIT_VIEW);
  });

  it('pans with the pointer and centres on a minimap click', () => {
    const v = { zoom: 4, u: 0.5, v: 0.5 };
    // Dragging right by a quarter of the stage shows what was to the left.
    expect(panBy(v, 0.25, 0).u).toBeCloseTo(0.5 - 0.25 / 4);
    expect(panBy(v, -10, 0).u).toBeCloseTo(1 - 0.125);
    expect(centreOn(v, 0.1, 0.6)).toEqual({ zoom: 4, u: 0.125, v: 0.6 });
    expect(panBy(FIT_VIEW, 0.3, 0.3)).toEqual(FIT_VIEW);
  });

  it('gives the 1:1 zoom, the layer transform and the visible box', () => {
    expect(oneToOneZoom(600, 300)).toBe(2);
    expect(oneToOneZoom(600, 0)).toBe(1);
    expect(viewTransform(FIT_VIEW)).toBe('translate(0.0000%, 0.0000%) scale(1.00000)');
    // Zoom 2 on the top-left quarter: the layer moves by 0 and scales by 2.
    expect(viewTransform({ zoom: 2, u: 0.25, v: 0.25 })).toBe(
      'translate(0.0000%, 0.0000%) scale(2.00000)',
    );
    expect(viewTransform({ zoom: 2, u: 0.75, v: 0.5 })).toBe(
      'translate(-100.0000%, -50.0000%) scale(2.00000)',
    );
    expect(visibleRect({ zoom: 4, u: 0.5, v: 0.25 })).toEqual([0.375, 0.125, 0.25, 0.25]);
  });
});
