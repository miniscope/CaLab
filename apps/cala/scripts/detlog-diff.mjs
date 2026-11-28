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
 * it prints the first key handled at another live frame with equal content (`when`) and the
 * first key whose content differs (`what`), with the live frames observed at that row in each
 * run, and the first position where the two logs handle different rows (`log order`, e.g. a
 * visit result and a look-back answer between the same two batches in the other order); the
 * findings are ranked by that observed frame. Discover only (rows before the `end` row) unless `--settle` (the Final settle).
 * In the Final settle the `observed` column is the live frames plus the settle frames fed, and a
 * repeatable run logs `ans end` rows in request order (as answers are taken up), so they match by
 * ordinal; without repeatable they are in arrival order.
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
  /** Every keyed row in log order: `{ id: 'class#key', observed }`. */
  const seq = [];
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
    seq.push({ id: `${cls}#${key}`, observed });
  }
  return { rows: rows.length, classes, seq };
}

const a = load(files[0]);
const b = load(files[1]);

/**
 * Per row class, two findings: `when`, the first key observed at another live frame (the
 * row's content equal), and `what`, the first key whose content differs (or that only one run
 * has). Each is null when there is none.
 */
const report = [];
for (const cls of new Set([...a.classes.keys(), ...b.classes.keys()])) {
  const ma = a.classes.get(cls) ?? new Map();
  const mb = b.classes.get(cls) ?? new Map();
  const keys = [...new Set([...ma.keys(), ...mb.keys()])].sort((x, y) => x - y);
  let when = null;
  let what = null;
  for (const k of keys) {
    const ra = ma.get(k) ?? null;
    const rb = mb.get(k) ?? null;
    if (!ra || !rb) {
      what ??= { key: k, observed: (ra ?? rb).observed, a: ra, b: rb, fields: ['missing'] };
      break;
    }
    const fields = Object.keys(ra).filter(
      (n) => n !== 'observed' && !IGNORE.has(n) && ra[n] !== rb[n],
    );
    const observed = Math.min(ra.observed, rb.observed);
    if (fields.length) what ??= { key: k, observed, a: ra, b: rb, fields };
    else if (ra.observed !== rb.observed) when ??= { key: k, observed, a: ra, b: rb, fields: [] };
    if (what && when) break;
  }
  for (const [kind, f] of [
    ['when', when],
    ['what', what],
  ])
    report.push({ cls, kind, a: ma.size, b: mb.size, first: f });
}
// `order`: the first place the two logs handle different rows (e.g. a visit result and a
// look-back answer between the same two batches, in the other order).
const n = Math.min(a.seq.length, b.seq.length);
let at = 0;
while (at < n && a.seq[at].id === b.seq[at].id) at++;
const order =
  at < Math.max(a.seq.length, b.seq.length)
    ? {
        key: at,
        observed: Math.min(a.seq[at]?.observed ?? Infinity, b.seq[at]?.observed ?? Infinity),
        a: a.seq[at] ?? null,
        b: b.seq[at] ?? null,
        fields: ['id'],
      }
    : null;
report.push({ cls: 'log order', kind: 'row', a: a.seq.length, b: b.seq.length, first: order });
report.sort((x, y) => (x.first?.observed ?? Infinity) - (y.first?.observed ?? Infinity));

if (args.includes('--json')) {
  console.log(JSON.stringify(report, null, 1));
} else {
  console.log(
    `rows: ${a.rows} vs ${b.rows} (${withSettle ? 'Discover + Final settle' : 'Discover'}); ` +
      '`when`: same content at another live frame; `what`: different content',
  );
  for (const r of report) {
    const f = r.first;
    const head = `${r.cls.padEnd(12)} ${r.kind} ${String(r.a).padStart(5)} / ${String(r.b).padEnd(5)}`;
    if (!f) {
      console.log(`${head} identical`);
      continue;
    }
    const show = (x) =>
      x ? f.fields.map((n) => (n === 'missing' ? 'present' : `${n}=${x[n]}`)).join(' ') : 'absent';
    console.log(
      `${head} #${f.key} at observed ${f.a?.observed ?? '-'} vs ${f.b?.observed ?? '-'}` +
        (f.fields.length ? `: ${f.fields.join(',')} | a: ${show(f.a)} | b: ${show(f.b)}` : ''),
    );
  }
}
