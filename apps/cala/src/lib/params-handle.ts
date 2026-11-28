/**
 * The wasm handles of resolved params in this thread: what the engine constructors take
 * (`new SlowLoop(.., params)`). Each worker gets the resolved JSON in its init message
 * (`run-params.ts`) and turns it into a handle here.
 */
import { ResolvedParams, resolveParams } from './cala-wasm.ts';
import { paramsContext, type ParamsLayer } from './run-params.ts';

let cached: { json: string; handle: ResolvedParams } | null = null;

/**
 * The handle of `json` (`ResolvedParams.toJson`'s text). Rebuilt only when the text changes
 * (a new run); the previous handle is freed then. Constructors only read it, so the handle is
 * never held past the next run's.
 */
export function paramsHandle(json: string): ResolvedParams {
  if (cached?.json !== json) {
    const handle = ResolvedParams.fromJson(json);
    cached?.handle.free();
    cached = { json, handle };
  }
  return cached.handle;
}

/**
 * Resolve a run's params layer against its recording, once per run (the frame worker, at the
 * pipeline's start): the resolved JSON every other worker is sent. Throws the resolve errors as
 * `[{pointer, message}]` JSON.
 */
export function resolveRunParams(
  layer: ParamsLayer,
  info: { fps?: number | null; width: number; height: number },
): string {
  const r = resolveParams(JSON.stringify(layer), JSON.stringify(paramsContext(info)));
  try {
    return r.toJson();
  } finally {
    r.free();
  }
}
