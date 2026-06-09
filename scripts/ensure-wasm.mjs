#!/usr/bin/env node
/**
 * Ensure the wasm-pack output (crates/solver/pkg/) exists and is not stale.
 *
 * The pkg/ directory is build-only and gitignored — it is NOT committed (the
 * binary previously was, and went silently stale because gitignored rebuilds
 * never show up in `git status`). This guard runs as a pre-hook for the JS
 * entry points (dev/typecheck/test/build:apps) so consumers always see a fresh
 * binding surface and binary, without paying for a rebuild when nothing changed.
 *
 * Rebuilds only when:
 *   - pkg/calab_solver_bg.wasm is missing, OR
 *   - any tracked solver source (src/**, Cargo.toml) is newer than the binary.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const solverDir = join(repoRoot, 'crates', 'solver');
const wasmFile = join(solverDir, 'pkg', 'calab_solver_bg.wasm');

/** Latest mtime (ms) across a directory tree, recursively. */
function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full));
    } else {
      newest = Math.max(newest, statSync(full).mtimeMs);
    }
  }
  return newest;
}

function needsRebuild() {
  if (!existsSync(wasmFile)) return 'pkg/ missing';
  const wasmMtime = statSync(wasmFile).mtimeMs;
  const srcMtime = Math.max(
    newestMtime(join(solverDir, 'src')),
    statSync(join(solverDir, 'Cargo.toml')).mtimeMs,
  );
  return srcMtime > wasmMtime ? 'solver source changed' : null;
}

const reason = needsRebuild();
if (!reason) {
  console.log('[ensure-wasm] pkg/ is up to date — skipping rebuild.');
  process.exit(0);
}

console.log(`[ensure-wasm] Rebuilding WASM (${reason})...`);
try {
  // Invoke wasm-pack directly (no shell) — mirrors the `build:wasm` npm script.
  execFileSync('wasm-pack', ['build', '--target', 'web', '--release'], {
    cwd: solverDir,
    stdio: 'inherit',
  });
} catch {
  console.error(
    '[ensure-wasm] WASM build failed. Install the Rust toolchain + wasm-pack ' +
      '(see rust-toolchain.toml), or run `npm run build:wasm` manually.',
  );
  process.exit(1);
}
