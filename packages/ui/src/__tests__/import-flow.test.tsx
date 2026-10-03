import { describe, it, expect, afterEach } from 'vitest';
import { render } from 'solid-js/web';
import { createImportStore } from '@calab/io';
import type { NpyResult } from '@calab/core';
import { ImportOverlay } from '../import/ImportOverlay.tsx';

// jsdom has no ResizeObserver (TracePreview observes its container) and no
// 2D canvas; the preview simply skips drawing without a context.
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= NoopResizeObserver as unknown as typeof ResizeObserver;
HTMLCanvasElement.prototype.getContext = (() =>
  null) as typeof HTMLCanvasElement.prototype.getContext;

const noSimulate = () => Promise.reject(new Error('not used'));

function matrix(rows: number, cols: number): NpyResult {
  return {
    data: new Float64Array(rows * cols),
    shape: [rows, cols],
    dtype: '<f8',
    fortranOrder: false,
  };
}

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
});

function mount(layout: 'stacked' | 'split') {
  const store = createImportStore({ appName: 'TestApp', simulate: noSimulate });
  const demoRequests: unknown[] = [];
  const root = document.createElement('div');
  document.body.appendChild(root);
  dispose = render(
    () => (
      <ImportOverlay
        store={store}
        title="TestApp"
        subtitle="Testing"
        version="CaLab test"
        layout={layout}
        demoButtonLabel={layout === 'split' ? 'Generate' : 'Load Demo Data'}
        samplingRatePurpose="testing"
        readyStep={{ message: 'Ready to go.' }}
        hasFile={false}
        onReset={() => store.resetImport()}
        onLoadDemo={(opts) => demoRequests.push(opts)}
      />
    ),
    root,
  );
  return { store, root, demoRequests };
}

const button = (root: HTMLElement, text: string) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

describe('ImportOverlay', () => {
  it('stacked layout: drop step offers the demo form and sends its settings', () => {
    const { root, demoRequests } = mount('stacked');
    expect(root.querySelector('h1')?.textContent).toBe('TestApp');
    expect(root.textContent).toContain('Step 1 of 4: Load Data');
    expect(root.querySelector('.drop-zone')).not.toBeNull();
    expect(root.querySelector('.import-split')).toBeNull();

    button(root, 'Load Demo Data')!.click();
    expect(demoRequests).toEqual([
      expect.objectContaining({ numCells: 100, durationMinutes: 15, fps: 30, seed: undefined }),
    ]);
  });

  it('split layout: file and synthetic panels side by side', () => {
    const { root } = mount('split');
    expect(root.querySelector('.import-split')).not.toBeNull();
    expect(button(root, 'Generate')).toBeDefined();
  });

  it('walks dimensions -> sampling rate -> ready through the store', () => {
    const { store, root } = mount('stacked');
    store.setDataSource('file');
    store.setParsedData(matrix(3, 40));
    expect(root.textContent).toContain('Confirm Dimensions');
    expect(root.textContent).toContain('Cells');

    button(root, 'Swap Dimensions')!.click();
    expect(store.effectiveShape()).toEqual([40, 3]);
    button(root, 'Swap Dimensions')!.click();
    button(root, 'Confirm')!.click();
    expect(store.importStep()).toBe('sampling-rate');
    expect(root.textContent).toContain('required for correct testing');

    button(root, '30 Hz (miniscope / 2-photon)')!.click();
    expect(root.textContent).toContain('At 30 Hz');
    button(root, 'Confirm')!.click();

    // DataValidationReport validates on mount; the store then reaches 'ready'.
    expect(store.validationResult()?.isValid).toBe(true);
    expect(store.importStep()).toBe('ready');
    expect(root.textContent).toContain('Ready to go.');
    expect(root.textContent).toContain('3 cells');
  });

  it('lists candidate arrays from a multi-array container and loads the chosen one', () => {
    const { store, root } = mount('stacked');
    store.setNpzArrays({ arrayNames: ['a', 'b'], arrays: { a: matrix(2, 10), b: matrix(4, 10) } });
    expect(root.textContent).toContain('Select Array');
    (root.querySelectorAll('.npz-array-item')[1] as HTMLButtonElement).click();
    expect(store.selectedNpzArray()).toBe('b');
    expect(store.effectiveShape()).toEqual([4, 10]);
  });

  it('shows import errors from the store', () => {
    const { store, root } = mount('stacked');
    store.setImportError('Bad file');
    expect(root.querySelector('.error-card')?.textContent).toContain('Bad file');
  });
});
