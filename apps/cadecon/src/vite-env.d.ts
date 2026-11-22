/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_APP_VERSION?: string;
  /** Build-time comparison switch: 'off' keeps the rate-cap spike size in the final pass. */
  readonly VITE_BLIND_UNIT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
