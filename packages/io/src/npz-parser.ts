// .npz parser - decompresses zip archives containing .npy files
// .npz is simply a ZIP archive where each entry is a .npy file
// Uses fflate for zip decompression

import { unzipSync } from 'fflate';
import { parseNpy } from './npy-parser.ts';
import type { NpyResult, NpzResult } from '@calab/core';

/**
 * Parse a .npz (zip-archived .npy) buffer.
 *
 * Decompresses the zip archive, iterates entries, and parses each .npy file.
 * Non-.npy entries (metadata files, etc.) are silently skipped.
 *
 * @param buffer - The raw ArrayBuffer from reading a .npz file
 * @returns NpzResult with parsed arrays and their names (without .npy extension)
 * @throws Error if the .npz contains no .npy arrays, or if decompression fails
 */
export function parseNpz(buffer: ArrayBuffer): NpzResult {
  const zipData = new Uint8Array(buffer);
  const entries = unzipSync(zipData);

  const arrays: Record<string, NpyResult> = {};
  const arrayNames: string[] = [];

  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('.npy')) {
      const arrayName = name.replace(/\.npy$/, '');
      // IMPORTANT: fflate's unzipSync returns Uint8Array views on a shared buffer.
      // We must copy to get a standalone ArrayBuffer for parseNpy.
      const copy = new Uint8Array(data);
      arrays[arrayName] = parseNpy(copy.buffer as ArrayBuffer);
      arrayNames.push(arrayName);
    }
  }

  if (arrayNames.length === 0) {
    throw new Error('.npz file contains no .npy arrays');
  }

  return { arrays, arrayNames };
}
