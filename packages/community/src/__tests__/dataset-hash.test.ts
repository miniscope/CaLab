import { describe, it, expect } from 'vitest';
import { computeDatasetHash } from '../dataset-hash.ts';

describe('computeDatasetHash', () => {
  it('returns a 64-character hex string', async () => {
    const data = new Float64Array([1.0, 2.0, 3.0]);
    const hash = await computeDatasetHash(data);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same input gives same hash', async () => {
    const data = new Float64Array([1.0, 2.0, 3.0]);
    const hash1 = await computeDatasetHash(data);
    const hash2 = await computeDatasetHash(data);
    expect(hash1).toBe(hash2);
  });

  it('produces different hashes for different data', async () => {
    const a = new Float64Array([1.0, 2.0, 3.0]);
    const b = new Float64Array([4.0, 5.0, 6.0]);
    const hashA = await computeDatasetHash(a);
    const hashB = await computeDatasetHash(b);
    expect(hashA).not.toBe(hashB);
  });

  it('works with an empty Float64Array', async () => {
    const data = new Float64Array([]);
    const hash = await computeDatasetHash(data);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
