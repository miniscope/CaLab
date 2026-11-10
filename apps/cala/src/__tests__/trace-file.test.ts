import { describe, expect, it } from 'vitest';
import {
  MemoryBackend,
  TraceFile,
  TraceStorageError,
  createTraceFile,
  type BlockBackend,
} from '../lib/trace-file.ts';
import { traceChunks } from '../lib/export.ts';

/** A backend that records writes (offset order) and can fail after some bytes. */
class FakeBackend implements BlockBackend {
  private readonly inner: MemoryBackend;
  writes: { offset: number; length: number }[] = [];
  removed = false;
  finished = 0;
  private budget: number;
  constructor(bytes: number, budget = Infinity) {
    this.inner = new MemoryBackend(bytes);
    this.budget = budget;
  }
  async write(offset: number, bytes: Uint8Array): Promise<void> {
    if (bytes.length > this.budget) {
      throw new TraceStorageError('The browser ran out of storage (test).');
    }
    this.budget -= bytes.length;
    this.writes.push({ offset, length: bytes.length });
    await this.inner.write(offset, bytes);
  }
  async finish(): Promise<void> {
    this.finished++;
  }
  read(offset: number, length: number): Promise<Uint8Array> {
    return this.inner.read(offset, length);
  }
  async remove(): Promise<void> {
    this.removed = true;
  }
}

const CELLS = 5;
const FRAMES = 23;
const value = (f: number, c: number) => 1000 * f + c;

function batch(start: number, count: number): Float32Array {
  const out = new Float32Array(count * CELLS);
  for (let f = 0; f < count; f++)
    for (let c = 0; c < CELLS; c++) out[f * CELLS + c] = value(start + f, c);
  return out;
}

async function filled(backend = new FakeBackend(FRAMES * CELLS * 4)): Promise<TraceFile> {
  const file = new TraceFile(FRAMES, CELLS, backend, 'memory');
  for (let s = 0; s < FRAMES; s += 4) file.append(s, batch(s, Math.min(4, FRAMES - s)));
  await file.finish();
  return file;
}

describe('TraceFile', () => {
  it('lays traces out frame-major and reads frames and cells back', async () => {
    const file = await filled();
    expect(file.bytes).toBe(FRAMES * CELLS * 4);
    const block = await file.readFrames(6, 9);
    expect(block.length).toBe(3 * CELLS);
    expect(block[0]).toBe(value(6, 0));
    expect(block[CELLS + 3]).toBe(value(7, 3));
    const cell = await file.readCell(3);
    expect(cell.length).toBe(FRAMES);
    for (let f = 0; f < FRAMES; f++) expect(cell[f]).toBe(value(f, 3));
  });

  it('copies appended traces, so the caller can reuse its buffer', async () => {
    const file = new TraceFile(2, CELLS, new FakeBackend(2 * CELLS * 4), 'memory');
    const b = batch(0, 2);
    file.append(0, b);
    b.fill(-1);
    await file.finish();
    expect((await file.readFrames(1, 2))[2]).toBe(value(1, 2));
  });

  it('accepts out-of-order and unaligned batches by offset', async () => {
    const backend = new FakeBackend(FRAMES * CELLS * 4);
    const file = new TraceFile(FRAMES, CELLS, backend, 'memory');
    file.append(10, batch(10, 13));
    file.append(0, batch(0, 10));
    await file.finish();
    expect((await file.readCell(4))[11]).toBe(value(11, 4));
    expect((await file.readCell(4))[3]).toBe(value(3, 4));
  });

  it('rejects traces outside the file', () => {
    const file = new TraceFile(4, CELLS, new FakeBackend(4 * CELLS * 4), 'memory');
    expect(() => file.append(3, batch(3, 2))).toThrow(RangeError);
    expect(() => file.append(0, new Float32Array(CELLS + 1))).toThrow(RangeError);
  });

  it('remembers a storage error, stops writing, and rethrows it', async () => {
    const backend = new FakeBackend(FRAMES * CELLS * 4, 2 * 4 * CELLS * 4 + 1);
    const file = new TraceFile(FRAMES, CELLS, backend, 'opfs');
    file.append(0, batch(0, 4));
    file.append(4, batch(4, 4));
    file.append(8, batch(8, 4)); // over budget
    file.append(12, batch(12, 4)); // skipped after the failure
    await expect(file.finish()).rejects.toThrow(/ran out of storage/);
    expect(backend.writes).toHaveLength(2);
    expect(() => file.append(16, batch(16, 4))).toThrow(/ran out of storage/);
  });

  it('applies backpressure: drained() waits until the queued bytes fall under the limit', async () => {
    const gate: (() => void)[] = [];
    const slow = new FakeBackend(FRAMES * CELLS * 4);
    const write = slow.write.bind(slow);
    slow.write = (o, b) => new Promise<void>((r) => gate.push(() => void write(o, b).then(r)));
    const file = new TraceFile(FRAMES, CELLS, slow, 'opfs');
    const one = 4 * CELLS * 4;
    for (let s = 0; s < 16; s += 4) file.append(s, batch(s, 4)); // 4 batches queued
    let resolved = false;
    const waiting = file.drained(one).then(() => (resolved = true));
    await new Promise((r) => setTimeout(r, 5));
    expect(resolved).toBe(false);
    while (!resolved) {
      gate.shift()?.();
      await new Promise((r) => setTimeout(r, 1));
    }
    await waiting;
    expect(gate.length).toBeLessThanOrEqual(1);
  });

  it('settles its queue even when the backend takes ownership of (detaches) the bytes', async () => {
    const inner = new FakeBackend(FRAMES * CELLS * 4);
    const detaching: BlockBackend = {
      ...inner,
      write: async (offset, bytes) => {
        await inner.write(offset, bytes.slice());
        structuredClone(bytes.buffer, { transfer: [bytes.buffer] }); // like a worker transfer
      },
      finish: () => inner.finish(),
      read: (o, l) => inner.read(o, l),
      remove: () => inner.remove(),
    };
    const file = new TraceFile(FRAMES, CELLS, detaching, 'opfs');
    for (let s = 0; s < FRAMES; s += 4) file.append(s, batch(s, Math.min(4, FRAMES - s)));
    await file.finish();
    expect(file.queuedBytes).toBe(0);
    await file.drained(0);
  });

  it('removes its storage on dispose', async () => {
    const backend = new FakeBackend(FRAMES * CELLS * 4);
    const file = await filled(backend);
    await file.dispose();
    expect(backend.removed).toBe(true);
  });
});

describe('createTraceFile without OPFS', () => {
  it('uses memory for small matrices and explains a matrix that is too big', async () => {
    const f = await createTraceFile(10, 4);
    expect(f.kind).toBe('memory');
    await f.dispose();
    await expect(createTraceFile(10_000_000, 4000)).rejects.toThrow(/more traces than fit/);
  });
});

describe('traceChunks', () => {
  it('streams whole frames in Fortran order, optionally only some cells', async () => {
    const file = await filled();
    const all: number[] = [];
    for await (const c of traceChunks(file, null)) {
      all.push(...new Float32Array(c.buffer, c.byteOffset, c.byteLength / 4));
    }
    expect(all).toHaveLength(FRAMES * CELLS);
    expect(all[7 * CELLS + 2]).toBe(value(7, 2));
    const some: number[] = [];
    for await (const c of traceChunks(file, [4, 1])) {
      some.push(...new Float32Array(c.buffer, c.byteOffset, c.byteLength / 4));
    }
    expect(some.slice(0, 4)).toEqual([value(0, 4), value(0, 1), value(1, 4), value(1, 1)]);
    expect(some).toHaveLength(FRAMES * 2);
  });
});
