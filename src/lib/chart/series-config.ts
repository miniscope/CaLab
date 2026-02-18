// Shared uPlot series configuration builders for trace panels.
// Trace colors follow the D3 category10 scheme for scientific consistency.

import type uPlot from 'uplot';

/**
 * Convert a color to rgba with the specified opacity.
 * Handles #rrggbb and #rgb hex formats. Returns input unchanged for other formats.
 */
export function withOpacity(color: string, alpha: number): string {
  if (color.startsWith('#')) {
    let hex = color.slice(1);

    // Expand shorthand #rgb to #rrggbb
    if (hex.length === 3) {
      hex = hex.split('').map(char => char + char).join('');
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

export function createRawSeries(): uPlot.Series {
  return { label: 'Raw', stroke: '#1f77b4', width: 1 };
}

export function createFilteredSeries(): uPlot.Series {
  return { label: 'Filtered', stroke: '#17becf', width: 1.5 };
}

export function createFitSeries(): uPlot.Series {
  return { label: 'Fit', stroke: '#ff7f0e', width: 1.5 };
}

export function createDeconvolvedSeries(): uPlot.Series {
  return { label: 'Deconvolved', stroke: '#2ca02c', width: 1 };
}

export function createResidualSeries(): uPlot.Series {
  return { label: 'Residuals', stroke: '#d62728', width: 1 };
}

/**
 * Create a dashed overlay variant for pinned snapshot comparison.
 * Uses 65% opacity and a [8,4] dash pattern for clear visibility.
 */
export function createGroundTruthSpikesSeries(): uPlot.Series {
  return { label: 'True Spikes', stroke: 'rgba(255, 193, 7, 0.7)', width: 1.5 };
}

export function createGroundTruthCalciumSeries(): uPlot.Series {
  return { label: 'True Calcium', stroke: 'rgba(0, 188, 212, 0.7)', width: 1.5, dash: [6, 3] };
}

export function createGroundTruthKernelSeries(): uPlot.Series {
  return { label: 'True Kernel', stroke: 'rgba(233, 30, 99, 0.8)', width: 1.5, dash: [6, 3] };
}

export function createPinnedOverlaySeries(
  label: string,
  baseStroke: string,
  baseWidth: number,
): uPlot.Series {
  const stroke = withOpacity(baseStroke, 0.65);
  return { label, stroke, width: baseWidth + 0.5, dash: [8, 4] };
}
