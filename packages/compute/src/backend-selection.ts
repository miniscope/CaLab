// Dev-only solver backend switch. Not a user setting: enable with `?backend=gpu`
// in the URL, or persistently with `localStorage.setItem('calab:backend', 'gpu')`
// (`?backend=wasm` overrides a stored flag for one page load). Anything else
// means the default WASM worker pool.

export type RequestedBackend = 'wasm' | 'gpu';

export const BACKEND_STORAGE_KEY = 'calab:backend';

function parse(raw: string | null | undefined): RequestedBackend | null {
  if (raw === 'gpu' || raw === 'webgpu') return 'gpu';
  if (raw === 'wasm') return 'wasm';
  return null;
}

export function getRequestedBackend(
  search: string = typeof window !== 'undefined' ? window.location.search : '',
  storage: Pick<Storage, 'getItem'> | null = typeof localStorage !== 'undefined'
    ? localStorage
    : null,
): RequestedBackend {
  const fromUrl = parse(new URLSearchParams(search).get('backend'));
  if (fromUrl) return fromUrl;
  try {
    return parse(storage?.getItem(BACKEND_STORAGE_KEY)) ?? 'wasm';
  } catch {
    return 'wasm';
  }
}

/**
 * How the calibration gate treats the GPU (dev only, like the backend flag):
 * 'advisory' (default) only reports when the GPU measures slower than the
 * WASM pool; 'auto' routes on it: the GPU takes tiles only while its measured
 * rate beats the pool's by the gate margin. `?gpuGate=auto`, or
 * localStorage 'calab:gpu-gate' = 'auto'.
 */
export type GpuGateMode = 'advisory' | 'auto';

export const GPU_GATE_STORAGE_KEY = 'calab:gpu-gate';

export function getRequestedGpuGate(
  search: string = typeof window !== 'undefined' ? window.location.search : '',
  storage: Pick<Storage, 'getItem'> | null = typeof localStorage !== 'undefined'
    ? localStorage
    : null,
): GpuGateMode {
  const fromUrl = new URLSearchParams(search).get('gpuGate');
  if (fromUrl === 'auto' || fromUrl === 'advisory') return fromUrl;
  try {
    return storage?.getItem(GPU_GATE_STORAGE_KEY) === 'auto' ? 'auto' : 'advisory';
  } catch {
    return 'advisory';
  }
}

/** Why WebGPU cannot be used here, or null if `navigator.gpu` exists. */
export function webGpuUnavailableReason(): string | null {
  if (typeof navigator === 'undefined') return 'no navigator';
  if (!('gpu' in navigator) || !(navigator as { gpu?: unknown }).gpu) {
    return typeof isSecureContext !== 'undefined' && !isSecureContext
      ? 'WebGPU needs a secure context (https or localhost)'
      : 'this browser does not expose WebGPU (navigator.gpu)';
  }
  return null;
}
