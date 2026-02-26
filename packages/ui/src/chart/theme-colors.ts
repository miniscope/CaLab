// Shared theme color utilities for uPlot chart components.

// Hardcoded axis colors used by all uPlot chart components.
// These match the CSS theme but are needed as JS values for uPlot config.
export const AXIS_TEXT = '#616161';
export const AXIS_GRID = 'rgba(0, 0, 0, 0.06)';
export const AXIS_TICK = 'rgba(0, 0, 0, 0.15)';

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
    accent: v('--accent') ?? '#2171b5',
    accentMuted: v('--accent-muted') ?? 'rgba(33, 113, 181, 0.08)',
  };
}
