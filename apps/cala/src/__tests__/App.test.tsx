import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render } from 'solid-js/web';
import type { FrameSourceInfo } from '../lib/frame-source.ts';
import type { FrameClient } from '../lib/frame-client.ts';
import type { PipelineStepResult } from '../lib/pipeline-types.ts';
import type { PipelinePlan } from '../lib/pipeline-plan.ts';
import { makeFile } from './synth-avi.ts';

// uPlot needs a real browser (matchMedia); the shared barrels pull it in but
// this app draws no charts.
vi.mock('uplot', () => ({ default: class {} }));
vi.mock('@dschz/solid-uplot', () => ({ SolidUplot: () => null }));

// jsdom has no Worker; the real client is covered by the frame-source tests
// (the source itself) and the Playwright smoke test (worker + wasm).
const INFO: FrameSourceInfo = {
  frameCount: 50,
  width: 4,
  height: 3,
  bitDepth: 8,
  fourcc: 'GREY',
  bottomUp: true,
  fps: 20,
  fpsSource: 'timestamps',
  fpsFromMetadata: 20,
  fpsFromTimestamps: 20,
  aviDeclaredFps: 60,
  timestampCount: 50,
  files: [
    { name: '0.avi', frames: 30 },
    { name: '1.avi', frames: 20 },
  ],
  ignoredFiles: [],
  warnings: ['A test warning.'],
};

const fake = vi.hoisted(() => ({
  open: vi.fn(),
  readFrame: vi.fn(),
  readFrames: vi.fn(),
  dispose: vi.fn(),
  startPipeline: vi.fn(),
  stepPipeline: vi.fn(),
  stopPipeline: vi.fn(),
  probe: vi.fn(),
  openSessions: vi.fn(),
}));
vi.mock('../lib/frame-client.ts', () => ({ createFrameClient: (): FrameClient => fake }));
// No slow worker in jsdom; discovery itself is tested in cells.test.ts.
vi.mock('../lib/slow-client.ts', () => ({
  createSlowClient: () => ({
    visitWorkers: 0,
    release() {},
    ready: () => Promise.resolve(),
    dispose() {},
  }),
  RESERVED_THREADS: 5,
  PARALLEL_FORWARD_BUFFERS: 4,
  visitWorkerCount: () => 0,
}));

// The compress worker exists on every page but `?factors=0` (a stream's factor default); none in jsdom.
vi.mock('../lib/compress-client.ts', () => ({
  createCompressClient: () => ({
    backfill() {},
    extract() {},
    extractCancel() {},
    releaseHelpers() {},
    helpersReady() {},
    dispose() {},
  }),
}));

// Look-back is on by default for recordings but needs worker threads, which jsdom has not.
vi.mock('../lib/lookback-client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/lookback-client.ts')>()),
  createLookbackClient: () => ({
    blocked: () => 'No look-back worker in jsdom.',
    begin: () => false,
    rows() {},
    flatField() {},
    backState() {},
    reset() {},
    poolSize: 0,
  }),
}));

import App from '../App.tsx';

HTMLCanvasElement.prototype.getContext = (() =>
  null) as typeof HTMLCanvasElement.prototype.getContext;

const PLAN: PipelinePlan = {
  frameCount: 50,
  batchSize: 8,
  calibrationFrames: 50,
  motionWarmupFrames: 50,
  previewMaxSide: 320,
  boundaries: [],
  sessionFix: true,
};

const image = () => ({ width: 4, height: 3, data: new Float32Array(12) });

/** A pipeline that runs one setup step, then batches of 25 frames, then is done. */
function fakePipeline(): void {
  let next = 0;
  fake.startPipeline.mockImplementation(async () => {
    next = 0;
    return PLAN;
  });
  fake.stopPipeline.mockResolvedValue(undefined);
  fake.stepPipeline.mockImplementation(async (): Promise<PipelineStepResult> => {
    const timings = { readMs: 1, preprocessMs: 2, motionMs: 3, otherMs: 0, traceMs: 0 };
    if (next === 0) {
      next = 1;
      return { kind: 'setup', phase: 'calibrate', done: 50, total: 50, timings };
    }
    if (next > 50) return { kind: 'done' };
    const start = next - 1;
    next += 25;
    return {
      kind: 'batch',
      start,
      count: 25,
      dy: new Float32Array(25).fill(0.5),
      dx: new Float32Array(25).fill(-1),
      quality: new Float32Array(25),
      flags: new Uint32Array(25),
      flickerOffset: new Float32Array(25),
      flickerGain: new Float32Array(25).fill(0.01),
      previews: {
        frame: start + 24,
        raw: image(),
        preprocessed: image(),
        corrected: image(),
        output: image(),
      },
      timings,
    };
  });
}

let dispose: (() => void) | undefined;
beforeEach(fakePipeline);
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
  localStorage.clear();
  vi.clearAllMocks();
});

/** Click a tab of the right-hand column (a diagnostics tab through the More menu). */
function openTab(root: HTMLElement, id: string): void {
  const sel = `[data-testid="tab-${id}"]`;
  if (!root.querySelector(sel))
    root.querySelector<HTMLButtonElement>('[data-testid="tab-more"]')!.click();
  root.querySelector<HTMLButtonElement>(sel)!.click();
}

function mount(): HTMLElement {
  const root = document.createElement('div');
  document.body.appendChild(root);
  dispose = render(() => <App />, root);
  return root;
}

async function pick(root: HTMLElement, files: File[]): Promise<void> {
  const input = root.querySelector<HTMLInputElement>('[data-testid="folder-input"]')!;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(fake.open).toHaveBeenCalled());
}

/** Press Run on the pre-run sheet (opening a recording does not start Discover). */
async function run(root: HTMLElement): Promise<void> {
  await vi.waitFor(() => expect(root.querySelector('[data-testid="run-start"]')).not.toBeNull());
  root.querySelector<HTMLButtonElement>('[data-testid="run-start"]')!.click();
}

describe('App', () => {
  it('opens on the folder picker with a directory input', () => {
    const root = mount();
    expect(root.querySelector('.app-header__title')?.textContent).toBe('Cala');
    expect(root.querySelector('.drop-zone')).not.toBeNull();
    const folder = root.querySelector('[data-testid="folder-input"]')!;
    expect(folder.hasAttribute('webkitdirectory')).toBe(true);
    expect(folder.hasAttribute('multiple')).toBe(true);
    expect(root.querySelector('.dashboard-shell')).toBeNull();
  });

  it('opens a folder and shows the viewer, scrubber and info panel', async () => {
    fake.open.mockResolvedValue(INFO);
    fake.readFrame.mockImplementation(async () => new Uint8Array(12));
    const root = mount();
    const files = [
      makeFile('0.avi', new Uint8Array(4), 'rec'),
      makeFile('1.avi', new Uint8Array(4), 'rec'),
    ];
    await pick(root, files);

    await vi.waitFor(() => expect(root.querySelector('.dashboard-shell')).not.toBeNull());
    expect(fake.open).toHaveBeenCalledWith(
      files.map((file) => ({ file, relPath: `rec/${file.name}` })),
    );
    expect(root.querySelector('.compact-header__file')?.textContent).toBe('rec');
    expect(root.querySelector('.compact-header__info')?.textContent).toContain('50 frames');

    const slider = root.querySelector<HTMLInputElement>('input[type="range"][aria-label="Frame"]')!;
    expect(slider.max).toBe('49');
    expect(root.querySelector('[data-testid="frame-canvas"]')).not.toBeNull();
    await vi.waitFor(() => expect(fake.readFrame).toHaveBeenCalledWith(0));
    expect(root.querySelector('[data-testid="frame-readout"]')?.textContent).toContain('1 / 50');

    openTab(root, 'recording');
    const info = root.querySelector('[data-panel-id="info"]')!.textContent!;
    expect(info).toContain('4 x 3 px, 8-bit (GREY)');
    expect(info).toContain('20.00 Hz from timeStamps.csv');
    expect(info).toContain('60.0 Hz (declared by the writer, ignored)');
    expect(info).toContain('0.avi');
    expect(info).toContain('A test warning.');

    // Scrubbing requests that frame and updates the readout.
    slider.value = '25';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(fake.readFrame).toHaveBeenCalledWith(25));
    expect(root.querySelector('[data-testid="frame-readout"]')?.textContent).toContain('26 / 50');
  });

  it('shows the pre-run sheet on open, runs on Run, and shows progress and the history', async () => {
    fake.open.mockResolvedValue(INFO);
    fake.readFrame.mockImplementation(async () => new Uint8Array(12));
    const root = mount();
    await pick(root, [makeFile('0.avi', new Uint8Array(4))]);
    // Opening loads the recording only: the sheet with its settings, hidden slots and Run.
    await vi.waitFor(() =>
      expect(root.querySelector('[data-testid="prerun-sheet"]')).not.toBeNull(),
    );
    expect(fake.startPipeline).not.toHaveBeenCalled();
    expect(root.querySelector('[data-testid="discover-settings"]')).not.toBeNull();
    for (const slot of ['repeatable', 'seed', 'crop'])
      expect(root.querySelector<HTMLElement>(`[data-testid="prerun-slot-${slot}"]`)?.hidden).toBe(
        true,
      );
    expect(root.querySelector('[data-testid="run-strip-stage"]')?.textContent).toBe('Ready');
    await run(root);
    await vi.waitFor(() => expect(fake.startPipeline).toHaveBeenCalledTimes(1));
    const status = () => root.querySelector('[data-testid="pipeline-status"]')?.textContent;
    await vi.waitFor(() => expect(status()).toMatch(/^(Discover done|Done)$/));
    expect(root.querySelector('[data-testid="pipeline-readout"]')?.textContent).toContain(
      'frame 50 / 50',
    );
    // The Run panel's convergence plot (in every layout) and the History tab (one group shown) are up.
    expect(root.querySelector('[data-testid="history-convergence"]')).not.toBeNull();
    // Batch timings (3 ms of motion per 25 frames, twice) are averaged per frame.
    openTab(root, 'timing');
    expect(root.querySelector('[data-testid="pipeline-stages"]')?.textContent).toContain(
      'motion 0.1',
    );
    openTab(root, 'history');
    expect(root.querySelector('[data-testid="history-tab"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="history-imaging"]')).not.toBeNull();
    expect(root.querySelectorAll('[data-testid="cells-view"]')).toHaveLength(1);

    // Done: the settings fold to a summary line, and Discover is one line in its hue with ✓.
    expect(root.querySelector('[data-testid="settings-summary"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="prerun-sheet"]')).toBeNull();
    const discover = root.querySelector('[data-testid="step-panel-discover"]')!;
    expect(discover.getAttribute('data-state')).toBe('done');
    expect(discover.textContent).toMatch(/^Discover0 cells/);

    // Opening another folder stops the worker-side pipeline.
    root.querySelectorAll<HTMLButtonElement>('.compact-header__actions button')[0].click();
    expect(fake.stopPipeline).toHaveBeenCalled();
    // The next recording opens on its own pre-run sheet, with nothing of the last run.
    await pick(root, [makeFile('0.avi', new Uint8Array(4))]);
    await vi.waitFor(() =>
      expect(root.querySelector('[data-testid="prerun-sheet"]')).not.toBeNull(),
    );
    expect(fake.startPipeline).toHaveBeenCalledTimes(1);
    expect(root.querySelector('[data-testid="run-export"]')).toBeNull();
    expect(root.querySelector('[data-testid="pipeline-status"]')).toBeNull();
    expect(root.querySelector('[data-testid="run-strip-stage"]')?.textContent).toBe('Ready');
  });

  it('puts the run rail over one row of tabs, keyboard-operable and remembered', async () => {
    fake.open.mockResolvedValue(INFO);
    fake.readFrame.mockImplementation(async () => new Uint8Array(12));
    const root = mount();
    await pick(root, [makeFile('0.avi', new Uint8Array(4))]);
    await run(root);
    const stage = () => root.querySelector('[data-testid="run-strip-stage"]')?.textContent;
    await vi.waitFor(() => expect(stage()).toBe('Discover done'));
    // The rail: the stage track with Discover done, and Cells at 0 on this cell-less recording.
    expect(
      root.querySelector('[data-testid="run-step-discover"]')?.getAttribute('data-state'),
    ).toBe('done');
    expect(root.querySelector('[data-testid="cells-readout"]')?.textContent).toBe('0');
    expect(root.querySelector('[data-testid="pipeline-readout"]')?.textContent).toMatch(
      /^frame 50 \/ 50 · /,
    );
    // One tab row (the cell's Trace / Demixing is a switch, not a second row): Run, Cell, QC and
    // History, then More with the diagnostics.
    const lists = root.querySelectorAll('[role="tablist"]');
    expect(lists).toHaveLength(1);
    const tabs = [...lists[0].querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(['Run', 'Cell', 'QC', 'History', 'More▾']);
    const more = root.querySelector<HTMLButtonElement>('[data-testid="tab-more"]')!;
    expect(more).toBe(tabs[4]);
    expect(more.getAttribute('aria-haspopup')).toBe('menu');
    expect(root.querySelector('[data-testid="tab-more-menu"]')).toBeNull();
    const selected = () => tabs.find((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected()?.textContent).toBe('Run');
    expect(selected()?.tabIndex).toBe(0);
    expect(tabs[1].tabIndex).toBe(-1);
    // Each tab controls its panel; only the shown panels and the kept ones are in the DOM.
    const panel = document.getElementById(selected()!.getAttribute('aria-controls')!)!;
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(panel.querySelector('[data-testid="pipeline-status"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="qc-table"]')).toBeNull();
    // Arrow keys move along the row and select.
    tabs[0].focus();
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(selected()?.textContent).toBe('Cell');
    tabs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(selected()?.textContent).toBe('QC');
    expect(root.querySelector('[data-testid="qc-table"]')).not.toBeNull();
    // End reaches More without opening it; Enter opens its menu of the diagnostics.
    tabs[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(selected()?.textContent).toBe('QC');
    more.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const menu = root.querySelector('[data-testid="tab-more-menu"]')!;
    expect(menu.getAttribute('role')).toBe('menu');
    const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
    expect(items.map((t) => t.textContent)).toEqual([
      'Correlation',
      'Flat field',
      'Timing',
      'Raw file',
      'Recording',
    ]);
    expect(items.map((t) => t.dataset.testid)).toEqual([
      'tab-corr',
      'tab-flatfield',
      'tab-timing',
      'tab-raw',
      'tab-recording',
    ]);
    items[4].click();
    // The menu closes; More is the selected tab and shows the diagnostics tab it holds.
    expect(root.querySelector('[data-testid="tab-more-menu"]')).toBeNull();
    expect(selected()).toBe(more);
    expect(more.textContent).toBe('Recording▾');
    expect(more.tabIndex).toBe(0);
    expect(document.getElementById(more.getAttribute('aria-controls')!)?.dataset.tab).toBe(
      'recording',
    );
    // Run stays mounted (hidden) while another tab is shown: its state is kept.
    expect(root.querySelector('[data-testid="pipeline-status"]')).not.toBeNull();
    expect(localStorage.getItem('cala.sideTab.run')).toBe('recording');
  });

  it('opens a recording on the Run tab for its sheet, and keeps the remembered tab', async () => {
    localStorage.setItem('cala.sideTab.run', 'qc');
    fake.open.mockResolvedValue(INFO);
    fake.readFrame.mockImplementation(async () => new Uint8Array(12));
    const root = mount();
    await pick(root, [makeFile('0.avi', new Uint8Array(4))]);
    await vi.waitFor(() =>
      expect(root.querySelector('[data-testid="prerun-sheet"]')).not.toBeNull(),
    );
    expect(root.querySelector('[data-testid="tab-run"]')?.getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(localStorage.getItem('cala.sideTab.run')).toBe('qc');
  });

  it('toggles play and pause', async () => {
    fake.open.mockResolvedValue(INFO);
    fake.readFrame.mockImplementation(async () => new Uint8Array(12));
    const root = mount();
    await pick(root, [makeFile('0.avi', new Uint8Array(4))]);
    await vi.waitFor(() => expect(root.querySelector('.cala-play')).not.toBeNull());

    const play = root.querySelector<HTMLButtonElement>('.cala-play')!;
    expect(play.textContent).toBe('Play');
    play.click();
    expect(play.textContent).toBe('Pause');
    // Playback advances through the worker at the recording's frame rate.
    await vi.waitFor(() => expect(fake.readFrame).toHaveBeenCalledWith(2), { timeout: 2000 });
    play.click();
    expect(play.textContent).toBe('Play');
  });

  it('shows an error from the frame source and stays on the picker', async () => {
    fake.open.mockRejectedValue(new Error('0.avi: compressed codec MJPG'));
    const root = mount();
    await pick(root, [makeFile('0.avi', new Uint8Array(4))]);
    await vi.waitFor(() => expect(root.querySelector('.error-card')).not.toBeNull());
    expect(root.querySelector('.error-card')?.textContent).toContain('MJPG');
    expect(root.querySelector('.drop-zone')).not.toBeNull();
  });

  it('returns to the picker from "Open another folder"', async () => {
    fake.open.mockResolvedValue(INFO);
    fake.readFrame.mockImplementation(async () => new Uint8Array(12));
    const root = mount();
    await pick(root, [makeFile('0.avi', new Uint8Array(4))]);
    await vi.waitFor(() => expect(root.querySelector('.dashboard-shell')).not.toBeNull());
    root.querySelectorAll<HTMLButtonElement>('.compact-header__actions button')[0].click();
    expect(root.querySelector('.drop-zone')).not.toBeNull();
  });
});

describe('App open-folder control', () => {
  it('says files are read locally', () => {
    const root = mount();
    expect(root.querySelector('[data-testid="local-note"]')?.textContent).toContain(
      'never leave your computer',
    );
  });

  it('uses the directory picker when available, and shows nothing on cancel', async () => {
    const show = vi.fn(async () => {
      throw new DOMException('cancelled', 'AbortError');
    });
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = show;
    try {
      const root = mount();
      root.querySelector<HTMLElement>('.drop-zone')!.click();
      await vi.waitFor(() => expect(show).toHaveBeenCalledWith({ mode: 'read' }));
      await Promise.resolve();
      expect(root.querySelector('[role="alert"]')).toBeNull();
    } finally {
      delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    }
  });

  it('shows an error when the picker is refused', async () => {
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => {
      throw new DOMException('Permission denied', 'NotAllowedError');
    };
    try {
      const root = mount();
      root.querySelector<HTMLElement>('.drop-zone')!.click();
      await vi.waitFor(() =>
        expect(root.querySelector('[role="alert"]')?.textContent).toContain('Permission denied'),
      );
    } finally {
      delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    }
  });
});

describe('App: video series chooser', () => {
  const avis = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => makeFile(`${prefix}${i}.avi`, new Uint8Array(4), 'rec'));

  async function pickNoWait(root: HTMLElement, files: File[]): Promise<void> {
    const input = root.querySelector<HTMLInputElement>('[data-testid="folder-input"]')!;
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  it('opens msCam without asking when a behavCam series sits beside it', async () => {
    fake.open.mockResolvedValue(INFO);
    const root = mount();
    const files = [...avis('behavCam', 2), ...avis('msCam', 3)];
    await pick(root, files);
    expect(root.querySelector('[data-testid="series-chooser"]')).toBeNull();
    expect(fake.open).toHaveBeenCalledTimes(1);
  });

  it('asks which series to open when two are ambiguous, then opens the pick', async () => {
    fake.open.mockResolvedValue(INFO);
    const root = mount();
    const a = avis('camA', 2);
    const b = avis('camB', 5);
    await pickNoWait(root, [...a, ...b]);
    const chooser = await vi.waitFor(() => {
      const el = root.querySelector('[data-testid="series-chooser"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(fake.open).not.toHaveBeenCalled();
    const options = [
      ...chooser.querySelectorAll<HTMLButtonElement>('[data-testid="series-option"]'),
    ];
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('camB*.avi'),
      expect.stringContaining('camA*.avi'),
    ]);
    expect(options[0].textContent).toContain('5 files');
    expect(options[0].textContent).toContain('rec');
    // Native buttons: keyboard-operable (Tab, Enter, Space) without extra handlers.
    expect(options.every((o) => o.tagName === 'BUTTON' && o.type === 'button')).toBe(true);

    options[1].click();
    await vi.waitFor(() => expect(fake.open).toHaveBeenCalled());
    const opened = fake.open.mock.calls[0][0] as { relPath: string }[];
    expect(opened.map((e) => e.relPath)).toEqual(a.map((f) => `rec/${f.name}`));
    expect(root.querySelector('[data-testid="series-chooser"]')).toBeNull();
  });

  it('cancel leaves the chooser without opening', async () => {
    const root = mount();
    await pickNoWait(root, [...avis('camA', 2), ...avis('camB', 2)]);
    await vi.waitFor(() =>
      expect(root.querySelector('[data-testid="series-chooser"]')).not.toBeNull(),
    );
    root.querySelector<HTMLButtonElement>('[data-testid="series-cancel"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('[data-testid="series-chooser"]')).toBeNull());
    expect(fake.open).not.toHaveBeenCalled();
  });
});

describe('App: multi-session run', () => {
  const v4 = (day: string, n: number) => [
    ...Array.from({ length: n }, (_, i) =>
      makeFile(`${i}.avi`, new Uint8Array(4), `data/${day}/12_00_00/My_V4_Miniscope`),
    ),
    makeFile('0.avi', new Uint8Array(4), `data/${day}/12_00_00/BehavCam_0`),
    makeFile(
      'metaData.json',
      JSON.stringify({ recordingStartTime: { msecSinceEpoch: day === 'day1' ? 2000 : 1000 } }),
      `data/${day}/12_00_00`,
    ),
  ];
  const pickSessions = (root: HTMLElement, files: File[]) => {
    const input = root.querySelector<HTMLInputElement>('[data-testid="folder-input"]')!;
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  it('lists the sessions of a parent folder, ordered by start time, and checks them', async () => {
    fake.probe.mockImplementation(async (sessions: unknown[]) =>
      sessions.map((_, i) => ({ info: { ...INFO, width: i === 0 ? 4 : 5 } })),
    );
    const root = mount();
    pickSessions(root, [...v4('day1', 2), ...v4('day2', 3)]);
    const items = await vi.waitFor(() => {
      const el = root.querySelectorAll('[data-testid="session-item"]');
      expect(el).toHaveLength(2);
      return [...el];
    });
    expect(fake.open).not.toHaveBeenCalled();
    // day2 started first (metaData.json recordingStartTime).
    expect(items[0].textContent).toContain('day2/12_00_00/My_V4_Miniscope');
    expect(items[0].textContent).toContain('cala-results/day2/12_00_00/My_V4_Miniscope');
    // The behaviour camera is not a session; the two sizes differ: an error, no start.
    await vi.waitFor(() =>
      expect(root.querySelector('[data-testid="session-error"]')?.textContent).toContain(
        'all sessions must match',
      ),
    );
    expect(root.querySelector<HTMLButtonElement>('[data-testid="sessions-start"]')!.disabled).toBe(
      true,
    );
    // Removing one leaves a valid one-session list.
    root.querySelectorAll<HTMLButtonElement>('[data-testid="session-remove"]')[1].click();
    await vi.waitFor(() =>
      expect(root.querySelectorAll('[data-testid="session-item"]')).toHaveLength(1),
    );
    expect(root.querySelector('[data-testid="session-error"]')).toBeNull();
  });

  it('opens one session as a plain folder, as before', async () => {
    fake.open.mockResolvedValue(INFO);
    const root = mount();
    await pick(root, v4('day1', 2));
    expect(root.querySelector('[data-testid="session-setup"]')).toBeNull();
    expect(fake.probe).not.toHaveBeenCalled();
  });

  it('offers an empty session list from the start screen', async () => {
    const root = mount();
    root.querySelector<HTMLButtonElement>('[data-testid="multi-session"]')!.click();
    await vi.waitFor(() =>
      expect(root.querySelector('[data-testid="session-setup"]')).not.toBeNull(),
    );
    root.querySelector<HTMLButtonElement>('[data-testid="session-add"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('[data-testid="add-cancel"]')).not.toBeNull());
  });
});

describe('App: animal project', () => {
  const days = ['2026_11_10', '2026_11_11', '2026_11_12'];
  const sid = (d: string) => `${d}/09_00_00/My_V4_Miniscope`;
  const animalFiles = () =>
    days.flatMap((d, i) => [
      makeFile('0.avi', new Uint8Array(4), `mouse1/${d}/09_00_00/My_V4_Miniscope`),
      makeFile(
        'metaData.json',
        JSON.stringify({ recordingStartTime: { msecSinceEpoch: Date.UTC(2026, 10, 10 + i, 9) } }),
        `mouse1/${d}/09_00_00`,
      ),
    ]);
  /** Two earlier separate runs of the first session, as their folders hold them. */
  const runFiles = () =>
    [
      ['r1', '2026-11-12T00:00:00.000Z'],
      ['r2', '2026-11-13T00:00:00.000Z'],
    ].flatMap(([run, created]) => [
      makeFile(
        'cala-run.json',
        JSON.stringify({
          format: 'cala-run',
          created,
          mode: 'separate',
          sessions: [
            { path: `mouse1/${sid(days[0])}`, results_path: sid(days[0]), status: 'written' },
          ],
        }),
        `mouse1/cala-results/runs/${run}`,
      ),
      makeFile(
        'cala-session.json',
        JSON.stringify({
          format: 'cala-session',
          created,
          cells: 4,
          stages_run: [
            { stage: 'discover', outcome: 'done' },
            { stage: 'refine', outcome: 'done' },
            { stage: 'extract', outcome: 'done' },
          ],
        }),
        `mouse1/cala-results/runs/${run}/${sid(days[0])}`,
      ),
    ]);
  const openProject = (root: HTMLElement, files: File[]) => {
    const input = root.querySelector<HTMLInputElement>('[data-testid="project-input"]')!;
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const rows = (root: HTMLElement) => [
    ...root.querySelectorAll<HTMLTableRowElement>('[data-testid="project-row"]'),
  ];

  beforeEach(() => {
    fake.probe.mockImplementation(async (sessions: unknown[]) =>
      sessions.map(() => ({ info: { ...INFO, frameCount: 800 } })),
    );
  });

  it('shows every session with its status, current result and shared ids', async () => {
    const root = mount();
    expect(root.querySelector('[data-testid="open-project"]')).not.toBeNull();
    openProject(root, [...animalFiles(), ...runFiles()]);
    await vi.waitFor(() => expect(rows(root)).toHaveLength(3));
    const [first, second] = rows(root);
    expect(first.textContent).toContain(sid(days[0]));
    expect(first.textContent).toContain('800 frames, 0:40');
    expect(first.querySelector('[data-testid="cell-discover"]')!.textContent).toBe('done');
    expect(first.querySelector('[data-testid="cell-refine"]')).toBeNull();
    expect(first.querySelector('[data-testid="cell-current"]')!.textContent).toContain('run r2');
    expect(first.querySelector('[data-testid="cell-ids"]')!.textContent).toBe('own');
    expect(second.querySelector('[data-testid="cell-current"]')!.textContent).toBe('—');
    expect(root.querySelector('[data-testid="project-warning"]')!.textContent).toContain(
      '2 existing run folders',
    );
    expect(fake.open).not.toHaveBeenCalled();
  });

  it('sets an older result current from the details', async () => {
    const root = mount();
    openProject(root, [...animalFiles(), ...runFiles()]);
    await vi.waitFor(() => expect(rows(root)).toHaveLength(3));
    rows(root)[0].querySelector<HTMLButtonElement>('[data-testid="row-details"]')!.click();
    const items = await vi.waitFor(() => {
      const el = root.querySelectorAll('[data-testid="result-item"]');
      expect(el).toHaveLength(2);
      return el;
    });
    expect(items[0].textContent).toContain('run r2 (current)');
    expect(items[0].textContent).toContain('mouse1/cala-results/runs/r2/');
    items[1].querySelector<HTMLButtonElement>('[data-testid="set-current"]')!.click();
    await vi.waitFor(() =>
      expect(rows(root)[0].querySelector('[data-testid="cell-current"]')!.textContent).toContain(
        'run r1',
      ),
    );
  });

  it('builds a run plan from selected rows', async () => {
    const root = mount();
    openProject(root, animalFiles());
    await vi.waitFor(() => expect(rows(root)).toHaveLength(3));
    const chain = root.querySelector<HTMLButtonElement>('[data-testid="plan-chain"]')!;
    expect(chain.disabled).toBe(true);
    const select = (i: number) => {
      const box = rows(root)[i].querySelector<HTMLInputElement>('[data-testid="row-select"]')!;
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    };
    select(0);
    select(1);
    await vi.waitFor(() => expect(chain.disabled).toBe(false));
    chain.click();
    select(2);
    root.querySelector<HTMLButtonElement>('[data-testid="plan-separate"]')!.click();
    const groups = await vi.waitFor(() => {
      const el = root.querySelectorAll('[data-testid="plan-group"]');
      expect(el).toHaveLength(2);
      return el;
    });
    expect(groups[0].textContent).toContain('Joint: 2 sessions');
    expect(groups[1].textContent).toContain('Separate: 1 session');
    expect(root.querySelector<HTMLButtonElement>('[data-testid="plan-start"]')!.disabled).toBe(
      false,
    );
    root.querySelectorAll<HTMLButtonElement>('[data-testid="plan-remove"]')[0].click();
    await vi.waitFor(() =>
      expect(root.querySelectorAll('[data-testid="plan-group"]')).toHaveLength(1),
    );
    root.querySelector<HTMLButtonElement>('[data-testid="project-close"]')!.click();
    await vi.waitFor(() =>
      expect(root.querySelector('[data-testid="open-project"]')).not.toBeNull(),
    );
  });

  it('offers one project per animal for an experiment folder', async () => {
    const root = mount();
    const files = ['m1', 'm2'].flatMap((m) =>
      days
        .slice(0, 2)
        .map((d) => makeFile('0.avi', new Uint8Array(4), `exp/${m}/${d}/09_00_00/My_V4_Miniscope`)),
    );
    openProject(root, files);
    const options = await vi.waitFor(() => {
      const el = root.querySelectorAll<HTMLButtonElement>('[data-testid="split-option"]');
      expect(el).toHaveLength(2);
      return el;
    });
    options[1].click();
    await vi.waitFor(() => expect(rows(root)).toHaveLength(2));
    expect(root.querySelector('[data-testid="project-name"]')!.textContent).toBe('m2');
    expect(rows(root)[0].textContent).toContain(sid(days[0]));
  });
});
