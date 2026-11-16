// Series colours are CSS custom properties (light/dark values in global.css).
// Known apps keep a fixed slot so a filter never repaints the survivors.

const KNOWN: Record<string, number> = { catune: 1, cadecon: 2, cala: 3 };

/** `var(--series-N)` for an app; unknown apps take later slots by sorted name. */
export function appColor(app: string, allApps: string[]): string {
  const known = KNOWN[app];
  if (known) return `var(--series-${known})`;
  const others = allApps.filter((a) => !(a in KNOWN)).sort();
  const i = Math.max(0, others.indexOf(app));
  return `var(--series-${Math.min(8, 4 + i)})`;
}

export function slot(n: number): string {
  return `var(--series-${((n - 1) % 8) + 1})`;
}

export const NEUTRAL = 'var(--series-muted)';
