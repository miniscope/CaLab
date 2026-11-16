import { beforeEach, describe, expect, it, vi } from 'vitest';

const inserted: Array<{ event_name: string; event_data: unknown }> = [];
let release: (() => void) | null = null;
let failInit = false;

vi.mock('../supabase.ts', () => ({
  supabaseEnabled: true,
  supabaseUrl: undefined,
  supabaseAnonKey: undefined,
  getSupabase: vi.fn(async () => ({
    from: () => ({
      insert: vi.fn(async (row: { event_name: string; event_data: unknown }) => {
        inserted.push(row);
        return {};
      }),
    }),
    functions: {
      invoke: vi.fn(
        () =>
          new Promise((resolve) => {
            release = () =>
              resolve(
                failInit
                  ? { data: null, error: new Error('x') }
                  : { data: { session_id: 's1' }, error: null },
              );
          }),
      ),
    },
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null } })),
      signInAnonymously: vi.fn(async () => ({ data: { session: { access_token: 't' } } })),
      onAuthStateChange: vi.fn(),
    },
  })),
}));

type Mod = typeof import('../analytics.ts');

async function load(): Promise<Mod> {
  vi.resetModules();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => {} });
  vi.stubGlobal('window', { screen: { width: 1, height: 1 } });
  vi.stubGlobal('document', {
    referrer: '',
    addEventListener: () => {},
    visibilityState: 'visible',
  });
  vi.stubGlobal('navigator', { userAgent: 'Chrome/1', doNotTrack: null });
  return import('../analytics.ts');
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('events fired before the session exists', () => {
  beforeEach(() => {
    inserted.length = 0;
    release = null;
    failInit = false;
  });

  it('are queued and sent, in order, once the session is created', async () => {
    const m = await load();
    const init = m.initSession('cala', 't');
    await flush();
    void m.trackEvent('webgpu_info', { adapter: 'hardware' });
    void m.trackEvent('file_imported', { extension: 'avi' });
    await flush();
    expect(inserted).toHaveLength(0);
    release?.();
    await init;
    await flush();
    expect(inserted.map((r) => r.event_name)).toEqual(['webgpu_info', 'file_imported']);
  });

  it('are dropped when the session cannot be created', async () => {
    failInit = true;
    const m = await load();
    const init = m.initSession('cala', 't');
    await flush();
    void m.trackEvent('webgpu_info', { adapter: 'none' });
    release?.();
    await init;
    await flush();
    void m.trackEvent('file_imported', {});
    await flush();
    expect(inserted).toHaveLength(0);
  });

  it('are not queued when no session start was attempted, and the queue is bounded', async () => {
    const m = await load();
    void m.trackEvent('webgpu_info', {});
    await flush();
    const init = m.initSession('cala', 't');
    await flush();
    for (let i = 0; i < 40; i++) void m.trackEvent('file_imported', { i });
    release?.();
    await init;
    await flush();
    expect(inserted).toHaveLength(25);
  });
});
