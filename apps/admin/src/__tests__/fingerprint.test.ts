import { describe, expect, it } from 'vitest';
import { buildReport, fetchFingerprint, FINGERPRINT_CHECKS } from '../lib/fingerprint.ts';

const allTrue = () => Object.fromEntries(FINGERPRINT_CHECKS.map((c) => [c.key, true]));

describe('schema fingerprint', () => {
  it('reports all present', () => {
    const r = buildReport(allTrue());
    expect(r.status).toBe('ok');
    expect(r.missing).toEqual([]);
  });

  it('lists missing migrations, ignoring optional ones', () => {
    const r = buildReport({
      ...allTrue(),
      '008_is_anonymous_column': false,
      '015_app_name_slug_check': false,
      '018_admin_read_indexes': false,
    });
    expect(r.missing.map((m) => m.migration)).toEqual(['008', '015']);
  });

  it('treats absent keys as unknown, not missing', () => {
    const r = buildReport({});
    expect(r.status).toBe('ok');
    expect(r.rows.every((x) => x.state === 'unknown')).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it('degrades to unavailable when the function is missing or the call throws', async () => {
    const noFn = await fetchFingerprint({
      rpc: async () => ({ data: null, error: { message: 'Could not find the function' } }),
    });
    expect(noFn.status).toBe('unavailable');
    expect(noFn.reason).toContain('Could not find');
    const boom = await fetchFingerprint({
      rpc: () => {
        throw new Error('network down');
      },
    });
    expect(boom.status).toBe('unavailable');
    const none = await fetchFingerprint(null as never);
    expect(none.status).toBe('unavailable');
  });
});
