/**
 * Give a consumed buffer's memory back now instead of at the next garbage
 * collection.
 *
 * Workers receive large transferred buffers (visit jobs and results, raw
 * batches for the flat field) and drop them as soon as WASM has copied them
 * in. Their JS heaps stay tiny, so V8 collects rarely, and dropped buffers
 * piled up to 50-150 MB per worker (a few hundred MB per tab) between
 * collections. Detaching a buffer (`ArrayBuffer.prototype.transfer(0)`)
 * releases its backing store at once.
 *
 * Only for buffers the caller owns outright (received by transfer, or made
 * for this message) and never uses again: every view of the buffer becomes
 * empty. A WASM memory, a SharedArrayBuffer, a browser without `transfer`, or
 * an already detached buffer are left as they are.
 */
export function freeBuffer(view: ArrayBufferView | null | undefined): void {
  const buf = view?.buffer as (ArrayBuffer & { transfer?: (n: number) => ArrayBuffer }) | undefined;
  if (!buf || !(buf instanceof ArrayBuffer) || typeof buf.transfer !== 'function') return;
  if ((buf as { detached?: boolean }).detached) return;
  try {
    buf.transfer(0);
  } catch {
    // Not detachable (a WASM memory's buffer): it stays with its owner.
  }
}
