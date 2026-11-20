/** `SpanStatsBackend` on the cala WASM module (`QcMonitor.spanStats`). */
import { initCalaWasm, QcMonitor } from './cala-wasm.ts';
import type { SpanStats, SpanStatsBackend } from './extract-qc.ts';

let fields: Map<string, number> | null = null;

function index(name: string): number {
  fields ??= new Map(
    QcMonitor.spanStatsFields()
      .split(',')
      .map((f, i) => [f, i]),
  );
  const i = fields.get(name);
  if (i === undefined) throw new Error(`QcMonitor.spanStats has no field ${name}.`);
  return i;
}

export const spanStatsWasm: SpanStatsBackend = {
  stats(trace: Float32Array, fps: number): SpanStats {
    // Model noise unknown here: exact zeros count as zero (the solver clips to 0).
    const v = QcMonitor.spanStats(trace, NaN, fps);
    return {
      peakSnr: v[index('peak_snr')],
      events: v[index('events')],
      eventRate: v[index('event_rate')],
      zeroFrac: v[index('zero_frac')],
      lowSnr: v[index('low_snr')] === 1,
    };
  },
  windowFrames: (fps: number) => QcMonitor.windowFrames(fps),
};

/** Load the module (idempotent) and return the backend. */
export async function loadSpanStats(): Promise<SpanStatsBackend> {
  await initCalaWasm();
  return spanStatsWasm;
}
