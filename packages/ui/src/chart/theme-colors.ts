// Theme colours for uPlot charts. Axis chrome reads the tokens at draw time, so a chart drawn
// after a theme change uses the new values; `themeRedrawPlugin` redraws on the change itself.

import type uPlot from 'uplot';
import { onThemeChange } from '../theme.ts';

/** Light-theme axis colours, for canvas code that draws its own axes outside uPlot. */
export const AXIS_TEXT = '#616161';
export const AXIS_GRID = 'rgba(0, 0, 0, 0.06)';
export const AXIS_TICK = 'rgba(0, 0, 0, 0.15)';

/** A token's value on `el` (the root when omitted), or `fallback` when it is unset. */
export function cssToken(name: string, fallback: string, el?: Element): string {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(el ?? document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

/** uPlot axis strokes that follow the theme: tick labels, grid lines, tick marks. */
export const axisText = (u: uPlot): string => cssToken('--ink-2', AXIS_TEXT, u.root);
export const axisGrid = (u: uPlot): string => cssToken('--line', AXIS_GRID, u.root);
export const axisTick = (u: uPlot): string => cssToken('--chart-tick', AXIS_TICK, u.root);

/** uPlot plugin: redraw the chart when the theme changes (axis colours are read at draw time). */
export function themeRedrawPlugin(): uPlot.Plugin {
  let off: (() => void) | undefined;
  return {
    hooks: {
      init: (u) => {
        off = onThemeChange(() => u.redraw(false));
      },
      destroy: () => off?.(),
    },
  };
}

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
