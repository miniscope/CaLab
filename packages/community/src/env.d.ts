interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_DONATION_SUPABASE_URL?: string;
  readonly VITE_DONATION_SUPABASE_ANON_KEY?: string;
  readonly VITE_DONATION_DANDISET?: string;
  readonly VITE_DONATION_DANDI_INSTANCE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
