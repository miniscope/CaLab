import { describe, expect, it } from 'vitest';
import type { DonationMeta, PresignedRequest } from '@calab/community';
import {
  DonationRunner,
  MAX_CHUNK_BYTES,
  MAX_DONATION_BYTES,
  type DonationApi,
  type DonationJob,
  type DonationPhase,
  type DonationStore,
  type WorkerLike,
} from '../lib/donation-runner.ts';
import type { DonationEvent, DonationRequest } from '../workers/donation-types.ts';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * A donation worker that emits `chunks` (their sizes in bytes) after `start`,
 * one more each time the previous one is acked, then `done`. `cancel` makes it
 * answer `cancelled`.
 */
class FakeWorker implements WorkerLike {
  onmessage: ((e: MessageEvent<DonationEvent>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  readonly received: DonationRequest[] = [];
  terminated = false;
  private next = 0;
  private readonly sizes: number[];
  private readonly frames: number;

  /** `fakeBytes`: chunks are `{ length }` stand-ins, so huge sizes cost no memory. */
  private readonly fakeBytes: boolean;

  constructor(sizes: number[], opts: { frames?: number; fakeBytes?: boolean } = {}) {
    this.sizes = sizes;
    this.frames = opts.frames ?? 10;
    this.fakeBytes = opts.fakeBytes ?? false;
  }

  private emit(msg: DonationEvent): void {
    queueMicrotask(() => this.onmessage?.({ data: msg } as MessageEvent<DonationEvent>));
  }

  private sendNext(): void {
    if (this.next >= this.sizes.length) {
      this.emit({ type: 'progress', frames: this.frames });
      this.emit({ type: 'done', chunks: this.sizes.length });
      return;
    }
    const i = this.next++;
    const bytes = this.fakeBytes
      ? ({ length: this.sizes[i] } as Uint8Array)
      : new Uint8Array(this.sizes[i]).fill(i + 1);
    this.emit({ type: 'chunk', index: i, firstFrame: i, frames: 1, bytes });
  }

  postMessage(msg: DonationRequest): void {
    this.received.push(msg);
    if (msg.type === 'start') this.sendNext();
    else if (msg.type === 'ack') this.sendNext();
    else if (msg.type === 'cancel') this.emit({ type: 'cancelled' });
  }

  terminate(): void {
    this.terminated = true;
  }
}

function memStore() {
  const files = new Map<string, Uint8Array>();
  const store: DonationStore = {
    write: async (name, bytes) => void files.set(name, bytes),
    read: async (name) => {
      const b = files.get(name);
      if (!b) throw new Error(`no ${name}`);
      return b;
    },
    remove: async (name) => void files.delete(name),
  };
  return { files, store };
}

interface Calls {
  log: string[];
  created: { meta: DonationMeta; files: { name: string; bytes: number }[] }[];
  puts: { name: string; bytes: number }[];
}

/** An API that records every call; `failPut(name, attempt)` makes that PUT throw. */
function fakeApi(opts: { failPut?: (name: string, attempt: number) => boolean } = {}) {
  const calls: Calls = { log: [], created: [], puts: [] };
  const attempts = new Map<string, number>();
  const api: DonationApi = {
    createDonation: async (meta, files) => {
      calls.log.push('create');
      calls.created.push({ meta, files: files.map((f) => ({ ...f })) });
      return 'don-1';
    },
    donationUploadUrl: async (id, name) => {
      calls.log.push(`url ${name}`);
      return { url: `https://r2.test/${id}/${name}`, headers: {}, expires_in: 900 };
    },
    putPresigned: async (req: PresignedRequest, bytes) => {
      const name = req.url.slice(req.url.lastIndexOf('/') + 1);
      const attempt = (attempts.get(name) ?? 0) + 1;
      attempts.set(name, attempt);
      calls.log.push(`put ${name}`);
      if (opts.failPut?.(name, attempt)) throw new Error('network down');
      calls.puts.push({ name, bytes: bytes.length });
    },
    finishDonation: async () => void calls.log.push('finish'),
    withdrawDonation: async () => void calls.log.push('withdraw'),
  };
  return { api, calls };
}

const GEOMETRY = { width: 4, height: 3, frameCount: 10, bitDepth: 8 };

function job(over: Partial<DonationMeta> = {}, geometry = GEOMETRY): DonationJob {
  const meta: DonationMeta = {
    indicator: 'GCaMP6f',
    species: 'mouse',
    brain_region: 'CA1',
    scope: 'UCLA Miniscope v4',
    fps: 20,
    width: geometry.width,
    height: geometry.height,
    n_frames: geometry.frameCount,
    bytes_per_pixel: geometry.bitDepth === 16 ? 2 : 1,
    cala_version: 'test',
    sharing: 'public',
    subject_id: 'm7',
    subject_sex: 'F',
    subject_age: 'P90D',
    session_date: '2026-01-15',
    rights_attested: true,
    protocol_attested: true,
    contact_ok: false,
    ...over,
  };
  return {
    meta,
    encode: { source: { entries: [] }, fps: 20, expect: geometry },
    timestamps: new TextEncoder().encode('Frame Number,Time Stamp (ms)\n0,0\n'),
    metaJson: new TextEncoder().encode('{"cala_version":"test"}'),
  };
}

function runner(worker: FakeWorker, api: DonationApi, store: DonationStore) {
  const states: DonationPhase[] = [];
  const r = new DonationRunner({
    worker: () => worker,
    api,
    store,
    onState: (s) => states.push(s),
    sleep: () => Promise.resolve(),
  });
  return { r, states };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DonationRunner', () => {
  it('encodes, creates with the exact sizes, uploads in order and finishes once', async () => {
    const worker = new FakeWorker([100, 70, 30]);
    const { api, calls } = fakeApi();
    const { files, store } = memStore();
    const { r, states } = runner(worker, api, store);
    const j = job();

    const end = await r.run(j);

    const extras = j.timestamps!.length + j.metaJson.length;
    expect(end).toEqual({ kind: 'done', donationId: 'don-1', bytes: 200 + extras });
    expect(calls.created).toHaveLength(1);
    expect(calls.created[0].files).toEqual([
      { name: 'frames-0000.calaraw.gz', bytes: 100 },
      { name: 'frames-0001.calaraw.gz', bytes: 70 },
      { name: 'frames-0002.calaraw.gz', bytes: 30 },
      { name: 'timestamps.csv', bytes: j.timestamps!.length },
      { name: 'meta.json', bytes: j.metaJson.length },
    ]);
    expect(calls.created[0].meta).toBe(j.meta);
    // Upload sizes are the chunk byte lengths, in the declared order.
    expect(calls.puts).toEqual(calls.created[0].files);
    expect(calls.log.filter((c) => c === 'finish')).toHaveLength(1);
    expect(calls.log.at(-1)).toBe('finish');
    expect(calls.log.indexOf('create')).toBeLessThan(
      calls.log.indexOf('put frames-0000.calaraw.gz'),
    );
    // Every chunk was acked, the worker is gone, and the local files are deleted.
    expect(
      worker.received.filter((m) => m.type === 'ack').map((m) => (m as { index: number }).index),
    ).toEqual([0, 1, 2]);
    expect(worker.terminated).toBe(true);
    expect(files.size).toBe(0);
    expect(states.some((s) => s.kind === 'encoding')).toBe(true);
    expect(
      states.filter((s) => s.kind === 'uploading').map((s) => (s as { index: number }).index),
    ).toEqual([0, 1, 2, 3, 4]);
  });

  it('declares no timestamps.csv when the recording has none', async () => {
    const { api, calls } = fakeApi();
    const { store } = memStore();
    const { r } = runner(new FakeWorker([10]), api, store);
    const j = { ...job(), timestamps: undefined };
    await r.run(j);
    expect(calls.created[0].files.map((f) => f.name)).toEqual([
      'frames-0000.calaraw.gz',
      'meta.json',
    ]);
  });

  it('retries a failed upload with a fresh URL and then succeeds', async () => {
    const { api, calls } = fakeApi({
      failPut: (name, attempt) => name === 'frames-0001.calaraw.gz' && attempt <= 2,
    });
    const { store } = memStore();
    const { r, states } = runner(new FakeWorker([10, 20]), api, store);

    const end = await r.run(job());

    expect(end.kind).toBe('done');
    expect(calls.log.filter((c) => c === 'url frames-0001.calaraw.gz')).toHaveLength(3);
    expect(calls.puts.map((p) => p.name)).toEqual([
      'frames-0000.calaraw.gz',
      'frames-0001.calaraw.gz',
      'timestamps.csv',
      'meta.json',
    ]);
    expect(calls.log.filter((c) => c === 'finish')).toHaveLength(1);
    const attempts = states
      .filter((s) => s.kind === 'uploading' && s.name === 'frames-0001.calaraw.gz')
      .map((s) => (s as { attempt: number }).attempt);
    expect(attempts).toEqual([1, 2, 3]);
  });

  it('gives up after 3 retries: error, no finish, local files kept for a resume', async () => {
    let down = true;
    const { api, calls } = fakeApi({
      failPut: (name) => down && name === 'frames-0001.calaraw.gz',
    });
    const { files, store } = memStore();
    const { r } = runner(new FakeWorker([10, 20]), api, store);

    const end = await r.run(job());

    expect(end.kind).toBe('error');
    expect(end).toMatchObject({ resumable: true });
    expect((end as { message: string }).message).toMatch(/frames-0001\.calaraw\.gz failed 4 times/);
    expect(calls.log.filter((c) => c === 'put frames-0001.calaraw.gz')).toHaveLength(4);
    expect(calls.log).not.toContain('finish');
    expect(files.size).toBe(2);

    // Resume continues with the failed file, without creating the donation again.
    down = false;
    const resumed = await r.resume();
    expect(resumed.kind).toBe('done');
    expect(calls.log.filter((c) => c === 'create')).toHaveLength(1);
    expect(calls.puts.filter((p) => p.name === 'frames-0000.calaraw.gz')).toHaveLength(1);
    expect(calls.log.filter((c) => c === 'finish')).toHaveLength(1);
    expect(files.size).toBe(0);
  });

  it('discard after a failed upload withdraws the donation and deletes the local files', async () => {
    const { api, calls } = fakeApi({ failPut: () => true });
    const { files, store } = memStore();
    const { r } = runner(new FakeWorker([10]), api, store);
    await r.run(job());
    await r.discard();
    expect(calls.log).toContain('withdraw');
    expect(files.size).toBe(0);
    expect(r.phase().kind).toBe('idle');
  });

  it('cancel while encoding stops the worker: nothing is created, local files deleted', async () => {
    const worker = new FakeWorker([10, 20, 30]);
    const { api, calls } = fakeApi();
    const { files, store } = memStore();
    // The store cancels the run once the first chunk is written.
    const r: DonationRunner = new DonationRunner({
      worker: () => worker,
      api,
      store: {
        ...store,
        write: async (name, bytes) => {
          await store.write(name, bytes);
          r.cancel();
        },
      },
    });
    const end = await r.run(job());

    expect(end.kind).toBe('cancelled');
    expect(worker.received.some((m) => m.type === 'cancel')).toBe(true);
    expect(calls.log).toEqual([]);
    expect(files.size).toBe(0);
    expect(worker.terminated).toBe(true);
  });

  it('cancel while uploading withdraws the created donation', async () => {
    const { store, files } = memStore();
    const base = fakeApi();
    // The API cancels the run once the first file is sent.
    const r: DonationRunner = new DonationRunner({
      worker: () => new FakeWorker([10, 20]),
      api: {
        ...base.api,
        putPresigned: async (req, bytes) => {
          await base.api.putPresigned(req, bytes);
          r.cancel();
        },
      },
      store,
      sleep: async () => {},
    });
    const end = await r.run(job());
    expect(end.kind).toBe('cancelled');
    expect(base.calls.puts).toHaveLength(1);
    expect(base.calls.log).toContain('withdraw');
    expect(base.calls.log).not.toContain('finish');
    expect(files.size).toBe(0);
  });

  it('refuses a recording whose estimated size is above the cap before encoding or creating', async () => {
    // 2048 x 2048 x 16-bit x 3000 frames ~ 15 GB compressed.
    const big = { width: 2048, height: 2048, frameCount: 3000, bitDepth: 16 };
    const worker = new FakeWorker([10]);
    const { api, calls } = fakeApi();
    const { store } = memStore();
    const { r } = runner(worker, api, store);
    const end = await r.run(job({}, big));
    expect(end.kind).toBe('error');
    expect((end as { message: string }).message).toMatch(/limit per shared recording/);
    expect(worker.received).toEqual([]);
    expect(calls.log).toEqual([]);
  });

  it('refuses before create when the compressed chunks pass the cap', async () => {
    // 103 chunks at the 100 MiB chunk limit: 10.06 GiB, over the 10 GiB cap.
    const worker = new FakeWorker(new Array<number>(103).fill(MAX_CHUNK_BYTES), {
      fakeBytes: true,
    });
    const { api, calls } = fakeApi();
    const { files, store } = memStore();
    const { r } = runner(worker, api, store);
    const end = await r.run(job());
    expect(end.kind).toBe('error');
    expect(end).toMatchObject({ resumable: false });
    expect((end as { message: string }).message).toMatch(/larger than the 10\.0 GB limit/);
    expect(102 * MAX_CHUNK_BYTES).toBeLessThanOrEqual(MAX_DONATION_BYTES);
    expect(calls.log).toEqual([]);
    expect(worker.received.some((m) => m.type === 'cancel')).toBe(true);
    expect(files.size).toBe(0);
  });

  it('refuses without both consent boxes ticked', async () => {
    const worker = new FakeWorker([10]);
    const { api, calls } = fakeApi();
    const { store } = memStore();
    const { r } = runner(worker, api, store);
    const end = await r.run(job({ protocol_attested: false }));
    expect(end.kind).toBe('error');
    expect(worker.received).toEqual([]);
    expect(calls.log).toEqual([]);
  });

  it('reports an encoder error without creating anything', async () => {
    const worker = new FakeWorker([10]);
    worker.postMessage = (msg: DonationRequest) => {
      worker.received.push(msg);
      if (msg.type === 'start') {
        queueMicrotask(() =>
          worker.onmessage?.({
            data: { type: 'error', message: '0.avi: bad frame' },
          } as MessageEvent<DonationEvent>),
        );
      }
    };
    const { api, calls } = fakeApi();
    const { store } = memStore();
    const { r } = runner(worker, api, store);
    const end = await r.run(job());
    expect(end).toEqual({ kind: 'error', message: '0.avi: bad frame', resumable: false });
    expect(calls.log).toEqual([]);
  });
});
