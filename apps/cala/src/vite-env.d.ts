/// <reference types="vite/client" />

/** Git commit of the build (set in `vite.config.ts`; empty when unknown). */
declare const __CALA_COMMIT__: string;
/** Whether the build tree had uncommitted changes. */
declare const __CALA_GIT_DIRTY__: boolean;
/** The WASM engine's version (the cala crate's package version; empty when unknown). */
declare const __CALA_ENGINE_VERSION__: string;
