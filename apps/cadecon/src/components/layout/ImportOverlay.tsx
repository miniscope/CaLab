import { Show, createSignal, type JSX } from 'solid-js';
import { FileDropZone } from '../import/FileDropZone.tsx';
import { NpzArraySelector } from '../import/NpzArraySelector.tsx';
import { DimensionConfirmation } from '../import/DimensionConfirmation.tsx';
import { SamplingRateInput } from '../import/SamplingRateInput.tsx';
import { DataValidationReport } from '../import/DataValidationReport.tsx';
import { importStep, effectiveShape, samplingRate, npzArrays } from '../../lib/data-store.ts';
import { DEMO_PRESETS, DEFAULT_PRESET_ID } from '@calab/compute';
import { buildFeedbackUrl, buildFeatureRequestUrl, buildBugReportUrl } from '@calab/community';

const STEP_LABELS: Record<string, { num: number; label: string }> = {
  drop: { num: 1, label: 'Load Data' },
  'confirm-dims': { num: 2, label: 'Confirm Dimensions' },
  'sampling-rate': { num: 3, label: 'Set Sampling Rate' },
  validation: { num: 4, label: 'Validate Data' },
};

const TOTAL_STEPS = 4;

export interface ImportOverlayProps {
  hasFile: boolean;
  onReset: () => void;
  onLoadDemo: (opts: {
    numCells: number;
    durationMinutes: number;
    fps: number;
    presetId: string;
    seed?: number | 'random';
  }) => void;
}

export function ImportOverlay(props: ImportOverlayProps): JSX.Element {
  const stepInfo = () => STEP_LABELS[importStep()] ?? { num: 1, label: 'Load Data' };

  const [demoCells, setDemoCells] = createSignal(20);
  const [demoDuration, setDemoDuration] = createSignal(5);
  const [demoFps, setDemoFps] = createSignal(30);
  const [demoPresetId, setDemoPresetId] = createSignal(DEFAULT_PRESET_ID);
  const [useRandomSeed, setUseRandomSeed] = createSignal(false);

  return (
    <main class="import-container">
      <header class="app-header">
        <h1 class="app-header__title">CaDecon</h1>
        <span class="app-header__version">CaLab {import.meta.env.VITE_APP_VERSION || 'dev'}</span>
        <p class="app-header__subtitle">Automated Calcium Deconvolution</p>
      </header>

      <div class="step-indicator">
        <div class="step-indicator__bar">
          {[1, 2, 3, 4].map((n) => (
            <div
              class={`step-dot ${n <= stepInfo().num ? 'step-dot--active' : ''} ${n === stepInfo().num ? 'step-dot--current' : ''}`}
            >
              {n}
            </div>
          ))}
        </div>
        <p class="step-indicator__label">
          Step {stepInfo().num} of {TOTAL_STEPS}: {stepInfo().label}
        </p>
      </div>

      <Show when={props.hasFile}>
        <div class="start-over-row">
          <button class="btn-secondary btn-small" onClick={props.onReset}>
            Start Over
          </button>
        </div>
      </Show>

      <Show when={importStep() === 'drop'}>
        <FileDropZone />
        <Show when={npzArrays()}>
          <NpzArraySelector />
        </Show>
        <div class="demo-data-row">
          <span class="demo-data-row__divider">or generate synthetic data</span>
          <select
            class="demo-data-row__select"
            value={demoPresetId()}
            onChange={(e) => setDemoPresetId(e.currentTarget.value)}
          >
            {DEMO_PRESETS.map((p) => (
              <option value={p.id}>{p.label}</option>
            ))}
          </select>
          <div class="demo-data-row__fields">
            <label class="demo-data-row__field">
              <span>Cells</span>
              <input
                type="number"
                min={1}
                max={200}
                value={demoCells()}
                onInput={(e) => {
                  const v = parseInt(e.currentTarget.value, 10);
                  if (!isNaN(v) && v >= 1) setDemoCells(Math.min(v, 200));
                }}
              />
            </label>
            <label class="demo-data-row__field">
              <span>Duration (min)</span>
              <input
                type="number"
                min={0.5}
                max={60}
                step={0.5}
                value={demoDuration()}
                onInput={(e) => {
                  const v = parseFloat(e.currentTarget.value);
                  if (!isNaN(v) && v >= 0.5) setDemoDuration(Math.min(v, 60));
                }}
              />
            </label>
            <label class="demo-data-row__field">
              <span>FPS</span>
              <input
                type="number"
                min={1}
                max={120}
                value={demoFps()}
                onInput={(e) => {
                  const v = parseInt(e.currentTarget.value, 10);
                  if (!isNaN(v) && v >= 1) setDemoFps(Math.min(v, 120));
                }}
              />
            </label>
          </div>
          <label class="demo-data-row__checkbox">
            <input
              type="checkbox"
              checked={useRandomSeed()}
              onChange={(e) => setUseRandomSeed(e.currentTarget.checked)}
            />
            <span>Random seed</span>
          </label>
          <button
            class="btn-secondary"
            onClick={() =>
              props.onLoadDemo({
                numCells: demoCells(),
                durationMinutes: demoDuration(),
                fps: demoFps(),
                presetId: demoPresetId(),
                seed: useRandomSeed() ? 'random' : undefined,
              })
            }
          >
            Load Demo Data
          </button>
        </div>
      </Show>

      <Show when={importStep() === 'confirm-dims'}>
        <div class="file-info-dimmed">
          <FileDropZone />
        </div>
        <DimensionConfirmation />
      </Show>

      <Show when={importStep() === 'sampling-rate'}>
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

      <Show when={importStep() === 'validation'}>
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

      <footer class="import-feedback">
        <a href={buildFeedbackUrl('cadecon')} target="_blank" rel="noopener noreferrer">
          Feedback
        </a>
        <span class="import-feedback__sep">&middot;</span>
        <a href={buildFeatureRequestUrl('cadecon')} target="_blank" rel="noopener noreferrer">
          Feature Request
        </a>
        <span class="import-feedback__sep">&middot;</span>
        <a href={buildBugReportUrl('cadecon')} target="_blank" rel="noopener noreferrer">
          Bug Report
        </a>
      </footer>
    </main>
  );
}
