/**
 * The slow worker's side of the strip helpers (`?debug&obsstrips=N`; experimental, off by default):
 * hands out a batch's strip jobs, collects the deltas, adds them once the batch's frames are
 * observed, and holds back everything that would read or write the footprint statistics meanwhile
 * (visit results, look-back answers, review candidates), releasing it in arrival order after the
 * apply. A helper that failed has its job summed here instead (`SlowLoop.stripLocal`), so no
 * batch's statistics are lost. See `discover/strips.rs`.
 */
import type { PortLike } from '../workers/slow-types.ts';
import {
  STRIP_KEEP_VERSIONS,
  type OwnerToStrip,
  type StripToOwner,
} from '../workers/strip-types.ts';
import { stripJob, stripJobTransfer, type BatchFrames } from './strip-plan.ts';

/** What the strip helpers need of the WASM `SlowLoop`. */
export interface StripLoopLike {
  /** Frames observed so far (the next frame's slow-loop index). */
  readonly frames?: number;
  stripsBegin?(version: number, count: number, strips: number): Uint32Array;
  stripContext?(i: number): Uint8Array;
  stripsKeys?(): Float64Array;
  stripsAdd?(bytes: Uint8Array): void;
  stripsApply?(): void;
  stripLocal?(
    version: number,
    context: Uint8Array,
    frames: Float32Array,
    traces: Float32Array,
    cells: number,
    background: Float32Array | undefined,
    keys: Float64Array,
  ): Uint8Array;
  /** `[batches, applied, frames, strips, maxRows, cells, clusters, droppedCells, droppedClusters, clusterSkips]`. */
  stripStats?(): Float64Array;
}

/** Which duty a batch belongs to: Discover's live frames or the Final settle. */
export type StripKind = 'live' | 'end';

interface Pending {
  id: number;
  version: number;
  kind: StripKind;
  source: BatchFrames;
  fit: number[];
  keys: Float64Array;
  jobs: { row0: number; row1: number; context: Uint8Array }[];
  deltas: (Uint8Array | null)[];
  answered: number;
  done: (() => void) | null;
  t0: number;
}

/** Counters of the strip helpers (`SlowStatus.strips`). */
export interface StripCounters {
  helpers: number;
  /** Batches summed by the helpers, and observed the ordinary way (no fitting frame, no cells, a library a helper does not hold). */
  batches: number;
  ordinary: number;
  /** Jobs summed on the slow worker because a helper failed. */
  local: number;
  /** Bytes of the contexts and of the deltas, summed. */
  contextBytes: number;
  deltaBytes: number;
  /** The slow worker's ms beginning batches (upkeep, contexts, row copies, posting) and applying them. */
  beginMs: number;
  applyMs: number;
  /** Ms from a batch's last frame observed to its last delta back (the slow worker waits). */
  waitMs: number;
  /** The slow loop's own counters (`stripStats`): `[batches, applied, frames, strips, maxRows, cells, clusters, droppedCells, droppedClusters, clusterSkips]`. */
  loop?: number[];
}

export class StripHelpers {
  private session = -1;
  private versions: number[] = [];
  private pending: Pending | null = null;
  private nextId = 1;
  private held: (() => void)[] = [];
  /** Per helper, its ms on jobs: `[live, end]`. */
  busyMs: number[][];
  private c: Omit<StripCounters, 'helpers' | 'loop'> = StripHelpers.zero();
  private waitFrom = 0;

  constructor(
    private readonly ports: PortLike<OwnerToStrip>[],
    private readonly now: () => number,
  ) {
    this.busyMs = ports.map(() => [0, 0]);
  }

  private static zero(): Omit<StripCounters, 'helpers' | 'loop'> {
    return {
      batches: 0,
      ordinary: 0,
      local: 0,
      contextBytes: 0,
      deltaBytes: 0,
      beginMs: 0,
      applyMs: 0,
      waitMs: 0,
    };
  }

  get count(): number {
    return this.ports.length;
  }

  /** A batch waits for its deltas: whatever reads the statistics must be held (`hold`). */
  get waiting(): boolean {
    return this.pending !== null;
  }

  init(session: number, width: number, height: number, fov: Uint8Array): void {
    this.reset();
    this.session = session;
    for (const p of this.ports) p.postMessage({ type: 'init', session, width, height, fov });
  }

  /** The run is dropped: helpers forget it; a batch waiting is abandoned (its continuation runs, to unwind). */
  drop(session: number): void {
    const p = this.pending;
    this.reset();
    this.session = session;
    for (const port of this.ports) port.postMessage({ type: 'reset', session });
    p?.done?.();
  }

  private reset(): void {
    this.versions = [];
    this.pending = null;
    this.held = [];
    this.busyMs = this.ports.map(() => [0, 0]);
    this.c = StripHelpers.zero();
  }

  /** A newly published library, to every helper (a copy each). */
  library(version: number, bytes: Uint8Array): void {
    if (this.ports.length === 0) return;
    for (const p of this.ports) {
      const b = bytes.slice();
      p.postMessage({ type: 'library', session: this.session, version, bytes: b }, [
        b.buffer as ArrayBuffer,
      ]);
    }
    this.versions.push(version);
    while (this.versions.length > STRIP_KEEP_VERSIONS) this.versions.shift();
  }

  /**
   * Begin a strip batch of `src` (all solved with `version`): the slow loop's upkeep and contexts,
   * the jobs posted. `false`, nothing changed: observe the batch the ordinary way. On `true` the
   * caller observes the batch's frames, then calls `whenDone` and, from its callback, `apply`.
   */
  begin(loop: StripLoopLike, version: number, src: BatchFrames, kind: StripKind): boolean {
    if (this.ports.length === 0 || this.pending || !loop.stripsBegin) return false;
    // A library the helpers may not hold (the slow loop keeps its newest; a helper the 8 newest).
    if (!this.versions.includes(version) || loop.frames === undefined) {
      this.c.ordinary++;
      return false;
    }
    const t0 = this.now();
    const first = loop.frames;
    const rows = loop.stripsBegin(version, src.count, this.ports.length);
    if (rows.length === 0) {
      this.c.ordinary++;
      this.c.beginMs += this.now() - t0;
      return false;
    }
    const keys = loop.stripsKeys!();
    const fit = Array.from(keys, (k) => k - first);
    const id = this.nextId++;
    const jobs: Pending['jobs'] = [];
    for (let i = 0; i < rows.length / 2; i++) {
      const context = loop.stripContext!(i);
      const r = { row0: rows[2 * i], row1: rows[2 * i + 1] };
      jobs.push({ ...r, context });
      this.c.contextBytes += context.byteLength;
      const job = stripJob(src, fit, keys.slice(), r, {
        session: this.session,
        id,
        version,
        context,
      });
      this.ports[i].postMessage(job, stripJobTransfer(job));
    }
    this.pending = {
      id,
      version,
      kind,
      source: src,
      fit,
      keys,
      jobs,
      deltas: jobs.map(() => null),
      answered: 0,
      done: null,
      t0,
    };
    this.c.batches++;
    this.c.beginMs += this.now() - t0;
    return true;
  }

  /** Call `fn` once every job of the batch answered (now, if they all have). */
  whenDone(fn: () => void): void {
    const p = this.pending;
    if (!p) {
      fn();
      return;
    }
    this.waitFrom = this.now();
    if (p.answered === p.jobs.length) fn();
    else p.done = fn;
  }

  /** A message from helper `i`. */
  handle(i: number, msg: StripToOwner): void {
    const p = this.pending;
    if (msg.session !== this.session || !p || msg.id !== p.id || i >= p.jobs.length) return;
    if (p.deltas[i] !== null) return;
    if (msg.type === 'delta') {
      p.deltas[i] = msg.bytes;
      this.c.deltaBytes += msg.bytes.byteLength;
      this.busyMs[i][p.kind === 'live' ? 0 : 1] += msg.ms;
    } else {
      // Summed here at the apply.
      p.deltas[i] = new Uint8Array(0);
    }
    p.answered++;
    if (p.answered === p.jobs.length && p.done) {
      const fn = p.done;
      p.done = null;
      this.c.waitMs += this.now() - this.waitFrom;
      fn();
    }
  }

  /** Add the batch's deltas (its frames all observed); a failed helper's job is summed here. */
  apply(loop: StripLoopLike): void {
    const p = this.pending;
    if (!p) return;
    const t0 = this.now();
    try {
      p.jobs.forEach((j, i) => {
        let bytes = p.deltas[i];
        if (!bytes || bytes.byteLength === 0) {
          const job = stripJob(p.source, p.fit, p.keys, j, {
            session: this.session,
            id: p.id,
            version: p.version,
            context: j.context,
          });
          bytes = loop.stripLocal!(
            p.version,
            j.context,
            job.frames,
            job.traces,
            job.cells,
            job.background,
            p.keys,
          );
          this.c.local++;
        }
        loop.stripsAdd!(bytes);
      });
      loop.stripsApply!();
    } finally {
      this.pending = null;
      this.c.applyMs += this.now() - t0;
    }
  }

  /** Run `fn` now, or after the batch waiting is applied (in arrival order). */
  hold(fn: () => void): boolean {
    if (!this.pending) return false;
    this.held.push(fn);
    return true;
  }

  /** Run what was held, in order, until a new batch waits again. */
  release(): void {
    while (!this.pending && this.held.length > 0) this.held.shift()!();
  }

  counters(loop: StripLoopLike | null): StripCounters {
    const s = loop?.stripStats?.();
    return { helpers: this.ports.length, ...this.c, ...(s ? { loop: Array.from(s) } : {}) };
  }
}
