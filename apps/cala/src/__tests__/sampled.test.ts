import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, createSignal } from 'solid-js';
import { createSampled } from '../lib/sampled.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createSampled', () => {
  it('reads at most once per period however often the store changes', () => {
    createRoot((dispose) => {
      const [processed, setProcessed] = createSignal(0);
      const [status] = createSignal('running');
      // eslint-disable-next-line solid/reactivity -- read untracked by createSampled, on purpose
      const reads = vi.fn(() => processed());
      // The key reads the fast store too, as the rail's does (processed === 0).
      const v = createSampled(reads, () => `${status()}|${processed() === 0}`, 500);
      expect(v()).toBe(0);
      setProcessed(1); // the key changes (0 -> not 0): sampled at once
      expect(v()).toBe(1);
      const before = reads.mock.calls.length;
      for (let i = 2; i <= 50; i++) setProcessed(i);
      expect(v()).toBe(1);
      expect(reads.mock.calls.length).toBe(before);
      vi.advanceTimersByTime(500);
      expect(v()).toBe(50);
      expect(reads.mock.calls.length).toBe(before + 1);
      dispose();
    });
  });

  it('samples at once on a change of key (a stage ending lands without delay)', () => {
    createRoot((dispose) => {
      const [status, setStatus] = createSignal('running');
      const v = createSampled(
        () => status(),
        () => status(),
        500,
      );
      setStatus('done');
      expect(v()).toBe('done');
      dispose();
    });
  });

  it('stops its timer with its owner', () => {
    const reads = vi.fn(() => 1);
    createRoot((dispose) => {
      createSampled(reads, () => '', 500);
      dispose();
    });
    const n = reads.mock.calls.length;
    vi.advanceTimersByTime(5000);
    expect(reads.mock.calls.length).toBe(n);
  });
});
