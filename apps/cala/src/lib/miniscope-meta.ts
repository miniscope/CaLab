/**
 * Miniscope recording sidecar files: `metaData.json` (nominal settings) and
 * `timeStamps.csv` (one row per frame). The AVI header's own frame rate is
 * never used: real 20 fps files declare 60.
 */

export interface MiniscopeMetadata {
  /** Nominal frame rate from `frameRate` (`"20FPS"` or a number), if present. */
  frameRate: number | null;
  framesPerFile: number | null;
  deviceType: string | null;
}

/** Parse a Miniscope `metaData.json`. Returns null if the text is not a JSON object. */
export function parseMetadata(text: string): MiniscopeMetadata | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  let deviceType: string | null = null;
  if (typeof o.deviceType === 'string') deviceType = o.deviceType;
  else if (typeof o.deviceName === 'string') deviceType = o.deviceName;
  return {
    frameRate: parseFrameRate(o.frameRate),
    framesPerFile: positiveNumber(o.framesPerFile),
    deviceType,
  };
}

function positiveNumber(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/** `"20FPS"`, `"30 fps"`, `"15.5"` or `20` -> Hz; anything else -> null. */
export function parseFrameRate(v: unknown): number | null {
  if (typeof v === 'number') return positiveNumber(v);
  if (typeof v !== 'string') return null;
  const m = /^\s*([0-9]*\.?[0-9]+)\s*(?:fps|hz)?\s*$/i.exec(v);
  return m ? positiveNumber(m[1]) : null;
}

export interface TimeStamps {
  /** Frame timestamps in milliseconds, in file order. */
  ms: Float64Array;
}

/**
 * Parse `timeStamps.csv` (header `Frame Number,Time Stamp (ms),Buffer Index`).
 * The time column is found by header name, so extra or reordered columns
 * work. Returns null when there is no time column or no valid row.
 */
export function parseTimeStamps(text: string): TimeStamps | null {
  const lines = text.split(/\r?\n/);
  const header = (lines[0] ?? '').split(',').map((h) => h.trim().toLowerCase());
  const col = header.findIndex((h) => h.startsWith('time stamp') || h === 'timestamp');
  if (col < 0) return null;
  const values: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const v = Number(lines[i].split(',')[col]);
    if (Number.isFinite(v)) values.push(v);
  }
  return values.length > 0 ? { ms: Float64Array.from(values) } : null;
}

/**
 * Frame rate in Hz from timestamps. Timestamps are integer milliseconds with
 * USB jitter, so one interval is a poor estimate while the mean over a long
 * recording is good (a median is quantised: 51 ms against a true ~50.6 ms is
 * a 0.8% rate error, ~9 s over 20 min). Intervals above twice the median
 * (dropped frames, stalls) are excluded from the mean. Null when the
 * timestamps cannot give a positive interval.
 */
export function fpsFromTimeStamps(ms: Float64Array): number | null {
  if (ms.length < 2) return null;
  const diffs: number[] = [];
  for (let i = 1; i < ms.length; i++) {
    const d = ms[i] - ms[i - 1];
    if (d > 0) diffs.push(d);
  }
  if (diffs.length === 0) return null;
  const sorted = [...diffs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  let sum = 0;
  let n = 0;
  for (const d of diffs) {
    if (d <= 2 * median) {
      sum += d;
      n++;
    }
  }
  return 1000 / (sum / n);
}
