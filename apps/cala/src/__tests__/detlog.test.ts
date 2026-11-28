// @vitest-environment node
/**
 * The determinism log (`?debug&detlog`): the hash, the page-side store, and the rows the slow
 * worker sends for a batch, a visit take and apply, and a library.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fnvBytes, keepDetlog, type DetLogRow } from '../lib/detlog.ts';
import { SlowRunner } from '../lib/slow-runner.ts';
import type { FastToSlow, OwnerToVisit, SlowToMain } from '../workers/slow-types.ts';
import { fakeLib, INIT, stubSlowLoop } from './slow-fixtures.ts';

function frames(start: number, count = 2): Extract<FastToSlow, { type: 'frames' }> {
  return {
    type: 'frames',
    session: 1,
    start,
    count,
    version: 3,
    cells: 0,
    frames: new Float32Array(2 * count),
    traces: new Float32Array(0),
  };
}

describe('fnvBytes', () => {
  it('depends on the bytes only, not on the view or its alignment', () => {
    const a = Float32Array.of(1, 2, 3);
    const buf = new Uint8Array(13);
    buf.set(new Uint8Array(a.buffer), 1);
    expect(fnvBytes(a)).toBe(fnvBytes(new Uint8Array(a.buffer)));
    expect(fnvBytes(a)).toBe(fnvBytes(buf.subarray(1)));
    expect(fnvBytes(a)).not.toBe(fnvBytes(Float32Array.of(1, 2, 4)));
    expect(fnvBytes(new Uint8Array(0))).not.toBe(fnvBytes(new Uint8Array(1)));
  });
});

describe('keepDetlog', () => {
  afterEach(() => {
    delete (globalThis as { __calaDetlog?: unknown }).__calaDetlog;
  });

  it('appends within a session, restarts on a newer one, ignores an older one', () => {
    const g = globalThis as { __calaDetlog?: { session: number; rows: DetLogRow[] } };
    keepDetlog({ session: 1, rows: [['end', 4]] });
    keepDetlog({ session: 1, rows: [['final', 4]] });
    expect(g.__calaDetlog?.rows).toEqual([
      ['end', 4],
      ['final', 4],
    ]);
    keepDetlog({ session: 2, rows: [['end', 1]] });
    keepDetlog({ session: 1, rows: [['end', 9]] });
    expect(g.__calaDetlog).toEqual({ session: 2, rows: [['end', 1]] });
  });
});

describe('SlowRunner determinism log', () => {
  function run(detlog: boolean) {
    const toMain: SlowToMain[] = [];
    const jobs: OwnerToVisit[] = [];
    let taken = false;
    const loop: { work: number } & ReturnType<typeof stubSlowLoop> = stubSlowLoop({
      observe: vi.fn(() => {
        loop.work += 10;
        return true;
      }),
      takeJob: vi.fn(() => {
        if (taken) return undefined;
        taken = true;
        return Uint8Array.of(7, 7);
      }),
      housekeep: vi.fn(() => (taken ? fakeLib(5) : undefined)),
    });
    const runner = new SlowRunner({
      create: () => loop,
      toFast: { postMessage: () => {} },
      toMain: { postMessage: (m) => toMain.push(m) },
      visits: [{ postMessage: (m: OwnerToVisit) => jobs.push(m) }],
      now: () => 0,
      timer: () => () => {},
    });
    runner.setDetlog(detlog);
    runner.handle(INIT);
    runner.handle(frames(0));
    runner.handleVisit(0, { type: 'result', session: 1, bytes: Uint8Array.of(1), ms: 1 });
    runner.handle(frames(2));
    const rows = toMain.flatMap((m) => (m.type === 'detlog' ? m.rows : []));
    return { rows, jobs };
  }

  it('logs batches, the take and apply of a visit, and the library, stamped with frames observed', () => {
    const { rows, jobs } = run(true);
    expect(jobs.filter((m) => m.type === 'job')).toHaveLength(1);
    expect(rows.map((r) => r[0])).toEqual(['batch', 'take', 'apply', 'pub', 'batch']);
    // Width x height is 2 x 1 (INIT): the hashes cover count x 2 frame values and the traces.
    const input = [fnvBytes(new Float32Array(4)), fnvBytes(new Float32Array(0)), 0];
    expect(rows[0]).toEqual(['batch', 0, 0, 2, 3, 0, ...input]);
    expect(rows[1]).toEqual(['take', 2, 1, 0, fnvBytes(Uint8Array.of(7, 7))]);
    expect(rows[2]).toEqual(['apply', 2, 1, 0, fnvBytes(Uint8Array.of(1)), 20]);
    expect(rows[3]).toEqual(['pub', 2, 5, fnvBytes(fakeLib(5).toBytes())]);
    expect(rows[4]).toEqual(['batch', 2, 2, 2, 3, 20, ...input]);
  });

  it('sends nothing without it', () => {
    expect(run(false).rows).toEqual([]);
  });
});
