/**
 * The Final settle: after Discover's last frame with look-back on, the slow
 * loop re-reads the recording (or its factors) through the look-back
 * workers with the cell set frozen, then makes a last round of visits and
 * publishes the final library. `SlowRunner` owns the ports, the requests
 * out and the publishing; this driver owns the settle's state and pacing.
 *
 * The settle's visits on the visit workers are earned per frame fed
 * (`SETTLE.visitRate`, `SlowInit.settleVisitRate`): a visit is handed out
 * only against that credit (`settleDispatch`). Settle answers are observed
 * one at a time in pieces (`settleObserve`): with a visit out the worker gives
 * way between pieces, so visit results do not wait for a whole answer, and
 * while more than `SETTLE.visitOwedFrames` frames' worth is owed with a visit
 * out, observation waits for the next result; what is still owed after the last
 * answer is handed out before the last round (`settlePaid`). So the pass
 * makes `floor(rate x fed)` visits however fast the machine, the look-back
 * workers or the visit workers are (handing out a visit whenever this worker
 * gets round to a result would make a faster settle visit less).
 *
 * The Final settle's requests (`final`) are read only once the main thread
 * says Discover's inputs are final (its last back state and flat-field map),
 * so its frames never depend on when those arrived. Its relay keeps two
 * requests on worker 0 (`settleNext`): the one out, and the next, sent
 * `hold` to be read and preprocessed meanwhile. The held one is cued
 * (`solve`) at the top of the answer before, so it is solved with the same
 * library as with one request out. (The `?debug` relay round trip,
 * `relay.end.p0.rtt`, runs from the cue, not from the request.) Both apply only to a settle on the
 * recording (`relayed`). A settle on factors (below) has neither: the
 * factors are the frames Discover preprocessed itself, complete before the
 * settle starts (the wait for `factors`), so back state and flat field play
 * no part; and the pooled settle keeps one plain request out per worker.
 */
import { runParams } from './run-params.ts';
import type {
  LookbackToSlow,
  SettleStatus,
  SettleVisits,
  SlowToLookback,
  FactorSource,
} from '../workers/lookback-types.ts';
import type { EditScopeName, PortLike, SlowInit } from '../workers/slow-types.ts';
import {
  movedAgainstNoise,
  noiseMap,
  SETTLE,
  SettleFeed,
  settlePlan,
  stillMovingRatios,
  truncatePlan,
  unitFootprints,
} from './settle.ts';
import type { LookbackItem, LookbackReq, PublishedLibrary, SlowLoopLike } from './slow-runner.ts';
import type { DetailTimer, DutyClock, SlowDuty } from './work-meter.ts';

/** What the Final settle needs of its `SlowRunner` (the runner's own state, read live). */
export interface FinalSettleHost {
  readonly loop: SlowLoopLike | null;
  readonly init: SlowInit | null;
  readonly consumed: number;
  /** Frames the slow loop did not take (`observe` returned false). */
  skipped: number;
  scope: EditScopeName;
  /** History-review candidates waiting for the visits out. */
  reviewed: Float32Array[];
  /** The Final settle's visit rate, visits per settle frame fed (0: none). */
  readonly settleRate: number;
  readonly parallel: boolean;
  readonly busy: readonly boolean[];
  readonly jobs: number;
  readonly lbPort: PortLike<SlowToLookback> | null;
  readonly lbReqs: readonly (LookbackReq | null)[];
  readonly lbHeld: LookbackReq | null;
  readonly lbPortOff: boolean[];
  readonly lbFactors: readonly boolean[];
  readonly lbError: string | undefined;
  readonly factorLive: boolean;
  readonly factorSource: FactorSource['factors'] | null;
  /** The settle's last status, kept for the final status after it ends. */
  settleStatus: SettleStatus | undefined;
  /** The newest checkpoint's "still moving" hint, sent with the next status. */
  stillMoving: Float64Array | null;
  readonly clock: DutyClock<SlowDuty>;
  readonly dt: DetailTimer | null;
  now(): number;
  tm<T>(key: string, fn: () => T): T;
  defer(fn: () => void): void;
  fail(err: unknown): void;
  status(batchMs: number, maxStepMs: number): void;
  publish(lib: PublishedLibrary): void;
  finish(): void;
  housekeep(): void;
  dispatch(limit?: number): number;
  settlePorts(): number[];
  sendRequest(
    port: number,
    kind: LookbackReq['kind'],
    flat: Float64Array,
    items: LookbackItem[],
    skip?: Uint8Array,
    hold?: boolean,
  ): void;
  solveHeld(): void;
  dropHeld(): void;
  cancelRequests(): void;
  releaseFrames(msg: Extract<LookbackToSlow, { type: 'frames' }>, port: number): void;
  /** Background settle: answers still being fed in pieces are dropped. */
  bgSettleStop(): void;
  settleView(d: Settle, done: boolean): SettleStatus;
}

/** Settling, between Discover's last frame and the final library (`SlowRunner.settlePump`). */
export interface Settle {
  /** `sweep`: the settle pass; `final`: the last visits on every tile. */
  phase: 'sweep' | 'final';
  feed: SettleFeed;
  /** Frames observed (fed through `observe`). */
  fed: number;
  recording: number;
  /** Next checkpoint at this many frames fed, and the footprints of the last one. */
  nextCheck: number;
  prev: ReturnType<typeof unitFootprints> | null;
  moving: { cells: number; above: number } | null;
  /** Steps of the final round so far (without visit workers: one). */
  finalSteps: number;
  /** With visit workers: work and visits at the start of the final round (its cap). */
  finalWork0: number;
  finalJobs0: number;
  /** Stop now (the user's Stop): publish the final library. */
  stop: boolean;
  statusAt: number;
  /** Look-back workers that answered a settle request (`SettleStatus.workers`). */
  served: Set<number>;
  /** The settle's visits (`SETTLE.visitRate`; counted with visit workers only). */
  v: SettleVisits;
  /**
   * Settle answers being observed, oldest first: the head is observed in pieces
   * (`settleObserve`), the rest wait for it (one answer at a time, in arrival order).
   */
  answers: SettleAnswer[];
  /** The head answer waits between pieces for the visits owed (`settleObserve`); since when (null: not). */
  holdSince: number | null;
  /** Visits handed out when the pass's last answer was in (null: before; the rest is paid at the end). */
  payFrom: number | null;
  /** Every tile was made due to pay what the pass owed. */
  allDue: boolean;
}

/** A settle answer observed in pieces (`Settle.answers`). */
export interface SettleAnswer {
  msg: Extract<LookbackToSlow, { type: 'frames' }>;
  req: LookbackReq;
  /** Frames observed so far; whether its observation began (its worker's next request went out). */
  next: number;
  begun: boolean;
}

/** The Final settle of the current run, driven by `SlowRunner`'s messages. */
export class FinalSettleDriver {
  constructor(private readonly r: FinalSettleHost) {}

  state: Settle | null = null;

  /**
   * The look-back workers the Final settle asks: worker 0, and on a recording's
   * factors every pool worker in the settle that was switched to them.
   */
  private finalSettlePorts(): number[] {
    if (!this.r.factorSource) return [0];
    return [0, ...this.r.settlePorts().filter((i) => this.r.lbFactors[i])];
  }

  /**
   * The Final settle reads the recording, on worker 0 alone: its requests wait
   * for final inputs (`final`) and are relayed with one prepared ahead
   * (`settleNext`). On factors (a live stream's, or a recording's, possibly
   * on the whole pool) neither: the factors hold the frames Discover
   * preprocessed itself, ready before the settle starts, and the pooled
   * settle keeps one plain request out per worker.
   */
  private relayed(): boolean {
    return !this.r.factorLive;
  }

  /** A Final settle request is out to some look-back worker. */
  private finalSettleOut(): boolean {
    return this.r.lbReqs.some((q) => q?.kind === 'end');
  }

  /**
   * A pool worker failed in the Final settle: left out for the rest of the run;
   * its request's frames go back to the feed for another worker (or worker 0).
   */
  finalSettlePortFailed(req: LookbackReq, message: string): void {
    this.r.lbPortOff[req.port] = true;
    this.state?.feed.putBack(req.items.map((it) => it.frame));
    console.warn(`cala end settle look-back worker ${req.port} stopped: ${message}`);
    this.r.status(0, 0);
  }

  /** Discover's last frame with look-back on: settle (see `settlePump`). */
  startFinalSettle(recording = this.r.consumed): void {
    const loop = this.r.loop!;
    loop.setEditScope('refine');
    this.r.scope = 'refine';
    // Review candidates would wait for every visit out; Discover is over.
    this.r.reviewed = [];
    this.r.bgSettleStop();
    // Requests of Discover's look-back still out are dropped (their late answers are ignored).
    this.r.cancelRequests();
    // The frames Discover forwarded: the recording (stream index = file frame).
    const init = this.r.init;
    const cap = init ? runParams(init.params).engine.settle.final_max_frames : 0;
    const feed = new SettleFeed(truncatePlan(settlePlan(recording, cap), init?.settleFraction ?? 1));
    this.state = {
      phase: 'sweep',
      feed,
      fed: 0,
      recording,
      nextCheck: SETTLE.checkEvery,
      prev: null,
      moving: null,
      finalSteps: 0,
      finalWork0: 0,
      finalJobs0: 0,
      stop: false,
      statusAt: this.r.now(),
      served: new Set(),
      v: {
        rate: this.r.parallel ? this.r.settleRate : 0,
        handed: 0,
        paidAtEnd: 0,
        unpaid: 0,
        owedMax: 0,
        holds: 0,
        heldMs: 0,
        starved: 0,
        finalRound: 0,
      },
      answers: [],
      holdSince: null,
      payFrom: null,
      allDue: false,
    };
    // The look-back worker solves with the library Discover ended with
    // (qc_eval publishes it before the settle); the first checkpoint's reference.
    this.state.prev = this.checkpointLibrary(loop);
    this.r.status(0, 0);
    this.settlePump();
  }

  /**
   * Publish the slow loop's current library (`finalize`) and return its
   * unit-peak footprints (a settle checkpoint).
   */
  private checkpointLibrary(loop: SlowLoopLike): ReturnType<typeof unitFootprints> {
    const lib = this.r.clock.span('end', () => this.r.tm('end.finalize', () => loop.finalize()));
    const tu = this.r.dt ? this.r.now() : 0;
    const fps = unitFootprints({
      ids: lib.ids(),
      starts: lib.supportStarts(),
      pixels: lib.supportPixels(),
      values: lib.footprintValues(),
    });
    this.r.dt?.add('end.unitFootprints', this.r.now() - tu);
    this.r.publish(lib);
    return fps;
  }

  /** A checkpoint: publish, and count the cells that moved more than `SETTLE.movingK` x their noise since the last. */
  private settleCheckpoint(loop: SlowLoopLike, d: Settle): void {
    const now = this.r.tm('end.checkpoint', () => this.checkpointLibrary(loop));
    const noise = this.r.tm('end.footprintNoise', () => noiseMap(loop.footprintNoise()));
    if (d.prev) {
      const m = this.r.tm('end.moved', () =>
        movedAgainstNoise(d.prev!, now, noise, SETTLE.movingK),
      );
      d.moving = { cells: m.cells, above: m.aboveK };
    }
    this.r.tm('end.stillMoving', () => this.noteStillMoving(loop, d.prev, now));
    d.prev = now;
  }

  /**
   * The per-cell "still moving" hint of the step between two checkpoints
   * (see `stillMovingRatios`); every checkpoint spans the same number of
   * frames, so values mean the same at every Final-settle level.
   */
  private noteStillMoving(
    loop: SlowLoopLike,
    before: ReturnType<typeof unitFootprints> | null,
    after: ReturnType<typeof unitFootprints>,
  ): void {
    if (!before) return;
    this.r.stillMoving = stillMovingRatios(before, after, (id, px) =>
      loop.footprintNoiseOn(id, px),
    );
  }

  /**
   * Settling, event-driven (qc_eval's `LookBack::settle`): the next `SETTLE.batch` frames of the plan go to the look-back
   * worker; an answer is observed through the ordinary `observe` (the next
   * request is already out), and then earns its visits (`step` at the summed
   * budget here; with visit workers, the due tiles are handed out). A
   * checkpoint every `SETTLE.checkEvery` frames publishes the library. When
   * the plan is fed (or look-back fails), a last round of visits on every
   * tile, then the final library. A Stop publishes the final library once
   * the visits out are back.
   */
  settlePump(): void {
    this.r.clock.span('end', () => this.settlePumpInner());
  }

  private settlePumpInner(): void {
    const d = this.state;
    const loop = this.r.loop;
    const init = this.r.init;
    if (!d || !loop || !init) return;
    if (d.stop) {
      // Answers not yet observed are not: their buffers go back.
      for (const a of d.answers.splice(0)) this.r.releaseFrames(a.msg, a.req.port);
      if (d.holdSince !== null) {
        d.v.heldMs += this.r.now() - d.holdSince;
        d.holdSince = null;
      }
      if (!this.r.busy.some((b) => b)) this.finishFinalSettle();
      return;
    }
    if (d.phase === 'sweep') {
      const failed = this.r.lbError !== undefined || !this.r.lbPort;
      // A worker whose answer waits to be observed gets its next request when that begins.
      const waiting = (i: number) => d.answers.some((a) => a.req.port === i && !a.begun);
      if (this.relayed()) {
        if (failed) this.r.dropHeld();
        else if (!this.r.lbReqs[0] && !waiting(0)) this.settleNext();
      } else if (!failed)
        for (const i of this.finalSettlePorts()) {
          if (d.feed.done) break;
          if (!this.r.lbReqs[i] && !waiting(i)) this.settleRequest(i);
        }
      if (
        !this.finalSettleOut() &&
        !this.r.lbHeld &&
        d.answers.length === 0 &&
        (d.feed.done || failed)
      ) {
        // The visits the pass earned and could not hand out in time, before the last round.
        if (!this.settlePaid(loop, d)) return;
        d.phase = 'final';
        d.finalWork0 = loop.work;
        d.finalJobs0 = this.r.jobs;
        loop.markAllDue();
        this.r.status(0, 0);
      } else return;
    }
    // The last round of visits.
    if (this.r.busy.some((b) => b)) return;
    if (this.r.parallel) {
      this.r.housekeep();
      // The same cap as without workers (`SETTLE.finalSteps` budgets of work):
      // visits keep making tiles due again, so "until none is due" may not end.
      const capped =
        loop.work - d.finalWork0 >= init.budget * SETTLE.finalSteps ||
        this.r.jobs - d.finalJobs0 >= SETTLE.finalVisitsMax;
      const n = capped ? 0 : this.r.dispatch();
      d.v.finalRound += n;
      if (n > 0) return;
    } else if (d.finalSteps === 0) {
      d.finalSteps++;
      const lib = loop.step(init.budget * SETTLE.finalSteps);
      if (lib) this.r.publish(lib);
    }
    this.finishFinalSettle();
  }

  /** The settle counts its visits against a rate (`SETTLE.visitRate`; visit workers only). */
  private settleMetered(d: Settle): boolean {
    return d.v.rate > 0 && this.r.parallel;
  }

  /** Visits the settle's frames earned and are not handed out yet (Infinity: no rate). */
  private settleOwed(d: Settle): number {
    if (!this.settleMetered(d)) return Infinity;
    // (The small slack keeps a product such as 0.4 x 160 from rounding down a whole visit.)
    return Math.floor(d.v.rate * d.fed + 1e-9) - d.v.handed;
  }

  /**
   * Hand out the settle's visits: to every idle visit worker, at most the visits owed. Credit
   * that finds nothing due is kept for later frames (never dropped: the pass hands out
   * `floor(rate x fed)` in all, `settlePaid`).
   */
  settleDispatch(d: Settle): void {
    if (d.stop) return;
    const owed = this.settleOwed(d);
    const n = this.r.dispatch(owed);
    if (!this.settleMetered(d)) return;
    d.v.handed += n;
    const left = owed - n;
    d.v.owedMax = Math.max(d.v.owedMax, left);
    if (left > 0 && d.payFrom === null && !this.r.busy.some((b) => b)) d.v.starved++;
  }

  /**
   * The settle's observation waits between pieces: more than `SETTLE.visitOwedFrames` frames'
   * worth of visits is owed and a visit is out (its result frees a worker for the next). So a
   * settle whose visit workers fall behind waits for them, rather than handing out fewer visits
   * per frame. With nothing out, nothing waits (the credit is carried; see `settleDispatch`).
   */
  private settleOwedTooMuch(d: Settle): boolean {
    return (
      this.settleMetered(d) &&
      !d.stop &&
      this.settleOwed(d) > d.v.rate * SETTLE.visitOwedFrames &&
      this.r.busy.some((b) => b)
    );
  }

  /**
   * After the pass's last answer: hand out what it still owes (waiting for visits out; with
   * nothing due, every tile is made due first, as the last round does anyway). Returns true when
   * the last round may start.
   */
  private settlePaid(loop: SlowLoopLike, d: Settle): boolean {
    if (!this.settleMetered(d) || d.stop) return true;
    d.payFrom ??= d.v.handed;
    const done = (): boolean => {
      d.v.paidAtEnd = d.v.handed - (d.payFrom ?? d.v.handed);
      return true;
    };
    if (this.settleOwed(d) <= 0) return done();
    this.settleDispatch(d);
    if (this.r.busy.some((b) => b)) return false;
    if (!d.allDue && this.settleOwed(d) > 0) {
      d.allDue = true;
      loop.markAllDue();
      this.settleDispatch(d);
      if (this.r.busy.some((b) => b)) return false;
    }
    d.v.unpaid = Math.max(0, this.settleOwed(d));
    return done();
  }

  /**
   * The settle's next request out: the held one is cued (or, with none, a
   * request goes out), at the point where the request itself would go;
   * and the one after it goes out held, to be read and preprocessed while
   * the slow worker works on the answer in hand. Frames and order are those of a plain request, and each request is solved
   * with the library a plain request would use.
   */
  private settleNext(): void {
    const d = this.state!;
    if (d.stop) return;
    if (this.r.lbHeld) this.r.solveHeld();
    else this.settleRequest(0);
    if (this.r.lbReqs[0]) this.settleRequest(0, true);
  }

  /**
   * The next settle frames to look-back worker `port` (`hold`, worker 0 on the
   * recording: prepared ahead, see `settleNext`).
   */
  private settleRequest(port = 0, hold = false): void {
    const d = this.state!;
    const frames = d.feed.take(SETTLE.batch);
    if (frames.length === 0) return;
    const flat = new Float64Array(3 * frames.length);
    frames.forEach((f, i) => {
      flat[3 * i] = f.frame;
      flat[3 * i + 1] = f.block;
    });
    const items = frames.map((f) => ({ frame: f.frame, ids: new Float64Array(0) }));
    this.r.sendRequest(port, 'end', flat, items, undefined, hold);
  }

  /**
   * Observe the settle's answers, oldest first. As an answer begins, its worker's next request
   * goes out (on the recording, the held one is cued and the next prepared, `settleNext`); then its frames go through `observe` in pieces of
   * `SETTLE.observePiece`, each followed by the visits they earned. While a visit is out the
   * worker gives way between pieces (`defer`), so visit results are applied within an answer
   * and the visit workers get their next visits without waiting for the whole answer. While too
   * many visits are owed (`settleOwedTooMuch`) it waits for the next result (`handleVisit`
   * resumes it). Without visit workers an answer is observed in one go.
   */
  settleObserve(loop: SlowLoopLike, d: Settle): void {
    for (;;) {
      if (this.state !== d || d.stop) return;
      const a = d.answers[0];
      if (!a) {
        this.settlePump();
        return;
      }
      if (!a.begun) {
        a.begun = true;
        this.settleNextFor(d, a.req.port);
      }
      while (a.next < a.msg.count) {
        if (this.settleOwedTooMuch(d)) {
          if (d.holdSince === null) {
            d.holdSince = this.r.now();
            d.v.holds++;
          }
          return;
        }
        if (d.holdSince !== null) {
          d.v.heldMs += this.r.now() - d.holdSince;
          d.holdSince = null;
        }
        const n = this.r.parallel ? SETTLE.observePiece : a.msg.count;
        this.observeSettle(loop, d, a, n);
        if (this.state !== d || d.stop) return;
        if (a.next < a.msg.count && this.r.parallel && this.r.busy.some((b) => b)) {
          this.r.defer(() => {
            try {
              // (A hold is resumed by the visit result that ends it, not here.)
              if (this.state === d && !d.stop && d.holdSince === null)
                this.r.clock.span('end', () => this.settleObserve(loop, d));
            } catch (err) {
              this.r.fail(err);
            }
          });
          return;
        }
      }
      d.answers.shift();
      this.r.releaseFrames(a.msg, a.req.port);
    }
  }

  /** As a settle answer from look-back worker `port` begins: that worker's next request. */
  private settleNextFor(d: Settle, port: number): void {
    if (this.relayed()) {
      // The next request is solved first (and the one after it prepared): the look-back
      // worker works on them while these frames are observed here. Not gated on the feed:
      // the last batch may be held while the feed is already done.
      if (!d.stop) this.r.tm('end.request', () => this.settleNext());
      return;
    }
    // The pooled settle on factors: the next request to this worker.
    const next =
      !d.stop &&
      !d.feed.done &&
      this.r.lbError === undefined &&
      !this.r.lbReqs[port] &&
      this.finalSettlePorts().includes(port);
    if (next) this.r.tm('end.request', () => this.settleRequest(port));
  }

  /** The next `n` frames of settle answer `a` through `observe`, then the visits they earn. */
  private observeSettle(loop: SlowLoopLike, d: Settle, a: SettleAnswer, n: number): void {
    const init = this.r.init!;
    const { msg, req } = a;
    const items = req.items;
    const px = init.width * init.height;
    const bg = msg.background;
    const nb = bg && msg.count > 0 ? bg.length / msg.count : 0;
    const end = Math.min(msg.count, a.next + Math.max(1, n));
    let ok = 0;
    // Version 0: the worker had no library yet, nothing was solved.
    if (msg.version !== 0)
      for (let i = a.next; i < end; i++) {
        // The stream index is required with look-back on; nothing reads it after Discover.
        const te = this.r.dt ? this.r.now() : 0;
        const seen = loop.observe(
          msg.frames.subarray(i * px, (i + 1) * px),
          msg.version,
          msg.traces.subarray(i * msg.cells, (i + 1) * msg.cells),
          bg?.subarray(i * nb, (i + 1) * nb),
          items[i].frame,
        );
        if (this.r.dt) {
          this.r.dt.add('end.observe', this.r.now() - te);
          this.r.dt.add('end.observe#', 1);
        }
        if (seen) ok++;
        else this.r.skipped++;
      }
    d.fed += end - a.next;
    a.next = end;
    if (this.r.parallel) {
      this.r.housekeep();
      this.settleDispatch(d);
    } else if (ok > 0) {
      const lib = loop.step(init.budget * ok);
      if (lib) this.r.publish(lib);
    }
    if (d.fed >= d.nextCheck) {
      d.nextCheck += SETTLE.checkEvery;
      this.settleCheckpoint(loop, d);
    }
    if (this.r.now() - d.statusAt >= 250) {
      d.statusAt = this.r.now();
      this.r.status(0, 0);
    }
  }

  private finishFinalSettle(): void {
    const d = this.state;
    if (d) this.r.settleStatus = this.r.settleView(d, true);
    this.state = null;
    this.r.finish();
  }
}
