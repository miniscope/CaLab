import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import type { CellStore } from '../lib/cell-store.ts';
import { TraceHistory } from '../lib/trace-history.ts';

const chart = vi.hoisted(() => ({
  overview: null as {
    envelope: { duration: number; x: number[] };
    onZoomChange: (s: number, e: number) => void;
  } | null,
  zoom: null as { data: () => [number[], (number | null)[]] } | null,
}));
vi.mock('@calab/ui/chart', () => ({
  OKABE_ITO: { vermillion: '#f00', blue: '#00f' },
  TraceOverview: (p: NonNullable<typeof chart.overview>) => {
    chart.overview = p;
    return <div />;
  },
  ZoomWindow: (p: NonNullable<typeof chart.zoom>) => {
    chart.zoom = p;
    return <div />;
  },
}));
import { CellTraceViewer } from '../components/CellTraceViewer.tsx';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.innerHTML = '';
});

describe('selected cell long-recording viewer', () => {
  it('uses bounded detail, keeps absolute times, and navigates old overview-only regions', () => {
    const h = new TraceHistory(4);
    h.push(0, 1, [7], [100]);
    h.push(999_996, 4, [7], [1, 2, 3, 4]);
    const dense = vi.spyOn(h, 'dense').mockImplementation(() => {
      throw new Error('full-recording allocation');
    });
    const range = vi.spyOn(h, 'range');
    const cells = {
      tick: () => 0,
      saved: () => false,
      history: () => h,
      frame: () => 1_000_000,
    } as unknown as CellStore;
    const host = document.createElement('div');
    document.body.append(host);
    dispose = render(() => <CellTraceViewer cells={cells} id={7} fps={20} />, host);
    const [x, y] = chart.zoom!.data();
    expect(y.filter((v) => v !== null)).toEqual([1, 2, 3, 4]);
    expect(x[1]).toBe(999_996 / 20);
    expect(chart.overview!.envelope.duration).toBe(50_000);
    expect(chart.overview!.envelope.x.length).toBeLessThanOrEqual(1024);
    expect(host.textContent).toContain('earlier regions have overview only');
    // Fractional navigation must not put bracketing samples outside the
    // endpoints: uPlot requires monotonically increasing timestamps.
    const s = 999_996.5 / 20;
    const e = 999_998.5 / 20;
    chart.overview!.onZoomChange(s, e);
    const [fractionalX, fractionalY] = chart.zoom!.data();
    expect(fractionalX[0]).toBe(s);
    expect(fractionalX.at(-1)).toBe(e);
    expect(fractionalX.every((v, i) => i === 0 || v > fractionalX[i - 1])).toBe(true);
    expect(fractionalY.filter((v) => v !== null)).toEqual([2, 3]);
    chart.overview!.onZoomChange(0, 1);
    const [oldX, oldY] = chart.zoom!.data();
    expect(oldX).toEqual([0, 1]);
    expect(oldY).toEqual([null, null]);
    expect(dense).not.toHaveBeenCalled();
    for (const [, first, end] of range.mock.calls) expect(end - first).toBeLessThanOrEqual(4);
  });
});
