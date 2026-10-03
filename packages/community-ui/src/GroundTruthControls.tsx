/**
 * Ground-truth reveal/toggle button and the notices that go with it, shown
 * when the app is running on simulated demo data. Revealing ground truth locks
 * community submission for that dataset (the submit button checks `locked`).
 */

import { Show, type Accessor, type JSX } from 'solid-js';
import './styles/ground-truth.css';

/** The slice of an import store (createImportStore in @calab/io) these use. */
export interface GroundTruthState {
  isDemo: Accessor<boolean>;
  groundTruthVisible: Accessor<boolean>;
  groundTruthLocked: Accessor<boolean>;
  revealGroundTruth: () => void;
  toggleGroundTruthVisibility: () => void;
}

export interface GroundTruthProps {
  state: GroundTruthState;
}

export function GroundTruthControls(props: GroundTruthProps): JSX.Element {
  function handleToggle(): void {
    if (!props.state.groundTruthLocked()) {
      props.state.revealGroundTruth();
    } else {
      props.state.toggleGroundTruthVisibility();
    }
  }

  return (
    <Show when={props.state.isDemo()}>
      <button class="btn-primary btn-small" onClick={handleToggle}>
        {props.state.groundTruthVisible() ? 'Hide Ground Truth' : 'Show Ground Truth'}
      </button>
    </Show>
  );
}

export function GroundTruthNotices(props: GroundTruthProps): JSX.Element {
  return (
    <Show when={props.state.isDemo()}>
      <Show when={!props.state.groundTruthLocked()}>
        <div class="submit-panel__gt-warning">
          Revealing ground truth will disable community submission
        </div>
      </Show>
      <Show when={props.state.groundTruthLocked()}>
        <div class="submit-panel__gt-locked-notice">
          Community submission disabled — ground truth was viewed. Reload demo data to re-enable.
        </div>
      </Show>
    </Show>
  );
}
