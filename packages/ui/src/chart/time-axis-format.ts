// Pure time-axis helpers for stream-time plots (seconds since stream start).
// Units adapt to the window span (cala History design, section 3.3).

const H = 3600;
const DAY = 86400;

/** Candidate tick steps in seconds, ascending. */
const STEPS_S = [
  1,
  2,
  5,
  10,
  15,
  30,
  60,
  120,
  300,
  600,
  900,
  1800,
  H,
  2 * H,
  3 * H,
  6 * H,
  12 * H,
  DAY,
  2 * DAY,
];
/** Day multiples used once 2 d ticks are still too dense. */
const DAY_MULTIPLES = [3, 5, 7, 10, 14, 30, 60, 90, 180, 365];

const p2 = (x: number) => String(x).padStart(2, '0');

/**
 * Smallest step (s) from the ladder that keeps ticks at least `minPx` apart
 * over `widthPx` pixels covering `spanS` seconds.
 */
export function chooseTimeStep(spanS: number, widthPx: number, minPx = 55): number {
  const maxTicks = Math.max(1, Math.floor(widthPx / minPx));
  for (const s of STEPS_S) if (spanS / s <= maxTicks) return s;
  for (const m of DAY_MULTIPLES) if (spanS / (m * DAY) <= maxTicks) return m * DAY;
  return Math.ceil(spanS / maxTicks / DAY) * DAY;
}

export interface TimeTick {
  t: number;
  label: string;
}

/** Tick positions (stream s) and labels for the window [t0, t1] drawn `widthPx` wide. */
export function timeTicks(t0: number, t1: number, widthPx: number): TimeTick[] {
  const span = t1 - t0;
  if (!(span > 0) || !(widthPx > 0)) return [];
  const step = chooseTimeStep(span, widthPx);
  const out: TimeTick[] = [];
  const longRun = t1 > DAY;
  for (let t = Math.ceil(t0 / step - 1e-9) * step + 0, i = 0; t <= t1 + 1e-6; t += step, i++) {
    const r = Math.round(t);
    const d = Math.floor(r / DAY);
    const h = Math.floor((r % DAY) / H);
    const m = Math.floor((r % H) / 60);
    const s = r % 60;
    const midnight = h === 0 && m === 0 && s === 0;
    let label: string;
    if (span >= 2 * DAY) {
      label = midnight ? `d${d}` : `d${d} ${p2(h)}:${p2(m)}`;
    } else if (span >= 2 * H) {
      if (longRun) {
        label = midnight ? `d${d}` : i === 0 ? `d${d} ${p2(h)}:${p2(m)}` : `${p2(h)}:${p2(m)}`;
      } else {
        label = `${Math.floor(r / H)}:${p2(m)}`;
      }
    } else if (r >= H) {
      label = `${Math.floor(r / H)}:${p2(m)}:${p2(s)}`;
    } else {
      label = `${Math.floor(r / 60)}:${p2(s)}`;
    }
    out.push({ t, label });
  }
  return out;
}

/** Elapsed stream time for readouts: `m:ss`, `h:mm:ss`, or `dD hh:mm:ss` (days). */
export function formatElapsed(t: number, spanS?: number): string {
  if (!Number.isFinite(t)) return '–';
  const r = Math.max(0, Math.round(t));
  const d = Math.floor(r / DAY);
  const h = Math.floor((r % DAY) / H);
  const m = Math.floor((r % H) / 60);
  const s = r % 60;
  if (d > 0 || (spanS !== undefined && spanS > DAY)) return `d${d} ${p2(h)}:${p2(m)}:${p2(s)}`;
  if (h > 0) return `${h}:${p2(m)}:${p2(s)}`;
  return `${m}:${p2(s)}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Wall clock for hover/click readouts, local time, e.g. "Tue 14:20:05". */
export function formatClock(wallMs: number): string {
  if (!Number.isFinite(wallMs)) return '';
  const d = new Date(wallMs);
  return `${WEEKDAYS[d.getDay()]} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
