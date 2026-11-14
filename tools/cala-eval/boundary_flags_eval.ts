/**
 * Session-boundary flags on a qc_eval run: feeds the app's `BoundaryMonitor`
 * (apps/cala/src/lib/boundary-flags.ts, the same code the app runs) with what
 * qc_eval logged, and prints each boundary's flag and checks.
 *
 *   node tools/cala-eval/boundary_flags_eval.ts <run dir> --fps F --sessions B1,.. --frames T [--json]
 *
 * The run must be a `--sessions ... --session-fix all` (or `reg,...`) run of a
 * diagnostics build with `--boundary-log --churn-log`: it reads
 * `session_boundaries.tsv` (the fits), `boundary_null.tsv` (the alignment
 * null), `boundary_pre.tsv` (noise map median every 10 frames, floor mean),
 * `adds.tsv` (slow-loop adds by recording frame) and `boundary_traces.bin`
 * (every cell's online trace). Differences from the app: the floor summary is
 * the FOV mean (the app takes the median), imaging is sampled every 10
 * frames (the app: every 32), and adds count at the frame the slow loop
 * made them (the app: at its status messages).
 *
 * Node 23.6+ runs the TypeScript directly (type stripping).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BoundaryMonitor } from '../../apps/cala/src/lib/boundary-flags.ts';
import type { SessionStart } from '../../apps/cala/src/lib/session-boundary.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function tsv(path: string): Record<string, string>[] {
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  const head = lines[0].split('\t');
  return lines.slice(1).map((l) => {
    const c = l.split('\t');
    return Object.fromEntries(head.map((h, i) => [h, c[i] ?? '']));
  });
}

function traces(path: string): Map<number, { t0: number; x: Float32Array }> {
  const b = readFileSync(path);
  if (b.subarray(0, 8).toString() !== 'CALABTL1') throw new Error('not CALABTL1');
  const n = b.readUInt32LE(8);
  let o = 12;
  const out = new Map<number, { t0: number; x: Float32Array }>();
  for (let i = 0; i < n; i++) {
    const id = Number(b.readBigUInt64LE(o));
    const t0 = b.readUInt32LE(o + 8);
    const len = b.readUInt32LE(o + 12);
    o += 16;
    const x = new Float32Array(len);
    for (let k = 0; k < len; k++) x[k] = b.readFloatLE(o + 4 * k);
    o += 8 * len; // traces, then ring levels
    out.set(id, { t0, x });
  }
  return out;
}

const run = process.argv[2];
const fps = Number(arg('--fps') ?? 20);
const boundaries = (arg('--sessions') ?? '').split(',').filter(Boolean).map(Number);
const frames = Number(arg('--frames'));
const batch = 8;

const mon = new BoundaryMonitor({ boundaries, frames, fps });
const starts = new Map<number, SessionStart>();
tsv(join(run, 'session_boundaries.tsv')).forEach((r, k) => {
  const n = (s: string) => (s === '' ? NaN : Number(s));
  starts.set(Number(r.frame), {
    index: k + 1,
    frame: Number(r.frame),
    transform: [n(r.rot_deg), n(r.dy), n(r.dx)],
    fitted: [n(r.fit_rot_deg), n(r.fit_dy), n(r.fit_dx)],
    ncc: n(r.ncc),
    nccUnrotated: n(r.ncc_unrotated),
    chanceNcc: n(r.chance_ncc),
    pinnedRotation: r.pinned_rot === '1',
    pinnedShift: r.pinned_shift === '1',
    floorGain: n(r.floor_gain),
    floorOffset: n(r.floor_offset),
    floorKept: n(r.floor_kept),
    noiseRatio: n(r.noise_ratio),
  });
});
const nulls = tsv(join(run, 'boundary_null.tsv')).map((r) => ({
  frame: Number(r.frame),
  ncc: Number(r.ncc),
}));
const pre = tsv(join(run, 'boundary_pre.tsv'));
const imaging = pre
  .filter((r) => r.noise_p50 !== 'NaN' && r.noise_p50 !== '')
  .map((r) => ({
    frame: Number(r.frame),
    noise: Number(r.noise_p50),
    floor: Number(r.floor_mean),
  }));
const addFrames = tsv(join(run, 'adds.tsv'))
  .map((r) => Number(r.recording_frame))
  .sort((a, b) => a - b);
const cells = traces(join(run, 'boundary_traces.bin'));
const list = [...cells.entries()];

let ni = 0;
let ii = 0;
let ai = 0;
for (let f = 0, count = 0; f < frames; f += count) {
  // Batches of 8, cut short before a boundary (as the app's plan does).
  const next = boundaries.find((b) => b > f) ?? frames;
  count = Math.min(batch, frames - f, next - f);
  const end = f + count;
  const st = starts.get(f);
  if (st) mon.onSessionStart(st);
  while (ni < nulls.length && nulls[ni].frame < end) {
    mon.onNull(nulls[ni].frame, nulls[ni].ncc);
    ni++;
  }
  while (ii < imaging.length && imaging[ii].frame < end) {
    const m = imaging[ii++];
    mon.onImaging(m.frame, m.noise, m.floor);
  }
  while (ai < addFrames.length && addFrames[ai] < end) ai++;
  mon.onAdds(end, ai);
  // Cells with a trace at the batch's first frame (as the fast loop's library).
  const ids: number[] = [];
  for (const [id, c] of list) {
    const k = f - c.t0;
    if (k >= 0 && k < c.x.length && Number.isFinite(c.x[k])) {
      ids.push(id);
    }
  }
  const tr = new Float32Array(count * ids.length);
  for (let j = 0; j < ids.length; j++) {
    const c = cells.get(ids[j])!;
    for (let i = 0; i < count; i++) {
      const v = c.x[f + i - c.t0];
      tr[i * ids.length + j] = Number.isFinite(v) ? v : 0;
    }
  }
  mon.onTraces(f, count, ids, tr);
}
mon.end();
const flags = mon.flags();
if (process.argv.includes('--json')) console.log(JSON.stringify(flags, null, 1));
for (const fl of flags) {
  console.log(
    `boundary ${fl.index} @${fl.frame}: ${fl.severity.toUpperCase()}${fl.pending ? ' (pending)' : ''}`,
  );
  for (const c of fl.checks)
    console.log(
      `  ${c.key.padEnd(13)} ${c.judged ? c.severity.padEnd(7) : 'n/j    '} value ${c.value.toFixed(4).padStart(9)}  null ${c.nullCentre.toFixed(4)} ± ${c.nullSpread.toFixed(4)}  z ${c.z.toFixed(2)}  | ${c.reason}`,
    );
  console.log(`  -> ${fl.reason}`);
}
