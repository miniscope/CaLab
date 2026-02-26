// Shared chart series utilities: color palette, subset coloring, opacity helpers.

/** D3 category10 color palette for scientific chart consistency. */
export const D3_CATEGORY10 = [
  '#1f77b4',
  '#ff7f0e',
  '#2ca02c',
  '#d62728',
  '#9467bd',
  '#8c564b',
  '#e377c2',
  '#7f7f7f',
  '#bcbd22',
  '#17becf',
];

/** Return the D3 category10 color for a given subset index (wraps around). */
export function subsetColor(idx: number): string {
  return D3_CATEGORY10[idx % D3_CATEGORY10.length];
}

/**
 * Convert a color to rgba with the specified opacity.
 * Handles #rrggbb and #rgb hex formats. Returns input unchanged for other formats.
 */
export function withOpacity(color: string, alpha: number): string {
  if (color.startsWith('#')) {
    let hex = color.slice(1);

    // Expand shorthand #rgb to #rrggbb
    if (hex.length === 3) {
      hex = hex
        .split('')
        .map((char) => char + char)
        .join('');
    }

    // Parse #rrggbb format
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
  }

  // Safe fallback: return unchanged for other formats
  return color;
}
