/**
 * The determinism log (`?debug&detlog`, measurement only): one row per state-changing call of the
 * slow worker during a run, stamped with the live frames observed at that moment (in the Final
 * settle, plus the settle frames fed), so two runs of
 * the same recording at the same settings can be diffed (`apps/cala/scripts/detlog-diff.mjs`)
 * and the first divergence named. Logging changes no decision; hashing costs the slow worker a
 * little time, so a logged run is compared only with other logged runs.
 *
 * Row layout: `[kind, observed, ...fields]`, numbers only besides `kind` and the request kind.
 * Rows whose key is a stable id (batch start, take sequence, request id, library version) can be
 * matched across runs whatever order the messages arrived in.
 */

/** One row: kind, live frames observed so far (plus Final settle frames fed), then the kind's fields (see `DetLogKind`). */
export type DetLogRow = [DetLogKind, number, ...(number | string)[]];

/**
 * Row kinds and their fields after `observed`:
 * - `batch`: start, count, library version the fast loop used, `SlowLoop.work` before the batch;
 * - `take`: take sequence, visit worker, hash of the job bytes;
 * - `apply`: take sequence, visit worker, hash of the result bytes, `SlowLoop.work` before;
 * - `pub`: library version, hash of the library bytes;
 * - `req`: request id, look-back worker, request kind, frames, hash of the request's frame list;
 * - `ans`: request id, look-back worker, request kind, library version solved with (-1: an
 *   error), hash of the answer's traces;
 * - `end`: Discover's last frame is in (`SlowRunner.end`);
 * - `final`: the final library is published.
 */
export type DetLogKind = 'batch' | 'take' | 'apply' | 'pub' | 'req' | 'ans' | 'end' | 'final';

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a over a typed array's bytes, 32-bit words at a time (the tail byte by byte), unsigned.
 * Equal bytes give equal hashes; it is a fingerprint for diffing runs, not a checksum.
 */
export function fnvBytes(view: ArrayBufferView): number {
  const n = view.byteLength;
  // An unaligned view is hashed from an aligned copy, so the hash depends on the bytes only.
  if (view.byteOffset % 4 !== 0)
    return fnvBytes(new Uint8Array(view.buffer, view.byteOffset, n).slice());
  const words = n >>> 2;
  let h = FNV_OFFSET;
  const w = new Uint32Array(view.buffer, view.byteOffset, words);
  for (let i = 0; i < words; i++) h = Math.imul(h ^ w[i], FNV_PRIME);
  const b = new Uint8Array(view.buffer, view.byteOffset, n);
  for (let i = words * 4; i < n; i++) h = Math.imul(h ^ b[i], FNV_PRIME);
  return (h ^ n) >>> 0;
}

/** Rows buffered in the slow worker until `take` hands them over (one message per flush). */
export class DetLog {
  private rows: DetLogRow[] = [];

  /** Append a row. */
  row(kind: DetLogKind, observed: number, ...fields: (number | string)[]): void {
    this.rows.push([kind, observed, ...fields]);
  }

  /** The rows since the last call (empty when none), handed over and cleared. */
  take(): DetLogRow[] {
    const out = this.rows;
    this.rows = [];
    return out;
  }
}

/** The page's determinism log of the newest session (`globalThis.__calaDetlog`; the driver reads it). */
export interface PageDetlog {
  session: number;
  rows: DetLogRow[];
}

/**
 * Keep rows from the slow worker on the page (`globalThis.__calaDetlog`): appended within a
 * session, started afresh by a newer one, ignored from an older one.
 */
export function keepDetlog(msg: { session: number; rows: DetLogRow[] }): void {
  const g = globalThis as { __calaDetlog?: PageDetlog };
  const cur = g.__calaDetlog;
  if (!cur || msg.session > cur.session)
    g.__calaDetlog = { session: msg.session, rows: [...msg.rows] };
  else if (msg.session === cur.session) for (const r of msg.rows) cur.rows.push(r);
}
