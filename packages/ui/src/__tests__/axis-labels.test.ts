import { describe, it, expect } from 'vitest';
import { placeAxisLabels } from '../chart/axis-labels.ts';

describe('placeAxisLabels', () => {
  it('keeps every label when they have room, anchoring the ends inward', () => {
    const out = placeAxisLabels(
      [
        { x: 40, text: '0:00' },
        { x: 140, text: '0:10' },
        { x: 240, text: '0:20' },
      ],
      { x0: 40, x1: 240 },
    );
    expect(out.map((l) => [l.text, l.anchor])).toEqual([
      ['0:00', 'start'],
      ['0:10', 'middle'],
      ['0:20', 'end'],
    ]);
  });

  it('drops a round tick that would collide with a pinned label at a segment seam', () => {
    // Discover's last tick at its end (x 300), the Final settle segment's "0" 8 px later.
    const out = placeAxisLabels(
      [
        { x: 200, text: '0:40' },
        { x: 300, text: '0:50' },
        { x: 308, text: '0', anchor: 'start', priority: 1 },
        { x: 400, text: '1,000 fed', anchor: 'end', priority: 1 },
      ],
      { x0: 40, x1: 400 },
    );
    expect(out.map((l) => l.text)).toEqual(['0:40', '0', '1,000 fed']);
    // No two kept boxes overlap.
    const boxes = out.map((l) => {
      const w = l.text.length * 6;
      return l.anchor === 'start'
        ? [l.x, l.x + w]
        : l.anchor === 'end'
          ? [l.x - w, l.x]
          : [l.x - w / 2, l.x + w / 2];
    });
    for (let i = 1; i < boxes.length; i++) expect(boxes[i][0]).toBeGreaterThan(boxes[i - 1][1]);
  });

  it('skips empty and non-finite labels and those that cannot fit the span', () => {
    const out = placeAxisLabels(
      [
        { x: NaN, text: 'a' },
        { x: 50, text: '' },
        { x: 50, text: 'a very long label that is wider than the span' },
      ],
      { x0: 40, x1: 100 },
    );
    expect(out).toEqual([]);
  });
});
