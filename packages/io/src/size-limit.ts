// Decompressed-size cap shared by the archive parsers (.npz, compressed .mat).
//
// A compressed archive can declare, or actually inflate to, far more bytes than
// the file itself occupies (deflate reaches ~1000:1 on constant data, and the
// sizes in a ZIP header are just numbers the writer chose). Without a cap, a
// small file can make the parser allocate gigabytes and crash the tab.

/**
 * Default cap on the total decompressed bytes one archive may produce: 1 GiB.
 *
 * Why 1 GiB: the apps keep the decompressed arrays and then make at least one
 * more full copy (Fortran->C transpose in `processNpyResult`, Float64
 * per-cell extraction, worker transfers), so peak memory is roughly 3-4x the
 * decompressed size. At 1 GiB that is already close to the ~4 GiB a browser
 * tab can practically address (and to wasm32's 4 GiB solver heap). 1 GiB of
 * float32 is ~268 M samples -- e.g. 1000 cells x 268 k frames (2.5 h at
 * 30 Hz) -- well beyond typical calcium-imaging exports. Callers that know
 * they have more headroom (Node scripts, tests) can change it per call.
 */
export const DEFAULT_MAX_DECOMPRESSED_BYTES = 1024 * 1024 * 1024;

/** Options shared by the archive parsers. */
export interface ArchiveParseOptions {
  /**
   * Maximum total bytes the archive may decompress to, summed over every
   * entry that is read. Defaults to {@link DEFAULT_MAX_DECOMPRESSED_BYTES}.
   * Must be a number >= 0; `Infinity` disables the cap.
   */
  maxDecompressedBytes?: number;
}

/** Thrown when an archive would decompress past the configured cap. */
export class DecompressedSizeLimitError extends Error {
  /** Bytes the archive declared or produced when the cap was hit. */
  readonly bytes: number;
  /** The cap that was exceeded. */
  readonly limit: number;

  constructor(format: string, bytes: number, limit: number) {
    super(
      `${format} file would decompress to at least ${formatBytes(bytes)}, above the ` +
        `${formatBytes(limit)} limit. The file is corrupt, a decompression bomb, or too ` +
        'large to load in the browser -- split it into smaller files, or raise ' +
        'maxDecompressedBytes if this is intended.',
    );
    this.name = 'DecompressedSizeLimitError';
    this.bytes = bytes;
    this.limit = limit;
  }
}

/** Resolve and validate the `maxDecompressedBytes` option. */
export function resolveSizeLimit(options: ArchiveParseOptions | undefined): number {
  const limit = options?.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES;
  if (typeof limit !== 'number' || Number.isNaN(limit) || limit < 0) {
    throw new TypeError(`maxDecompressedBytes must be a number >= 0, got ${String(limit)}`);
  }
  return limit;
}

/** Human-readable byte count, e.g. `1.00 GiB`. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const units = ['bytes', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return u === 0 ? `${n} bytes` : `${v.toFixed(2)} ${units[u]}`;
}
