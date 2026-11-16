import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const from = vi.fn(() => ({ insert: vi.fn(async () => ({})) }));
const invoke = vi.fn(async () => ({ data: { session_id: 's1' }, error: null }));
const signInAnonymously = vi.fn(async () => ({ data: { session: { access_token: 't' } } }));
const getSession = vi.fn(async () => ({ data: { session: null } }));

vi.mock('../supabase.ts', () => ({
  supabaseEnabled: true,
  supabaseUrl: undefined,
  supabaseAnonKey: undefined,
  getSupabase: vi.fn(async () => ({
    from,
    functions: { invoke },
    auth: { getSession, signInAnonymously, onAuthStateChange: vi.fn() },
  })),
}));

import { analyticsEnabled, setAnalyticsEnabled, ANALYTICS_OFF_KEY } from '../analytics-consent.ts';
import { initSession, trackEvent } from '../analytics.ts';

function stubStorage(initial: Record<string, string> = {}, broken = false) {
  const data = { ...initial };
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => {
      if (broken) throw new Error('blocked');
      return k in data ? data[k] : null;
    },
    setItem: (k: string, v: string) => {
      if (broken) throw new Error('blocked');
      data[k] = v;
    },
    removeItem: (k: string) => {
      if (broken) throw new Error('blocked');
      delete data[k];
    },
  });
  return data;
}

beforeEach(() => {
  vi.stubGlobal('navigator', { doNotTrack: null });
  stubStorage();
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

describe('analyticsEnabled', () => {
  it('is on by default', () => {
    expect(analyticsEnabled()).toBe(true);
  });

  it('is off after setAnalyticsEnabled(false), on again after true', () => {
    const data = stubStorage();
    expect(setAnalyticsEnabled(false)).toBe(false);
    expect(data[ANALYTICS_OFF_KEY]).toBe('1');
    expect(setAnalyticsEnabled(true)).toBe(true);
    expect(analyticsEnabled()).toBe(true);
  });

  it('is off by default with Do Not Track, unless the user opted in', () => {
    vi.stubGlobal('navigator', { doNotTrack: '1' });
    expect(analyticsEnabled()).toBe(false);
    setAnalyticsEnabled(true);
    expect(analyticsEnabled()).toBe(true);
  });

  it('never throws when storage is blocked', () => {
    stubStorage({}, true);
    expect(analyticsEnabled()).toBe(true);
    expect(() => setAnalyticsEnabled(false)).not.toThrow();
  });
});

describe('opt-out reaches the network layer', () => {
  it('initSession makes no call and no anonymous sign-in when off', async () => {
    setAnalyticsEnabled(false);
    await initSession('cala', 'x');
    expect(signInAnonymously).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('trackEvent inserts nothing when off, and inserts when on', async () => {
    stubStorage();
    vi.stubGlobal('window', { screen: { width: 1, height: 1 } });
    vi.stubGlobal('document', {
      referrer: '',
      visibilityState: 'visible',
      addEventListener: vi.fn(),
    });
    vi.stubGlobal('sessionStorage', { getItem: () => 'anon', setItem: () => {} });
    vi.stubGlobal('navigator', { doNotTrack: null, userAgent: 'Chrome/1' });
    await initSession('cala', 'x');
    expect(invoke).toHaveBeenCalledTimes(1);
    await trackEvent('run_started', { stage: 'discover' });
    expect(from).toHaveBeenCalledTimes(1);
    setAnalyticsEnabled(false);
    await trackEvent('run_started', { stage: 'discover' });
    expect(from).toHaveBeenCalledTimes(1);
  });
});

import { getTesterTag, sanitizeTesterTag, setTesterTag, TESTER_TAG_MAX } from '../tester-tag.ts';

describe('tester tag', () => {
  it('sanitises: strips disallowed chars, trims, caps length', () => {
    expect(sanitizeTesterTag('  Ana <b>Lopez</b>/../x!  ')).toBe('Ana bLopezb..x');
    expect(sanitizeTesterTag('a'.repeat(100))).toHaveLength(TESTER_TAG_MAX);
    expect(sanitizeTesterTag('line1\nline2')).toBe('line1line2');
    expect(sanitizeTesterTag('me@lab.edu_1-x')).toBe('me@lab.edu_1-x');
  });

  it('stores, returns, and clears the tag', () => {
    expect(setTesterTag(' bob ')).toBe('bob');
    expect(getTesterTag()).toBe('bob');
    setTesterTag('');
    expect(getTesterTag()).toBe('');
  });

  it('is ignored when analytics are off', () => {
    setTesterTag('bob');
    setAnalyticsEnabled(false);
    expect(getTesterTag()).toBe('');
  });

  it('never throws when storage is blocked', () => {
    stubStorage({}, true);
    expect(getTesterTag()).toBe('');
    expect(() => setTesterTag('x')).not.toThrow();
  });

  it('is sent once on session start and on change, never when off', async () => {
    vi.stubGlobal('window', { screen: { width: 1, height: 1 } });
    vi.stubGlobal('document', {
      referrer: '',
      visibilityState: 'visible',
      addEventListener: vi.fn(),
    });
    vi.stubGlobal('sessionStorage', { getItem: () => 'anon', setItem: () => {} });
    vi.stubGlobal('navigator', { doNotTrack: null, userAgent: 'Chrome/1' });
    setTesterTag('bob');
    const { updateTesterTag } = await import('../analytics.ts');
    await initSession('cala', 'x');
    await new Promise((r) => setTimeout(r, 0));
    expect(from).toHaveBeenCalledTimes(1);
    updateTesterTag('bob'); // unchanged
    updateTesterTag('alice');
    await new Promise((r) => setTimeout(r, 0));
    expect(from).toHaveBeenCalledTimes(2);
    setAnalyticsEnabled(false);
    updateTesterTag('carol');
    await new Promise((r) => setTimeout(r, 0));
    expect(from).toHaveBeenCalledTimes(2);
  });
});
