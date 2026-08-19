// Picks which array in a multi-array container (.npz / .mat) holds the traces.
//
// MATLAB has no arrays of fewer than two dimensions: a scalar is 1x1 and a
// vector is 1xN. So a bare `shape.length === 2` test admits every sampling rate
// and time vector saved next to the traces, and a .mat holding traces + fs + t
// offers three equally plausible-looking choices. numpy keeps scalars 0-D and
// vectors 1-D, so .npz never had this problem -- the rules below leave .npz
// behaviour unchanged while making .mat usable.

import type { NpzResult } from '@calab/core';

/** A 1x1 scalar can never be a trace matrix; anything larger might be. */
function isCandidate(shape: number[]): boolean {
  return shape.length === 2 && shape[0] * shape[1] > 1;
}

/** Shaped like cells x timepoints rather than like a vector. */
function isMatrixShaped(shape: number[]): boolean {
  return shape.length === 2 && shape[0] > 1 && shape[1] > 1;
}

/**
 * Names of arrays that could hold calcium traces, matrix-shaped ones first so
 * the selector leads with the likeliest choice.
 *
 * @param result - parsed multi-array container
 * @returns candidate array names, possibly empty
 */
export function traceCandidates(result: NpzResult): string[] {
  const names = result.arrayNames.filter((name) => isCandidate(result.arrays[name].shape));
  const matrices = names.filter((name) => isMatrixShaped(result.arrays[name].shape));
  const vectors = names.filter((name) => !isMatrixShaped(result.arrays[name].shape));
  return [...matrices, ...vectors];
}

/**
 * The array to load without asking, or null when the choice is ambiguous enough
 * to be worth a prompt. A lone candidate is unambiguous, and so is a lone
 * matrix among vectors -- the shape of a .mat that stores traces beside its
 * acquisition parameters.
 *
 * @param result - parsed multi-array container
 * @returns the array name to auto-select, or null to show the selector
 */
export function soleTraceCandidate(result: NpzResult): string | null {
  const candidates = traceCandidates(result);
  if (candidates.length === 1) return candidates[0];

  const matrices = candidates.filter((name) => isMatrixShaped(result.arrays[name].shape));
  return matrices.length === 1 ? matrices[0] : null;
}
