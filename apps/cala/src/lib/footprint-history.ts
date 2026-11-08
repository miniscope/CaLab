/**
 * How each cell's footprint changed over the run, for the selected-cell view.
 *
 * Every published library version is offered (`record`); a cell gets a new
 * snapshot only when its footprint differs from its previous one. A snapshot
 * is the footprint cropped to its support (plus a small pad) and quantized to
 * 8 bits of its own peak, so a typical 25 x 25 px cell costs well under 1 KB.
 * Bounds: `maxPerCell` snapshots per cell (the oldest after the first go:
 * the first shows the cell as found) and `maxBytes` in total (the cell with
 * the most snapshots is thinned the same way). Cells that leave the library
 * are dropped by `retain`. Pure, unit-tested.
 */
import type { LibraryView } from '../workers/slow-types.ts';

export interface FootprintSnapshot {
  /** Library version that published it, and the stream frame it was published after. */
  version: number;
  frame: number;
  /** Crop box in image pixels. */
  x0: number;
  y0: number;
  w: number;
  h: number;
  /** Footprint value of the crop's brightest pixel. */
  peak: number;
  /** `w * h` values, row-major, 0..255 of `peak` (0 also outside the support). */
  data: Uint8Array;
}

interface CellFootprints {
  hash: number;
  snaps: FootprintSnapshot[];
}

/** Pad around the support, px. */
export const FOOTPRINT_PAD = 6;
/** Bookkeeping per snapshot, bytes (rough). */
const SNAP_OVERHEAD = 64;

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** FNV-1a over the support's pixel indices and value bits. */
function footprintHash(view: LibraryView, a: number, b: number): number {
  let h = 0x811c9dc5;
  for (let k = a; k < b; k++) {
    f32[0] = view.values[k];
    h = Math.imul(h ^ view.pixels[k], 0x01000193);
    h = Math.imul(h ^ u32[0], 0x01000193);
  }
  return (h ^ (b - a)) >>> 0;
}

function snapshot(view: LibraryView, a: number, b: number): FootprintSnapshot {
  const W = view.width;
  let y0 = view.height;
  let x0 = W;
  let y1 = 0;
  let x1 = 0;
  let peak = 0;
  for (let k = a; k < b; k++) {
    const p = view.pixels[k];
    const y = Math.floor(p / W);
    const x = p - y * W;
    if (y < y0) y0 = y;
    if (x < x0) x0 = x;
    if (y + 1 > y1) y1 = y + 1;
    if (x + 1 > x1) x1 = x + 1;
    if (view.values[k] > peak) peak = view.values[k];
  }
  y0 = Math.max(0, y0 - FOOTPRINT_PAD);
  x0 = Math.max(0, x0 - FOOTPRINT_PAD);
  y1 = Math.min(view.height, y1 + FOOTPRINT_PAD);
  x1 = Math.min(W, x1 + FOOTPRINT_PAD);
  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);
  const data = new Uint8Array(w * h);
  if (peak > 0) {
    for (let k = a; k < b; k++) {
      const p = view.pixels[k];
      const y = Math.floor(p / W) - y0;
      const x = (p % W) - x0;
      data[y * w + x] = Math.round((255 * Math.max(0, view.values[k])) / peak);
    }
  }
  return { version: view.version, frame: view.frame, x0, y0, w, h, peak, data };
}

const sizeOf = (s: FootprintSnapshot) => s.data.length + SNAP_OVERHEAD;

export class FootprintHistory {
  readonly maxPerCell: number;
  readonly maxBytes: number;
  private readonly cells = new Map<number, CellFootprints>();
  private held = 0;
  private snaps = 0;

  constructor(maxPerCell = 64, maxBytes = 50 * 1048576) {
    this.maxPerCell = Math.max(2, Math.floor(maxPerCell));
    this.maxBytes = Math.max(1, Math.floor(maxBytes));
  }

  /** Bytes held (crops plus a rough per-snapshot overhead), and snapshots held. */
  get bytes(): number {
    return this.held;
  }

  get count(): number {
    return this.snaps;
  }

  /** Offer a published library: cells whose footprint changed get a snapshot. */
  record(view: LibraryView): void {
    for (let slot = 0; slot < view.ids.length; slot++) {
      const a = view.starts[slot];
      const b = view.starts[slot + 1];
      if (b <= a) continue;
      const id = view.ids[slot];
      const hash = footprintHash(view, a, b);
      let cell = this.cells.get(id);
      if (cell && cell.hash === hash) continue;
      if (!cell) {
        cell = { hash, snaps: [] };
        this.cells.set(id, cell);
      }
      cell.hash = hash;
      const snap = snapshot(view, a, b);
      cell.snaps.push(snap);
      this.held += sizeOf(snap);
      this.snaps++;
      if (cell.snaps.length > this.maxPerCell) this.thin(cell);
    }
    while (this.held > this.maxBytes && this.thinFullest()) {
      // Each pass drops one snapshot from the cell holding the most.
    }
  }

  /** Drop the oldest snapshot after the first (the cell as found). */
  private thin(cell: CellFootprints): boolean {
    if (cell.snaps.length < 3) return false;
    const [gone] = cell.snaps.splice(1, 1);
    this.held -= sizeOf(gone);
    this.snaps--;
    return true;
  }

  private thinFullest(): boolean {
    let fullest: CellFootprints | null = null;
    for (const c of this.cells.values()) {
      if (!fullest || c.snaps.length > fullest.snaps.length) fullest = c;
    }
    return fullest ? this.thin(fullest) : false;
  }

  /** Snapshots of `id`, oldest first (empty when unknown). */
  get(id: number): readonly FootprintSnapshot[] {
    return this.cells.get(id)?.snaps ?? [];
  }

  /** Drop every cell not in `ids` (except `keep`, e.g. the selected cell). */
  retain(ids: Iterable<number>, keep?: number | null): void {
    const live = new Set(ids);
    if (keep !== undefined && keep !== null) live.add(keep);
    for (const [id, cell] of [...this.cells]) {
      if (live.has(id)) continue;
      for (const s of cell.snaps) this.held -= sizeOf(s);
      this.snaps -= cell.snaps.length;
      this.cells.delete(id);
    }
  }

  clear(): void {
    this.cells.clear();
    this.held = 0;
    this.snaps = 0;
  }
}
