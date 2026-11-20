import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, createSignal } from 'solid-js';
import { createSideTab, loadSideTab, saveSideTab, showPickedCell } from '../lib/side-tab.ts';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('side tab', () => {
  it('remembers the tab per viewer', () => {
    createRoot((dispose) => {
      const ids = ['run', 'cell', 'qc'];
      const a = createSideTab('run', 'run', () => ids);
      expect(a.active()).toBe('run');
      a.set('qc');
      expect(a.active()).toBe('qc');
      expect(loadSideTab('run')).toBe('qc');
      expect(loadSideTab('result')).toBeNull();
      expect(createSideTab('run', 'run', () => ids).active()).toBe('qc');
      dispose();
    });
  });

  it('falls back to the default when the remembered tab is not offered', () => {
    saveSideTab('run', 'raw');
    createRoot((dispose) => {
      expect(createSideTab('run', 'run', () => ['run', 'cell']).active()).toBe('run');
      dispose();
    });
  });

  it('works without storage (it throws)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    createRoot((dispose) => {
      const t = createSideTab('result', 'result', () => ['result', 'qc']);
      expect(t.active()).toBe('result');
      t.set('qc');
      expect(t.active()).toBe('qc');
      dispose();
    });
  });

  it('shows the Cell tab when a cell is picked, unless held', () => {
    const [selected, select] = createSignal<number | null>(null);
    const [hold, setHold] = createSignal(false);
    const { t, dispose } = createRoot((dispose) => {
      const t = createSideTab('run', 'qc', () => ['qc', 'cell', 'history']);
      showPickedCell(t, selected, hold);
      return { t, dispose };
    });
    expect(t.active()).toBe('qc');
    select(4);
    expect(t.active()).toBe('cell');
    t.set('history');
    select(null);
    expect(t.active()).toBe('history');
    setHold(true);
    select(5);
    expect(t.active()).toBe('history');
    dispose();
  });
});
