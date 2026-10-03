// .npz parser - decompresses zip archives containing .npy files
// .npz is simply a ZIP archive where each entry is a .npy file
// Uses fflate for zip decompression

import { unzipSync, type UnzipFileInfo } from 'fflate';
import { parseNpy } from './npy-parser.ts';
import {
  DecompressedSizeLimitError,
  resolveSizeLimit,
  type ArchiveParseOptions,
} from './size-limit.ts';
import type { NpyResult, NpzResult } from '@calab/core';

// Smallest possible ZIP central-directory record. A real archive cannot list
// more entries than fit in the file, so a larger count means a corrupt end
// record; bail out instead of looping billions of times over garbage.
const MIN_CENTRAL_DIR_ENTRY_BYTES = 46;

/**
 * Parse a .npz (zip-archived .npy) buffer.
 *
 * Decompresses the zip archive, iterates entries, and parses each .npy file.
 * Non-.npy entries (metadata files, etc.) are skipped without being
 * decompressed.
 *
 * Decompression is capped: before inflating anything, the uncompressed sizes
 * the archive declares for its .npy entries are summed and checked against
 * `options.maxDecompressedBytes` (default 1 GiB, see
 * `DEFAULT_MAX_DECOMPRESSED_BYTES`). fflate inflates each entry into a buffer
 * of exactly its declared size, so the declared sizes also bound what is
 * actually allocated -- a zip bomb is rejected before any large allocation.
 *
 * @param buffer - The raw ArrayBuffer from reading a .npz file
 * @param options - Optional decompressed-size cap
 * @returns NpzResult with parsed arrays and their names (without .npy extension)
 * @throws DecompressedSizeLimitError if the archive would exceed the cap
 * @throws Error if the archive is corrupt, an entry is not a valid .npy, or
 *         the .npz contains no .npy arrays
 */
export function parseNpz(buffer: ArrayBuffer, options?: ArchiveParseOptions): NpzResult {
  const limit = resolveSizeLimit(options);
  const zipData = new Uint8Array(buffer);
  const maxEntries = Math.floor(zipData.length / MIN_CENTRAL_DIR_ENTRY_BYTES);

  let seen = 0;
  let declaredTotal = 0;
  const filter = (file: UnzipFileInfo): boolean => {
    if (++seen > maxEntries) {
      throw new Error(
        'Not a valid .npz file: corrupt ZIP directory (entry count exceeds file size)',
      );
    }
    if (!file.name.endsWith('.npy')) return false;
    const size = file.originalSize;
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Not a valid .npz file: corrupt size for entry "${file.name}"`);
    }
    declaredTotal += size;
    if (declaredTotal > limit) {
      throw new DecompressedSizeLimitError('.npz', declaredTotal, limit);
    }
    return true;
  };

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zipData, { filter });
  } catch (err) {
    if (err instanceof DecompressedSizeLimitError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith('Not a valid .npz file')) throw err;
    throw new Error(`Not a valid .npz file: ${msg}`, { cause: err });
  }

  const arrays: Record<string, NpyResult> = {};
  const arrayNames: string[] = [];

  for (const [name, data] of Object.entries(entries)) {
    const arrayName = name.replace(/\.npy$/, '');
    // fflate may return a view on a larger shared buffer; parseNpy needs a
    // standalone, offset-0 ArrayBuffer. Copy only when it is not one already.
    const standalone =
      data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
        ? (data.buffer as ArrayBuffer)
        : (new Uint8Array(data).buffer as ArrayBuffer);
    try {
      arrays[arrayName] = parseNpy(standalone);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`.npz entry "${name}": ${msg}`, { cause: err });
    }
    arrayNames.push(arrayName);
  }

  if (arrayNames.length === 0) {
    throw new Error('.npz file contains no .npy arrays');
  }

  return { arrays, arrayNames };
}
