import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../auth.ts';

const { subscribeAuth } = vi.hoisted(() => ({
  subscribeAuth: vi.fn((cb: (state: AuthState) => void) => {
    cb({ user: null, loading: false });
    return () => {};
  }),
}));

vi.mock('../auth.ts', () => ({ subscribeAuth }));
vi.mock('../supabase.ts', () => ({ supabaseEnabled: false, getSupabase: async () => null }));

describe('community-store', () => {
  beforeEach(() => {
    vi.resetModules();
    subscribeAuth.mockClear();
  });

  it('does not subscribe to auth at import time', async () => {
    await import('../community-store.ts');
    expect(subscribeAuth).not.toHaveBeenCalled();
  });

  it('does not subscribe when imported through the package barrel', async () => {
    await import('../index.ts');
    expect(subscribeAuth).not.toHaveBeenCalled();
  });

  it('initCommunityStore subscribes exactly once', async () => {
    const store = await import('../community-store.ts');
    store.initCommunityStore();
    store.initCommunityStore();
    expect(subscribeAuth).toHaveBeenCalledTimes(1);
  });

  it('first read of user()/authLoading() starts the store once', async () => {
    const store = await import('../community-store.ts');
    expect(store.authLoading()).toBe(false);
    expect(store.user()).toBeNull();
    store.initCommunityStore();
    expect(subscribeAuth).toHaveBeenCalledTimes(1);
  });
});
