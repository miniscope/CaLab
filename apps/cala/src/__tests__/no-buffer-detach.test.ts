import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guard for the v2.18.0 Refine blowup: never "free" a buffer with
 * `ArrayBuffer.prototype.transfer(0)` (or `transfer()` to any size).
 *
 * In Chrome, the detached buffer's memory is not released: it stays with the
 * new zero-length buffer until that one is garbage-collected, and V8 counts
 * it as 0 bytes, so its external-memory pressure never triggers that GC. A
 * worker with a tiny JS heap then keeps every buffer it "freed". Refine on a
 * real GPU hands out ~300 tile visits a second (3.35 MB each): the tab grew
 * by ~1 GB/s and stalled at 6-12 GB. Dropping the reference instead lets V8
 * count the buffer and collect it.
 *
 * This cannot be reproduced in Node's or jsdom's V8, so the test scans the
 * app's sources instead.
 */
const SRC = join(import.meta.dirname, '..');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== '__tests__') out.push(...sources(p));
    } else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('buffer release', () => {
  it('no app source detaches a buffer with ArrayBuffer transfer()', () => {
    const offenders = sources(SRC).filter((f) =>
      /\.transfer(ToFixedLength)?\(\s*\d*\s*\)/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
