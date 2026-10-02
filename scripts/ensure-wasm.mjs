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

/** True when `cmd --version` runs, i.e. the tool is on PATH. */
function hasTool(cmd) {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' });
    return true;
  } catch {
    return false;
  }
}

const missing = ['cargo', 'wasm-pack'].filter((cmd) => !hasTool(cmd));
if (missing.length > 0) {
  console.error(
    [
      `[ensure-wasm] Cannot build the WASM solver (${reason}): ${missing.join(' and ')} not found on PATH.`,
      '',
      '  Rust is required even if you never touch the solver: crates/solver/pkg/ is',
      '  gitignored, so a fresh clone has to build it before dev/test/typecheck/build.',
      '',
      '  Install:',
      '    curl --proto =https --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust via rustup',
      '    rustup target add wasm32-unknown-unknown   # rust-toolchain.toml also requests it',
      '    cargo install wasm-pack                    # or: brew install wasm-pack',
      '',
      '  Then open a new shell (so ~/.cargo/bin is on PATH) and re-run.',
    ].join('\n'),
  );
  process.exit(1);
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
    '[ensure-wasm] WASM build failed (see the wasm-pack output above). Rust and ' +
      'wasm-pack are required on a fresh clone because crates/solver/pkg/ is ' +
      'gitignored. Check that `rustup target list --installed` includes ' +
      'wasm32-unknown-unknown, then retry with `npm run build:wasm`.',
  );
  process.exit(1);
}
