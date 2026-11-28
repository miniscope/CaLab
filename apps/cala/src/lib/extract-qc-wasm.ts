/** `SpanStatsBackend` on the cala WASM module (`QcMonitor.spanStats`). */
import { initCalaWasm, QcMonitor } from './cala-wasm.ts';
import type { SpanStats, SpanStatsBackend } from './extract-qc.ts';
import { paramsHandle } from './params-handle.ts';

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

/** The backend with the QC settings of `params` (a run's resolved params, `run-params.ts`). */
export function spanStatsWasm(params: string): SpanStatsBackend {
  return {
    stats(trace: Float32Array, fps: number): SpanStats {
      // Model noise unknown here: exact zeros count as zero (the solver clips to 0).
      const v = QcMonitor.spanStats(trace, NaN, paramsHandle(params), fps);
      return {
        peakSnr: v[index('peak_snr')],
        events: v[index('events')],
        eventRate: v[index('event_rate')],
        zeroFrac: v[index('zero_frac')],
        lowSnr: v[index('low_snr')] === 1,
      };
    },
    windowFrames: (fps: number) => QcMonitor.windowFrames(paramsHandle(params), fps),
  };
}

/** Load the module (idempotent) and return the backend of `params`. */
export async function loadSpanStats(params: string): Promise<SpanStatsBackend> {
  await initCalaWasm();
  return spanStatsWasm(params);
}
