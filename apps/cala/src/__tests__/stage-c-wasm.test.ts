// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { it } from 'vitest';

it('fused WASM batches match separate calls across forced memory growth', () => {
  // Use an isolated module instance so forced growth cannot affect other
  // tests. The standalone script asserts frames, traces, QC and side outputs.
  execFileSync(
    process.execPath,
    [resolve(import.meta.dirname, '../../scripts/stage-c-parity.mjs')],
    {
      stdio: 'pipe',
    },
  );
}, 15000);
