/**
 * RunEvents: the bounded log of discrete changes in a run (stage, scale, flat-field map,
 * setting, pause/resume, range expansion, warning, gap, error, restart). It is the single
 * source for the chart's event lane and for what Refine and Extract must replay.
 *
 * Kept sorted by stream time. Bounded: past `maxEvents`, old display-only flat-field events
 * fold into hourly summaries; events with `replay: true` and every non-flat-field event are
 * never folded. If folding is not enough, the oldest non-replay 'range'/'warning' events are
 * dropped (they are display-only and the store still has the ranges themselves).
 */

export type RunEventKind =
  /** A run stage started or ended (Discover, Refine, Extract; docs/stages.md). */
  | 'stage'
  | 'scale'
  | 'flatfield'
  | 'setting'
  | 'pause'
  | 'resume'
  | 'range'
  | 'warning'
  | 'gap'
  | 'error'
  | 'restart'
  /** A new session starts here (a multi-session Joint run); `to` is its 0-based index. */
  | 'session';

export interface RunEvent {
  /** Stream frame it took effect at. */
  frame: number;
  /** Stream seconds. */
  t: number;
  kind: RunEventKind;
  key?: string;
  from?: number | string;
  to?: number | string;
  detail?: string;
  /** Pass 2 / downstream must apply it; never folded. */
  replay?: boolean;
  /** Folded summaries: events merged into this one. */
  count?: number;
  /** Extra payload (e.g. flat field: seq, source, first, change). */
  data?: Record<string, number | string | boolean>;
  /** Wall clock ms when logged (for clock-time readouts). */
  wall?: number;
}

export class RunEvents {
  private readonly maxEvents: number;
  private readonly foldOlderThanS: number;
  private ev: RunEvent[] = [];
  private ver = 0;

  constructor(o: { maxEvents?: number; foldOlderThanS?: number } = {}) {
    this.maxEvents = o.maxEvents ?? 100_000;
    this.foldOlderThanS = o.foldOlderThanS ?? 86400;
  }

  /** Append (events normally arrive in order); an older `t` is inserted in place, after equal times. */
  push(e: RunEvent): void {
    const n = this.ev.length;
    if (n === 0 || e.t >= this.ev[n - 1].t) this.ev.push(e);
    else this.ev.splice(this.upper(e.t), 0, e);
    this.ver++;
    if (this.ev.length > this.maxEvents) this.compact();
  }
  list(): readonly RunEvent[] {
    return this.ev;
  }
  /** Events with t0 <= t < t1, in order. O(log n + k). */
  between(t0: number, t1: number): readonly RunEvent[] {
    return this.ev.slice(this.lower(t0), this.lower(t1));
  }
  ofKind(kind: RunEventKind): RunEvent[] {
    return this.ev.filter((e) => e.kind === kind);
  }
  /** Bumps on every change. */
  version(): number {
    return this.ver;
  }
  /** Estimate: 64 B per event plus string lengths. */
  bytes(): number {
    let b = 0;
    for (const e of this.ev) {
      b += 64;
      if (e.key) b += e.key.length;
      if (e.detail) b += e.detail.length;
      if (typeof e.from === 'string') b += e.from.length;
      if (typeof e.to === 'string') b += e.to.length;
      if (e.data) for (const k in e.data) b += 16 + k.length;
    }
    return b;
  }
  toJSON(): string {
    return JSON.stringify(this.ev);
  }
  clear(): void {
    this.ev = [];
    this.ver++;
  }

  /** First index with t >= x. */
  private lower(x: number): number {
    let lo = 0,
      hi = this.ev.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.ev[m].t < x) lo = m + 1;
      else hi = m;
    }
    return lo;
  }
  /** First index with t > x. */
  private upper(x: number): number {
    let lo = 0,
      hi = this.ev.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.ev[m].t <= x) lo = m + 1;
      else hi = m;
    }
    return lo;
  }

  /** Fold old display-only flat-field events into hourly summaries, then drop old range/warning events if still over. */
  private compact(): void {
    const cutoff = this.ev[this.ev.length - 1].t - this.foldOlderThanS;
    const out: RunEvent[] = [];
    const hours = new Map<number, RunEvent>();
    for (const e of this.ev) {
      if (e.kind !== 'flatfield' || e.replay === true || e.t >= cutoff) {
        out.push(e);
        continue;
      }
      const hour = Math.floor(e.t / 3600) * 3600;
      const n = e.count ?? 1;
      const to = typeof e.to === 'number' ? e.to : undefined;
      const s = hours.get(hour);
      if (!s) {
        const sum: RunEvent = {
          frame: e.frame,
          t: hour,
          kind: 'flatfield',
          count: n,
          detail: `${n} maps`,
        };
        if (to !== undefined) sum.to = to;
        if (e.wall !== undefined) sum.wall = e.wall;
        hours.set(hour, sum);
        out.push(sum);
      } else {
        s.count = (s.count ?? 0) + n;
        s.detail = `${s.count} maps`;
        s.frame = Math.min(s.frame, e.frame);
        if (to !== undefined) s.to = typeof s.to === 'number' ? Math.max(s.to, to) : to;
      }
    }
    out.sort((a, b) => a.t - b.t);
    let excess = out.length - this.maxEvents;
    if (excess > 0) {
      const keep: RunEvent[] = [];
      for (const e of out) {
        if (excess > 0 && e.replay !== true && (e.kind === 'range' || e.kind === 'warning'))
          excess--;
        else keep.push(e);
      }
      this.ev = keep;
    } else {
      this.ev = out;
    }
    this.ver++;
  }
}
