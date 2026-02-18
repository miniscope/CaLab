/**
 * Ground truth reveal/toggle controls shown when tuning on demo data.
 * Displays the reveal button and warning/locked notices.
 */

import { Show } from 'solid-js';
import {
  isDemo,
  groundTruthVisible,
  groundTruthLocked,
  revealGroundTruth,
  toggleGroundTruthVisibility,
} from '../../lib/data-store.ts';

export function GroundTruthControls() {
  function handleToggle(): void {
    if (!groundTruthLocked()) {
      revealGroundTruth();
    } else {
      toggleGroundTruthVisibility();
    }
  }

  return (
    <Show when={isDemo()}>
      <button class="btn-primary btn-small" onClick={handleToggle}>
        {groundTruthVisible() ? 'Hide Ground Truth' : 'Show Ground Truth'}
      </button>
    </Show>
  );
}

export function GroundTruthNotices() {
  return (
    <Show when={isDemo()}>
      <Show when={!groundTruthLocked()}>
        <div class="submit-panel__gt-warning">
          Revealing ground truth will disable community submission
        </div>
      </Show>
      <Show when={groundTruthLocked()}>
        <div class="submit-panel__gt-locked-notice">
          Community submission disabled — ground truth was viewed. Reload demo data to re-enable.
        </div>
      </Show>
    </Show>
  );
}
