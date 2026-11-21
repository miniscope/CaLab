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
import { LookbackReader, lookbackFrames } from '../lib/lookback-reader.ts';
import { LOOKBACK } from '../lib/slow-runner.ts';
import { StagePool } from '../lib/stage-pool.ts';
import type {
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
  r.reader?.dispose();
  r.source?.dispose();
}

function begin(msg: Extract<MainToLookback, { type: 'begin' }>): void {
  stop();
  // `ready` is set right below (it needs `r` to tell a stale open).
  const r = { session: msg.session, source: null, reader: null } as unknown as Run;
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
  r.reader = new LookbackReader(src);
  const pool = new StagePool(2, LOOKBACK.takeMax * src.info.width * src.info.height);
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
      withReader(msg.session, (reader) => reader.setBackState(msg.state));
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
    case 'library':
      withReader(msg.session, (reader) => reader.setLibrary(msg.version, msg.bytes));
      return;
    case 'release':
      withReader(msg.session, (_, pool) => pool.release(msg.frames));
      return;
    case 'request': {
      const r = run;
      requests = requests.then(() => serve(r, msg));
      return;
    }
  }
}

async function serve(
  r: Run | null,
  msg: Extract<SlowToLookback, { type: 'request' }>,
): Promise<void> {
  const { session, id } = msg;
  try {
    if (!r || r.session !== session) throw new Error('look-back is not set up for this run');
    const { reader, pool } = await r.ready;
    const frames = lookbackFrames(msg.items);
    if (frames.length > LOOKBACK.takeMax)
      throw new Error(`look-back: ${frames.length} frames in one request`);
    const out = await pool.acquire();
    let solved;
    try {
      solved = await reader.serve(frames, out, msg.skip);
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
