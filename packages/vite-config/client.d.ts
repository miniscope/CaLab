// Build-time globals that `defineCalabApp` (src/index.ts) injects through Vite
// `define`. The root tsconfig.app.json adds this file to every app's
// type-check, so apps don't need to declare it themselves.

/**
 * The app's `calab.id` slug from its package.json (e.g. `"catune"`). Use it
 * as the analytics `app_name` and the GitHub issue label.
 */
declare const __APP_ID__: string;
