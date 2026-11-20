/**
 * Mean and max projections of the field of view over a run, for the export
 * (format version 4, `fov_mean` / `fov_max`) and the saved-result viewer.
 *
 * Extract feeds every frame of the recording once, in order, with the final
 * flat field from frame 0 and Discover's recorded motion, so the images match
 * the traces in the same export. Each image lives in the domain where it says
 * most, both in preprocessed grey levels at full resolution:
 *
 *   mean: the registered, preprocessed frame before the background floor is
 *         removed (the "Motion-corrected" view): the anatomy, vessels and
 *         glow, what sessions are aligned by;
 *   max:  the same frame with the background floor removed (the "Bg removed"
 *         view, what the cell model fits): every cell that ever fired.
 *
 * Pixels without data in a frame (moved in from outside the FOV mask by the
 * shift; non-finite) are skipped; a pixel with no data in any frame is NaN.
 *
 * A multi-session (Joint) run keeps one pair per session, split at the
 * session boundaries, so each session's export gets its own images. Memory:
 * per session a float64 sum, a uint32 count and a float32 max per pixel
 * (16 bytes per pixel: 5.8 MB for 600 x 600).
 */

/** The projections of one span of frames. */
export interface FovProjectionSpan {
  /** First frame of the span, and the frames that went into it. */
  start: number;
  frames: number;
  /** `height * width`, row-major, preprocessed grey levels (NaN: no data). */
  mean: Float32Array;
  max: Float32Array;
}

/** The projections of a run: one span per session (one for a single recording). */
export interface FovProjections {
  width: number;
  height: number;
  spans: FovProjectionSpan[];
}

interface Acc {
  start: number;
  frames: number;
  sum: Float64Array;
  count: Uint32Array;
  max: Float32Array;
}

export class FovProjector {
  private readonly px: number;
  private readonly accs: Acc[] = [];

  /** `boundaries`: first frames of sessions 1.. (empty for one recording). */
  constructor(
    readonly width: number,
    readonly height: number,
    private readonly boundaries: readonly number[] = [],
  ) {
    this.px = width * height;
  }

  /** The accumulator of the session holding `frame`. */
  private accFor(frame: number): Acc {
    let s = 0;
    while (s < this.boundaries.length && frame >= this.boundaries[s]) s++;
    const start = s === 0 ? 0 : this.boundaries[s - 1];
    let a = this.accs.find((x) => x.start === start);
    if (!a) {
      a = {
        start,
        frames: 0,
        sum: new Float64Array(this.px),
        count: new Uint32Array(this.px),
        max: new Float32Array(this.px).fill(-Infinity),
      };
      this.accs.push(a);
    }
    return a;
  }

  /**
   * Frames `start .. start + count` (row-major, frame after frame) before the
   * background floor is removed: they feed the mean.
   */
  addRegistered(frames: Float32Array, start: number, count: number): void {
    const px = this.px;
    for (let k = 0; k < count; k++) {
      const a = this.accFor(start + k);
      a.frames++;
      const o = k * px;
      const { sum, count: n } = a;
      for (let i = 0; i < px; i++) {
        const v = frames[o + i];
        if (Number.isFinite(v)) {
          sum[i] += v;
          n[i]++;
        }
      }
    }
  }

  /** The same frames with the background floor removed: they feed the max. */
  addOutput(frames: Float32Array, start: number, count: number): void {
    const px = this.px;
    for (let k = 0; k < count; k++) {
      const m = this.accFor(start + k).max;
      const o = k * px;
      for (let i = 0; i < px; i++) {
        const v = frames[o + i];
        if (v > m[i]) m[i] = v;
      }
    }
  }

  /** The images so far, one span per session seen, in frame order. */
  result(): FovProjections {
    const spans = [...this.accs]
      .sort((a, b) => a.start - b.start)
      .map((a) => {
        const mean = new Float32Array(this.px);
        const max = new Float32Array(this.px);
        for (let i = 0; i < this.px; i++) {
          mean[i] = a.count[i] > 0 ? a.sum[i] / a.count[i] : NaN;
          max[i] = a.max[i] === -Infinity ? NaN : a.max[i];
        }
        return { start: a.start, frames: a.frames, mean, max };
      });
    return { width: this.width, height: this.height, spans };
  }
}

/**
 * The projections of frames `[start, end)`: the spans inside it, combined
 * (frame-weighted mean, max of maxes). Null when no span lies inside.
 */
export function projectionFor(
  p: FovProjections | null | undefined,
  range: { start: number; end: number },
): { mean: Float32Array; max: Float32Array; frames: number } | null {
  if (!p) return null;
  const spans = p.spans.filter((s) => s.start >= range.start && s.start + s.frames <= range.end);
  if (spans.length === 0) return null;
  if (spans.length === 1)
    return { mean: spans[0].mean, max: spans[0].max, frames: spans[0].frames };
  const px = p.width * p.height;
  const mean = new Float32Array(px);
  const max = new Float32Array(px).fill(NaN);
  let frames = 0;
  for (const s of spans) frames += s.frames;
  for (let i = 0; i < px; i++) {
    let sum = 0;
    let w = 0;
    for (const s of spans) {
      const v = s.mean[i];
      if (Number.isFinite(v)) {
        sum += v * s.frames;
        w += s.frames;
      }
      const m = s.max[i];
      if (Number.isFinite(m) && !(m <= max[i])) max[i] = m;
    }
    mean[i] = w > 0 ? sum / w : NaN;
  }
  return { mean, max, frames };
}
