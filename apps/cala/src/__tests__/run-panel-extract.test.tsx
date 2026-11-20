import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { LIVE_EXTRACT_READY, liveFactorsBlocked, type FactorState } from '../lib/compress-store.ts';
import {
  createStageLog,
  LIVE_EXTRACT_NOTE,
  LIVE_FACTORS_NOTE,
  LIVE_NOTE,
  type StageLog,
} from '../lib/run-stages.ts';

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
const SETTINGS = () => ({ maxIterations: 20, settleShare: 0.02 });

interface Setup {
  factors: FactorState;
  factorsFailed: boolean;
  source: 'raw' | 'factors';
  minValid?: Float32Array;
  /** The compress store's error (absent: none). */
  compressError?: string;
  live?: boolean;
  refineFactors?: boolean;
  /** The Extract store's status (default done). */
  pass2Status?: string;
  /** The Refine store's members (default: idle). */
  refine?: Record<string, unknown>;
  stages?: StageLog;
  /** No compress store (`?compress=off`). */
  noCompress?: boolean;
  /** Extract has no result (the export falls back on a live run's traces). */
  noResult?: boolean;
  /** The cell store's members over the defaults. */
  cells?: Record<string, unknown>;
}

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
});

function mount(o: Setup): HTMLElement {
  const pass2 = stub<RunPanelProps['pass2']>({
    status: () => o.pass2Status ?? 'done',
    source: () => o.source,
    factorsFailed: () => o.factorsFailed,
    processed: () => FRAMES,
    total: () => FRAMES,
    error: () => null,
    blockedReason: () => null,
    result: () =>
      o.noResult
        ? null
        : {
            ids: Uint32Array.of(1, 2),
            cells: 2,
            frames: FRAMES,
            seconds: 2,
            source: o.source,
            ...(o.minValid ? { minValid: o.minValid } : {}),
          },
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
    ...o.cells,
  });
  const compress = stub<NonNullable<RunPanelProps['compress']>>({
    factors: () => o.factors,
    status: () => null,
    error: () => o.compressError ?? null,
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
        refine={stub<RunPanelProps['refine']>(o.refine ?? { status: () => 'idle' })}
        stages={o.stages ?? createStageLog()}
        availability={{ discover: null, refine: null, extract: null }}
        onRefine={() => {}}
        cells={cells}
        label="rec"
        width={4}
        height={3}
        fps={20}
        narrow
        ui={ui}
        compress={o.noCompress ? undefined : compress}
        live={o.live}
        liveFactors={
          o.live && !o.noCompress
            ? liveFactorsBlocked(o.factors, null, Boolean(o.compressError))
            : undefined
        }
        refineFactors={o.refineFactors}
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

  it('says the compression failed when the compress store has an error', () => {
    const root = mount({
      factors: 'unusable',
      factorsFailed: false,
      source: 'raw',
      compressError: 'QuotaExceededError',
    });
    expect(text(root, 'extract-source')).toBe('Extract replays the file: the compression failed.');
    const short = mount({ factors: 'unusable', factorsFailed: false, source: 'raw' });
    expect(text(short, 'extract-source')).toBe(
      'Extract replays the file: the factors do not cover the recording.',
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

describe('the Run panel of a live run with compression on', () => {
  const LIVE = {
    factors: 'ready',
    factorsFailed: false,
    source: 'raw',
    live: true,
    pass2Status: 'idle',
  } as const;

  it('offers Extract on the factors of a live run and says what it reads', () => {
    const root = mount(LIVE);
    expect(root.querySelector('[data-testid="pass2-run"]')).not.toBeNull();
    expect(text(root, 'extract-source')).toBe(LIVE_EXTRACT_READY);
    // Without ?refine=factors no Refine is offered, and the note offers none.
    expect(text(root, 'live-stage-note')).toBe(LIVE_EXTRACT_NOTE);
    expect(root.querySelector('[data-testid="refine-run"]')).toBeNull();
  });

  it('says why the factors of a stream cannot be read yet', () => {
    const root = mount({ ...LIVE, factors: 'unusable' });
    expect(text(root, 'extract-source')).toBe(
      'The factors do not cover the stream (a last window of one frame is not compressed). The export keeps the live traces.',
    );
  });

  it("names the export after Extract's traces once Extract ran", () => {
    const done = mount({ ...LIVE, pass2Status: 'done', source: 'factors' });
    expect(done.querySelector('[data-testid="export-npz"]')?.getAttribute('title')).toContain(
      "Extract's traces",
    );
  });

  it('keeps a live run Discover-only without compression', () => {
    const root = mount({ ...LIVE, noCompress: true });
    expect(root.querySelector('[data-testid="pass2-run"]')).toBeNull();
    expect(root.querySelector('[data-testid="extract-source"]')).toBeNull();
    expect(text(root, 'live-stage-note')).toBe(LIVE_NOTE);
  });

  it('shows Refine for a live run with ?refine=factors, named after what it does', () => {
    const root = mount({
      ...LIVE,
      refineFactors: true,
      refine: {
        status: () => 'idle',
        route: () => 'factors',
        routeNote: () => null,
        factorSettings: SETTINGS,
      },
    });
    expect(text(root, 'refine-run')).toBe('Refine until settled');
    expect(text(root, 'live-stage-note')).toBe(LIVE_FACTORS_NOTE);
  });

  describe('the export of the live traces while Refine runs on the factors', () => {
    const running = (finalLibrary: boolean) => {
      const stages = createStageLog();
      stages.begin('refine');
      return mount({
        ...LIVE,
        refineFactors: true,
        stages,
        noResult: true,
        refine: {
          status: () => 'running',
          route: () => 'factors',
          routeNote: () => null,
          factorSettings: SETTINGS,
          processed: () => 1,
          total: () => 20,
          fps: () => 0,
          phase: () => ({ kind: 'iterate', stopping: false, last: null }),
        },
        cells: {
          // The worst case: the last status the main thread holds does not say final.
          status: () => ({ final: false, factorRun: true }),
          finalLibrary: () => finalLibrary,
          library: () => ({ ids: Uint32Array.of(1, 2), version: 3 }),
          history: () => ({
            range: (_id: number, a: number, b: number) => new Float32Array(b - a),
          }),
        },
      });
    };
    const button = (root: HTMLElement) =>
      root.querySelector<HTMLButtonElement>('[data-testid="export-npz"]')!;

    it('stays available while the library is final', async () => {
      const root = running(true);
      await vi.waitFor(() => expect(button(root).disabled).toBe(false));
      expect(button(root).getAttribute('title')).toContain('the live traces');
    });

    it('waits for the final library otherwise', async () => {
      const root = running(false);
      await new Promise((r) => setTimeout(r, 0));
      expect(button(root).disabled).toBe(true);
    });
  });

  it('shows the progress bars of Extract and Refine running on the factors of a live run', () => {
    const stages = createStageLog();
    stages.begin('refine');
    const root = mount({
      ...LIVE,
      refineFactors: true,
      stages,
      refine: {
        status: () => 'running',
        route: () => 'factors',
        routeNote: () => null,
        factorSettings: SETTINGS,
        processed: () => 1,
        total: () => 20,
        fps: () => 0,
        phase: () => ({ kind: 'iterate', stopping: false, last: null }),
      },
    });
    expect(root.querySelector('[data-testid="refine-readout"]')).not.toBeNull();
    expect(root.querySelector('[role="progressbar"][aria-label="Refine"]')).not.toBeNull();
  });
});

describe('the Run panel of Refine on the factors', () => {
  const FILE = {
    factors: 'ready',
    factorsFailed: false,
    source: 'raw',
    pass2Status: 'idle',
  } as const;

  it('reads out the iterations of a running Refine on the factors', () => {
    const stages = createStageLog();
    stages.begin('refine');
    const root = mount({
      ...FILE,
      refineFactors: true,
      stages,
      refine: {
        status: () => 'running',
        route: () => 'factors',
        routeNote: () => null,
        factorSettings: () => ({ maxIterations: 20, settleShare: 0.02 }),
        processed: () => 2,
        total: () => 20,
        fps: () => 0,
        phase: () => ({
          kind: 'iterate',
          stopping: false,
          last: {
            iteration: 2,
            libraryVersion: 9,
            cells: 40,
            frames: 1200,
            fittingFrames: 800,
            accepted: 5,
            changedShare: 0.04,
            medianChange: 0.003,
            lowValid: 0,
            tilesSkipped: 0,
            ms: 10,
          },
        }),
      },
    });
    expect(text(root, 'refine-readout')).toBe(
      'Refine 1 on the factors: iteration 2 of at most 20 done · 5 refinements accepted · 4.0% of cells still changing (settled below 2.0%) · median change 0.3%',
    );
  });

  it('reads out how a finished Refine on the factors stopped', () => {
    const stages = createStageLog();
    stages.begin('refine');
    stages.end('refine', 'done', {
      cells: 40,
      footprintsRefined: 30,
      medianFootprintChange: 0.012,
      source: 'factors',
      iterations: 20,
      stop: 'cap',
      changedShare: 0.031,
    });
    const root = mount({
      ...FILE,
      refineFactors: true,
      stages,
      refine: {
        status: () => 'done',
        route: () => 'factors',
        routeNote: () => null,
        factorSettings: SETTINGS,
      },
    });
    expect(text(root, 'refine-readout')).toBe(
      'Refine 1 on the factors: stopped at the cap of 20 iterations without settling (3.1% of cells still changing) · 30 of 40 footprints refined · median change of those 1.2%',
    );
  });

  it("says why a file's Refine replays the file with the switch on", () => {
    const note = 'Refine replays the file: the last Refine on the factors failed.';
    const root = mount({
      ...FILE,
      refineFactors: true,
      refine: { status: () => 'idle', route: () => 'raw', routeNote: () => note },
    });
    expect(text(root, 'refine-route')).toBe(note);
    expect(text(root, 'refine-run')).toBe('Refine');
  });
});
