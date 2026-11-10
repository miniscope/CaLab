/**
 * The slow loop (streaming cell discovery), inside its own worker: observes
 * every frame the fast worker forwards, returns the frame buffer, and
 * publishes each new library version to the fast worker (bytes) and to the
 * main thread (footprints for drawing).
 *
 * Tile visits (the expensive part) run either here, `budget` work units
 * after each observed frame, or, with visit workers, in parallel on those
 * workers: after every batch and every visit result the runner hands a
 * visit (`SlowLoop.takeJob`) to each idle worker and applies what comes back
 * (`applyJob`); the slow loop guarantees that visits out at the same time
 * never touch the same cells (see `discover/shard.rs`). This worker then
 * only observes, so it keeps up with the fast loop.
 *
 * Its stalls (a tile visit or a library rebuild can take 50-160 ms) only
 * delay this worker; the fast worker drops batches for it instead of waiting
 * (see `ForwardPool`).
 */
import type {
  CellStatusView,
  FastToSlow,
  LibraryView,
  OwnerToVisit,
  PortLike,
  SlowCounters,
  SlowInit,
  SlowStatus,
  SlowToFast,
  SlowToMain,
  VisitToOwner,
} from '../workers/slow-types.ts';
import { libraryViewTransferables } from '../workers/slow-types.ts';

/** What the runner needs of a published `TraceLibrary`. */
export interface PublishedLibrary {
  readonly version: number;
  ids(): Uint32Array;
  centers(): Float32Array;
  radii(): Float32Array;
  supportStarts(): Uint32Array;
  supportPixels(): Uint32Array;
  footprintValues(): Float32Array;
  toBytes(): Uint8Array;
  free(): void;
}

/** What the runner needs of the WASM `SlowLoop`. */
export interface SlowLoopLike {
  observe(frame: Float32Array, version: number, traces: Float32Array): boolean;
  step(budget: number): PublishedLibrary | undefined;
  finalize(): PublishedLibrary;
  setNoise(noise: Float32Array): void;
  /** Parallel visits (needed only with visit workers). */
  takeJob?(): Uint8Array | undefined;
  applyJob?(bytes: Uint8Array): void;
  housekeep?(): PublishedLibrary | undefined;
  readonly cellCount: number;
  readonly reservoirBytes: number;
  /** Work spent so far, about multiply-adds (absent in older fakes). */
  readonly work?: number;
  stats(): Float64Array;
  /** `(id, established, transients)` triples (absent in older fakes). */
  cellStatus?(): Float64Array;
  free(): void;
}

export interface SlowRunnerDeps {
  create(init: SlowInit): SlowLoopLike;
  toFast: PortLike<SlowToFast>;
  toMain: PortLike<SlowToMain>;
  /** Ports to the visit workers (none: visit tiles here). */
  visits?: PortLike<OwnerToVisit>[];
  now?: () => number;
}

function counters(s: ArrayLike<number>): SlowCounters {
  return {
    visits: s[0] ?? 0,
    proposals: s[1] ?? 0,
    adds: s[2] ?? 0,
    rejects: s[3] ?? 0,
    merges: s[4] ?? 0,
    mergeTests: s[5] ?? 0,
    refines: s[6] ?? 0,
    commits: s[7] ?? 0,
    deletes: s[8] ?? 0,
    splits: s[9] ?? 0,
    absorbs: s[10] ?? 0,
    newAdds: s[11] ?? 0,
    reAdds: s[12] ?? 0,
    churned: s[13] ?? 0,
    establishedRemovals: s[15] ?? 0,
  };
}

/** Wall time between cell-status updates to the main thread, ms. */
export const CELL_STATUS_EVERY_MS = 1000;

function cellStatusView(flat: ArrayLike<number>): CellStatusView {
  const n = Math.floor(flat.length / 3);
  const ids = new Uint32Array(n);
  const established = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    ids[i] = flat[3 * i];
    established[i] = flat[3 * i + 1] > 0 ? 1 : 0;
  }
  return { ids, established };
}

export class SlowRunner {
  private readonly deps: SlowRunnerDeps;
  private readonly now: () => number;
  private readonly visits: PortLike<OwnerToVisit>[];
  private session = -1;
  private loop: SlowLoopLike | null = null;
  private init: SlowInit | null = null;
  private frame = 0;
  private observed = 0;
  private skipped = 0;
  private version = 0;
  private final = false;
  private ending = false;
  private statusAt = -Infinity;
  /** Per visit worker: a visit is out. */
  private busy: boolean[];
  private jobs = 0;
  private visitMsSum = 0;
  private visitMsN = 0;
  private visitMs = 0;
  /** Wall time this worker spent handing out and applying visits, ms. */
  private jobOwnerMs = 0;

  constructor(deps: SlowRunnerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => performance.now());
    this.visits = deps.visits ?? [];
    this.busy = this.visits.map(() => false);
  }

  /** Tile visits run on visit workers. */
  private get parallel(): boolean {
    return this.visits.length > 0;
  }

  handle(msg: FastToSlow): void {
    if (msg.type === 'reset' || msg.type === 'init') {
      if (msg.session < this.session) return;
      this.drop();
      this.session = msg.session;
      // (An init replaces a visit worker's state too.)
      if (msg.type === 'reset')
        for (const v of this.visits) v.postMessage({ type: 'reset', session: msg.session });
      if (msg.type === 'init') {
        const { width, height, fov, noise, cellDiameterPx, flattenSigmaPx, budget } = msg;
        this.init = { width, height, fov, noise, cellDiameterPx, flattenSigmaPx, budget };
        this.loop = this.deps.create(this.init);
        for (const v of this.visits)
          v.postMessage({ type: 'init', session: msg.session, ...this.init });
      }
      return;
    }
    if (msg.session !== this.session) return;
    try {
      if (msg.type === 'frames') this.frames(msg);
      else if (msg.type === 'end') this.end();
    } catch (err) {
      this.fail(err);
    }
  }

  /** A message from visit worker `i`. */
  handleVisit(i: number, msg: VisitToOwner): void {
    if (msg.session !== this.session || !this.loop) return;
    try {
      if (msg.type === 'error') throw new Error(`visit worker ${i}: ${msg.message}`);
      this.busy[i] = false;
      const t0 = this.now();
      this.loop.applyJob!(msg.bytes);
      this.jobOwnerMs += this.now() - t0;
      this.jobs++;
      this.visitMsSum += msg.ms;
      this.visitMsN++;
      this.housekeep();
      if (this.ending) {
        if (!this.busy.some((b) => b)) this.finish();
      } else this.dispatch();
    } catch (err) {
      this.fail(err);
    }
  }

  private fail(err: unknown): void {
    this.deps.toMain.postMessage({
      type: 'error',
      session: this.session,
      message: err instanceof Error ? err.message : String(err),
    });
    this.drop();
  }

  private frames(msg: Extract<FastToSlow, { type: 'frames' }>): void {
    const loop = this.loop;
    const init = this.init;
    let observed = 0;
    let maxStep = 0;
    const t0 = this.now();
    try {
      if (loop && init) {
        if (msg.noise) {
          loop.setNoise(msg.noise);
          for (const v of this.visits)
            v.postMessage({ type: 'noise', session: this.session, noise: msg.noise });
        }
        const px = init.width * init.height;
        for (let i = 0; i < msg.count; i++) {
          const frame = msg.frames.subarray(i * px, (i + 1) * px);
          const traces = msg.traces.subarray(i * msg.cells, (i + 1) * msg.cells);
          if (!loop.observe(frame, msg.version, traces)) {
            this.skipped++;
            continue;
          }
          observed++;
          this.observed++;
          this.frame = msg.start + i + 1;
          if (this.parallel) continue;
          const s = this.now();
          const lib = loop.step(init.budget);
          maxStep = Math.max(maxStep, this.now() - s);
          if (lib) this.publish(lib);
        }
        if (this.parallel) {
          const s = this.now();
          this.housekeep();
          maxStep = this.now() - s;
          this.dispatch();
        }
      }
    } finally {
      // The buffer always goes back, or the fast worker's pool would shrink.
      this.deps.toFast.postMessage(
        {
          type: 'ack',
          session: msg.session,
          frames: msg.frames,
          start: msg.start,
          count: msg.count,
          observed,
        },
        [msg.frames.buffer as ArrayBuffer],
      );
    }
    this.status(this.now() - t0, maxStep);
  }

  /** Trimming decisions and, when due, a new library (parallel mode). */
  private housekeep(): void {
    const lib = this.loop?.housekeep!();
    if (lib) this.publish(lib);
  }

  /** A tile visit to every idle visit worker, while any is due. */
  private dispatch(): void {
    const loop = this.loop;
    if (!loop || this.ending) return;
    for (let i = 0; i < this.visits.length; i++) {
      if (this.busy[i]) continue;
      const t0 = this.now();
      const bytes = loop.takeJob!();
      if (!bytes) break;
      this.busy[i] = true;
      this.visits[i].postMessage({ type: 'job', session: this.session, bytes }, [
        bytes.buffer as ArrayBuffer,
      ]);
      this.jobOwnerMs += this.now() - t0;
    }
  }

  private end(): void {
    const loop = this.loop;
    if (!loop || this.final || this.ending) return;
    // Visits out still come back and are applied before the final library.
    this.ending = true;
    if (!this.busy.some((b) => b)) this.finish();
  }

  private finish(): void {
    const loop = this.loop;
    if (!loop || this.final) return;
    this.final = true;
    this.publish(loop.finalize());
    this.status(0, 0);
  }

  private publish(lib: PublishedLibrary): void {
    try {
      const version = lib.version;
      if (version !== this.version) {
        this.version = version;
        const bytes = lib.toBytes();
        // The main thread keeps the newest library's bytes for pass 2.
        const mainBytes = bytes.slice();
        this.deps.toFast.postMessage({ type: 'library', session: this.session, version, bytes }, [
          bytes.buffer as ArrayBuffer,
        ]);
        const init = this.init!;
        const library: LibraryView = {
          version,
          frame: this.frame,
          width: init.width,
          height: init.height,
          ids: lib.ids(),
          centers: lib.centers(),
          radii: lib.radii(),
          starts: lib.supportStarts(),
          pixels: lib.supportPixels(),
          values: lib.footprintValues(),
        };
        this.deps.toMain.postMessage(
          { type: 'library', session: this.session, library, bytes: mainBytes },
          libraryViewTransferables(library, mainBytes),
        );
      }
    } finally {
      lib.free();
    }
  }

  private status(batchMs: number, maxStepMs: number): void {
    const loop = this.loop;
    if (!loop) return;
    const status: SlowStatus = {
      frame: this.frame,
      observed: this.observed,
      skipped: this.skipped,
      cells: loop.cellCount,
      version: this.version,
      counters: counters(loop.stats()),
      reservoirBytes: loop.reservoirBytes,
      batchMs,
      maxStepMs,
      visitWorkers: this.visits.length,
      jobs: this.jobs,
      jobsInFlight: this.busy.filter((b) => b).length,
      visitMs: this.visitMsN > 0 ? this.visitMsSum / this.visitMsN : this.visitMs,
      jobOwnerMs: this.jobOwnerMs,
      work: loop.work ?? 0,
      final: this.final,
    };
    this.visitMs = status.visitMs;
    this.visitMsSum = 0;
    this.visitMsN = 0;
    const t = this.now();
    const transfer: Transferable[] = [];
    if (loop.cellStatus && (this.final || t - this.statusAt >= CELL_STATUS_EVERY_MS)) {
      this.statusAt = t;
      const view = cellStatusView(loop.cellStatus());
      status.cellStatus = view;
      transfer.push(view.ids.buffer as ArrayBuffer, view.established.buffer as ArrayBuffer);
    }
    this.deps.toMain.postMessage({ type: 'status', session: this.session, status }, transfer);
  }

  private drop(): void {
    this.loop?.free();
    this.loop = null;
    this.init = null;
    this.frame = 0;
    this.observed = 0;
    this.skipped = 0;
    this.version = 0;
    this.final = false;
    this.ending = false;
    this.statusAt = -Infinity;
    this.busy = this.visits.map(() => false);
    this.jobs = 0;
    this.visitMsSum = 0;
    this.visitMsN = 0;
    this.visitMs = 0;
    this.jobOwnerMs = 0;
  }
}
