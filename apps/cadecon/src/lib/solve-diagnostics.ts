/**
 * Plain-language notes for the per-cell solver diagnostics (cap_limited,
 * no_size_fit, peak_outlier_ratio, dropped_spikes). Display only: these never
 * change a result.
 */

/** peak_outlier_ratio above this flags a trace whose tallest event dwarfs the rest. */
export const PEAK_OUTLIER_RATIO_NOTE_THRESHOLD = 3;

export interface SolveDiagnosticsInput {
  capLimited?: boolean;
  noSizeFit?: boolean;
  peakOutlierRatio?: number;
  droppedSpikes?: number;
}

export interface DiagnosticNote {
  /** Short text shown under the trace stats. */
  text: string;
  /** Longer explanation for the title attribute. */
  title: string;
}

export function solveDiagnosticNotes(d: SolveDiagnosticsInput | undefined): DiagnosticNote[] {
  if (!d) return [];
  const notes: DiagnosticNote[] = [];
  if (d.capLimited) {
    notes.push({
      text: 'busiest frames hit the max firing rate',
      title:
        'The largest events reached the per-frame spike ceiling set by Max firing rate, so their counts may be clipped. Raising it lets those frames hold more spikes.',
    });
  }
  if (d.noSizeFit) {
    notes.push({
      text: 'no spike size fit the data',
      title:
        'No spike size reproduced the continuous fit within one noise standard error, so the size that fit best was used (usually the smallest allowed size). Counts for this cell are less reliable.',
    });
  }
  if (d.peakOutlierRatio !== undefined && d.peakOutlierRatio > PEAK_OUTLIER_RATIO_NOTE_THRESHOLD) {
    notes.push({
      text: `one event is ${d.peakOutlierRatio.toFixed(1)}x taller than typical`,
      title:
        'The tallest event is much larger than the typical event, so a single outlier may be setting the spike size for the whole trace.',
    });
  }
  if (d.droppedSpikes !== undefined && d.droppedSpikes > 0) {
    notes.push({
      text: `${d.droppedSpikes} spike${d.droppedSpikes === 1 ? '' : 's'} dropped`,
      title:
        'These spikes could not be placed because every nearby frame was already at the per-frame ceiling.',
    });
  }
  return notes;
}
