import type { JSX } from 'solid-js';
import { ToggleSwitch } from './ToggleSwitch.tsx';
import { sparsityCompareEnabled, setSparsityCompareEnabled } from '../../lib/algorithm-store.ts';
import { isRunLocked } from '../../lib/iteration-store.ts';

/**
 * Display / diagnostic options. These do not change the deconvolution result —
 * they add extra material for visual inspection. The sparsity-comparison overlay
 * must be enabled BEFORE a run because it is computed during the run, so it lives
 * with the pre-run controls rather than being a purely post-run view toggle.
 */
export function DisplaySettings(): JSX.Element {
  return (
    <div class="param-panel">
      <div class="param-panel__sliders">
        <ToggleSwitch
          label="Sparsity Comparison Overlay"
          description="Visual inspection only — solves every trace with BOTH sparsity settings each iteration so the Trace Inspector can overlay them. Does not change results, and roughly doubles run time."
          checked={sparsityCompareEnabled()}
          onChange={setSparsityCompareEnabled}
          disabled={isRunLocked()}
        />
      </div>
    </div>
  );
}
