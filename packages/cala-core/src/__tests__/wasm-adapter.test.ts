import { describe, it, expect, vi, beforeEach } from 'vitest';

// We mock the cala-core WASM pkg at the module-resolution level so the
// test suite doesn't need the WASM artifact to be loadable in Node —
// we're only exercising the idempotent init-promise plumbing, not the
// WASM boot itself. Real WASM execution is covered at Phase 5 exit
// (task 25) in the browser.

const initSpy = vi.fn(async () => undefined);
const panicHookSpy = vi.fn();

vi.mock('../../../../crates/cala-core/pkg/calab_cala_core', () => ({
  default: initSpy,
  init_panic_hook: panicHookSpy,
  AviReader: class StubAviReader {},
  Fitter: class StubFitter {},
  MutationQueueHandle: class StubMutationQueueHandle {},
  Preprocessor: class StubPreprocessor {},
  SnapshotHandle: class StubSnapshotHandle {},
}));

// Helper: return a fresh copy of the adapter with a clean module state.
// `vi.resetModules()` drops the in-module `calaReady` singleton so each
// test starts with init never having been called yet.
async function loadFreshAdapter(): Promise<typeof import('../wasm-adapter.ts')> {
  vi.resetModules();
  initSpy.mockClear();
  panicHookSpy.mockClear();
  return import('../wasm-adapter.ts');
}

describe('initCalaCore', () => {
  beforeEach(() => {
    initSpy.mockClear();
    panicHookSpy.mockClear();
  });

  it('calls init exactly once even when called multiple times', async () => {
    const { initCalaCore } = await loadFreshAdapter();
    await initCalaCore();
    await initCalaCore();
    await initCalaCore();
    expect(initSpy).toHaveBeenCalledTimes(1);
  });

  it('installs the panic hook after init resolves', async () => {
    const { initCalaCore } = await loadFreshAdapter();
    await initCalaCore();
    expect(panicHookSpy).toHaveBeenCalledTimes(1);
  });

  it('concurrent callers share one init promise', async () => {
    const { initCalaCore } = await loadFreshAdapter();
    const [a, b, c] = await Promise.all([initCalaCore(), initCalaCore(), initCalaCore()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(initSpy).toHaveBeenCalledTimes(1);
  });

  it('re-exports the binding types so consumers never touch crates/*', async () => {
    const mod = await loadFreshAdapter();
    expect(mod.AviReader).toBeDefined();
    expect(mod.Fitter).toBeDefined();
    expect(mod.Preprocessor).toBeDefined();
    expect(mod.MutationQueueHandle).toBeDefined();
    expect(mod.SnapshotHandle).toBeDefined();
    expect(mod.init_panic_hook).toBeDefined();
  });
});
