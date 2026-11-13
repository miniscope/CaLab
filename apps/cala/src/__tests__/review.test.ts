// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  HistoryReview,
  initCalaWasm,
  quantizeTiles,
  SlowLoop,
  TileCompressor,
  TraceLibraryBuilder,
} from '../lib/cala-wasm.ts';
import { createCompressClient } from '../lib/compress-client.ts';
import { CompressFeed } from '../lib/compress-feed.ts';
import { CompressRunner } from '../lib/compress-runner.ts';
import { createReviewClient } from '../lib/review-client.ts';
import {
  candidateCount,
  REVIEW_ROWS_PER_STEP,
  ReviewRunner,
  type HistoryReviewLike,
} from '../lib/review-runner.ts';
import {
  createReviewStore,
  REVIEW_EVERY_WINDOWS,
  reviewEvery,
  reviewReadout,
} from '../lib/review-store.ts';
import { createSlowClient } from '../lib/slow-client.ts';
import { SlowRunner, type PublishedLibrary, type SlowLoopLike } from '../lib/slow-runner.ts';
import { memoryStore } from '../lib/window-store.ts';
import type { CompressToMain, FastToCompress } from '../workers/compress-types.ts';
import type { CompressToReview, ReviewStatus, ReviewToMain } from '../workers/review-types.ts';
import type { FastToSlow, OwnerToVisit, SlowToMain, VisitToOwner } from '../workers/slow-types.ts';

beforeAll(async () => {
  await initCalaWasm(
    readFileSync(resolve(import.meta.dirname, '../../../../crates/cala/pkg/calab_cala_bg.wasm')),
  );
});

/** One candidate in the layout of `HistoryReview.finish`: a 2 x 2 footprint at `(y0, x0)`. */
function candidate(y0: number, x0: number): number[] {
  return [y0, x0, 2, 2, 9, 7, 1, 0.5, 0.5, 0.25];
}

describe('ReviewRunner (fake review)', () => {
  function setup(rows = 10, maxFactorBytes?: number) {
    const toMain: ReviewToMain[] = [];
    const calls: string[] = [];
    let windows = 0;
    let left = 0;
    let turn: (() => void) | null = null;
    const review: HistoryReviewLike = {
      addWindow: (b) => {
        calls.push(`add ${b[0]}`);
        return ++windows;
      },
      dropOldest: () => {
        calls.push('drop');
        windows--;
      },
      get windows() {
        return windows;
      },
      get factorBytes() {
        return 100 * windows;
      },
      begin: (lib) => {
        calls.push(`begin ${lib.length}`);
        left = windows >= 4 ? rows : 0;
        return left;
      },
      scan: (n) => {
        calls.push(`scan ${n}`);
        left = Math.max(0, left - n);
        return left;
      },
      finish: () => Float32Array.from([...candidate(3, 4), ...candidate(20, 9)]),
      cancel: () => calls.push('cancel'),
      free: () => calls.push('free'),
    };
    const r = new ReviewRunner({
      create: (w, h) => {
        calls.push(`create ${w}x${h}`);
        windows = 0;
        return review;
      },
      toMain: { postMessage: (m) => toMain.push(m) },
      heapBytes: () => 4096,
      ...(maxFactorBytes === undefined ? {} : { maxFactorBytes }),
      // Each yield waits for the test to let the review go on.
      yieldNow: () => new Promise<void>((done) => (turn = done)),
      now: (() => {
        let t = 0;
        return () => (t += 500);
      })(),
    });
    const step = async (): Promise<void> => {
      turn?.();
      turn = null;
      await Promise.resolve();
      await Promise.resolve();
    };
    const window = (i: number, session = 3): CompressToReview => ({
      type: 'window',
      session,
      bytes: Uint8Array.of(i),
    });
    const due = (session = 3): CompressToReview => ({
      type: 'review',
      session,
      version: 5,
      library: Uint8Array.of(1, 2, 3),
    });
    const statuses = (): ReviewStatus[] =>
      toMain.flatMap((m) => (m.type === 'status' ? [m.status] : []));
    r.handle({ type: 'init', session: 3, width: 40, height: 24 });
    return { r, toMain, calls, step, window, due, statuses };
  }

  it('scans a due review a few rows at a time and posts what it found', async () => {
    const t = setup(10);
    for (let i = 0; i < 4; i++) t.r.handle(t.window(i));
    t.r.handle(t.due());
    // The first rows are scanned at once; the rest after each yield.
    expect(t.calls.slice(-2)).toEqual(['begin 3', `scan ${REVIEW_ROWS_PER_STEP}`]);
    expect(t.statuses().at(-1)).toMatchObject({ running: true, reviews: 0 });
    await t.step();
    await t.step();
    await t.step();
    await t.r.idle();
    expect(t.calls.filter((c) => c.startsWith('scan')).length).toBe(3);
    const found = t.toMain.find((m) => m.type === 'candidates');
    expect(found).toMatchObject({ session: 3, version: 5 });
    if (found?.type !== 'candidates') return;
    expect(candidateCount(found.candidates)).toBe(2);
    expect(t.statuses().at(-1)).toEqual({
      reviews: 1,
      skipped: 0,
      candidates: 2,
      running: false,
      windows: 4,
      seconds: 0.5,
      factorBytes: 400,
      heapBytes: 4096,
    });
  });

  it('does not start a review on too little history', async () => {
    const t = setup();
    t.r.handle(t.window(0));
    t.r.handle(t.due());
    await t.r.idle();
    expect(t.calls.at(-1)).toBe('begin 3');
    expect(t.toMain).toEqual([]);
  });

  it('reviews without a library before the first one is published', async () => {
    const t = setup(1);
    for (let i = 0; i < 4; i++) t.r.handle(t.window(i));
    t.r.handle({ type: 'review', session: 3, version: 0, library: null });
    expect(t.calls).toContain('begin 0');
    await t.step();
    await t.r.idle();
    expect(t.statuses().at(-1)).toMatchObject({ reviews: 1 });
  });

  it('skips a review that is due while one runs, and adds the windows after it', async () => {
    const t = setup(8);
    for (let i = 0; i < 4; i++) t.r.handle(t.window(i));
    t.r.handle(t.due());
    t.r.handle(t.window(4));
    t.r.handle(t.due());
    expect(t.calls).not.toContain('add 4');
    expect(t.statuses().at(-1)).toMatchObject({ running: true, skipped: 1 });
    await t.step();
    await t.step();
    await t.r.idle();
    // One review, not two; the window that waited is in for the next one.
    expect(t.calls.filter((c) => c.startsWith('begin')).length).toBe(1);
    expect(t.calls.slice(-2)).toEqual(['cancel', 'add 4']);
    expect(t.statuses().at(-1)).toMatchObject({
      reviews: 1,
      skipped: 1,
      running: false,
      windows: 4,
      factorBytes: 500,
    });
    t.r.handle(t.due());
    expect(t.calls.at(-1)).toBe(`scan ${REVIEW_ROWS_PER_STEP}`);
  });

  it('stops a running review on reset and ignores another session', async () => {
    const t = setup(8);
    for (let i = 0; i < 4; i++) t.r.handle(t.window(i));
    t.r.handle(t.window(9, 99));
    expect(t.calls).not.toContain('add 9');
    t.r.handle(t.due());
    t.r.handle({ type: 'reset', session: 99 });
    expect(t.calls).not.toContain('free');
    t.r.handle({ type: 'reset', session: 3 });
    expect(t.calls.at(-1)).toBe('free');
    const before = t.toMain.length;
    await t.step();
    await t.r.idle();
    // The dropped review touches nothing and reports nothing.
    expect(t.calls.at(-1)).toBe('free');
    expect(t.toMain.length).toBe(before);
    t.r.handle(t.window(5));
    expect(t.calls.at(-1)).toBe('free');
  });

  it('drops the oldest windows beyond its memory budget', () => {
    const t = setup(8, 250);
    for (let i = 0; i < 4; i++) t.r.handle(t.window(i));
    expect(t.calls.filter((c) => c === 'drop').length).toBe(2);
  });

  it('reports a failing review and takes the next one', async () => {
    const toMain: ReviewToMain[] = [];
    let fail = true;
    const r = new ReviewRunner({
      create: () => ({
        addWindow: () => 1,
        dropOldest: () => {},
        windows: 4,
        factorBytes: 0,
        begin: () => 1,
        scan: () => {
          if (fail) throw new Error('boom');
          return 0;
        },
        finish: () => new Float32Array(0),
        cancel: () => {},
        free: () => {},
      }),
      toMain: { postMessage: (m) => toMain.push(m) },
      yieldNow: () => Promise.resolve(),
    });
    r.handle({ type: 'init', session: 1, width: 4, height: 4 });
    r.handle({ type: 'review', session: 1, version: 1, library: null });
    await r.idle();
    expect(toMain.at(-1)).toEqual({ type: 'error', session: 1, message: 'boom' });
    fail = false;
    r.handle({ type: 'review', session: 1, version: 1, library: null });
    await r.idle();
    // No candidates: only the status goes out.
    expect(toMain.filter((m) => m.type === 'candidates')).toEqual([]);
    expect(toMain.at(-1)).toMatchObject({ type: 'status', status: { reviews: 1, running: false } });
  });
});

const W = 40;
const H = 24;
const PX = W * H;

function batch(start: number, count: number): Float32Array {
  const out = new Float32Array(count * PX);
  for (let i = 0; i < out.length; i++) out[i] = 10 + 5 * Math.sin((start + i) / 7);
  return out;
}

describe('CompressRunner feeding the review worker', () => {
  function run(every: number) {
    const sent: FastToCompress[] = [];
    const feed = new CompressFeed(
      { width: W, height: H, session: 7, tile: 16, window: 10, quant: 64 },
      { postMessage: (m) => sent.push(m) },
    );
    const toReview: CompressToReview[] = [];
    const toMain: CompressToMain[] = [];
    const store = memoryStore();
    const r = new CompressRunner({
      store,
      quantize: quantizeTiles,
      create: (quant) => new TileCompressor(quant),
      toMain: { postMessage: (m) => toMain.push(m) },
      review: { port: { postMessage: (m) => toReview.push(m) }, every },
      yieldNow: () => Promise.resolve(),
    });
    return { feed, sent, toReview, store, r };
  }

  it('sends every window and, every few windows, the newest library', async () => {
    const t = run(2);
    t.feed.push(batch(0, 20), 0, 20);
    t.feed.library(4, Uint8Array.of(4, 4));
    t.feed.push(batch(20, 30), 20, 30);
    for (const m of t.sent) await t.r.handle(m);
    await t.r.idle();
    expect(t.toReview.map((m) => m.type)).toEqual([
      'init',
      'window',
      'window',
      'review',
      'window',
      'window',
      'review',
      'window',
    ]);
    expect(t.toReview[0]).toEqual({ type: 'init', session: 7, width: W, height: H });
    // A window message is the factor file.
    const windows = t.toReview.flatMap((m) => (m.type === 'window' ? [m.bytes] : []));
    windows.forEach((bytes, k) => expect(bytes).toEqual(t.store.files.get(`f${k}.bin`)));
    const reviews = t.toReview.flatMap((m) => (m.type === 'review' ? [m] : []));
    expect(reviews.map((m) => m.version)).toEqual([4, 4]);
    expect(reviews[0].library).toEqual(Uint8Array.of(4, 4));
    // Each request has its own copy (it is transferred).
    expect(reviews[0].library).not.toBe(reviews[1].library);

    await t.r.handle({ type: 'reset', session: 7 });
    expect(t.toReview.at(-1)).toEqual({ type: 'reset', session: 7 });
  });

  it('asks for a review without a library when none is out yet', async () => {
    const t = run(1);
    t.feed.push(batch(0, 10), 0, 10);
    for (const m of t.sent) await t.r.handle(m);
    await t.r.idle();
    expect(t.toReview.at(-1)).toEqual({ type: 'review', session: 7, version: 0, library: null });
  });

  it('sends nothing once the recording ended', async () => {
    const t = run(1);
    t.feed.push(batch(0, 14), 0, 14);
    t.feed.end();
    // The end arrives before the first window is compressed.
    for (const m of t.sent) await t.r.handle(m);
    await t.r.idle();
    expect(t.store.files.size).toBe(2);
    expect(t.toReview.map((m) => m.type)).toEqual(['init']);
  });
});

function fakeLib(version: number): PublishedLibrary {
  return {
    version,
    ids: () => Uint32Array.of(1),
    centers: () => Float32Array.of(0, 0),
    radii: () => Float32Array.of(1),
    supportStarts: () => Uint32Array.of(0, 1),
    supportPixels: () => Uint32Array.of(0),
    footprintValues: () => Float32Array.of(1),
    toBytes: () => Uint8Array.of(version),
    free: vi.fn(),
  };
}

const INIT: Extract<FastToSlow, { type: 'init' }> = {
  type: 'init',
  session: 1,
  width: 2,
  height: 1,
  fov: Uint8Array.of(1, 1),
  noise: Float32Array.of(1, 1),
  cellDiameterPx: 10,
  flattenSigmaPx: 0,
  budget: 123,
};

const FRAMES: Extract<FastToSlow, { type: 'frames' }> = {
  type: 'frames',
  session: 1,
  start: 0,
  count: 2,
  version: 0,
  cells: 0,
  frames: new Float32Array(4),
  traces: new Float32Array(0),
};

describe('SlowRunner taking reviewed cells', () => {
  function setup(visitWorkers: number) {
    const log: string[] = [];
    const toMain: SlowToMain[] = [];
    let due = 4;
    const loop: SlowLoopLike = {
      observe: () => true,
      step: () => undefined,
      finalize: () => fakeLib(9),
      setNoise: () => {},
      takeJob: () => (due-- > 0 ? (log.push('take'), Uint8Array.of(due)) : undefined),
      applyJob: () => void log.push('apply'),
      housekeep: () => undefined,
      addReviewed: (c) => (log.push(`add ${c[0]}`), 1),
      cellCount: 0,
      reservoirBytes: 0,
      stats: () => Float64Array.from({ length: 17 }, (_, i) => (i === 16 ? 5 : 0)),
      free: () => {},
    };
    const r = new SlowRunner({
      create: () => loop,
      toFast: { postMessage: () => {} },
      toMain: { postMessage: (m) => toMain.push(m) },
      visits: Array.from({ length: visitWorkers }, () => ({
        postMessage: (_m: OwnerToVisit) => {},
      })),
      now: () => 0,
    });
    r.handle(INIT);
    const reviewed = (y0: number, session = 1) =>
      r.handleReviewed({
        type: 'reviewed',
        session,
        candidates: Float32Array.from(candidate(y0, 0)),
      });
    const result: VisitToOwner = { type: 'result', session: 1, bytes: Uint8Array.of(0), ms: 1 };
    return { r, log, toMain, reviewed, result };
  }

  it('adds them at once when it visits tiles itself, and counts them in its status', () => {
    const t = setup(0);
    t.reviewed(11);
    expect(t.log).toEqual(['add 11']);
    t.reviewed(12, 2); // another session
    expect(t.log).toEqual(['add 11']);
    t.r.handle(FRAMES);
    const status = t.toMain.at(-1);
    expect(status?.type === 'status' && status.status.counters.reviewAdds).toBe(5);
  });

  it('waits for the visits out and hands out no new one meanwhile', () => {
    const t = setup(2);
    t.r.handle(FRAMES);
    expect(t.log).toEqual(['take', 'take']);
    t.reviewed(11);
    t.reviewed(12);
    expect(t.log).toEqual(['take', 'take']);
    // The first result frees a worker, which stays idle: a visit is still out.
    t.r.handleVisit(0, t.result);
    expect(t.log).toEqual(['take', 'take', 'apply']);
    // The last one back: the cells go in, then visits go out again.
    t.r.handleVisit(1, t.result);
    expect(t.log).toEqual(['take', 'take', 'apply', 'apply', 'add 11', 'add 12', 'take', 'take']);
  });

  it('adds them at once with idle visit workers, and not after the end', () => {
    const t = setup(2);
    t.reviewed(11);
    expect(t.log).toEqual(['add 11', 'take', 'take']);
    t.r.handleVisit(0, t.result);
    t.r.handleVisit(1, t.result);
    t.r.handle({ type: 'end', session: 1 });
    const before = t.log.length;
    t.reviewed(12);
    expect(t.log.length).toBe(before);
  });
});

describe('review store and readout', () => {
  const status = (s: Partial<ReviewStatus>): ReviewStatus => ({
    reviews: 0,
    skipped: 0,
    candidates: 0,
    running: false,
    windows: 0,
    seconds: 0,
    factorBytes: 0,
    heapBytes: 0,
    ...s,
  });

  it('reads the URL switch', () => {
    expect(reviewEvery(null)).toBeNull();
    expect(reviewEvery('')).toBe(REVIEW_EVERY_WINDOWS);
    expect(reviewEvery('3')).toBe(3);
    expect(reviewEvery('0')).toBe(REVIEW_EVERY_WINDOWS);
    expect(reviewEvery('x')).toBe(REVIEW_EVERY_WINDOWS);
    expect(REVIEW_EVERY_WINDOWS).toBe(8);
  });

  it('passes the candidates of its session to the slow loop', () => {
    const applied: [number, number][] = [];
    const store = createReviewStore(8, (session, c) => applied.push([session, c.length]));
    store.reset(4);
    const candidates = Float32Array.from(candidate(1, 1));
    store.onMessage({ type: 'candidates', session: 3, version: 2, candidates });
    expect(applied).toEqual([]);
    store.onMessage({ type: 'candidates', session: 4, version: 2, candidates });
    expect(applied).toEqual([[4, 10]]);
    store.onMessage({ type: 'status', session: 3, status: status({ reviews: 9 }) });
    expect(store.status()).toBeNull();
    store.onMessage({ type: 'status', session: 4, status: status({ reviews: 1 }) });
    expect(store.status()?.reviews).toBe(1);
    store.onMessage({ type: 'error', session: -1, message: 'crashed' });
    expect(store.error()).toBe('History review: crashed');
    store.reset(5);
    expect(store.status()).toBeNull();
    expect(store.error()).toBeNull();
  });

  it('says what the reviews did', () => {
    expect(reviewReadout(null, 0, 8)).toBe('History review: every 8 windows, none yet');
    expect(reviewReadout(status({ running: true }), 0, 8)).toBe(
      'History review: first review · reviewing',
    );
    expect(reviewReadout(status({ reviews: 1, candidates: 1, seconds: 12.34 }), 1, 8)).toBe(
      'History review: 1 review · 1 candidate · 1 cell added · last 12.3 s',
    );
    expect(
      reviewReadout(
        status({ reviews: 3, candidates: 14, seconds: 38.2, skipped: 2, running: true }),
        6,
        8,
      ),
    ).toBe(
      'History review: 3 reviews · 14 candidates · 6 cells added · last 38.2 s · 2 skipped · reviewing',
    );
  });
});

describe('clients', () => {
  const fakeWorker = () => ({
    postMessage: vi.fn(),
    terminate: vi.fn(),
    onmessage: null,
    onerror: null,
  });

  it('hands the compress worker the port to the review worker', () => {
    const reviewWorker = fakeWorker();
    const got: ReviewToMain[] = [];
    const review = createReviewClient(
      (m) => got.push(m),
      () => reviewWorker,
    );
    const [connect, transfer] = reviewWorker.postMessage.mock.calls[0];
    expect(connect.type).toBe('connect');
    expect(transfer.length).toBe(1);
    expect(transfer[0]).toBe(connect.port);

    const compressWorker = fakeWorker();
    const frames = { connectCompress: vi.fn(() => Promise.resolve()) };
    createCompressClient(
      frames,
      () => {},
      () => compressWorker,
      { port: review.port, every: 8 },
    );
    const [msg, ports] = compressWorker.postMessage.mock.calls[0];
    expect(msg.review.port).toBe(review.port);
    expect(msg.review.every).toBe(8);
    expect(ports.length).toBe(2);
    expect(ports[1]).toBe(review.port);

    (reviewWorker.onerror as unknown as (e: { message: string }) => void)({ message: '' });
    expect(got).toEqual([{ type: 'error', session: -1, message: 'The review worker crashed.' }]);
    review.dispose();
    expect(reviewWorker.terminate).toHaveBeenCalled();
  });

  it('sends reviewed candidates to the slow worker', () => {
    const worker = fakeWorker();
    const slow = createSlowClient(
      { connectSlow: () => Promise.resolve() },
      () => {},
      () => worker,
    );
    const candidates = Float32Array.from(candidate(2, 3));
    slow.addReviewed(6, candidates);
    const [msg, transfer] = worker.postMessage.mock.calls.at(-1)!;
    expect(msg).toEqual({ type: 'reviewed', session: 6, candidates });
    expect(transfer).toEqual([candidates.buffer]);
    slow.dispose();
  });
});

describe('history review on real factors (WASM)', () => {
  const N = 96;
  const WINDOW = 200;
  const WINDOWS = 8;

  /** Uniform in (0, 1). */
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967296;
    };
  }

  /** A Gaussian soma (sigma 2.5 px, peak 1): frame pixels and values. */
  function soma(cy: number, cx: number): { pix: number[]; val: number[] } {
    const pix: number[] = [];
    const val: number[] = [];
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const r2 = (y - cy) ** 2 + (x - cx) ** 2;
        if (r2 <= 64) {
          pix.push(y * N + x);
          val.push(Math.exp(-r2 / 12.5));
        }
      }
    }
    return { pix, val };
  }

  /** Calcium-like trace: events at random times, decaying over about 8 frames. */
  function trace(next: () => number, frames: number, amp: number): Float32Array {
    const out = new Float32Array(frames);
    let level = 0;
    for (let t = 0; t < frames; t++) {
      if (next() < 0.02) level += amp;
      out[t] = level;
      level *= 0.88;
    }
    return out;
  }

  /** A footprint on a 17 x 17 canvas around `(cy, cx)`. */
  function addSoma(b: TraceLibraryBuilder, id: number, cy: number, cx: number): void {
    const values = new Float32Array(17 * 17);
    for (let y = 0; y < 17; y++) {
      for (let x = 0; x < 17; x++) {
        const r2 = (y - 8) ** 2 + (x - 8) ** 2;
        if (r2 <= 64) values[y * 17 + x] = Math.exp(-r2 / 12.5);
      }
    }
    b.addFootprint(id, cy - 8, cx - 8, 17, 17, values);
  }

  it('finds the cell the library lacks and the slow loop takes it', async () => {
    // Unit noise, a bright cell the library has and a dimmer one on a tile edge that it lacks.
    const next = rng(11);
    const frames = WINDOWS * WINDOW;
    const cells = [
      { ...soma(30, 30), c: trace(next, frames, 8) },
      { ...soma(60, 62), c: trace(next, frames, 4) },
    ];
    const sent: FastToCompress[] = [];
    const feed = new CompressFeed(
      { width: N, height: N, session: 1, tile: 64, window: WINDOW, quant: 64 },
      { postMessage: (m) => sent.push(m) },
    );
    const BATCH = 50;
    const buf = new Float32Array(BATCH * N * N);
    for (let s = 0; s < frames; s += BATCH) {
      for (let i = 0; i < buf.length; i += 2) {
        const r = Math.sqrt(-2 * Math.log(next()));
        const a = 2 * Math.PI * next();
        buf[i] = r * Math.cos(a);
        buf[i + 1] = r * Math.sin(a);
      }
      for (let k = 0; k < BATCH; k++) {
        for (const cell of cells) {
          const amp = cell.c[s + k];
          for (let j = 0; j < cell.pix.length; j++)
            buf[k * N * N + cell.pix[j]] += amp * cell.val[j];
        }
      }
      feed.push(buf, s, BATCH);
    }

    // Compress worker -> review worker -> slow loop, as in the app.
    const toMain: ReviewToMain[] = [];
    const review = new ReviewRunner({
      create: (w, h) => new HistoryReview(w, h),
      toMain: { postMessage: (m) => toMain.push(m) },
      yieldNow: () => Promise.resolve(),
    });
    const compress = new CompressRunner({
      store: memoryStore(),
      quantize: quantizeTiles,
      create: (quant) => new TileCompressor(quant),
      toMain: { postMessage: () => {} },
      review: { port: { postMessage: (m) => review.handle(m) }, every: WINDOWS },
      yieldNow: () => Promise.resolve(),
    });
    const builder = new TraceLibraryBuilder(N, N);
    addSoma(builder, 1, 30, 30);
    const lib = builder.buildUnfiltered();
    builder.free();
    const libBytes = lib.toBytes();
    lib.free();
    await compress.handle(sent[0]);
    await compress.handle({ type: 'library', session: 1, version: 1, bytes: libBytes });
    for (const m of sent.slice(1)) await compress.handle(m);
    await compress.idle();
    await review.idle();

    const status = toMain.findLast((m) => m.type === 'status');
    expect(status).toMatchObject({
      status: { reviews: 1, candidates: 1, windows: WINDOWS, running: false },
    });
    const found = toMain.find((m) => m.type === 'candidates');
    expect(found?.type).toBe('candidates');
    if (found?.type !== 'candidates') return;
    const c = found.candidates;
    expect(candidateCount(c)).toBe(1);
    // The footprint's peak is at the hidden cell.
    const [y0, x0, h, w] = c;
    let peak = 6;
    for (let i = 6; i < c.length; i++) if (c[i] > c[peak]) peak = i;
    expect(c[peak]).toBe(1);
    expect(Math.abs(y0 + Math.floor((peak - 6) / w) - 60)).toBeLessThanOrEqual(2);
    expect(Math.abs(x0 + ((peak - 6) % w) - 62)).toBeLessThanOrEqual(2);
    expect(c.length).toBe(6 + h * w);

    const fov = new Uint8Array(N * N).fill(1);
    const noise = new Float32Array(N * N).fill(1);
    const slow = new SlowLoop(N, N, fov, noise, 10, 0);
    try {
      expect(slow.addReviewed(c)).toBe(1);
      expect(slow.cellCount).toBe(1);
      expect(slow.stats()[16]).toBe(1);
      // The same spot again is taken.
      expect(slow.addReviewed(c)).toBe(0);
      expect(() => slow.addReviewed(c.subarray(0, c.length - 1))).toThrow(/malformed/);
      const out = slow.finalize();
      expect(out.ids().length).toBe(1);
      out.free();
    } finally {
      slow.free();
    }
  }, 120_000);
});
