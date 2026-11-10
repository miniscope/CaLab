/**
 * The export of a live run. A live source has no file to re-read, so there
 * is no pass 2: the traces exported are the ones the fast loop solved as the
 * frames came in (the trace history), laid out frames x cells from frame 0
 * like a pass-2 result. A cell's frames before it was found, and frames a
 * bounded history no longer holds, are NaN.
 */
import type { CellStore } from './cell-store.ts';
import type { Pass2Result } from './pass2-store.ts';
import { MAX_MEMORY_TRACE_BYTES, MemoryBackend, TraceFile } from './trace-file.ts';

/** Frames copied per step while filling the trace file. */
const STEP_FRAMES = 1024;

/**
 * The live traces of the cells in the current library over `frames` frames
 * as a pass-2 result (null without a library). Throws when the matrix is too
 * large to hold in memory.
 */
export async function liveTraceResult(
  cells: Pick<CellStore, 'library' | 'history'>,
  frames: number,
  seconds: number,
): Promise<Pass2Result | null> {
  const library = cells.library();
  if (!library || library.ids.length === 0 || frames < 1) return null;
  const ids = library.ids.slice();
  const n = ids.length;
  const bytes = frames * n * 4;
  if (bytes > MAX_MEMORY_TRACE_BYTES)
    throw new Error(
      `${n} cells x ${frames.toLocaleString()} frames of live traces is more than fits in memory.`,
    );
  const history = cells.history();
  const file = new TraceFile(frames, n, new MemoryBackend(bytes), 'memory');
  for (let f = 0; f < frames; f += STEP_FRAMES) {
    const count = Math.min(STEP_FRAMES, frames - f);
    const block = new Float32Array(count * n);
    for (let j = 0; j < n; j++) {
      const trace = history.range(ids[j], f, f + count);
      for (let i = 0; i < count; i++) block[i * n + j] = trace[i];
    }
    file.append(f, block);
  }
  await file.finish();
  return { ids, traces: file, frames, cells: n, version: library.version, library, seconds };
}
