/** Worker pool sizing logic.
 *  Determines how many Web Workers to spawn for parallel solving. */

/** Default worker count based on hardware concurrency.
 *  Reserves 1 core for the main thread, floor 2, cap 8. */
export function getDefaultWorkerCount(): number {
  const cores = navigator.hardwareConcurrency ?? 4;
  return Math.max(2, Math.min(cores - 1, 8));
}

/** Read `?workers=N` from the URL. Returns the clamped value or null. */
export function getWorkersOverride(): number | null {
  const raw = new URLSearchParams(window.location.search).get('workers');
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  return Math.min(n, 16);
}

/** Resolve the effective worker count: URL override > hardware default. */
export function resolveWorkerCount(): number {
  return getWorkersOverride() ?? getDefaultWorkerCount();
}
