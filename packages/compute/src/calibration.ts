// Backend calibration: when the GPU should participate at all.
//
// A pull-based tile queue balances load by itself (a faster consumer simply
// pulls more), so calibration is a gate and a tie-breaker, not a load
// balancer:
//   - gate: the GPU takes part only on a hardware adapter whose measured rate
//     beats the WASM pool's;
//   - tie-breaker (hook, not implemented): a TileAssignPolicy can read
//     consumer.calibration() to keep the last large tile away from the slower
//     consumer.
// Measurements expire (AC vs battery and thermal state change throughput), so
// each run re-measures briefly instead of trusting an old number.

import type { BackendCalibration } from './solve-tiles.ts';

export interface CalibrationStore {
  record(cal: BackendCalibration): void;
  /** Latest measurement for `backend`, or null if none or older than the max age. */
  get(backend: string, now?: number): BackendCalibration | null;
  clear(): void;
}

/** Default max age of a calibration entry: 10 minutes. */
export const CALIBRATION_MAX_AGE_MS = 10 * 60 * 1000;

export function createCalibrationStore(maxAgeMs = CALIBRATION_MAX_AGE_MS): CalibrationStore {
  const entries = new Map<string, BackendCalibration>();
  return {
    record(cal) {
      entries.set(cal.backend, cal);
    },
    get(backend, now = Date.now()) {
      const e = entries.get(backend);
      if (!e) return null;
      if (now - e.measuredAt > maxAgeMs) {
        entries.delete(backend);
        return null;
      }
      return e;
    },
    clear() {
      entries.clear();
    },
  };
}

/** The fields of GPUAdapterInfo / GPUAdapter we look at (old and new spellings). */
export interface AdapterLike {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
  /** Newer Chrome: GPUAdapterInfo.isFallbackAdapter. */
  isFallbackAdapter?: boolean;
  /** Older Chrome: GPUAdapter.isFallbackAdapter, adapter.info / requestAdapterInfo(). */
  info?: AdapterLike;
}

/** A reason string when the adapter is a software/fallback one (SwiftShader etc.), else null. */
export function softwareAdapterReason(adapter: AdapterLike | null | undefined): string | null {
  if (!adapter) return null;
  const all: AdapterLike[] = [adapter, ...(adapter.info ? [adapter.info] : [])];
  for (const a of all) {
    if (a.isFallbackAdapter) return 'fallback (software) WebGPU adapter';
    const text = [a.vendor, a.architecture, a.device, a.description]
      .filter((s): s is string => typeof s === 'string')
      .join(' ')
      .toLowerCase();
    if (text.includes('swiftshader')) return 'SwiftShader (software) WebGPU adapter';
  }
  return null;
}

/**
 * Whether the GPU should take part, given fresh calibrations. null = yes;
 * otherwise the reason. Without a WASM measurement there is nothing to beat
 * yet, so the GPU is allowed (and measured).
 */
export function gpuParticipationVerdict(
  gpu: BackendCalibration | null,
  wasm: BackendCalibration | null,
  minSpeedup = 1.2,
): string | null {
  if (!gpu || !wasm) return null;
  if (gpu.sampleItersPerSec >= minSpeedup * wasm.sampleItersPerSec) return null;
  const ratio = gpu.sampleItersPerSec / wasm.sampleItersPerSec;
  return `GPU measured ${ratio.toFixed(2)}x the WASM pool (needs ${minSpeedup}x)`;
}
