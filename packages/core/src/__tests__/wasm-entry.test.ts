/**
 * The `@calab/core/wasm` entry (src/wasm.ts) and getSolverVersion(), through
 * the real WASM build. Loading mirrors wasm-parity.test.ts (stubbed fetch for
 * the .wasm file).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as wasm from '../wasm.ts';
import * as barrel from '../index.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const PKG_WASM = `${REPO_ROOT}crates/solver/pkg/calab_solver_bg.wasm`;
const pkgPresent = existsSync(PKG_WASM);
if (!pkgPresent && process.env.CI) {
  throw new Error(`WASM pkg missing at ${PKG_WASM}. Run \`npm run ensure-wasm\` first.`);
}

describe('@calab/core barrel', () => {
  it('does not re-export the WASM adapter', () => {
    for (const name of ['initWasm', 'Solver', 'solver_version', 'getSolverVersion']) {
      expect(barrel).not.toHaveProperty(name);
    }
  });
});

describe.skipIf(!pkgPresent)('@calab/core/wasm', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', async (input: URL | string) => {
      const url = input instanceof URL ? input : new URL(input);
      if (url.protocol !== 'file:') throw new Error(`unexpected fetch in test: ${url}`);
      return new Response(readFileSync(fileURLToPath(url)), {
        headers: { 'Content-Type': 'application/wasm' },
      });
    });
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('getSolverVersion() initializes WASM and returns the crate version', async () => {
    const version = await wasm.getSolverVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(version).toBe(wasm.solver_version());
  });

  it('getSolverVersion() returns undefined when WASM cannot load', async () => {
    vi.resetModules();
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fresh = await import('../wasm.ts');
    await expect(fresh.getSolverVersion()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
