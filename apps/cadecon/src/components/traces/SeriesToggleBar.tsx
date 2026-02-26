/** Compact row of series visibility toggles. */

import type { JSX } from 'solid-js';
import {
  showRawTrace,
  setShowRawTrace,
  showReconvolved,
  setShowReconvolved,
  showResidual,
  setShowResidual,
  showSpikes,
  setShowSpikes,
  showWeight,
  setShowWeight,
} from '../../lib/viz-store.ts';

interface ToggleItem {
  label: string;
  color: string;
  get: () => boolean;
  set: (v: boolean) => void;
}

const TOGGLES: ToggleItem[] = [
  { label: 'Raw', color: '#1f77b4', get: showRawTrace, set: setShowRawTrace },
  { label: 'Reconv', color: '#ff7f0e', get: showReconvolved, set: setShowReconvolved },
  { label: 'Resid', color: '#d62728', get: showResidual, set: setShowResidual },
  { label: 'Spikes', color: '#2ca02c', get: showSpikes, set: setShowSpikes },
  { label: 'Weight', color: '#17becf', get: showWeight, set: setShowWeight },
];

export function SeriesToggleBar(): JSX.Element {
  return (
    <div class="series-toggle-bar">
      {TOGGLES.map((t) => (
        <label class="series-toggle-bar__item">
          <span class="series-toggle-bar__swatch" style={{ background: t.color }} />
          <input
            type="checkbox"
            checked={t.get()}
            onChange={(e) => t.set(e.currentTarget.checked)}
          />
          <span class="series-toggle-bar__label">{t.label}</span>
        </label>
      ))}
    </div>
  );
}
