import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'solid-js/web';
import { createSignal, type JSX } from 'solid-js';
import type { CellStore } from '../lib/cell-store.ts';
import { initialFlatFieldState, type FlatFieldState } from '../lib/flat-field.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import { CorrGhost } from '../components/CorrDistancePanel.tsx';
import { FlatFieldPanel } from '../components/FlatFieldPanel.tsx';
import { TimingPanel } from '../components/TimingPanel.tsx';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.innerHTML = '';
});

function mountIn(el: () => JSX.Element): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(el, host);
  return host;
}

const W = 4;
const H = 2;

/** A pipeline store with only what the Flat field and Timing tabs read. */
function fakeStore(flat: FlatFieldState) {
  const [state, setState] = createSignal(flat);
  const store = {
    flatField: state,
    flatEnabled: () => state().enabled,
    setFlatEnabled: () => {},
    status: () => 'done',
    stageMs: () => ({ readMs: 0.2, preprocessMs: 2.5, motionMs: 3.3 }),
    stageBusy: () => [] as number[],
    fps: () => 0,
  } as unknown as PipelineStore;
  return { store, setState };
}

describe('Flat field tab', () => {
  const base: FlatFieldState = {
    ...initialFlatFieldState(),
    supported: true,
    fps: 20,
    firstFrames: 3000,
  };

  it('shows a hatched placeholder and the progress toward the first map', () => {
    const { store } = fakeStore({ ...base, frames: 1000 });
    const host = mountIn(() => <FlatFieldPanel store={store} width={W} height={H} />);
    expect(host.querySelector('[data-testid="flatfield-placeholder"]')?.textContent).toBe(
      'No map yet',
    );
    expect(host.querySelector('[data-testid="flatfield-badge"]')?.textContent).toBe('Estimating');
    const meter = host.querySelector('[data-testid="flatfield-progress"] [role="meter"]')!;
    expect(meter.getAttribute('aria-valuenow')).toBe('50');
    expect(meter.getAttribute('aria-valuemax')).toBe('150');
  });

  it('drops the placeholder and the progress once a map is in force', () => {
    const map = {
      gain: new Float32Array(W * H).fill(1),
      offset: new Float32Array(0),
      dark: 0,
      binsUsed: 5,
      framesUsed: 3000,
      gainSd: 0.02,
    };
    const { store } = fakeStore({ ...base, frames: 4000, map, updates: 1, firstFrame: 3000 });
    const host = mountIn(() => <FlatFieldPanel store={store} width={W} height={H} />);
    expect(host.querySelector('[data-testid="flatfield-placeholder"]')).toBeNull();
    expect(host.querySelector('[data-testid="flatfield-progress"]')).toBeNull();
    expect(host.querySelector('[data-testid="flatfield-badge"]')?.textContent).toBe('Estimated');
    expect(host.querySelector('[data-testid="flatfield-first-frame"]')?.textContent).toBe(
      'frame 3,000',
    );
  });

  it('says Off over the placeholder when the correction is off', () => {
    const { store } = fakeStore({ ...base, enabled: false });
    const host = mountIn(() => <FlatFieldPanel store={store} width={W} height={H} />);
    expect(host.querySelector('[data-testid="flatfield-placeholder"]')?.textContent).toBe('Off');
    expect(host.querySelector('[data-testid="flatfield-progress"]')).toBeNull();
  });
});

describe('Timing tab', () => {
  function fakeCells(onMs: number[]) {
    return {
      fps: () => 20,
      status: () => null,
      events: () => [],
      batch: () => null,
      timing: () => ({
        on: onMs,
        off: [],
        solveOn: [],
        solveOff: [],
        solveQc: [],
        solveNoQc: [],
        qcBuildMs: [],
      }),
      slowTiming: () => ({ batchMs: [], stepMs: [] }),
    } as unknown as CellStore;
  }

  it('draws a measured series as a span with the frame budget, an empty one as a dash', () => {
    const { store } = fakeStore(initialFlatFieldState());
    const host = mountIn(() => <TimingPanel store={store} cells={fakeCells([2, 4, 6])} />);
    const on = host.querySelector('[data-testid="timing-on"]')!;
    expect(on.querySelector('.range-bar__span')).not.toBeNull();
    // The budget of a frame at 20 fps is 50 ms.
    expect(on.querySelector('[role="img"]')?.getAttribute('aria-label')).toContain(
      'reference 50.0',
    );
    expect(on.querySelector('.cala-timing__fig')?.textContent).toBe('4.00 · 6.00 · 6.00');
    const off = host.querySelector('[data-testid="timing-off"]')!;
    expect(off.querySelector('.range-bar__span')).toBeNull();
    expect(off.querySelector('.cala-timing__fig')?.textContent).toBe('–');
    expect(host.querySelector('[data-testid="timing-stage-motion"]')?.textContent).toBe(
      'motion3.30',
    );
    expect(host.querySelector('[data-testid="cells-counters"]')?.textContent).toContain(
      'The slow loop starts after frame 50.',
    );
  });
});

describe('Correlation tab before Compute', () => {
  it('draws the axes at the default range with the message in the plot', () => {
    const host = mountIn(() => <CorrGhost message="Needs at least two cells" />);
    const fig = host.querySelector('[data-testid="corr-ghost"]')!;
    expect(fig.querySelector('svg')?.getAttribute('aria-label')).toBe('Needs at least two cells');
    expect(fig.querySelectorAll('[data-testid="corr-x-tick"]').length).toBeGreaterThan(1);
    const yTicks = Array.from(fig.querySelectorAll('text[text-anchor="end"]')).map(
      (t) => t.textContent,
    );
    expect(yTicks[0]).toBe('-0.1');
    expect(yTicks[yTicks.length - 1]).toBe('0.5');
    expect(host.querySelector('[data-testid="corr-plot"]')).toBeNull();
  });
});
