// Thin wrapper over fflate's zipSync so consumers can bundle named byte blobs
// (e.g. a results archive: activity.<ext> + results.json) without importing
// fflate directly.

import { zipSync } from 'fflate';

/**
 * Bundle named byte blobs into an uncompressed-container-friendly ZIP.
 *
 * @param files - map of entry name (e.g. "results.json") to its bytes
 * @returns ArrayBuffer containing the ZIP archive
 */
export function zipFiles(files: Record<string, Uint8Array>): ArrayBuffer {
  const zipped = zipSync(files);
  return zipped.buffer.slice(
    zipped.byteOffset,
    zipped.byteOffset + zipped.byteLength,
  ) as ArrayBuffer;
}
