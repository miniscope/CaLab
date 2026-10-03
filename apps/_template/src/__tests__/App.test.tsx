import { describe, it, expect, afterEach, vi } from 'vitest';
import { render } from 'solid-js/web';
import type { NpyResult } from '@calab/core';
import { validateParsedData } from '@calab/io';
import App from '../App.tsx';
import { importStore } from '../lib/data-store.ts';

// uPlot needs a real browser (matchMedia, a CSS import Node cannot load). The
// barrels this app imports pull it in, but the template's views do not use it.
vi.mock('uplot', () => ({ default: class {} }));
vi.mock('@dschz/solid-uplot', () => ({ SolidUplot: () => null }));

// jsdom has no ResizeObserver and no 2D canvas; the charts skip drawing
// without a context.
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= NoopResizeObserver as unknown as typeof ResizeObserver;
HTMLCanvasElement.prototype.getContext = (() =>
  null) as typeof HTMLCanvasElement.prototype.getContext;

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  importStore.resetImport();
  document.body.replaceChildren();
});

function mount(): HTMLElement {
  const root = document.createElement('div');
  document.body.appendChild(root);
  dispose = render(() => <App />, root);
  return root;
}

describe('App', () => {
  it('opens on the import overlay', () => {
    const root = mount();
    expect(root.querySelector('.import-container h1')?.textContent).toBe('__APP_DISPLAY_NAME__');
    expect(root.textContent).toContain('Step 1 of 4: Load Data');
    expect(root.querySelector('.drop-zone')).not.toBeNull();
    expect(root.querySelector('.dashboard-shell')).toBeNull();
  });

  it('shows the dashboard with a trace chart once the import is ready', () => {
    const root = mount();
    const data: NpyResult = {
      data: Float64Array.from({ length: 3 * 40 }, (_, i) => Math.sin(i)),
      shape: [3, 40],
      dtype: '<f8',
      fortranOrder: false,
    };
    importStore.setDataSource('file');
    importStore.setParsedData(data);
    importStore.setDimensionsConfirmed(true);
    importStore.setSamplingRate(20);
    importStore.setValidationResult(validateParsedData(data, [3, 40]));

    expect(root.querySelector('.import-container')).toBeNull();
    expect(root.querySelector('.compact-header__title')?.textContent).toBe('__APP_DISPLAY_NAME__');
    expect(root.querySelector('.compact-header__info')?.textContent).toContain('3 cells');
    expect(root.querySelectorAll('[data-panel-id="trace"] option')).toHaveLength(3);
    expect(root.querySelector('[data-panel-id="trace"] canvas')).not.toBeNull();
  });
});
