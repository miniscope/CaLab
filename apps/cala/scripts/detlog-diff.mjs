#!/usr/bin/env node
/**
 * Where two cala runs first differ, from their determinism logs (`?debug&detlog`;
 * `memory-measure.mjs --detlog` saves `<tag>-detlog.json`; row layout in `src/lib/detlog.ts`).
 *
 *   node apps/cala/scripts/detlog-diff.mjs a-detlog.json b-detlog.json [--settle] [--json]
 *
 * Rows are matched by stable keys, not by position (results arrive in timing order):
 * batches by start frame, visit takes and applies by take sequence, libraries by version,
 * look-back requests and answers by kind and their ordinal within the kind. For each row class
 * it prints the first key whose fields differ, the live frames observed at that row in each run,
 * and which fields differ; the classes are ranked by the observed frame of their first
 * difference. Discover only (rows before the `end` row) unless `--settle` (the Final settle).
 *
 * Reading it (mechanisms as in the cala repeatability diagnosis):
 * - `req csettle` first: Background settle asked for other frames or at another frame
 *   (its dose or schedule);
 * - `take`/`apply` first by `observed`: a visit was handed out or applied at another frame
 *   (visit results applied on arrival); by `hash` with the same `observed`: the state it was
 *   taken from already differed;
 * - `ans` first with equal `req` rows: the same request was answered differently (`version`:
 *   solved with another library; `traces` only: preprocessed from another back state);
 * - `batch version` first: the fast loop used another library for that batch;
 * - `batch work` only dates the divergence: the first batch the slow loop reached with a
 *   different amount of work done.
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--'));
if (files.length !== 2) {
  console.error('usage: detlog-diff.mjs a-detlog.json b-detlog.json [--settle] [--json]');
  process.exit(2);
}
const withSettle = args.includes('--settle');

/** Fields after `[kind, observed]`, by kind (`src/lib/detlog.ts`). */
const FIELDS = {
  batch: ['start', 'count', 'version', 'work'],
  take: ['seq', 'worker', 'job'],
  apply: ['seq', 'worker', 'result', 'work'],
  pub: ['version', 'bytes'],
  req: ['id', 'port', 'kind', 'frames', 'list'],
  ans: ['id', 'port', 'kind', 'version', 'traces'],
  end: [],
  final: [],
};
/** Fields that differ between runs without meaning a different decision (ids, worker slots). */
const IGNORE = new Set(['id', 'port', 'worker', 'seq']);

/** The log's rows of the asked phase, grouped into classes of keyed records. */
function load(path) {
  const { rows } = JSON.parse(readFileSync(path, 'utf8'));
  const classes = new Map();
  const ordinal = new Map();
  let phase = 'discover';
  for (const row of rows) {
    const [kind, observed, ...rest] = row;
    if (kind === 'end') phase = 'settle';
    if (phase === 'settle' && !withSettle) break;
    const f = Object.fromEntries((FIELDS[kind] ?? []).map((n, i) => [n, rest[i]]));
    let cls = kind;
    let key;
    if (kind === 'batch') key = f.start;
    else if (kind === 'take' || kind === 'apply') key = f.seq;
    else if (kind === 'pub') key = f.version;
    else if (kind === 'req' || kind === 'ans') {
      cls = `${kind} ${f.kind}`;
      const n = (ordinal.get(cls) ?? 0) + 1;
      ordinal.set(cls, n);
      key = n;
    } else continue;
    if (!classes.has(cls)) classes.set(cls, new Map());
    classes.get(cls).set(key, { observed, ...f });
  }
  return { rows: rows.length, classes };
}

const a = load(files[0]);
const b = load(files[1]);
const report = [];
for (const cls of new Set([...a.classes.keys(), ...b.classes.keys()])) {
  const ma = a.classes.get(cls) ?? new Map();
  const mb = b.classes.get(cls) ?? new Map();
  const keys = [...new Set([...ma.keys(), ...mb.keys()])].sort((x, y) => x - y);
  let first = null;
  for (const k of keys) {
    const ra = ma.get(k);
    const rb = mb.get(k);
    if (!ra || !rb) {
      first = {
        key: k,
        observed: (ra ?? rb).observed,
        a: ra ?? null,
        b: rb ?? null,
        fields: ['missing'],
      };
      break;
    }
    const fields = Object.keys(ra).filter((n) => !IGNORE.has(n) && ra[n] !== rb[n]);
    if (fields.length) {
      first = { key: k, observed: Math.min(ra.observed, rb.observed), a: ra, b: rb, fields };
      break;
    }
  }
  report.push({ cls, a: ma.size, b: mb.size, first });
}
report.sort((x, y) => (x.first?.observed ?? Infinity) - (y.first?.observed ?? Infinity));

if (args.includes('--json')) {
  console.log(JSON.stringify(report, null, 1));
} else {
  console.log(
    `rows: ${a.rows} vs ${b.rows} (${withSettle ? 'Discover + Final settle' : 'Discover'})`,
  );
  for (const r of report) {
    const f = r.first;
    const head = `${r.cls.padEnd(13)} ${String(r.a).padStart(5)} / ${String(r.b).padEnd(5)}`;
    if (!f) {
      console.log(`${head} identical`);
      continue;
    }
    const show = (x) =>
      x ? f.fields.map((n) => (n === 'missing' ? '' : `${n}=${x[n]}`)).join(' ') : 'absent';
    console.log(
      `${head} first differs at #${f.key} (observed ${f.a?.observed ?? '-'} vs ${f.b?.observed ?? '-'}): ` +
        `${f.fields.join(',')} | a: ${show(f.a)} | b: ${show(f.b)}`,
    );
  }
}
