import { describe, expect, it } from 'vitest';
import { createCompressStore } from '../lib/compress-store.ts';
import { createFactorExtract } from '../lib/factor-extract.ts';

function setup() {
  const store = createCompressStore();
  store.reset(3);
  const client = {
    extracts: [] as { session: number; job: number; version: number }[],
    cancels: [] as { session: number; job: number }[],
    extract(session: number, job: number, version: number) {
      this.extracts.push({ session, job, version });
    },
    extractCancel(session: number, job: number) {
      this.cancels.push({ session, job });
    },
  };
  const port = createFactorExtract(
    store,
    client,
    () => 3,
    () => true,
    () => true,
    () => 100,
  );
  return { store, client, port };
}

describe('createFactorExtract', () => {
  it('a job resolves at extract-done and hands each window to onWindow', async () => {
    const t = setup(); // store reset to session 3, fake client, port
    const seen: number[] = [];
    const job = t.port.run(9, Uint8Array.of(1), (start) => seen.push(start));
    const id = t.client.extracts.at(-1)!.job;
    t.store.onMessage({
      type: 'extracted',
      session: 3,
      job: id,
      start: 0,
      count: 2,
      ids: Uint32Array.of(1),
      traces: new Float32Array(2),
    });
    t.store.onMessage({ type: 'extract-done', session: 3, job: id, frames: 2, msPerFrame: 0.5 });
    await expect(job.done).resolves.toEqual({ frames: 2, msPerFrame: 0.5 });
    expect(seen).toEqual([0]);
  });
  it('rejects on its error, on cancel (and tells the worker), on a reset and on a crash', async () => {
    const t = setup();
    const a = t.port.run(9, Uint8Array.of(1), () => {});
    t.store.onMessage({
      type: 'error',
      session: 3,
      job: t.client.extracts.at(-1)!.job,
      message: 'f2.bin cannot be read',
    });
    await expect(a.done).rejects.toThrow('f2.bin');
    const b = t.port.run(9, Uint8Array.of(1), () => {});
    b.cancel();
    await expect(b.done).rejects.toThrow('cancelled');
    expect(t.client.cancels).toHaveLength(1);
    const c = t.port.run(9, Uint8Array.of(1), () => {});
    t.store.reset(4);
    await expect(c.done).rejects.toThrow('A new run started');
    t.store.reset(3);
    const d = t.port.run(9, Uint8Array.of(1), () => {});
    t.store.onMessage({ type: 'error', session: -1, message: 'The compress worker crashed.' });
    await expect(d.done).rejects.toThrow('crashed');
  });
});
