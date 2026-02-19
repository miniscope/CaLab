// SHA-256 dataset fingerprinting using the Web Crypto API.
// Hashes the parsed Float64Array (post-import), not raw file bytes,
// for cross-platform consistency (IEEE 754 is deterministic for identical values).

/**
 * Compute a SHA-256 hex digest of a Float64Array.
 * Used to detect duplicate submissions from the same recording.
 */
export async function computeDatasetHash(data: Float64Array): Promise<string> {
  // Copy into a plain ArrayBuffer to satisfy the strict BufferSource type.
  // Float64Array.buffer may be ArrayBufferLike (includes SharedArrayBuffer),
  // but crypto.subtle.digest requires a narrow ArrayBuffer | ArrayBufferView<ArrayBuffer>.
  const buffer = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer;
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
