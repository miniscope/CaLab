// Typed GPU failures shared by @calab/compute-gpu (which throws them) and the
// GPU batch consumer (which reacts to them). Consumers classify by `name`, so
// an error crossing a realm or a bundling boundary is still recognised.

/** A GPU allocation failed (device out-of-memory, or a validation error that followed one). */
export class GpuOutOfMemoryError extends Error {
  constructor(message = 'GPU out of memory') {
    super(message);
    this.name = 'GpuOutOfMemoryError';
  }
}

/** The GPUDevice was lost; the solver instance is dead and every later call fails fast. */
export class GpuDeviceLostError extends Error {
  readonly reason: string;
  constructor(reason: string, message = '') {
    super(`GPU device lost (${reason}): ${message || 'no message'}`);
    this.name = 'GpuDeviceLostError';
    this.reason = reason;
  }
}

export function isGpuOutOfMemoryError(err: unknown): boolean {
  return err instanceof Error && err.name === 'GpuOutOfMemoryError';
}

export function isGpuDeviceLostError(err: unknown): boolean {
  return err instanceof Error && err.name === 'GpuDeviceLostError';
}
