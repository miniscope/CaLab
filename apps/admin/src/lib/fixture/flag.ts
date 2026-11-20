// Fixture mode switch. It is true only in a Vite dev server (`import.meta.env.DEV`
// is the literal `false` in a production build, so every branch guarded by
// FIXTURE_MODE and the dynamic import of the generator are removed by the
// bundler) AND when the page URL carries `?fixture=1`.

export function fixtureRequested(isDev: boolean, search: string): boolean {
  if (!isDev) return false;
  return new URLSearchParams(search).get('fixture') === '1';
}

export const FIXTURE_MODE: boolean =
  import.meta.env.DEV && typeof location !== 'undefined'
    ? fixtureRequested(import.meta.env.DEV, location.search)
    : false;

/** Extra fixture switches: ?slow=1 (delay events), ?noanon=1 (drop is_anonymous), ?error=1 (fail sessions). */
export function fixtureOption(search: string, name: 'slow' | 'noanon' | 'error'): boolean {
  return new URLSearchParams(search).get(name) === '1';
}

export function fixtureSlow(): boolean {
  return FIXTURE_MODE && fixtureOption(location.search, 'slow');
}
export function fixtureOptions(): { slow: boolean; noanon: boolean; error: boolean } {
  const q = FIXTURE_MODE ? location.search : '';
  return {
    slow: fixtureOption(q, 'slow'),
    noanon: fixtureOption(q, 'noanon'),
    error: fixtureOption(q, 'error'),
  };
}
