/**
 * The look-back worker's message handling (`workers/lookback-worker.ts` is
 * its thin shell): one run at a time, the main thread's messages in order,
 * and the slow worker's requests one after another on a chain of their own
 * (a request may wait for rows the main thread has not sent yet, which must
 * not hold up those rows). Pure apart from the frame servers it is given, so
 * it is unit-tested with fakes and scripted ports.
 *
 * Requests are served by the run's frame server (`ServerSlot`): the
 * recording's `LookbackReader`, or a `FactorReader` on a run's factors (a
 * live stream's from its `begin`, or a recording's after `factors`, which
 * swaps the server on the request chain, so a request still out finishes on
 * the recording first).
 *
 * The end settle on the recording (requests with `final`, worker 0) adds two
 * things:
 *
 *  - **Final inputs.** It reads nothing before the main thread says the
 *    inputs are final (`final`: Discover's last back state and the flat
 *    field's last map are in). Otherwise the first settle blocks would start
 *    from whichever state had arrived, which depends on machine speed. A
 *    request served from factors never waits: the factors hold the frames
 *    Discover itself preprocessed, so back state and flat field play no part.
 *  - **Prepare ahead, solve on cue.** A `hold` request is read and
 *    preprocessed at once, then waits for its `solve` (or `drop`). The slow
 *    worker sends `solve` at the point an unheld request would go, so the
 *    library a request is solved with is the newest that arrived before the
 *    `solve`, while the reading and preprocessing overlap with the slow
 *    worker's work on the preceding answer. (The slow worker
 *    holds only recording requests; were a factor server's request held, it
 *    would wait for its cue and then be served whole, with the same library.)
 */
import { lookbackFrames, type LookbackPrepared, type LookbackSolved } from './lookback-reader.ts';
import type { FrameServer } from './factor-reader.ts';
import type { FlatFieldMap } from './flat-field.ts';
import type { SessionTransform } from './session-boundary.ts';
import { ServerSlot } from './server-slot.ts';
import { LOOKBACK } from './slow-runner.ts';
import type {
  FactorSource,
  LookbackToMain,
  LookbackToSlow,
  MainToLookback,
  SlowToLookback,
} from '../workers/lookback-types.ts';
import { errMsg } from './errors.ts';

/** What the service needs of `LookbackReader` (a frame server that also splits `serve`). */
export interface LookbackReaderLike extends FrameServer {
  pushRows(
    start: number,
    dy: ArrayLike<number>,
    dx: ArrayLike<number>,
    flags: ArrayLike<number>,
    offset: ArrayLike<number>,
    gain: ArrayLike<number>,
  ): void;
  setBackState(state: Uint8Array, frame?: number): void;
  setSession(index: number, transform: SessionTransform): void;
  setFlatField(map: FlatFieldMap | null): void;
  /** The run's resolved params (`run-params.ts`): its motion corrector and trace engine follow them. */
  setParams(params: string): void;
  applyLibrary(upTo?: number): void;
  prepare(frames: { frame: number; block: number }[], out: Float32Array): Promise<LookbackPrepared>;
  solve(p: LookbackPrepared, skip?: ArrayLike<number>): LookbackSolved;
}

/** What the service needs of `StagePool`. */
export interface FramePoolLike {
  acquire(): Promise<Float32Array>;
  release(buf: Float32Array): void;
}

export interface LookbackServiceDeps {
  /**
   * Open the source of a `begin`: its frame server, the recording's reader
   * (the same object; null on factors) and the frame-buffer pool.
   */
  open(msg: Extract<MainToLookback, { type: 'begin' }>): Promise<{
    server: FrameServer;
    reader: LookbackReaderLike | null;
    pool: FramePoolLike;
    dispose?: () => void;
  }>;
  /** A frame server on a run's factors (`factors` from the slow worker). */
  factorServer(f: FactorSource['factors']): FrameServer;
  /** The run's resolved params arrived (the factor servers' solvers are built from them). */
  params?(params: string): void;
  postSlow(msg: LookbackToSlow, transfer: Transferable[]): void;
  postMain(msg: LookbackToMain): void;
  now?: () => number;
}

/** A `hold` request's cue: solve it, or drop it unanswered. */
type Cue = 'solve' | 'drop';

interface Opened {
  slot: ServerSlot;
  reader: LookbackReaderLike | null;
  pool: FramePoolLike;
}

interface Run {
  session: number;
  ready: Promise<Opened>;
  dispose?: () => void;
  opened: Opened | null;
  /** Servers the slot replaced, disposed with the run. */
  retired: FrameServer[];
  stopped: boolean;
  /** The main thread said the inputs are final (`final`). */
  final: boolean;
  finalWaiters: (() => void)[];
  /** Cues that came before their request was waiting for one, and the waits. */
  cues: Map<number, Cue>;
  cueWaiters: Map<number, (c: Cue) => void>;
}

function messageOf(err: unknown): string {
  return errMsg(err);
}

export class LookbackService {
  private run: Run | null = null;
  /** Main-thread messages, in order (a `begin` opens the recording first). */
  private mainQueue: Promise<void> = Promise.resolve();
  /** Requests, one after another. */
  private requests: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly deps: LookbackServiceDeps) {
    this.now = deps.now ?? (() => performance.now());
  }

  /** A main-thread message (`connect` is the shell's). */
  handleMain(msg: Exclude<MainToLookback, { type: 'connect' }>): void {
    this.mainQueue = this.mainQueue
      .then(() => this.main(msg))
      .catch((err: unknown) => {
        this.deps.postMain({ type: 'error', session: msg.session, message: messageOf(err) });
      });
  }

  /** The requests and cues so far are done (tests). */
  idle(): Promise<void> {
    return Promise.all([this.mainQueue, this.requests]).then(() => {});
  }

  private main(msg: Exclude<MainToLookback, { type: 'connect' }>): void {
    switch (msg.type) {
      case 'begin':
        this.begin(msg);
        return;
      case 'rows':
        this.withReader(msg.session, (reader) =>
          reader.pushRows(msg.start, msg.dy, msg.dx, msg.flags, msg.flickerOffset, msg.flickerGain),
        );
        return;
      case 'back-state':
        this.withReader(msg.session, (reader) => reader.setBackState(msg.state, msg.frame));
        return;
      case 'session':
        this.withReader(msg.session, (reader) => reader.setSession(msg.index, msg.transform));
        return;
      case 'params':
        this.withRun(msg.session, (_, o) => {
          this.deps.params?.(msg.params);
          o.reader?.setParams(msg.params);
        });
        return;
      case 'flat':
        this.withReader(msg.session, (reader) => reader.setFlatField(msg.map));
        return;
      case 'final':
        // In order after the back states and maps before it (the same chain).
        this.withRun(msg.session, (r) => {
          r.final = true;
          for (const w of r.finalWaiters.splice(0)) w();
        });
        return;
      case 'reset':
        if (this.run && msg.session >= this.run.session) this.stop();
        return;
    }
  }

  /** A message from the slow worker. */
  handleSlow(msg: SlowToLookback): void {
    switch (msg.type) {
      case 'library':
        this.withRun(msg.session, (_, o) => o.slot.setLibrary(msg.version, msg.bytes));
        return;
      case 'factors': {
        const r = this.run;
        if (!r || r.session !== msg.session) return;
        // On the request chain: a request still out finishes on the recording first.
        this.requests = this.requests.then(async () => {
          const o = await r.ready.catch(() => null);
          if (this.run !== r || !o) return;
          r.retired.push(o.slot.swap(this.deps.factorServer(msg.factors)));
        });
        return;
      }
      case 'release':
        this.withRun(msg.session, (_, o) => o.pool.release(msg.frames));
        return;
      case 'solve':
      case 'drop': {
        // In order with the libraries (the same chain): a `solve` takes the newest that came
        // before it. No solve runs meanwhile (`solve` is synchronous), and preparing reads no library.
        const cue: Cue = msg.type;
        this.withRun(msg.session, (r, o) => {
          if (cue === 'solve' && o.reader && o.slot.server === o.reader) o.reader.applyLibrary();
          this.cue(r, msg.id, cue);
        });
        return;
      }
      case 'request': {
        const r = this.run;
        // Not set up for this run (before its `begin`, or after a reset): say so now, never stay
        // silent (the slow worker would wait for the request's timeout).
        if (!r || r.session !== msg.session) {
          this.deps.postSlow(
            {
              type: 'error',
              session: msg.session,
              id: msg.id,
              message: 'look-back is not set up for this run',
            },
            [],
          );
          return;
        }
        this.requests = this.requests.then(() => this.serve(r, msg));
        return;
      }
    }
  }

  private begin(msg: Extract<MainToLookback, { type: 'begin' }>): void {
    this.stop();
    const r: Run = {
      session: msg.session,
      ready: null as unknown as Run['ready'],
      opened: null,
      retired: [],
      stopped: false,
      final: false,
      finalWaiters: [],
      cues: new Map(),
      cueWaiters: new Map(),
    };
    r.ready = this.deps.open(msg).then((o) => {
      if (r.stopped) {
        o.server.dispose();
        o.dispose?.();
        throw new Error('look-back stopped');
      }
      r.dispose = o.dispose;
      r.opened = { slot: new ServerSlot(o.server), reader: o.reader, pool: o.pool };
      return r.opened;
    });
    const what = 'factors' in msg.source ? 'factors' : 'recording';
    r.ready.catch((err: unknown) => {
      if (this.run === r)
        this.deps.postMain({
          type: 'error',
          session: r.session,
          message: `Look-back could not open the ${what}: ${messageOf(err)}`,
        });
    });
    this.run = r;
  }

  private stop(): void {
    const r = this.run;
    this.run = null;
    if (!r) return;
    r.stopped = true;
    // Nothing of this run waits on: its chain must go on to the next run's requests.
    for (const w of r.finalWaiters.splice(0)) w();
    for (const w of r.cueWaiters.values()) w('drop');
    r.cueWaiters.clear();
    r.opened?.slot.server.dispose();
    for (const s of r.retired) s.dispose();
    r.dispose?.();
  }

  /** Run `fn` on the run of `session` once its source is open (in message order). */
  private withRun(session: number, fn: (r: Run, o: Opened) => void): void {
    const r = this.run;
    if (!r || r.session !== session) return;
    r.ready.then(
      (o) => {
        if (this.run === r) fn(r, o);
      },
      () => {},
    );
  }

  /** Run `fn` on the recording's reader of `session` (none on a live stream's factors). */
  private withReader(
    session: number,
    fn: (reader: LookbackReaderLike, pool: FramePoolLike) => void,
  ): void {
    this.withRun(session, (_, o) => {
      if (o.reader) fn(o.reader, o.pool);
    });
  }

  private cue(r: Run, id: number, cue: Cue): void {
    const w = r.cueWaiters.get(id);
    if (w) {
      r.cueWaiters.delete(id);
      w(cue);
    } else r.cues.set(id, cue);
  }

  private waitCue(r: Run, id: number): Promise<Cue> {
    const c = r.cues.get(id);
    if (c) {
      r.cues.delete(id);
      return Promise.resolve(c);
    }
    if (r.stopped) return Promise.resolve('drop');
    return new Promise((resolve) => r.cueWaiters.set(id, resolve));
  }

  private waitFinal(r: Run): Promise<void> {
    if (r.final || r.stopped) return Promise.resolve();
    return new Promise((resolve) => r.finalWaiters.push(resolve));
  }

  private async serve(r: Run, msg: Extract<SlowToLookback, { type: 'request' }>): Promise<void> {
    const { session, id } = msg;
    let out: Float32Array | null = null;
    let pool: FramePoolLike | null = null;
    try {
      const opened = await r.ready;
      pool = opened.pool;
      const frames = lookbackFrames(msg.items);
      if (frames.length > LOOKBACK.takeMax)
        throw new Error(`look-back: ${frames.length} frames in one request`);
      // The server at this request's turn (a `factors` swap before it is applied by now).
      const server = opened.slot.server;
      const reader = opened.reader && server === opened.reader ? opened.reader : null;
      let solved: LookbackSolved;
      let finalWaitMs = 0;
      if (reader) {
        // The final-inputs gate applies to the recording only (see the header).
        const final = msg.final === true;
        // Without `hold`, the libraries in hand when its turn comes are the ones it solves with
        // (as `serve`): before the wait for final inputs, which must not change that.
        if (final && !msg.hold) reader.applyLibrary();
        if (final) {
          const t0 = this.now();
          await this.waitFinal(r);
          finalWaitMs = this.now() - t0;
        }
        out = await pool.acquire();
        // (Any other request: the libraries in hand once it has a buffer, as `serve` does, up to
        // the version it names.)
        if (!final && !msg.hold) reader.applyLibrary(msg.version);
        let prepared: LookbackPrepared | null = null;
        let failed: unknown = null;
        try {
          prepared = await reader.prepare(frames, out);
        } catch (err) {
          failed = err;
        }
        // A held request answers (even its failure) only on its cue: the slow worker waits for it then.
        if (msg.hold && (await this.waitCue(r, id)) === 'drop') {
          pool.release(out);
          return;
        }
        if (failed !== null) throw failed;
        if (this.run !== r) {
          pool.release(out);
          return;
        }
        solved = reader.solve(prepared!, msg.skip);
      } else {
        // A factor server: nothing to prepare ahead; a held request is served whole on its cue.
        if (msg.hold && (await this.waitCue(r, id)) === 'drop') return;
        out = await pool.acquire();
        solved = await server.serve(frames, out, msg.skip);
        if (this.run !== r) {
          pool.release(out);
          return;
        }
      }
      const timing = finalWaitMs > 0 ? { ...solved.timing, finalWaitMs } : solved.timing;
      const transfer: Transferable[] = [out.buffer, solved.traces.buffer];
      if (solved.background) transfer.push(solved.background.buffer);
      this.deps.postSlow(
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
          timing,
        },
        transfer,
      );
    } catch (err) {
      if (out && pool) pool.release(out);
      if (this.run !== r) return;
      this.deps.postSlow({ type: 'error', session, id, message: messageOf(err) }, []);
    }
  }
}
