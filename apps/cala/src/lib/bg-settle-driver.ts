/**
 * Background settle (`csettle` in persisted keys, URL flags and message
 * kinds): look-back re-reads of saved frames while Discover runs below Max.
 * `SlowRunner` owns the ports and the requests out; this driver owns the
 * settle's state, its requests and how its answers are fed.
 *
 * Background settle (`SlowInit.csettle`, frames
 * only; `CSETTLE` in `settle.ts`): while a look-back Discover runs below Max,
 * the look-back worker also re-reads saved frames spread over the history
 * seen so far (`settleTake`), at the settle governor's rate (`SettleGovernor`:
 * re-read frames per second, at most the cap per live frame; `setCap`, `setPace`).
 * It is armed the first time the target goes below Max with a cap above 0,
 * so a run at Max never starts it. Their answers go into the footprint statistics
 * (`observeSettle`); held-out frames are not even solved. There are no
 * settle visits: Discover's own visits refine with the better statistics.
 * Need-driven look-back and these requests share the one look-back worker
 * and take turns when both have frames to ask for (or need-driven first,
 * `SlowInit.csettleNeedFirst`). The Final settle runs after the last frame as
 * without it.
 */
import type { LookbackToSlow } from '../workers/lookback-types.ts';
import type { SlowInit } from '../workers/slow-types.ts';
import { CSETTLE } from './settle.ts';
import { SettleGovernor } from './settle-governor.ts';
import type { LookbackItem, LookbackReq, SlowLoopLike } from './slow-runner.ts';
import type { DutyClock, SlowDuty } from './work-meter.ts';

/** What the Background settle needs of its `SlowRunner` (the runner's own state, read live). */
export interface BgSettleHost {
  readonly loop: SlowLoopLike | null;
  readonly init: SlowInit | null;
  readonly consumed: number;
  readonly version: number;
  /** A Joint run's current session starts here: nothing before it is re-read. */
  readonly lbFloor: number;
  /** Discover is running and look-back works. */
  readonly lookbackLive: boolean;
  /** The pacer's target live fps (0: Max) and pause. */
  readonly pace: { fps: number; paused: boolean };
  /** The settle's cap, re-read frames per live frame (0 = Off). */
  readonly cap: number;
  readonly parallel: boolean;
  readonly lbPortOff: boolean[];
  readonly clock: DutyClock<SlowDuty>;
  now(): number;
  tm<T>(key: string, fn: () => T): T;
  defer(fn: () => void): void;
  fail(err: unknown): void;
  status(batchMs: number, maxStepMs: number): void;
  housekeep(): void;
  dispatch(limit?: number): number;
  settlePorts(): number[];
  needRequest(loop: SlowLoopLike): boolean;
  lookbackRequest(): boolean;
  sendRequest(
    port: number,
    kind: LookbackReq['kind'],
    flat: Float64Array,
    items: LookbackItem[],
    skip?: Uint8Array,
  ): void;
  releaseFrames(msg: Extract<LookbackToSlow, { type: 'frames' }>, port: number): void;
}

/** Background settle (`SlowInit.csettle`), for the current run, once armed. */
export interface BgSettle {
  /** The rate per second, the re-read frames owed, and the cap. */
  gov: SettleGovernor;
  /** Frames per piece of an answer (0: whole answers). */
  yieldFrames: number;
  /** Worker 0 without a pool: need-driven look-back first, the settle only when it asks nothing (`SlowInit.csettleNeedFirst`). */
  needFirst: boolean;
  /** The next request is the settle's when both it and need-driven look-back have frames to ask for. */
  turn: boolean;
  /** The settle's own request on worker 0 failed or timed out: no more settle requests there this run (need-driven look-back goes on). */
  off: boolean;
  /** The answers in hand, when they are handled in pieces (at most one per look-back worker). */
  works: BgSettleWork[];
  requested: number;
  /** Frames dropped here (an answer with no library yet, or one cut short by the end of Discover). */
  dropped: number;
  /** Live frames observed while Discover ran. */
  live: number;
  answers: number;
  answerMs: number;
  maxBlockMs: number;
}

/** An answer of Background settle being fed to the slow loop. */
interface BgSettleWork {
  msg: Extract<LookbackToSlow, { type: 'frames' }>;
  req: LookbackReq;
  /** Frames handled so far. */
  next: number;
}

/** The Background settle of the current run, driven by `SlowRunner`'s messages. */
export class BgSettleDriver {
  constructor(private readonly r: BgSettleHost) {}

  /** Background settle (null: not armed in this run). */
  bgs: BgSettle | null = null;

  /** This run may arm Background settle (`SlowInit.csettle` with look-back), and how. */
  bgArm: { yieldFrames: number; needFirst: boolean; forwardPool: number } | null = null;

  /**
   * Arm Background settle the first time this run's target is below
   * Max with a cap above 0 (a run at Max never arms it: nothing changes there).
   */
  armSettle(): void {
    const arm = this.bgArm;
    const loop = this.r.loop;
    if (
      this.bgs ||
      !arm ||
      !loop ||
      !this.r.lookbackLive ||
      !(this.r.pace.fps > 0) ||
      !(this.r.cap > 0)
    )
      return;
    loop.enableSettle(CSETTLE.chunk);
    const gov = new SettleGovernor(
      this.r.cap,
      Math.max(1, this.r.settlePorts().length),
      arm.forwardPool,
    );
    gov.setTarget(this.r.pace.fps, this.r.pace.paused);
    this.bgs = {
      gov,
      yieldFrames: arm.yieldFrames,
      needFirst: arm.needFirst,
      turn: false,
      off: false,
      works: [],
      requested: 0,
      dropped: 0,
      live: 0,
      answers: 0,
      answerMs: 0,
      maxBlockMs: 0,
    };
  }

  /**
   * Worker 0 without a settle pool: need-driven look-back and the settle take
   * turns, or with `needFirst` the settle asks only when look-back asks nothing.
   */
  turnRequest(loop: SlowLoopLike, bgs: BgSettle): boolean {
    if (bgs.needFirst) return this.r.needRequest(loop) || this.bgSettleRequest(loop, bgs, 0);
    if (bgs.turn && this.bgSettleRequest(loop, bgs, 0)) return true;
    if (this.r.needRequest(loop)) {
      bgs.turn = true;
      return true;
    }
    return !bgs.turn && this.bgSettleRequest(loop, bgs, 0);
  }

  /**
   * Background settle: one chunk of saved frames to look-back worker
   * `port`, when a whole chunk is owed (`SettleGovernor`)
   * and no answer of that worker is still being fed in pieces.
   */
  bgSettleRequest(loop: SlowLoopLike, bgs: BgSettle, port: number): boolean {
    // No settle reads before the first library: the look-back worker would solve nothing.
    if (
      (port === 0 && bgs.off) ||
      bgs.works.some((w) => w.req.port === port) ||
      !bgs.gov.ready ||
      !this.r.lookbackLive ||
      this.r.version <= 0
    )
      return false;
    // The frames forwarded so far are the saved history (stream index = file frame).
    const take = this.r.clock.span('csettle', () =>
      loop.settleTake(this.r.consumed, CSETTLE.chunk),
    );
    // The current session only (as `needRequest`).
    const keep: number[] = [];
    for (let i = 0; 3 * i + 2 < take.length; i++) if (take[3 * i] >= this.r.lbFloor) keep.push(i);
    const n = keep.length;
    if (n === 0) return false;
    const flat = new Float64Array(3 * n);
    const skip = new Uint8Array(n);
    const items: LookbackItem[] = [];
    keep.forEach((k, i) => {
      flat[3 * i] = take[3 * k];
      flat[3 * i + 1] = take[3 * k + 1];
      skip[i] = take[3 * k + 2] > 0 ? 1 : 0;
      items.push({ frame: take[3 * k], ids: new Float64Array(0) });
    });
    bgs.gov.spend(n);
    bgs.requested += n;
    if (port === 0) bgs.turn = false;
    this.r.sendRequest(port, 'csettle', flat, items, skip);
    return true;
  }

  /**
   * A settle request failed (its frames count as dropped): on worker 0 the
   * settle there is off for the rest of this run; a pool worker is left out
   * for the rest of the run (the others go on; with none left, the settle
   * takes turns on worker 0 again).
   */
  bgSettleFailed(req: LookbackReq, message: string): void {
    const bgs = this.bgs;
    if (!bgs) return;
    bgs.dropped += req.items.length;
    if (req.port > 0) {
      this.r.lbPortOff[req.port] = true;
      bgs.gov.setWorkers(this.r.settlePorts().length);
      console.warn(`cala settle look-back worker ${req.port} stopped: ${message}`);
    } else {
      bgs.off = true;
      console.warn(`cala settle during Discover stopped: ${message}`);
    }
    this.r.status(0, 0);
  }

  /**
   * An answer of Background settle. Whole (the default, as qc_eval
   * measured it): the next request goes out first, so the look-back worker
   * reads on while every frame of this answer is fed here in one go. In
   * pieces (`SlowInit.csettleYield`): `yieldFrames` frames, then this worker
   * gives way to the batches and visit results waiting, and so on; the next
   * settle request waits for the last piece.
   */
  bgSettleAnswer(
    loop: SlowLoopLike,
    bgs: BgSettle,
    msg: Extract<LookbackToSlow, { type: 'frames' }>,
    req: LookbackReq,
  ): void {
    if (msg.count !== req.items.length)
      throw new Error(`settle: ${msg.count} frames for a request of ${req.items.length}`);
    const work: BgSettleWork = { msg, req, next: 0 };
    bgs.answers++;
    if (bgs.yieldFrames > 0) {
      bgs.works.push(work);
      // Need-driven look-back may use the worker meanwhile.
      this.r.lookbackRequest();
      this.bgSettlePiece(work);
      return;
    }
    this.r.lookbackRequest();
    this.bgSettleFeed(loop, bgs, work, msg.count);
    this.r.releaseFrames(msg, req.port);
  }

  /** The next piece of an answer handled in pieces; then give way, or finish. */
  private bgSettlePiece(work: BgSettleWork): void {
    const bgs = this.bgs;
    const loop = this.r.loop;
    // Dropped meanwhile (a reset, an error, the end of Discover): nothing left to do.
    if (!bgs || !loop || !bgs.works.includes(work)) return;
    this.r.clock.span('csettle', () => this.bgSettleFeed(loop, bgs, work, bgs.yieldFrames));
    if (work.next < work.msg.count) {
      this.r.defer(() => {
        try {
          this.bgSettlePiece(work);
        } catch (err) {
          this.r.fail(err);
        }
      });
      return;
    }
    bgs.works.splice(bgs.works.indexOf(work), 1);
    this.r.releaseFrames(work.msg, work.req.port);
    if (this.r.lookbackLive) this.r.lookbackRequest();
  }

  /**
   * Feed the next `n` frames of an answer to the footprint statistics
   * (`observeSettle`): held-out frames are passed over (they were not
   * solved); then the visits waiting are handed out, as after any message.
   */
  private bgSettleFeed(loop: SlowLoopLike, bgs: BgSettle, work: BgSettleWork, n: number): void {
    const init = this.r.init!;
    const { msg, req } = work;
    const t0 = this.r.now();
    const end = Math.min(msg.count, work.next + Math.max(1, n));
    // Version 0: the worker had no library yet, nothing was solved.
    if (msg.version === 0) {
      bgs.dropped += end - work.next;
      work.next = end;
      return;
    }
    const px = init.width * init.height;
    const bg = msg.background;
    const nb = bg && msg.count > 0 ? bg.length / msg.count : 0;
    let skipped = 0;
    for (let i = work.next; i < end; i++) {
      if (req.skip?.[i]) {
        skipped++;
        continue;
      }
      this.r.tm('csettle.observe', () =>
        loop.observeSettle(
          msg.frames.subarray(i * px, (i + 1) * px),
          msg.version,
          msg.traces.subarray(i * msg.cells, (i + 1) * msg.cells),
          bg?.subarray(i * nb, (i + 1) * nb),
          req.items[i].frame,
        ),
      );
    }
    if (skipped > 0) loop.settleSkipped(skipped);
    work.next = end;
    if (this.r.parallel) {
      this.r.housekeep();
      this.r.dispatch();
    }
    const ms = this.r.now() - t0;
    bgs.answerMs += ms;
    bgs.maxBlockMs = Math.max(bgs.maxBlockMs, ms);
  }

  /** Discover is over: answers still being fed in pieces are dropped (their buffers go back). */
  bgSettleStop(): void {
    const bgs = this.bgs;
    if (!bgs) return;
    for (const work of bgs.works.splice(0)) {
      bgs.dropped += work.msg.count - work.next;
      this.r.releaseFrames(work.msg, work.req.port);
    }
  }
}
