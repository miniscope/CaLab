/** Read CSS custom property values from :root for uPlot programmatic styling. */
export function getThemeColors() {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string) => s.getPropertyValue(name).trim() || undefined;
  return {
    textPrimary: v('--text-primary') ?? '#1a1a1a',
    textSecondary: v('--text-secondary') ?? '#616161',
    textTertiary: v('--text-tertiary') ?? '#9e9e9e',
    borderSubtle: v('--border-subtle') ?? '#e8e8e8',
    borderDefault: v('--border-default') ?? '#d4d4d4',
    accent: v('--accent') ?? '#1a7a5e',
    accentMuted: v('--accent-muted') ?? 'rgba(26, 122, 94, 0.12)',
  };
}
