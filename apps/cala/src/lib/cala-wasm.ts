/**
 * Single import point for the cala WASM module (crates/cala/pkg/).
 *
 * Rule: no other file imports the wasm-pack output directly (an ESLint
 * boundary enforces it). `initCalaWasm()` is lazy and idempotent.
 *
 * Lives in the app rather than in `@calab/core`: only cala uses it, and
 * `@calab/core` must stay wasm-free (its barrel is imported by apps that never
 * load a WASM module).
 */
import init, {
  AviHeader,
  aviIdx1PayloadLen,
  aviIsAvixContinuation,
  cala_version,
} from '../../../../crates/cala/pkg/calab_cala.js';

export { AviHeader, aviIdx1PayloadLen, aviIsAvixContinuation, cala_version };

let ready: Promise<void> | null = null;

/**
 * Initialize the WASM module. In the browser, call it with no argument. Tests
 * (Node has no `fetch` for file URLs) pass the `.wasm` bytes.
 */
export function initCalaWasm(wasmBytes?: BufferSource): Promise<void> {
  if (!ready) {
    ready = init(wasmBytes ? { module_or_path: wasmBytes } : undefined)
      .then(() => {})
      .catch((err) => {
        // Let a later call retry instead of staying stuck on a rejection.
        ready = null;
        throw err;
      });
  }
  return ready;
}
