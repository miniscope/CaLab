import { describe, it, expect, vi } from 'vitest';
import type { NpyResult } from '@calab/core';
import type { SimulationConfig, SimulationResult } from '@calab/compute';
import { createImportStore } from '../import-store.ts';
import { writeNpy } from '../npy-writer.ts';
import { zipFiles } from '../zip.ts';

function npyFile(name: string, rows: number, cols: number): File {
  const data = new Float32Array(rows * cols).map((_, i) => i % 7);
  return new File([writeNpy(data, [rows, cols])], name);
}

function npzFile(name: string, arrays: Record<string, [number, number]>): File {
  const entries: Record<string, Uint8Array> = {};
  for (const [key, [rows, cols]] of Object.entries(arrays)) {
    const data = new Float32Array(rows * cols).fill(1);
    entries[`${key}.npy`] = new Uint8Array(writeNpy(data, [rows, cols]));
  }
  return new File([zipFiles(entries)], name);
}

/** Deterministic stand-in for the WASM simulator. */
function fakeSimulate(cfg: SimulationConfig): Promise<SimulationResult> {
  const cells = cfg.num_cells;
  const tp = cfg.num_timepoints;
  return Promise.resolve({
    traces: Array.from({ length: cells * tp }, (_, i) => i / (cells * tp)),
    num_cells: cells,
    num_timepoints: tp,
    ground_truth: Array.from({ length: cells }, (_, c) => ({
      spikes: Array.from({ length: tp }, (_, t) => (t === c ? 1 : 0)),
      clean_calcium: Array.from({ length: tp }, () => c),
      alpha: 1,
      snr: 5,
      tau_rise_s: cfg.kernel.tau_rise_s,
      tau_decay_s: cfg.kernel.tau_decay_s,
    })),
  });
}

function makeStore(fetchBridgeData?: Parameters<typeof createImportStore>[0]['fetchBridgeData']) {
  return createImportStore({ appName: 'TestApp', simulate: fakeSimulate, fetchBridgeData });
}

describe('createImportStore', () => {
  it('starts empty on the drop step with no data source', () => {
    const s = makeStore();
    expect(s.importStep()).toBe('drop');
    expect(s.dataSource()).toBeNull();
    expect(s.isDemo()).toBe(false);
    expect(s.effectiveShape()).toBeNull();
  });

  describe('file import', () => {
    it('loads a .npy, tracks the file source, and walks the import steps', async () => {
      const s = makeStore();
      const file = npyFile('traces.npy', 3, 50);
      await s.importFile(file);

      expect(s.importError()).toBeNull();
      expect(s.dataSource()).toBe('file');
      expect(s.rawFile()).toBe(file);
      expect(s.effectiveShape()).toEqual([3, 50]);
      expect(s.importStep()).toBe('confirm-dims');

      s.setSwapped(true);
      expect(s.effectiveShape()).toEqual([50, 3]);
      s.setSwapped(false);

      s.setDimensionsConfirmed(true);
      expect(s.importStep()).toBe('sampling-rate');
      s.setSamplingRate(25);
      expect(s.durationSeconds()).toBe(2);
      expect(s.importStep()).toBe('validation');
    });

    it('rejects an unsupported extension without touching the source', async () => {
      const s = makeStore();
      await s.importFile(new File(['x'], 'traces.csv'));
      expect(s.importError()).toMatch(/Unsupported file format: \.csv/);
      expect(s.dataSource()).toBeNull();
      expect(s.rawFile()).toBeNull();
    });

    it('reports a parse failure through importError', async () => {
      const s = makeStore();
      await s.importFile(new File([new Uint8Array([1, 2, 3])], 'broken.npy'));
      expect(s.importError()).not.toBeNull();
      expect(s.parsedData()).toBeNull();
    });

    it('auto-selects the only trace matrix in a .npz', async () => {
      const s = makeStore();
      await s.importFile(npzFile('one.npz', { traces: [4, 20], fs: [1, 1] }));
      expect(s.npzArrays()).toBeNull();
      expect(s.effectiveShape()).toEqual([4, 20]);
    });

    it('asks for a choice when a .npz holds several matrices', async () => {
      const s = makeStore();
      await s.importFile(npzFile('two.npz', { a: [4, 20], b: [5, 30] }));
      expect(s.parsedData()).toBeNull();
      expect(s.npzArrays()?.arrayNames.sort()).toEqual(['a', 'b']);

      s.selectNpzArray('b');
      expect(s.selectedNpzArray()).toBe('b');
      expect(s.effectiveShape()).toEqual([5, 30]);
    });

    it('names the app when a container has no trace matrix', async () => {
      const s = makeStore();
      await s.importFile(npzFile('none.npz', { fs: [1, 1] }));
      expect(s.importError()).toMatch(/TestApp requires a 2D array/);
    });
  });

  describe('demo data', () => {
    it('generates traces with ground truth and tracks the demo source', async () => {
      const s = makeStore();
      await s.loadDemoData({ numCells: 2, durationMinutes: 0.05, fps: 10, seed: 7 });

      expect(s.dataSource()).toBe('demo');
      expect(s.isDemo()).toBe(true);
      expect(s.importStep()).toBe('ready');
      expect(s.effectiveShape()).toEqual([2, 30]);
      expect(s.demoConfig()?.seed).toBe(7);
      expect(s.demoIndicator()).not.toBeNull();
      expect(s.groundTruthTauRise()).toBeGreaterThan(0);

      const gt = s.getGroundTruthForCell(1);
      expect(gt?.spikes.length).toBe(30);
      expect(gt?.spikes[1]).toBe(1);
      expect(gt?.calcium[0]).toBe(1);
    });

    it('locks submission once ground truth is revealed', async () => {
      const s = makeStore();
      await s.loadDemoData({ numCells: 1, durationMinutes: 0.05, fps: 10 });

      s.toggleGroundTruthVisibility(); // no-op before reveal
      expect(s.groundTruthVisible()).toBe(false);
      s.revealGroundTruth();
      expect(s.groundTruthLocked()).toBe(true);
      s.toggleGroundTruthVisibility();
      expect(s.groundTruthVisible()).toBe(false);
    });
  });

  describe('bridge data', () => {
    const traces: NpyResult = {
      data: new Float64Array(2 * 40).fill(0.5),
      shape: [2, 40],
      dtype: '<f8',
      fortranOrder: false,
    };

    it('loads from the bridge and tracks the bridge source', async () => {
      const fetchBridgeData = vi.fn().mockResolvedValue({
        traces,
        metadata: { sampling_rate_hz: 20, num_cells: 2, num_timepoints: 40 },
      });
      const s = makeStore(fetchBridgeData);
      await s.loadFromBridge('http://127.0.0.1:9999');

      expect(fetchBridgeData).toHaveBeenCalledWith('http://127.0.0.1:9999');
      expect(s.dataSource()).toBe('bridge');
      expect(s.bridgeUrl()).toBe('http://127.0.0.1:9999');
      expect(s.samplingRate()).toBe(20);
      expect(s.validationResult()?.isValid).toBe(true);
      expect(s.importStep()).toBe('ready');
    });

    it('clears the bridge url and reports the error when loading fails', async () => {
      const s = makeStore(vi.fn().mockRejectedValue(new Error('connection refused')));
      await s.loadFromBridge('http://127.0.0.1:9999');
      expect(s.bridgeUrl()).toBeNull();
      expect(s.importError()).toBe('connection refused');
    });
  });

  it('resetImport returns every source back to the empty state', async () => {
    const s = makeStore();
    await s.loadDemoData({ numCells: 1, durationMinutes: 0.05, fps: 10 });
    s.revealGroundTruth();
    s.resetImport();

    expect(s.dataSource()).toBeNull();
    expect(s.importStep()).toBe('drop');
    expect(s.groundTruthLocked()).toBe(false);
    expect(s.groundTruthTauRise()).toBeNull();
    expect(s.demoConfig()).toBeNull();
  });
});
