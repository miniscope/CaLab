// .npz writer - bundles one or more Float32 arrays into a .npz (ZIP of .npy).
// Inverse of npz-parser.ts. Each array is written as "<name>.npy" so numpy's
// np.load(...)[name] recovers it.

import { writeNpy } from './npy-writer.ts';
import { zipFiles } from './zip.ts';

/**
 * Write named Float32 arrays to a .npz (zip of .npy) buffer.
 *
 * @param arrays - map of array name to its data + shape
 * @returns ArrayBuffer containing the .npz archive
 */
export function writeNpz(
  arrays: Record<string, { data: Float32Array; shape: number[] }>,
): ArrayBuffer {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, arr] of Object.entries(arrays)) {
    entries[`${name}.npy`] = new Uint8Array(writeNpy(arr.data, arr.shape));
  }
  return zipFiles(entries);
}
