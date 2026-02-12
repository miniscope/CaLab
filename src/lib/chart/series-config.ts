// Shared uPlot series configuration builders for trace panels.

import type uPlot from 'uplot';

export function createRawSeries(): uPlot.Series {
  return { label: 'Raw', stroke: '#1f77b4', width: 1 };
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
export function createPinnedOverlaySeries(
  label: string,
  baseStroke: string,
  baseWidth: number,
): uPlot.Series {
  let stroke: string;
  if (baseStroke.startsWith('#')) {
    const r = parseInt(baseStroke.slice(1, 3), 16);
    const g = parseInt(baseStroke.slice(3, 5), 16);
    const b = parseInt(baseStroke.slice(5, 7), 16);
    stroke = `rgba(${r}, ${g}, ${b}, 0.65)`;
  } else {
    stroke = baseStroke.replace('hsl(', 'hsla(').replace(')', ', 0.65)');
  }
  return { label, stroke, width: baseWidth + 0.5, dash: [8, 4] };
}
