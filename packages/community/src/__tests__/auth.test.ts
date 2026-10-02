import { describe, it, expect, vi } from 'vitest';
import type { User } from '../auth.ts';

type AuthCallback = (event: string, session: { user: User } | null) => void;

const handlers: AuthCallback[] = [];
let initialSession: { user: User } | null = null;

vi.mock('../supabase.ts', () => ({
  supabaseEnabled: true,
  getSupabase: vi.fn(async () => ({
    auth: {
      onAuthStateChange: (cb: AuthCallback) => {
        handlers.push(cb);
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
      getSession: async () => ({ data: { session: initialSession } }),
    },
  })),
}));

import { realUser, subscribeAuth } from '../auth.ts';
import type { AuthState } from '../auth.ts';

const anonymous = { id: 'anon', is_anonymous: true } as User;
const real = { id: 'real', email: 'a@lab.edu', is_anonymous: false } as User;
const legacy = { id: 'legacy', email: 'b@lab.edu' } as User; // no is_anonymous field

describe('realUser', () => {
  it('drops anonymous-auth users', () => {
    expect(realUser(anonymous)).toBeNull();
  });

  it('keeps real users, including tokens without the is_anonymous field', () => {
    expect(realUser(real)).toBe(real);
    expect(realUser(legacy)).toBe(legacy);
  });

  it('passes through null / undefined', () => {
    expect(realUser(null)).toBeNull();
    expect(realUser(undefined)).toBeNull();
  });
});

describe('subscribeAuth', () => {
  it('reports an anonymous session as signed out and a real session as signed in', async () => {
    initialSession = { user: anonymous };
    const states: AuthState[] = [];
    subscribeAuth((s) => states.push(s));

    await vi.waitFor(() => expect(states.length).toBeGreaterThan(0));
    expect(states.at(-1)).toEqual({ user: null, loading: false });

    handlers.at(-1)!('SIGNED_IN', { user: real });
    expect(states.at(-1)).toEqual({ user: real, loading: false });

    handlers.at(-1)!('SIGNED_IN', { user: anonymous });
    expect(states.at(-1)).toEqual({ user: null, loading: false });
  });
});
