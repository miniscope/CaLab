import { describe, it, expect, afterEach, vi } from 'vitest';
import { render } from 'solid-js/web';
import type { FrameSourceInfo } from '../lib/frame-source.ts';
import type { FrameClient } from '../lib/frame-client.ts';
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
}));
vi.mock('../lib/frame-client.ts', () => ({ createFrameClient: (): FrameClient => fake }));

import App from '../App.tsx';

HTMLCanvasElement.prototype.getContext = (() =>
  null) as typeof HTMLCanvasElement.prototype.getContext;

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

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

    const slider = root.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(slider.max).toBe('49');
    expect(root.querySelector('[data-testid="frame-canvas"]')).not.toBeNull();
    await vi.waitFor(() => expect(fake.readFrame).toHaveBeenCalledWith(0));
    expect(root.querySelector('[data-testid="frame-readout"]')?.textContent).toContain('1 / 50');

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
