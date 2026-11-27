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

import { appRootUrl, isAuthReturnFragment, realUser, subscribeAuth } from '../auth.ts';
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

describe('appRootUrl', () => {
  it('gives origin + base for an absolute (GitHub Pages) base', () => {
    expect(appRootUrl('https://miniscope.github.io/CaLab/CaTune/?x=1#t', '/CaLab/CaTune/')).toBe(
      'https://miniscope.github.io/CaLab/CaTune/',
    );
  });

  it('gives the page folder for the relative base, latest and versioned', () => {
    expect(appRootUrl('https://calab.miniscope.org/CaTune/#t', './')).toBe(
      'https://calab.miniscope.org/CaTune/',
    );
    expect(appRootUrl('https://calab.miniscope.org/Cala/v2.23.1/index.html?a=b', './')).toBe(
      'https://calab.miniscope.org/Cala/v2.23.1/',
    );
  });

  it('falls back to the site root without a base', () => {
    expect(appRootUrl('http://localhost:5173/x/y', undefined)).toBe('http://localhost:5173/');
  });
});

describe('isAuthReturnFragment', () => {
  it('spots a sign-in link result in the fragment', () => {
    expect(isAuthReturnFragment('#access_token=a&refresh_token=b&type=magiclink')).toBe(true);
    expect(isAuthReturnFragment('#error=access_denied&error_description=expired')).toBe(true);
  });

  it('leaves app routes alone', () => {
    expect(isAuthReturnFragment('')).toBe(false);
    expect(isAuthReturnFragment('#/overview')).toBe(false);
    expect(isAuthReturnFragment('#/cala?app=cala&range=30d')).toBe(false);
  });
});
