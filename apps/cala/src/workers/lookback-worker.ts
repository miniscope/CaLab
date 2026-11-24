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
import { FactorReader, type FrameServer } from '../lib/factor-reader.ts';
import { FactorWindow, TraceEngine, TraceLibrary } from '../lib/cala-wasm.ts';
import { LookbackReader, lookbackFrames } from '../lib/lookback-reader.ts';
import { LOOKBACK } from '../lib/slow-runner.ts';
import { ServerSlot } from '../lib/server-slot.ts';
import { StagePool } from '../lib/stage-pool.ts';
import { factorFiles } from '../lib/window-store.ts';
import type {
  FactorSource,
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
  ready: Promise<{ server: FrameServer; pool: StagePool }>;
  source: FrameSource | null;
  /** The recording's reader (null for a factor run). */
  reader: LookbackReader | null;
  /** What serves requests: `reader`, or a `FactorReader`; switched to the factors by `factors`. */
  slot: ServerSlot | null;
  /** Servers the slot replaced, disposed with the run. */
  retired: FrameServer[];
}

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
  r.slot?.server.dispose();
  for (const s of r.retired) s.dispose();
  r.source?.dispose();
}

function begin(msg: Extract<MainToLookback, { type: 'begin' }>): void {
  stop();
  // `ready` is set right below (it needs `r` to tell a stale open).
  const r = {
    session: msg.session,
    source: null,
    reader: null,
    slot: null,
    retired: [],
  } as unknown as Run;
  r.ready = open(r, msg);
  r.ready.catch((err: unknown) => {
    if (run === r)
      workerScope.postMessage({
        type: 'error',
        session: r.session,
        message: `Look-back could not open the ${'factors' in msg.source ? 'factors' : 'recording'}: ${messageOf(err)}`,
      });
  });
  run = r;
}

/** A frame server on a run's factors (it reads only the windows the compress status listed). */
function factorServer(f: FactorSource['factors']): FactorReader {
  return new FactorReader(factorFiles(f.folder), f.windows, f.width * f.height, {
    open: (bytes) => FactorWindow.fromBytes(bytes),
    solver: (bytes) => {
      const lib = TraceLibrary.fromBytes(bytes);
      try {
        // 0, 0: the solver's default tolerance and sweep cap (as the fast loop's engine).
        const engine = new TraceEngine(lib, 0, 0);
        return {
          cells: lib.ids().length,
          processFrames: (y, n) => engine.processFrames(y, n),
          lastBackground: () => engine.lastBackground(),
          free: () => engine.free(),
        };
      } finally {
        lib.free();
      }
    },
  });
}

async function open(
  r: Run,
  msg: Extract<MainToLookback, { type: 'begin' }>,
): Promise<{
  server: FrameServer;
  pool: StagePool;
}> {
  await initCalaWasm();
  if ('factors' in msg.source) {
    const f = msg.source.factors;
    const server = factorServer(f);
    if (run !== r) {
      server.dispose();
      throw new Error('look-back stopped');
    }
    r.slot = new ServerSlot(server);
    return { server, pool: new StagePool(2, LOOKBACK.takeMax * f.width * f.height) };
  }
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
  r.slot = new ServerSlot(r.reader);
  const pool = new StagePool(2, LOOKBACK.takeMax * src.info.width * src.info.height);
  return { server: r.reader, pool };
}

/** Run `fn` on the reader of `session` once it is open (in message order). */
function withReader(session: number, fn: (reader: LookbackReader, pool: StagePool) => void): void {
  const r = run;
  if (!r || r.session !== session) return;
  r.ready.then(
    ({ pool }) => {
      if (run === r && r.reader) fn(r.reader, pool);
    },
    () => {},
  );
}

/** Run `fn` on the frame server of `session` (recording or factors) once it is open. */
function withServer(session: number, fn: (server: FrameServer, pool: StagePool) => void): void {
  const r = run;
  if (!r || r.session !== session) return;
  r.ready.then(
    ({ server, pool }) => {
      if (run === r) fn(server, pool);
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
      withReader(msg.session, (reader) => reader.setFlatField(msg.map));
      return;
    case 'reset':
      if (run && msg.session >= run.session) stop();
      return;
  }
}

function handleSlow(msg: SlowToLookback): void {
  switch (msg.type) {
    case 'library': {
      const r = run;
      if (!r || r.session !== msg.session) return;
      r.ready.then(
        () => {
          if (run === r) r.slot?.setLibrary(msg.version, msg.bytes);
        },
        () => {},
      );
      return;
    }
    case 'factors': {
      const r = run;
      if (!r || r.session !== msg.session) return;
      // On the request chain: a request still out finishes on the file first.
      requests = requests.then(async () => {
        await r.ready.catch(() => {});
        if (run !== r || !r.slot) return;
        r.retired.push(r.slot.swap(factorServer(msg.factors)));
      });
      return;
    }
    case 'release':
      withServer(msg.session, (_, pool) => pool.release(msg.frames));
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

async function serve(r: Run, msg: Extract<SlowToLookback, { type: 'request' }>): Promise<void> {
  const { session, id } = msg;
  try {
    const { pool } = await r.ready;
    const server = r.slot!.server;
    const frames = lookbackFrames(msg.items);
    if (frames.length > LOOKBACK.takeMax)
      throw new Error(`look-back: ${frames.length} frames in one request`);
    const out = await pool.acquire();
    let solved;
    try {
      solved = await server.serve(frames, out, msg.skip);
    } catch (err) {
      pool.release(out);
      throw err;
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
