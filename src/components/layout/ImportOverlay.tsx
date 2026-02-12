import { Show, type JSX } from 'solid-js';
import { FileDropZone } from '../FileDropZone';
import { NpzArraySelector } from '../NpzArraySelector';
import { DimensionConfirmation } from '../DimensionConfirmation';
import { SamplingRateInput } from '../SamplingRateInput';
import { DataValidationReport } from '../DataValidationReport';
import { TracePreview } from '../TracePreview';
import {
  importStep,
  rawFile,
  effectiveShape,
  samplingRate,
  durationSeconds,
  validationResult,
  npzArrays,
} from '../../lib/data-store';

const STEP_LABELS: Record<string, { num: number; label: string }> = {
  'drop':          { num: 1, label: 'Load Data' },
  'confirm-dims':  { num: 2, label: 'Confirm Dimensions' },
  'sampling-rate': { num: 3, label: 'Set Sampling Rate' },
  'validation':    { num: 4, label: 'Validate Data' },
  'ready':         { num: 4, label: 'Ready' },
};

const TOTAL_STEPS = 4;

export interface ImportOverlayProps {
  hasFile: boolean;
  onReset: () => void;
  onLoadDemo: () => void;
}

export function ImportOverlay(props: ImportOverlayProps): JSX.Element {
  const step = () => importStep();
  const stepInfo = () => STEP_LABELS[step()] ?? { num: 1, label: 'Load Data' };

  const durationDisplay = () => {
    const d = durationSeconds();
    if (d === null) return null;
    const minutes = d / 60;
    if (minutes >= 1) return `${d.toFixed(1)}s (${minutes.toFixed(1)} min)`;
    return `${d.toFixed(1)}s`;
  };

  return (
    <main class="import-container">
      {/* Header */}
      <header class="app-header" data-tutorial="app-header">
        <h1 class="app-header__title">CaTune <span class="app-header__version">{import.meta.env.VITE_APP_VERSION || 'dev'}</span></h1>
        <p class="app-header__subtitle">
          Calcium Deconvolution Parameter Tuning
        </p>
      </header>

      {/* Step indicator */}
      <div class="step-indicator">
        <div class="step-indicator__bar">
          {[1, 2, 3, 4].map((n) => (
            <div class={`step-dot ${n <= stepInfo().num ? 'step-dot--active' : ''} ${n === stepInfo().num ? 'step-dot--current' : ''}`}>
              {n}
            </div>
          ))}
        </div>
        <p class="step-indicator__label">
          Step {stepInfo().num} of {TOTAL_STEPS}: {stepInfo().label}
        </p>
      </div>

      {/* Start Over button */}
      <Show when={props.hasFile}>
        <div class="start-over-row">
          <button class="btn-secondary btn-small" onClick={props.onReset}>
            Start Over
          </button>
        </div>
      </Show>

      {/* Step 1: File Drop */}
      <Show when={step() === 'drop'}>
        <FileDropZone />
        <Show when={npzArrays()}>
          <NpzArraySelector />
        </Show>
        <div class="demo-data-row">
          <span class="demo-data-row__divider">or</span>
          <button class="btn-secondary" onClick={props.onLoadDemo}>
            Load Demo Data
          </button>
          <p class="demo-data-row__hint">
            20 synthetic cells, 5 min at 30 Hz
          </p>
        </div>
      </Show>

      {/* Step 2: Confirm Dimensions */}
      <Show when={step() === 'confirm-dims'}>
        <div class="file-info-dimmed">
          <FileDropZone />
        </div>
        <DimensionConfirmation />
      </Show>

      {/* Step 3: Sampling Rate */}
      <Show when={step() === 'sampling-rate'}>
        <Show when={effectiveShape()}>
          {(shape) => (
            <div class="info-summary">
              <span>{shape()[0].toLocaleString()} cells</span>
              <span class="info-summary__sep">&middot;</span>
              <span>{shape()[1].toLocaleString()} timepoints</span>
            </div>
          )}
        </Show>
        <SamplingRateInput />
      </Show>

      {/* Step 4: Validation */}
      <Show when={step() === 'validation'}>
        <Show when={effectiveShape()}>
          {(shape) => (
            <div class="info-summary">
              <span>{shape()[0].toLocaleString()} cells</span>
              <span class="info-summary__sep">&middot;</span>
              <span>{shape()[1].toLocaleString()} timepoints</span>
              <span class="info-summary__sep">&middot;</span>
              <span>{samplingRate()} Hz</span>
            </div>
          )}
        </Show>
        <DataValidationReport />
      </Show>

      {/* Step 5 (ready): shown briefly before dashboard transition */}
      <Show when={step() === 'ready'}>
        <div class="info-summary">
          <Show when={rawFile()}>
            {(file) => (<>
              <span>{file().name}</span>
              <span class="info-summary__sep">&middot;</span>
            </>)}
          </Show>
          <Show when={effectiveShape()}>
            {(shape) => (<>
              <span>{shape()[0].toLocaleString()} cells</span>
              <span class="info-summary__sep">&middot;</span>
              <span>{shape()[1].toLocaleString()} timepoints</span>
              <span class="info-summary__sep">&middot;</span>
            </>)}
          </Show>
          <span>{samplingRate()} Hz</span>
          <Show when={durationDisplay()}>
            <span class="info-summary__sep">&middot;</span>
            <span>{durationDisplay()}</span>
          </Show>
        </div>
        <Show when={validationResult()}>
          {(result) => (
            <Show when={result().warnings.length > 0}>
              <p class="text-warning" style="text-align: center; margin-bottom: 12px;">
                {result().warnings.length} warning{result().warnings.length > 1 ? 's' : ''}
              </p>
            </Show>
          )}
        </Show>
        <TracePreview />
        <div class="card ready-card">
          <p class="text-success" style="font-weight: 600; text-align: center;">
            Data loaded and validated. Ready for parameter tuning.
          </p>
        </div>
      </Show>
    </main>
  );
}
