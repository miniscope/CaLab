/**
 * Frames rebuilt from a factor window (`FactorWindow`), the same way for the
 * Final settle on factors (look-back worker) and Extract on factors (compress
 * worker): the frame as compressed, NaN where no frame of the window had a
 * valid sample (the live frame had NaN there). Nothing is preprocessed again.
 */

/** A compressed window read back from its factor file (the WASM `FactorWindow`, or a fake). */
export interface FactorWindowLike {
  readonly frames: number;
  /** Stream index of the first frame. */
  readonly start: number;
  reconstruct(t0: number, count: number, out: Float32Array): void;
  /** 1 per pixel never valid in the window (absent in older builds: nothing is marked). */
  neverValid?(): Uint8Array;
  free(): void;
}

/** Frames `t0..t0 + count` of `w` into `out`, NaN on the pixels `never` marks. */
export function rebuildFrames(
  w: FactorWindowLike,
  never: Uint8Array | null,
  t0: number,
  count: number,
  out: Float32Array,
): void {
  w.reconstruct(t0, count, out);
  if (!never) return;
  const px = never.length;
  const marked: number[] = [];
  for (let p = 0; p < px; p++) if (never[p]) marked.push(p);
  for (let k = 0; k < count; k++) for (const p of marked) out[k * px + p] = NaN;
}
