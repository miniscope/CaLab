/**
 * Look-back worker (experimental; created only for Discover runs with
 * look-back on): re-reads the past frames the slow loop's scheduler asks
 * for from the recording, with a `FrameSource` of its own opened from the
 * same `File`s (Discover's sequential reader is never touched), and
 * preprocesses and solves them (`LookbackReader`). Requests and libraries
 * come from the slow worker over the port the main thread connects; what
 * Discover recorded (motion, flicker, the back half's state, the flat field)
 * comes from the main thread.
 *
 * Requests run on a chain of their own: a request may wait for rows the main
 * thread has not sent yet, which must not hold up those rows.
 */
import { initCalaWasm } from '../lib/cala-wasm.ts';
import { FrameSource } from '../lib/frame-source.ts';
import { LookbackReader, lookbackFrames, type LookbackSolved } from '../lib/lookback-reader.ts';
import { SettleReaders, type SettleReaderLike } from '../lib/settle-readers.ts';
import { LOOKBACK } from '../lib/slow-runner.ts';
import { StagePool } from '../lib/stage-pool.ts';
import type {
  LookbackSource,
  LookbackToMain,
  LookbackToSlow,
  MainToLookback,
  SlowToLookback,
} from './lookback-types.ts';

const workerScope = globalThis as unknown as {
  postMessage(msg: LookbackToMain): void;
  onmessage: ((e: MessageEvent<MainToLookback>) => void) | null;
};

/** The run being served. */
interface Run {
  session: number;
  ready: Promise<{ reader: LookbackReader; pool: StagePool }>;
  source: FrameSource | null;
  reader: LookbackReader | null;
  /** The recording as the main thread gave it (settle readers open their own). */
  files: LookbackSource;
  /** Settle readers for the Final settle, and the check mode (`begin`). */
  readers: number;
  check: boolean;
  /** The Final settle's readers while it runs. */
  settle: SettleReaders | null;
}

/** Chunks the settle readers prepare ahead of the request being served. */
const readerDepth = (readers: number) => readers + 1;

let slow: MessagePort | null = null;
let run: Run | null = null;
/** Main-thread messages, in order (a `begin` opens the recording first). */
let mainQueue: Promise<void> = Promise.resolve();
/** Requests, one after another. */
let requests: Promise<void> = Promise.resolve();

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function postSlow(msg: LookbackToSlow, transfer: Transferable[] = []): void {
  slow?.postMessage(msg, transfer);
}

function stop(): void {
  const r = run;
  run = null;
  if (!r) return;
  r.settle?.dispose();
  r.settle = null;
  r.reader?.dispose();
  r.source?.dispose();
}

function begin(msg: Extract<MainToLookback, { type: 'begin' }>): void {
  stop();
  // `ready` is set right below (it needs `r` to tell a stale open).
  const r = {
    session: msg.session,
    source: null,
    reader: null,
    files: msg.source,
    readers: Math.max(0, Math.floor(msg.readers ?? 0)),
    check: msg.check === true,
    settle: null,
  } as unknown as Run;
  r.ready = open(r, msg);
  r.ready.catch((err: unknown) => {
    if (run === r)
      workerScope.postMessage({
        type: 'error',
        session: r.session,
        message: `Look-back could not open the recording: ${messageOf(err)}`,
      });
  });
  run = r;
}

async function open(
  r: Run,
  msg: Extract<MainToLookback, { type: 'begin' }>,
): Promise<{
  reader: LookbackReader;
  pool: StagePool;
}> {
  await initCalaWasm();
  const src =
    'entries' in msg.source
      ? await FrameSource.open(msg.source.entries)
      : await FrameSource.openSessions(msg.source.sessions);
  if (run !== r) {
    src.dispose();
    throw new Error('look-back stopped');
  }
  r.source = src;
  r.reader = new LookbackReader(src, msg.prune ? { keepSessions: 2 } : {});
  // Two buffers (one answer being observed, one being served), and the settle readers' chunks ahead.
  const ahead = r.readers > 0 ? readerDepth(r.readers) : 0;
  const pool = new StagePool(2 + ahead, LOOKBACK.takeMax * src.info.width * src.info.height);
  return { reader: r.reader, pool };
}

/** Run `fn` on the reader of `session` once it is open (in message order). */
function withReader(session: number, fn: (reader: LookbackReader, pool: StagePool) => void): void {
  const r = run;
  if (!r || r.session !== session) return;
  r.ready.then(
    ({ reader, pool }) => {
      if (run === r) fn(reader, pool);
    },
    () => {},
  );
}

function handleMain(msg: MainToLookback): void {
  switch (msg.type) {
    case 'connect':
      slow?.close();
      slow = msg.port;
      slow.onmessage = (ev: MessageEvent<SlowToLookback>) => handleSlow(ev.data);
      return;
    case 'begin':
      begin(msg);
      return;
    case 'rows':
      withReader(msg.session, (reader) =>
        reader.pushRows(msg.start, msg.dy, msg.dx, msg.flags, msg.flickerOffset, msg.flickerGain),
      );
      return;
    case 'back-state':
      withReader(msg.session, (reader) => reader.setBackState(msg.state, msg.frame));
      return;
    case 'session':
      withReader(msg.session, (reader) => reader.setSession(msg.index, msg.transform));
      return;
    case 'flat':
      withReader(msg.session, (reader) => {
        reader.setFlatField(msg.map);
        run?.settle?.setFlat(msg.map, reader.flatField.seq);
      });
      return;
    case 'reset':
      if (run && msg.session >= run.session) stop();
      return;
  }
}

function handleSlow(msg: SlowToLookback): void {
  switch (msg.type) {
    case 'library':
      withReader(msg.session, (reader) => reader.setLibrary(msg.version, msg.bytes));
      return;
    case 'release':
      withReader(msg.session, (_, pool) => pool.release(msg.frames));
      return;
    case 'settle-plan':
      withReader(msg.session, (reader, pool) => void startSettle(msg, reader, pool));
      return;
    case 'settle-end':
      withReader(msg.session, () => {
        run?.settle?.stop();
        if (run) run.settle = null;
      });
      return;
    case 'request': {
      const r = run;
      // Not set up for this run (before its `begin`, or after a reset): say so now, never stay
      // silent (the slow worker would wait for the request's timeout).
      if (!r || r.session !== msg.session) {
        postSlow({
          type: 'error',
          session: msg.session,
          id: msg.id,
          message: 'look-back is not set up for this run',
        });
        return;
      }
      requests = requests.then(() => serve(r, msg));
      return;
    }
  }
}

/**
 * The Final settle starts: settle readers prepare its frames ahead
 * (`lib/settle-readers.ts`). Their front half is this worker's own (its
 * state), so they give the same bits.
 */
async function startSettle(
  msg: Extract<SlowToLookback, { type: 'settle-plan' }>,
  reader: LookbackReader,
  pool: StagePool,
): Promise<void> {
  const r = run;
  if (!r || r.readers === 0 || msg.frames.length < 2) return;
  r.settle?.dispose();
  r.settle = null;
  const plan = lookbackPlan(msg.frames);
  let front: Uint8Array;
  try {
    front = await reader.frontState(plan[0].frame);
  } catch {
    return; // Look-back stopped: the settle is served here, if at all.
  }
  if (run !== r) return;
  r.settle = new SettleReaders(
    {
      makeReader: () =>
        new Worker(new URL('./settle-reader-worker.ts', import.meta.url), {
          type: 'module',
        }) as unknown as SettleReaderLike,
      acquire: () => pool.acquire(),
      release: (buf) => pool.release(buf),
      forget: () => pool.forget(),
      job: (frames) => reader.readerJob(frames),
    },
    plan,
    {
      count: r.readers,
      depth: readerDepth(r.readers),
      chunk: msg.chunk,
      source: r.files,
      front,
      flat: reader.flatField,
    },
  );
}

/** A settle plan (`[frame, block, ...]`) as frames. */
function lookbackPlan(flat: Float64Array): { frame: number; block: number }[] {
  const out: { frame: number; block: number }[] = [];
  for (let k = 0; k + 1 < flat.length; k += 2) out.push({ frame: flat[k], block: flat[k + 1] });
  return out;
}

/**
 * A Final-settle request whose frames a settle reader prepared: the back
 * half and the solve here, as `LookbackReader.serve` does them (the library
 * applied first, the frames in order). Null: not prepared, serve it the old way.
 */
async function serveReady(
  r: Run,
  reader: LookbackReader,
  frames: { frame: number; block: number }[],
): Promise<
  | { out: Float32Array; solved: LookbackSolved }
  | { out: null; readers: number[] }
  | null
> {
  const settle = r.settle;
  if (!settle) return null;
  const t0 = performance.now();
  // The library in hand when the request came, as `serve` applies it before its first await.
  reader.applyLibraryNow();
  const got = await settle.take(frames);
  const timing = { readers: settle.drainBusy() };
  // Not prepared: served the old way, with the library applied above (none newer).
  if (!got) return { out: null, readers: timing.readers };
  const t1 = performance.now();
  const out = got.buf;
  const px = reader.pixels;
  // A flat field newer than the one the reader used: these frames are prepared again here.
  const redo = got.flatSeq !== reader.flatField.seq;
  let checked = 0;
  let mismatched = 0;
  const scratch = r.check && !redo ? new Float32Array(px) : null;
  for (let i = 0; i < frames.length; i++) {
    const y = out.subarray(i * px, (i + 1) * px);
    if (redo) await reader.prepareHere(frames[i].frame, y);
    else if (scratch) {
      await reader.prepareHere(frames[i].frame, scratch);
      const a = new Uint32Array(scratch.buffer);
      const b = new Uint32Array(y.buffer, y.byteOffset, px);
      checked++;
      for (let k = 0; k < px; k++)
        if (a[k] !== b[k]) {
          mismatched++;
          break;
        }
    }
    await reader.backOnly(frames[i].frame, frames[i].block, y);
  }
  const solved = reader.solveDone(frames.length, out, t0, t1 - t0);
  Object.assign(solved.timing, timing, {
    readerFrames: redo ? 0 : frames.length,
    ...(r.check ? { checked, mismatched } : {}),
  });
  return { out, solved };
}

async function serve(r: Run, msg: Extract<SlowToLookback, { type: 'request' }>): Promise<void> {
  const { session, id } = msg;
  try {
    const { reader, pool } = await r.ready;
    const frames = lookbackFrames(msg.items);
    if (frames.length > LOOKBACK.takeMax)
      throw new Error(`look-back: ${frames.length} frames in one request`);
    const ready = msg.skip ? null : await serveReady(r, reader, frames);
    let out: Float32Array;
    let solved: LookbackSolved;
    if (ready?.out) ({ out, solved } = ready);
    else {
      out = await pool.acquire();
      try {
        solved = await reader.serve(frames, out, msg.skip, ready !== null);
      } catch (err) {
        pool.release(out);
        throw err;
      }
      if (ready && !ready.out) solved.timing.readers = ready.readers;
    }
    if (run !== r) return;
    const transfer: Transferable[] = [out.buffer, solved.traces.buffer];
    if (solved.background) transfer.push(solved.background.buffer);
    postSlow(
      {
        type: 'frames',
        session,
        id,
        version: solved.version,
        count: frames.length,
        cells: solved.cells,
        frames: out,
        traces: solved.traces,
        ...(solved.background ? { background: solved.background } : {}),
        timing: solved.timing,
      },
      transfer,
    );
  } catch (err) {
    if (run !== r) return;
    postSlow({ type: 'error', session, id, message: messageOf(err) });
  }
}

workerScope.onmessage = (e) => {
  const msg = e.data;
  mainQueue = mainQueue
    .then(() => handleMain(msg))
    .catch((err: unknown) => {
      if ('session' in msg)
        workerScope.postMessage({ type: 'error', session: msg.session, message: messageOf(err) });
    });
};
