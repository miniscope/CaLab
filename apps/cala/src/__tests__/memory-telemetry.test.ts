import { afterEach, describe, expect, it } from 'vitest';
import {
  REPORT_TTL_MS,
  recordThreadHeap,
  startMemoryCollector,
  startMemoryReporter,
  totalWasmHeapBytes,
} from '../lib/memory-telemetry.ts';

let stop = () => {};
afterEach(() => stop());

describe('totalWasmHeapBytes', () => {
  it('sums the main thread and every worker', () => {
    stop = startMemoryCollector(() => 100);
    recordThreadHeap('a', 10);
    recordThreadHeap('b', 20);
    expect(totalWasmHeapBytes()).toBe(130);
  });

  it('uses a worker latest report, not the sum of its reports', () => {
    stop = startMemoryCollector(() => 0);
    recordThreadHeap('a', 10);
    recordThreadHeap('a', 50);
    expect(totalWasmHeapBytes()).toBe(50);
  });

  it('works with no worker reports', () => {
    stop = startMemoryCollector(() => 7);
    expect(totalWasmHeapBytes()).toBe(7);
  });

  it('drops workers that stopped reporting', () => {
    stop = startMemoryCollector(() => 0);
    recordThreadHeap('gone', 500, 1000);
    recordThreadHeap('live', 5, 1000 + REPORT_TTL_MS);
    expect(totalWasmHeapBytes(1000 + REPORT_TTL_MS + 1)).toBe(5);
  });

  it('ignores invalid reports', () => {
    stop = startMemoryCollector(() => 0);
    recordThreadHeap('a', Number.NaN);
    recordThreadHeap('b', -1);
    expect(totalWasmHeapBytes()).toBe(0);
  });
});

describe('reporter to collector over BroadcastChannel', () => {
  it('delivers a worker report to the main thread sum', async () => {
    stop = startMemoryCollector(() => 1);
    const stopReporter = startMemoryReporter(() => 41, 60_000, 'w1');
    await new Promise((r) => setTimeout(r, 100));
    stopReporter();
    expect(totalWasmHeapBytes()).toBe(42);
  });
});
