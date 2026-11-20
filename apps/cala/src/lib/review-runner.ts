/**
 * The review worker's logic: keeps the factors of every compressed window
 * and, when the compress worker says a review is due, scans them for cells
 * the library lacks (`HistoryReview`, crates/cala/src/compress/review.rs).
 *
 * A review takes seconds to minutes, so it runs in a worker that does nothing
 * else: neither the fast loop, nor the slow loop, nor the compression waits
 * for it. The scan runs a few grid rows at a time and yields to the event
 * loop in between, so that a reset stops it and a review that comes due
 * meanwhile is seen and skipped (never queued). Windows that arrive during a
 * review are added after it.
 */
import type { PortLike } from '../workers/slow-types.ts';
import type { CompressToReview, ReviewStatus, ReviewToMain } from '../workers/review-types.ts';

/** What the runner needs of the WASM `HistoryReview`. */
export interface HistoryReviewLike {
  addWindow(bytes: Uint8Array): number;
  dropOldest(): void;
  readonly windows: number;
  readonly factorBytes: number;
  /** Grid rows to scan (0: too little history, no review started). */
  begin(library: Uint8Array): number;
  /** Scans `rows` more rows; returns the rows left. */
  scan(rows: number): number;
  finish(): Float32Array;
  cancel(): void;
  free(): void;
}

export interface ReviewRunnerDeps {
  create(width: number, height: number): HistoryReviewLike;
  toMain: PortLike<ReviewToMain>;
  /** Bytes of the WASM heap, for the status (default: unknown, 0). */
  heapBytes?: () => number;
  /** Factors held at most, bytes; older windows are dropped beyond it. */
  maxFactorBytes?: number;
  /** Lets queued messages run (default: a macrotask). */
  yieldNow?: () => Promise<void>;
  now?: () => number;
}

/** Grid rows scanned between two looks at the message queue. */
export const REVIEW_ROWS_PER_STEP = 4;
/**
 * Factors the review worker holds at most: its WASM heap ends at 4 GB. A
 * 600-frame window of a real 600 x 600 recording is 15-30 MB, so this is
 * 1-2 h at 20 fps; a longer session is reviewed on its most recent windows.
 */
export const MAX_REVIEW_FACTOR_BYTES = 3 * 2 ** 30;

const HEADER = 6;
const NO_LIBRARY = new Uint8Array(0);
const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Candidates in the array of `HistoryReview.finish`. */
export function candidateCount(wire: Float32Array): number {
  let n = 0;
  for (let at = 0; at + HEADER <= wire.length; at += HEADER + wire[at + 2] * wire[at + 3]) n++;
  return n;
}

export class ReviewRunner {
  private readonly yieldNow: () => Promise<void>;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private session = -1;
  private review: HistoryReviewLike | null = null;
  /** The review in progress. */
  private task: Promise<void> | null = null;
  /** Bumps when the run is dropped, so a running review stops at its next yield. */
  private epoch = 0;
  /** Windows that arrived during a review. */
  private waiting: Uint8Array[] = [];
  private reviews = 0;
  private skipped = 0;
  private candidates = 0;
  private windows = 0;
  private seconds = 0;

  constructor(private readonly deps: ReviewRunnerDeps) {
    this.yieldNow = deps.yieldNow ?? macrotask;
    this.now = deps.now ?? (() => performance.now());
    this.maxBytes = deps.maxFactorBytes ?? MAX_REVIEW_FACTOR_BYTES;
  }

  /** One message from the compress worker. */
  handle(msg: CompressToReview): void {
    if (msg.type === 'init') {
      this.drop();
      this.session = msg.session;
      this.review = this.deps.create(msg.width, msg.height);
      return;
    }
    if (msg.session !== this.session || !this.review) return;
    try {
      if (msg.type === 'reset') {
        this.drop();
        this.session = -1;
      } else if (msg.type === 'window') {
        if (this.task) this.waiting.push(msg.bytes);
        else this.add(msg.bytes);
      } else if (this.task) {
        // One review at a time: a review due during another is not made up for.
        this.skipped++;
        this.post();
      } else {
        this.start(msg.version, msg.library ?? NO_LIBRARY);
      }
    } catch (err) {
      this.fail(this.session, err);
    }
  }

  /** Resolves when no review is running (for tests). */
  async idle(): Promise<void> {
    while (this.task) await this.task;
  }

  private add(bytes: Uint8Array): void {
    const review = this.review;
    if (!review) return;
    review.addWindow(bytes);
    while (review.windows > 1 && review.factorBytes > this.maxBytes) review.dropOldest();
  }

  private start(version: number, library: Uint8Array): void {
    const session = this.session;
    const task = this.run(version, library)
      .catch((err: unknown) => this.fail(session, err))
      .finally(() => {
        if (this.task === task) this.task = null;
      });
    this.task = task;
  }

  private async run(version: number, library: Uint8Array): Promise<void> {
    const review = this.review;
    if (!review) return;
    const { epoch, session } = this;
    const t0 = this.now();
    let left = review.begin(library);
    if (left === 0) return;
    this.post(true);
    try {
      while (left > 0) {
        left = review.scan(REVIEW_ROWS_PER_STEP);
        await this.yieldNow();
        // Dropped meanwhile: the review object is gone.
        if (epoch !== this.epoch) return;
      }
      const candidates = review.finish();
      this.reviews++;
      this.candidates += candidateCount(candidates);
      this.windows = review.windows;
      this.seconds = (this.now() - t0) / 1000;
      if (candidates.length > 0) {
        this.deps.toMain.postMessage({ type: 'candidates', session, version, candidates }, [
          candidates.buffer as ArrayBuffer,
        ]);
      }
    } finally {
      if (epoch === this.epoch) {
        review.cancel();
        for (const bytes of this.waiting.splice(0)) this.add(bytes);
        this.post(false);
      }
    }
  }

  private post(running = this.task !== null): void {
    const status: ReviewStatus = {
      reviews: this.reviews,
      skipped: this.skipped,
      candidates: this.candidates,
      running,
      windows: this.windows,
      seconds: this.seconds,
      factorBytes: this.review?.factorBytes ?? 0,
      heapBytes: this.deps.heapBytes?.() ?? 0,
    };
    this.deps.toMain.postMessage({ type: 'status', session: this.session, status });
  }

  private fail(session: number, err: unknown): void {
    this.deps.toMain.postMessage({
      type: 'error',
      session,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  /** Stop a running review, drop the factors and the counters. */
  private drop(): void {
    this.epoch++;
    this.task = null;
    this.review?.free();
    this.review = null;
    this.waiting = [];
    this.reviews = 0;
    this.skipped = 0;
    this.candidates = 0;
    this.windows = 0;
    this.seconds = 0;
  }
}
