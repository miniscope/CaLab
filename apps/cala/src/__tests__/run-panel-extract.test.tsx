import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import type { FactorState } from '../lib/compress-store.ts';
import { createStageLog } from '../lib/run-stages.ts';

// uPlot needs a real browser (matchMedia); the panel's plots are not under test.
vi.mock('uplot', () => ({ default: class {} }));
vi.mock('@dschz/solid-uplot', () => ({ SolidUplot: () => null }));

import { RunPanel, type RunPanelProps } from '../components/RunPanel.tsx';

/**
 * A store stub: the listed members as given, any other member a function that
 * answers nothing. Only what these tests look at is stated.
 */
function stub<T extends object>(members: Record<string, unknown>): T {
  return new Proxy(members, {
    get: (t, k) => (k in t ? t[k as string] : () => undefined),
  }) as unknown as T;
}

const FRAMES = 100;

interface Setup {
  factors: FactorState;
  factorsFailed: boolean;
  source: 'raw' | 'factors';
  minValid?: Float32Array;
}

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
});

function mount(o: Setup): HTMLElement {
  const pass2 = stub<RunPanelProps['pass2']>({
    status: () => 'done',
    source: () => o.source,
    factorsFailed: () => o.factorsFailed,
    processed: () => FRAMES,
    total: () => FRAMES,
    error: () => null,
    blockedReason: () => null,
    result: () => ({
      ids: Uint32Array.of(1, 2),
      cells: 2,
      frames: FRAMES,
      seconds: 2,
      source: o.source,
      ...(o.minValid ? { minValid: o.minValid } : {}),
    }),
  });
  const pipeline = stub<RunPanelProps['pipeline']>({
    status: () => 'done',
    record: () => ({ frames: FRAMES, snapshot: () => ({}), flatFieldApplied: [] }),
    flatFieldMap: () => null,
    processed: () => FRAMES,
    fps: () => 20,
    plan: () => null,
  });
  const cells = stub<RunPanelProps['cells']>({
    metrics: () => ({ lag: [] }),
    convergence: () => ({ state: 'converged', reason: '' }),
    status: () => null,
    library: () => null,
    qc: () => null,
  });
  const compress = stub<NonNullable<RunPanelProps['compress']>>({
    factors: () => o.factors,
    status: () => null,
  });
  const ui = stub<RunPanelProps['ui']>({
    run: stub({
      fps: () => 20,
      history: () => stub({ toExport: () => ({}) }),
      events: () => stub({ toJSON: () => '[]' }),
    }),
    window: stub({ state: { mode: 'run' }, inspected: () => null }),
    axisEnd: () => 0,
    span: () => ({ t0: 0, t1: 0 }),
    expanded: () => false,
    events: () => [],
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  dispose = render(
    () => (
      <RunPanel
        pipeline={pipeline}
        pass2={pass2}
        refine={stub<RunPanelProps['refine']>({ status: () => 'idle' })}
        stages={createStageLog()}
        availability={{ discover: null, refine: null, extract: null }}
        onRefine={() => {}}
        cells={cells}
        label="rec"
        width={4}
        height={3}
        fps={20}
        narrow
        ui={ui}
        compress={compress}
        visible={false}
      />
    ),
    root,
  );
  return root;
}

const text = (root: HTMLElement, id: string) =>
  root.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;

describe('the Run panel under Extract, with compression on', () => {
  it('says Extract replays the file when the last Extract on the factors failed', () => {
    const root = mount({ factors: 'ready', factorsFailed: true, source: 'raw' });
    expect(text(root, 'extract-source')).toBe(
      'Extract replays the file: the last Extract on the factors failed.',
    );
  });

  it('says Extract reads the factors when they are ready and none failed', () => {
    const root = mount({ factors: 'ready', factorsFailed: false, source: 'raw' });
    expect(text(root, 'extract-source')).toBe('Extract reads the factors (seconds).');
  });

  it('adds the sentence on cells with missing pixels to a factor Extract', () => {
    const root = mount({
      factors: 'ready',
      factorsFailed: false,
      source: 'factors',
      minValid: Float32Array.of(0.5, 0.75),
    });
    expect(text(root, 'pass2-status')).toContain(
      "2 cells have pixels without data in their footprint; their traces can differ from a file replay's.",
    );
  });

  it('says it in the singular for one cell', () => {
    const root = mount({
      factors: 'ready',
      factorsFailed: false,
      source: 'factors',
      minValid: Float32Array.of(0.5, 1),
    });
    expect(text(root, 'pass2-status')).toContain(
      "1 cell has pixels without data in its footprint; its trace can differ from a file replay's.",
    );
  });

  it('adds no such sentence when no cell is below 1, or for a raw Extract', () => {
    const none = mount({
      factors: 'ready',
      factorsFailed: false,
      source: 'factors',
      minValid: Float32Array.of(1, 1),
    });
    expect(text(none, 'pass2-status')).not.toContain('without data');
    dispose?.();
    document.body.replaceChildren();
    const raw = mount({ factors: 'ready', factorsFailed: false, source: 'raw' });
    expect(text(raw, 'pass2-status')).not.toContain('without data');
  });
});
