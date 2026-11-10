/**
 * The slow loop (streaming cell discovery), inside its own worker: observes
 * every frame the fast worker forwards, spends its work budget after each,
 * returns the frame buffer, and publishes each new library version to the
 * fast worker (bytes) and to the main thread (footprints for drawing).
 *
 * Its stalls (a tile visit or a library rebuild can take 50-160 ms) only
 * delay this worker; the fast worker drops batches for it instead of waiting
 * (see `ForwardPool`).
 */
import type {
  CellStatusView,
  FastToSlow,
  LibraryView,
  PortLike,
  SlowCounters,
  SlowInit,
  SlowStatus,
  SlowToFast,
  SlowToMain,
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
  readonly cellCount: number;
  readonly reservoirBytes: number;
  stats(): Float64Array;
  /** `(id, established, transients)` triples (absent in older fakes). */
  cellStatus?(): Float64Array;
  free(): void;
}

export interface SlowRunnerDeps {
  create(init: SlowInit): SlowLoopLike;
  toFast: PortLike<SlowToFast>;
  toMain: PortLike<SlowToMain>;
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
  private session = -1;
  private loop: SlowLoopLike | null = null;
  private init: SlowInit | null = null;
  private frame = 0;
  private observed = 0;
  private skipped = 0;
  private version = 0;
  private final = false;
  private statusAt = -Infinity;

  constructor(deps: SlowRunnerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => performance.now());
  }

  handle(msg: FastToSlow): void {
    if (msg.type === 'reset' || msg.type === 'init') {
      if (msg.session < this.session) return;
      this.drop();
      this.session = msg.session;
      if (msg.type === 'init') {
        const { width, height, fov, noise, cellDiameterPx, flattenSigmaPx, budget } = msg;
        this.init = { width, height, fov, noise, cellDiameterPx, flattenSigmaPx, budget };
        this.loop = this.deps.create(this.init);
      }
      return;
    }
    if (msg.session !== this.session) return;
    try {
      if (msg.type === 'frames') this.frames(msg);
      else if (msg.type === 'end') this.end();
    } catch (err) {
      this.deps.toMain.postMessage({
        type: 'error',
        session: this.session,
        message: err instanceof Error ? err.message : String(err),
      });
      this.drop();
    }
  }

  private frames(msg: Extract<FastToSlow, { type: 'frames' }>): void {
    const loop = this.loop;
    const init = this.init;
    let observed = 0;
    let maxStep = 0;
    const t0 = this.now();
    try {
      if (loop && init) {
        if (msg.noise) loop.setNoise(msg.noise);
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
          const s = this.now();
          const lib = loop.step(init.budget);
          maxStep = Math.max(maxStep, this.now() - s);
          if (lib) this.publish(lib);
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

  private end(): void {
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
      final: this.final,
    };
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
    this.statusAt = -Infinity;
  }
}
