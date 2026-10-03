/** Returns true when the URL hash contains Supabase magic-link tokens. */
export function isAuthCallback(): boolean {
  const hash = window.location.hash;
  return hash.includes('access_token=') || hash.includes('token_hash=');
}
