// Thin wrapper over fflate's zipSync so consumers can bundle named byte blobs
// (e.g. a results archive: activity.<ext> + results.json) without importing
// fflate directly.

import { zipSync, type ZipOptions } from 'fflate';

/**
 * Bundle named byte blobs into a ZIP archive. Entries are deflated (fflate's
 * zipSync default), which any ZIP reader -- including Python's zipfile and
 * numpy's np.load -- handles transparently.
 *
 * @param files - map of entry name (e.g. "results.json") to its bytes
 * @param options - fflate options; `{ level: 0 }` stores without compressing
 *   (fast; what `np.savez` does, and float traces barely compress)
 * @returns ArrayBuffer containing the ZIP archive
 */
export function zipFiles(files: Record<string, Uint8Array>, options?: ZipOptions): ArrayBuffer {
  const zipped = zipSync(files, options ?? {});
  return zipped.buffer.slice(
    zipped.byteOffset,
    zipped.byteOffset + zipped.byteLength,
  ) as ArrayBuffer;
}
