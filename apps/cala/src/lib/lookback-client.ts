/**
 * Main-thread side of look-back (see `lookback-reader.ts` and
 * `SlowRunner`): starts the look-back worker on the first Discover run with
 * look-back on, wires a `MessageChannel` between it and the slow worker,
 * and feeds it what Discover records as it goes (motion and flicker rows,
 * the back half's state from stage C, the newest flat-field map). The
 * pipeline store calls it (`createPipelineStore`'s `lookback`).
 *
 * Look-back pool (`pool` = S, from the core count, `settlePoolSize`): S more
 * look-back workers, each with its own channel to the slow worker (index 0
 * need-driven look-back and the end settle, 1..S the settle's chunks). They
 * start only when a run first goes below Max (`startPool`, possibly mid-run;
 * a run at Max never starts them) and then get their own copy of everything
 * above: what the run recorded so far (`begin`, every row, the newest flat
 * field) at once, the back half's state from its next snapshot. Only after
 * that snapshot does the slow worker hear of them (`settlePool`), so no
 * request reaches a worker that cannot serve it; it sends them its current
 * library then. A run's `reset` ends them (worker 0 stays until `release`), so a
 * run at Max after a paced one holds no pool workers.
 *
 * A run at Max (or one whose pool never started) gets the pool at Discover's
 * end when its Final settle reads the recording's factors
 * (`startFactorPool`): those workers open the factors, need nothing Discover
 * recorded, and are announced to the slow worker at once.
 */
import type { FlatFieldMap } from './flat-field.ts';
import type { BackStateSnapshot } from './pipeline-types.ts';
import type { SessionTransform } from './session-boundary.ts';
import type { SlowClient } from './slow-client.ts';
import type {
  FactorSource,
  LookbackSource,
  LookbackToMain,
  MainToLookback,
} from '../workers/lookback-types.ts';

/** What the pipeline store feeds look-back (all per Discover `session`). */
export interface LookbackFeed {
  /** Why look-back cannot run on the open recording (null: it can). */
  blocked(): string | null;
  /** A Discover run with look-back starts; false: it cannot (nothing was started). */
  begin(session: number): boolean;
  /**
   * A live stream with `?factors` ends and its factors are ready: start
   * look-back worker 0 on them (no pool, nothing recorded is fed).
   */
  beginFactors?(session: number, factors: FactorSource['factors']): void;
  /** Discover recorded frames `start..start + dy.length` (the arrays are copied). */
  rows(
    session: number,
    start: number,
    dy: ArrayLike<number>,
    dx: ArrayLike<number>,
    flags: ArrayLike<number>,
    flickerOffset: ArrayLike<number>,
    flickerGain: ArrayLike<number>,
  ): void;
  /** Stage C's back-half state (transferred on). */
  backState(session: number, snap: BackStateSnapshot): void;
  flatField(session: number, map: FlatFieldMap | null): void;
  /** The run's resolved params (`run-params.ts`), once the pipeline has them. */
  params(session: number, params: string): void;
  /**
   * A Joint run: Discover re-registered session `index` by `transform`
   * (`RunRecord.noteSession`). Call it before that batch's `rows`.
   */
  session?(session: number, index: number, transform: SessionTransform): void;
  /**
   * Discover ended and what was fed above is final: its last back state
   * went out, and the flat field's last map. The end settle reads nothing
   * before it (worker 0; `MainToLookback` `final`).
   */
  final?(session: number): void;
  /** The run stopped. */
  reset(session: number): void;
  /** The pacer's target live fps (0: Max) and pause, for the settle governor (`SlowRunner.setPace`). */
  pace?(fps: number, paused: boolean): void;
  /** The settle's cap, re-read frames per live frame (0 = Off; `SlowRunner.setCap`), during a run too. */
  cap?(cap: number): void;
  /**
   * `session`'s run went below Max: start the settle pool for it (once per
   * run; nothing when the pool size is 0). Returns the pool workers in the run.
   */
  startPool?(session: number): number;
  /**
   * `session`'s Discover ended and its Final settle reads the recording's factors: start the
   * settle pool for that settle if it is not running (a run at Max, or one whose Background
   * settle was off). Its workers open the factors themselves, need nothing Discover recorded,
   * and are announced to the slow worker at once. Returns the pool workers in the run.
   */
  startFactorPool?(session: number, factors: FactorSource['factors']): number;
  /**
   * `session`'s final library is out: end its pool workers (they serve the settles only, and
   * Extract never uses them), so they hold no memory while Extract runs. The slow worker hears
   * of it (`settlePool` with 0 workers). Returns the workers ended.
   */
  endPool?(session: number): number;
  /**
   * End every look-back worker (worker 0 too), so they hold no memory while nothing reads
   * the recording again; the next run starts and wires them anew. Released with the slow
   * worker (`SlowClient.release`), which holds their ports.
   */
  release?(): void;
  /** The settle pool's size S on this machine (started or not). */
  readonly poolSize?: number;
}

/** The subset of `Worker` the client uses (so tests can pass a fake). */
export type LookbackWorkerLike = Pick<
  Worker,
  'postMessage' | 'terminate' | 'onmessage' | 'onerror'
>;

/** What the look-back client is built from. */
export interface LookbackClientOptions {
  slow: Pick<SlowClient, 'connectLookback'> &
    Partial<Pick<SlowClient, 'settlePace' | 'settleCap' | 'settlePool'>>;
  /** The settle pool's size S: look-back workers besides worker 0 (default 0; `settlePoolSize`). */
  pool?: number;
  /** The open recording's files (null: none, or a live source). */
  source: () => LookbackSource | null;
  /** Why look-back cannot run besides the source (e.g. a live stream; null: it can). */
  blocked: () => string | null;
  /** A look-back worker error (worker 0: it stops look-back for the run; a pool worker: that worker only; Discover goes on). */
  onError?: (session: number, message: string, worker: number) => void;
  makeWorker?: () => LookbackWorkerLike;
  makeChannel?: () => { port1: MessagePort; port2: MessagePort };
}

/** One `rows` call, kept for a pool worker that joins mid-run. */
interface RowsChunk {
  start: number;
  dy: Float32Array;
  dx: Float32Array;
  flags: Uint8Array;
  flickerOffset: Float32Array;
  flickerGain: Float32Array;
}

/** Contiguous chunks joined into one (`rows` sends them in order from frame 0). */
function joinRows(chunks: RowsChunk[]): RowsChunk[] {
  const out: RowsChunk[] = [];
  let i = 0;
  while (i < chunks.length) {
    let j = i + 1;
    let end = chunks[i].start + chunks[i].dy.length;
    while (j < chunks.length && chunks[j].start === end) end += chunks[j++].dy.length;
    const part = chunks.slice(i, j);
    const join = <A extends Float32Array | Uint8Array>(
      make: new (n: number) => A,
      key: Exclude<keyof RowsChunk, 'start'>,
    ): A => {
      const a = new make(end - chunks[i].start);
      let at = 0;
      for (const c of part) {
        a.set(c[key] as unknown as ArrayLike<number>, at);
        at += c.dy.length;
      }
      return a;
    };
    out.push({
      start: chunks[i].start,
      dy: join(Float32Array, 'dy'),
      dx: join(Float32Array, 'dx'),
      flags: join(Uint8Array, 'flags'),
      flickerOffset: join(Float32Array, 'flickerOffset'),
      flickerGain: join(Float32Array, 'flickerGain'),
    });
    i = j;
  }
  return out;
}

/** Create the look-back client (worker 0 and `o.pool` settle-pool workers), wired to `o.slow`. */
export function createLookbackClient(o: LookbackClientOptions): LookbackFeed & {
  dispose(): void;
} {
  const poolSize = Math.max(0, Math.floor(o.pool ?? 0));
  let workers: LookbackWorkerLike[] = [];
  /**
   * The run look-back serves now: the workers in it (worker 0, then the pool
   * once started), and what it recorded so far, for a pool worker that joins late.
   */
  let run: {
    session: number;
    active: number;
    source: LookbackSource | FactorSource;
    rows: RowsChunk[];
    flat: FlatFieldMap | null | undefined;
    /** The run's resolved params (undefined: not sent yet). */
    params: string | undefined;
    /** Session re-registrations so far (a Joint run), in order. */
    sessions: { index: number; transform: SessionTransform }[];
    /**
     * The newest back state (a copy), while the pool may still start: a pool
     * started between one session's last snapshot and the next session's first
     * gets it, so it can serve the session the slow worker may still ask for.
     */
    newest: { frame: number; state: Uint8Array } | null;
    /** Pool workers started but not yet announced to the slow worker (they wait for a back state). */
    joining: number;
  } | null = null;
  /** The same message to every worker in the run; `copy(i)` gives worker `i` its own payload and transfer list. */
  function postAll(copy: (i: number) => [MainToLookback, Transferable[]]): void {
    const n = run ? Math.min(run.active, workers.length) : workers.length;
    for (let i = 0; i < n; i++) {
      const [msg, transfer] = copy(i);
      workers[i].postMessage(msg, transfer);
    }
  }

  /**
   * At least `count` workers, each wired to the slow worker by its index (which starts the slow
   * worker if it was released).
   */
  function ensureWorkers(count: number): void {
    for (let i = workers.length; i < count; i++) {
      const w =
        o.makeWorker?.() ??
        new Worker(new URL('../workers/lookback-worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<LookbackToMain>) =>
        o.onError?.(e.data.session, e.data.message, i);
      w.onerror = (e) => o.onError?.(-1, e.message || `Look-back worker ${i} crashed.`, i);
      const ch = o.makeChannel?.() ?? new MessageChannel();
      w.postMessage({ type: 'connect', port: ch.port2 } satisfies MainToLookback, [ch.port2]);
      o.slow.connectLookback(ch.port1, i);
      workers.push(w);
    }
  }

  function release(): void {
    for (const w of workers) w.terminate();
    workers = [];
    run = null;
  }

  return {
    blocked() {
      return o.blocked() ?? (o.source() ? null : 'Open a recording on disk first.');
    },
    begin(session) {
      const source = o.source();
      if (!source || o.blocked() !== null) return false;
      ensureWorkers(1);
      run = {
        session,
        active: 1,
        source,
        rows: [],
        flat: undefined,
        params: undefined,
        sessions: [],
        newest: null,
        joining: 0,
      };
      postAll(() => [{ type: 'begin', session, source }, []]);
      return true;
    },
    beginFactors(session, factors) {
      ensureWorkers(1);
      run = {
        session,
        active: 1,
        source: { factors },
        rows: [],
        flat: undefined,
        params: undefined,
        sessions: [],
        newest: null,
        joining: 0,
      };
      workers[0].postMessage({
        type: 'begin',
        session,
        source: { factors },
      } satisfies MainToLookback);
    },
    rows(session, start, dy, dx, flags, flickerOffset, flickerGain) {
      // Kept for a pool worker that joins later (a few bytes a frame), while the pool may still start.
      if (run?.session === session && run.active === 1 && poolSize > 0)
        run.rows.push({
          start,
          dy: Float32Array.from(dy),
          dx: Float32Array.from(dx),
          flags: Uint8Array.from(flags),
          flickerOffset: Float32Array.from(flickerOffset),
          flickerGain: Float32Array.from(flickerGain),
        });
      // Copies per worker (each is transferred).
      postAll(() => {
        const arrays = {
          dy: Float32Array.from(dy),
          dx: Float32Array.from(dx),
          flags: Uint8Array.from(flags),
          flickerOffset: Float32Array.from(flickerOffset),
          flickerGain: Float32Array.from(flickerGain),
        };
        return [
          { type: 'rows', session, start, ...arrays },
          Object.values(arrays).map((a) => a.buffer),
        ];
      });
    },
    backState(session, snap) {
      // Kept for a pool that starts later (one copy, the newest only).
      if (run?.session === session && run.active === 1 && poolSize > 0)
        run.newest = { frame: snap.frame, state: snap.state.slice() };
      // The snapshot's own buffer goes to the last worker; the others get copies.
      postAll((i) => {
        const last = (run ? Math.min(run.active, workers.length) : workers.length) - 1;
        const state = i === last ? snap.state : snap.state.slice();
        return [
          { type: 'back-state', session, frame: snap.frame, state },
          [state.buffer as ArrayBuffer],
        ];
      });
      // A pool started since the last snapshot has the back state now: it can serve.
      if (run?.session === session && run.joining > 0) {
        o.slow.settlePool?.(session, run.joining);
        run.joining = 0;
      }
    },
    params(session, params) {
      if (run?.session === session) run.params = params;
      postAll(() => [{ type: 'params', session, params }, []]);
    },
    flatField(session, map) {
      if (run?.session === session) run.flat = map;
      // Copied (the pipeline store keeps its map).
      postAll(() => [{ type: 'flat', session, map }, []]);
    },
    session(session, index, transform) {
      const t: SessionTransform = [transform[0], transform[1], transform[2]];
      if (run?.session === session) run.sessions.push({ index, transform: t });
      postAll(() => [{ type: 'session', session, index, transform: t }, []]);
    },
    final(session) {
      // Only worker 0 reads what Discover recorded in the Final settle; pool workers serve it
      // only on the factors, which need nothing from Discover.
      if (run?.session === session)
        workers[0]?.postMessage({ type: 'final', session } satisfies MainToLookback);
    },
    reset(session) {
      // A late reset of an earlier run (a stream's factor settle released after the next run
      // began) leaves the current run alone; worker 0 ignores a reset older than its run.
      if (run && run.session > session) {
        workers[0]?.postMessage({ type: 'reset', session } satisfies MainToLookback);
        return;
      }
      // The rows kept for a late pool go with the run.
      run = null;
      workers[0]?.postMessage({ type: 'reset', session } satisfies MainToLookback);
      // The pool ends with the run (its workers hold a reader, a frame pool and a library each):
      // a later run at Max holds none, and a later paced run starts fresh ones.
      for (const w of workers.slice(1)) w.terminate();
      workers = workers.slice(0, 1);
    },
    pace(fps, paused) {
      o.slow.settlePace?.(fps, paused);
    },
    cap(cap) {
      o.slow.settleCap?.(cap);
    },
    startPool(session) {
      const r = run;
      if (!r || r.session !== session) return 0;
      if ('factors' in r.source) return 0;
      if (r.active > 1 || poolSize === 0) return r.active - 1;
      ensureWorkers(1 + poolSize);
      const rows = joinRows(r.rows);
      r.rows = [];
      for (let i = 1; i <= poolSize; i++) {
        const w = workers[i];
        // A pool worker serves the settle during Discover only: it keeps the newest sessions' states.
        w.postMessage({
          type: 'begin',
          session,
          source: r.source,
          prune: true,
        } satisfies MainToLookback);
        if (r.params !== undefined)
          w.postMessage({ type: 'params', session, params: r.params } satisfies MainToLookback);
        // The session warps before the rows (a frame is never served without its own).
        for (const st of r.sessions)
          w.postMessage({ type: 'session', session, ...st } satisfies MainToLookback);
        for (const c of rows) {
          // The last worker takes the joined arrays; the others get copies.
          const a = i === poolSize ? c : joinRows([c])[0];
          w.postMessage({ type: 'rows', session, ...a } satisfies MainToLookback, [
            a.dy.buffer,
            a.dx.buffer,
            a.flags.buffer,
            a.flickerOffset.buffer,
            a.flickerGain.buffer,
          ]);
        }
        if (r.flat !== undefined)
          w.postMessage({ type: 'flat', session, map: r.flat } satisfies MainToLookback);
        // The newest back state so far (its session may still be asked for after the next one starts).
        const st = r.newest;
        if (st) {
          const state = i === poolSize ? st.state : st.state.slice();
          w.postMessage(
            { type: 'back-state', session, frame: st.frame, state } satisfies MainToLookback,
            [state.buffer as ArrayBuffer],
          );
        }
      }
      r.newest = null;
      r.active = 1 + poolSize;
      // Announced at the next back state (`backState`), when they can serve.
      r.joining = poolSize;
      return poolSize;
    },
    startFactorPool(session, factors) {
      const r = run;
      if (!r || r.session !== session) return 0;
      if ('factors' in r.source) return 0;
      if (r.active > 1 || poolSize === 0) return r.active - 1;
      ensureWorkers(1 + poolSize);
      // Nothing recorded is needed now: the rows kept for a late pool go.
      r.rows = [];
      r.newest = null;
      for (let i = 1; i <= poolSize; i++)
        workers[i].postMessage({
          type: 'begin',
          session,
          source: { factors },
          prune: true,
        } satisfies MainToLookback);
      r.active = 1 + poolSize;
      r.joining = 0;
      // On the factors from their begin: they serve at once (no back state to wait for). The slow
      // worker sends them the factors too (as to every pool worker) and its library.
      o.slow.settlePool?.(session, poolSize);
      return poolSize;
    },
    endPool(session) {
      const r = run;
      if (!r || r.session !== session || r.active <= 1) return 0;
      const n = r.active - 1;
      for (const w of workers.slice(1)) w.terminate();
      workers = workers.slice(0, 1);
      r.active = 1;
      r.joining = 0;
      o.slow.settlePool?.(session, 0);
      return n;
    },
    poolSize,
    release,
    dispose: release,
  };
}
