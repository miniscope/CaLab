/**
 * The strip helpers' jobs (`?debug&obsstrips=N`; experimental): cutting a batch's frames into the
 * rows each strip needs (slow worker) and summing one job (strip helper, or the slow worker itself
 * when a helper failed). See `workers/strip-types.ts` and `discover/strips.rs`.
 */
import type { OwnerToStrip } from '../workers/strip-types.ts';

export type StripJob = Extract<OwnerToStrip, { type: 'job' }>;

/** What a job needs of the WASM `SettleDeltaBuilder`. */
export interface StripBuilderLike {
  begin(context: Uint8Array): void;
  push(
    frame: Float32Array,
    library: unknown,
    traces: Float32Array,
    background: Float32Array | undefined,
    stream: number,
  ): void;
  finish(): Uint8Array;
}

/** The frames of a batch as they reached the slow worker. */
export interface BatchFrames {
  width: number;
  /** `count` whole frames, one after another (at least `count * width * height` values). */
  frames: Float32Array;
  /** `count * cells` traces. */
  traces: Float32Array;
  cells: number;
  /** `count * nb` background coefficients (absent: none). */
  background?: Float32Array;
  count: number;
  height: number;
}

/**
 * Job `i` of a strip batch: its rows of the fitting frames (`fit`: indices into the batch), their
 * traces and background, copied into fresh buffers (to be transferred).
 */
export function stripJob(
  b: BatchFrames,
  fit: readonly number[],
  keys: Float64Array,
  rows: { row0: number; row1: number },
  base: { session: number; id: number; version: number; context: Uint8Array },
): StripJob {
  const { width: w, height: h, cells } = b;
  const px = w * h;
  const span = (rows.row1 - rows.row0) * w;
  const frames = new Float32Array(fit.length * span);
  const traces = new Float32Array(fit.length * cells);
  const nb = b.background && b.count > 0 ? b.background.length / b.count : 0;
  const background = b.background ? new Float32Array(fit.length * nb) : undefined;
  fit.forEach((f, j) => {
    const at = f * px + rows.row0 * w;
    frames.set(b.frames.subarray(at, at + span), j * span);
    traces.set(b.traces.subarray(f * cells, (f + 1) * cells), j * cells);
    if (background && b.background)
      background.set(b.background.subarray(f * nb, (f + 1) * nb), j * nb);
  });
  return {
    type: 'job',
    ...base,
    row0: rows.row0,
    row1: rows.row1,
    keys,
    frames,
    traces,
    cells,
    ...(background ? { background } : {}),
  };
}

/** The buffers a job transfers. */
export function stripJobTransfer(job: StripJob): Transferable[] {
  const t: Transferable[] = [job.frames.buffer as ArrayBuffer, job.traces.buffer as ArrayBuffer];
  if (job.background) t.push(job.background.buffer as ArrayBuffer);
  return t;
}

/** Sum one job on `builder` with `library` (the batch's); returns the delta's bytes. */
export function runStripJob(
  builder: StripBuilderLike,
  library: unknown,
  job: Pick<StripJob, 'context' | 'keys' | 'frames' | 'traces' | 'cells' | 'background'>,
): Uint8Array {
  builder.begin(job.context);
  const n = job.keys.length;
  const span = n > 0 ? job.frames.length / n : 0;
  const nb = job.background && n > 0 ? job.background.length / n : 0;
  for (let j = 0; j < n; j++) {
    builder.push(
      job.frames.subarray(j * span, (j + 1) * span),
      library,
      job.traces.subarray(j * job.cells, (j + 1) * job.cells),
      job.background?.subarray(j * nb, (j + 1) * nb),
      job.keys[j],
    );
  }
  return builder.finish();
}
