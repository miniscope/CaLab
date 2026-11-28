import { describe, expect, it, vi } from 'vitest';

vi.mock('uplot', () => ({ default: class {} }));
vi.mock('@dschz/solid-uplot', () => ({ SolidUplot: () => null }));

const { sharedFormat } = await import('../components/ProjectView.tsx');

describe('sharedFormat (the setup page reads the sessions’ frame width and rate)', () => {
  it('gives the width and rate every session shares', () => {
    expect(
      sharedFormat([
        { width: 600, fps: 20 },
        { width: 600, fps: 20 },
      ]),
    ).toEqual({ width: 600, fps: 20 });
  });

  it('gives 0 where sessions differ, and skips sessions not read', () => {
    expect(sharedFormat([{ width: 600, fps: 20 }, null, { width: 608, fps: 20 }])).toEqual({
      width: 0,
      fps: 20,
    });
    expect(
      sharedFormat([
        { width: 600, fps: 30 },
        { width: 600, fps: null },
      ]),
    ).toEqual({
      width: 600,
      fps: 0,
    });
  });

  it('gives 0 with nothing read (a live stream before it connects)', () => {
    expect(sharedFormat([null])).toEqual({ width: 0, fps: 0 });
    expect(sharedFormat([])).toEqual({ width: 0, fps: 0 });
  });
});
