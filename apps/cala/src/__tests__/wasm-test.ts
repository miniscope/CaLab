import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initCalaWasm } from '../lib/cala-wasm.ts';

/** Load the local WASM binary in each suite's beforeAll hook. */
export async function initTestWasm(): Promise<void> {
  await initCalaWasm(
    readFileSync(resolve(import.meta.dirname, '../../../../crates/cala/pkg/calab_cala_bg.wasm')),
  );
}
