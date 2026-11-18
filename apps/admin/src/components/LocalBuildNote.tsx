import type { JSX } from 'solid-js';

/** Why a run on someone's machine may be missing from the counts. */
export function LocalBuildNote(): JSX.Element {
  return (
    <p class="note note--muted">
      Runs from local or dev builds (npm run dev, a build without Supabase credentials) send no
      analytics and are not counted here.
    </p>
  );
}
