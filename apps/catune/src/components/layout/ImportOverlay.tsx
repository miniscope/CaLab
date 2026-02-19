import { Show, createSignal, type JSX } from 'solid-js';
import { FileDropZone } from '../import/FileDropZone.tsx';
import { NpzArraySelector } from '../import/NpzArraySelector.tsx';
import { DimensionConfirmation } from '../import/DimensionConfirmation.tsx';
import { SamplingRateInput } from '../import/SamplingRateInput.tsx';
import { DataValidationReport } from '../import/DataValidationReport.tsx';
import { TracePreview } from '../import/TracePreview.tsx';
import {
  importStep,
  rawFile,
  effectiveShape,
  samplingRate,
  durationSeconds,
  validationResult,
  npzArrays,
} from '../../lib/data-store.ts';
import { formatDuration } from '@catune/core';
import { DEMO_PRESETS, DEFAULT_PRESET_ID } from '../../lib/chart/demo-presets.ts';
import {
  buildFeedbackUrl,
  buildFeatureRequestUrl,
  buildBugReportUrl,
} from '../../lib/community/index.ts';
import { getTutorialById } from '../../lib/tutorial/content/index.ts';
import { startTutorial } from '../../lib/tutorial/tutorial-engine.ts';
import { isTutorialActive } from '../../lib/tutorial/tutorial-store.ts';

const STEP_LABELS: Record<string, { num: number; label: string }> = {
  drop: { num: 1, label: 'Load Data' },
  'confirm-dims': { num: 2, label: 'Confirm Dimensions' },
  'sampling-rate': { num: 3, label: 'Set Sampling Rate' },
  validation: { num: 4, label: 'Validate Data' },
  ready: { num: 4, label: 'Ready' },
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

  // Demo data config
  const [demoCells, setDemoCells] = createSignal(20);
  const [demoDuration, setDemoDuration] = createSignal(5);
  const [demoFps, setDemoFps] = createSignal(30);
  const [demoPresetId, setDemoPresetId] = createSignal(DEFAULT_PRESET_ID);
  const [randomSeed, setRandomSeed] = createSignal(false);

  const durationDisplay = () => formatDuration(durationSeconds(), true);

  return (
    <main class="import-container">
      {/* Header */}
      <header class="app-header" data-tutorial="app-header">
        <h1 class="app-header__title">
          CaTune{' '}
          <span class="app-header__version">{import.meta.env.VITE_APP_VERSION || 'dev'}</span>
        </h1>
        <p class="app-header__subtitle">Calcium Deconvolution Parameter Tuning</p>
      </header>

      {/* Step indicator */}
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

      {/* Start Over button */}
      <Show when={props.hasFile}>
        <div class="start-over-row">
          <button class="btn-secondary btn-small" onClick={props.onReset}>
            Start Over
          </button>
        </div>
      </Show>

      {/* Step 1: File Drop */}
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
              checked={randomSeed()}
              onChange={(e) => setRandomSeed(e.currentTarget.checked)}
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
                seed: randomSeed() ? 'random' : undefined,
              })
            }
          >
            Load Demo Data
          </button>
          <Show when={!isTutorialActive()}>
            <div class="theory-tutorial-link">
              <span>New to deconvolution?</span>
              <button
                class="btn-secondary btn-small"
                onClick={() => {
                  const theory = getTutorialById('theory');
                  if (theory) startTutorial(theory);
                }}
              >
                Start Theory Tutorial
              </button>
            </div>
          </Show>
        </div>
      </Show>

      {/* Step 2: Confirm Dimensions */}
      <Show when={importStep() === 'confirm-dims'}>
        <div class="file-info-dimmed">
          <FileDropZone />
        </div>
        <DimensionConfirmation />
      </Show>

      {/* Step 3: Sampling Rate */}
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

      {/* Step 4: Validation */}
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

      {/* Step 5 (ready): shown briefly before dashboard transition */}
      <Show when={importStep() === 'ready'}>
        <div class="info-summary">
          <Show when={rawFile()}>
            {(file) => (
              <>
                <span>{file().name}</span>
                <span class="info-summary__sep">&middot;</span>
              </>
            )}
          </Show>
          <Show when={effectiveShape()}>
            {(shape) => (
              <>
                <span>{shape()[0].toLocaleString()} cells</span>
                <span class="info-summary__sep">&middot;</span>
                <span>{shape()[1].toLocaleString()} timepoints</span>
                <span class="info-summary__sep">&middot;</span>
              </>
            )}
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

      {/* Feedback links */}
      <footer class="import-feedback">
        <a href={buildFeedbackUrl()} target="_blank" rel="noopener noreferrer">
          Feedback
        </a>
        <span class="import-feedback__sep">&middot;</span>
        <a href={buildFeatureRequestUrl()} target="_blank" rel="noopener noreferrer">
          Feature Request
        </a>
        <span class="import-feedback__sep">&middot;</span>
        <a href={buildBugReportUrl()} target="_blank" rel="noopener noreferrer">
          Bug Report
        </a>
      </footer>
    </main>
  );
}
