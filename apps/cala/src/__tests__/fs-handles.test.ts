import { describe, expect, it } from 'vitest';
import { ensurePermission } from '../lib/fs-handles.ts';

describe('ensurePermission', () => {
  it('is true without requestPermission', async () => {
    expect(await ensurePermission({}, 'readwrite')).toBe(true);
  });
  it('is true when already granted, without a request', async () => {
    let requested = false;
    const h = {
      queryPermission: async () => 'granted',
      requestPermission: async () => {
        requested = true;
        return 'denied';
      },
    };
    expect(await ensurePermission(h, 'readwrite')).toBe(true);
    expect(requested).toBe(false);
  });
  it('requests when not granted', async () => {
    const mk = (r: string) => ({
      queryPermission: async () => 'prompt',
      requestPermission: async () => r,
    });
    expect(await ensurePermission(mk('granted'), 'readwrite')).toBe(true);
    expect(await ensurePermission(mk('denied'), 'readwrite')).toBe(false);
  });
  it('asks for the mode it is given', async () => {
    const modes: string[] = [];
    const h = {
      queryPermission: async (o: { mode: string }) => {
        modes.push(`query ${o.mode}`);
        return 'prompt';
      },
      requestPermission: async (o: { mode: string }) => {
        modes.push(`request ${o.mode}`);
        return 'granted';
      },
    };
    expect(await ensurePermission(h, 'read')).toBe(true);
    expect(modes).toEqual(['query read', 'request read']);
  });
  it('requests when there is no queryPermission', async () => {
    expect(await ensurePermission({ requestPermission: async () => 'denied' }, 'readwrite')).toBe(
      false,
    );
  });
});
