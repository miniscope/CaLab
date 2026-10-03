/**
 * Full-page import flow shown until the import store reaches 'ready':
 * app header, step indicator, file drop / array selection, synthetic-data
 * generator, dimension confirmation, sampling rate, and validation.
 *
 * Two layouts:
 *  - 'stacked': file drop above the synthetic-data form (CaTune), with an
 *    optional 'ready' step that previews traces before the dashboard mounts;
 *  - 'split':   file drop and synthetic-data form side by side (CaDecon).
 *
 * Community links (feedback, bug report) come in through `footer` so this
 * package stays free of the community backend.
 */

import { Show, createSignal, type JSX } from 'solid-js';
import { formatDuration } from '@calab/core';
import { DEFAULT_QUALITATIVE_CONFIG } from '@calab/compute';
import type { QualitativeSimConfig } from '@calab/compute';
import type { ImportStore } from '@calab/io';
import { isTutorialActive } from '@calab/tutorials';
import { SimulationConfigurator } from '../SimulationConfigurator.tsx';
import { FileDropZone } from './FileDropZone.tsx';
import { NpzArraySelector } from './NpzArraySelector.tsx';
import { DimensionConfirmation } from './DimensionConfirmation.tsx';
import { SamplingRateInput } from './SamplingRateInput.tsx';
import { DataValidationReport } from './DataValidationReport.tsx';
import { TracePreview } from './TracePreview.tsx';

const STEP_LABELS: Record<string, { num: number; label: string }> = {
  drop: { num: 1, label: 'Load Data' },
  'confirm-dims': { num: 2, label: 'Confirm Dimensions' },
  'sampling-rate': { num: 3, label: 'Set Sampling Rate' },
  validation: { num: 4, label: 'Validate Data' },
  ready: { num: 4, label: 'Ready' },
};

const TOTAL_STEPS = 4;

/** Settings from the synthetic-data form, passed to `onLoadDemo`. */
export interface DemoLoadRequest {
  numCells: number;
  durationMinutes: number;
  fps: number;
  qualitativeConfig: QualitativeSimConfig;
  seed?: number | 'random';
}

export interface ImportOverlayProps {
  store: ImportStore;
  /** App name shown as the page heading, e.g. 'CaTune'. */
  title: string;
  subtitle: string;
  /** Version label next to the title, e.g. 'CaLab 2.1.0'. */
  version: string;
  layout: 'stacked' | 'split';
  /** Label of the synthetic-data button ('Load Demo Data', 'Generate'). */
  demoButtonLabel: string;
  /** Finishes "This is required for correct ..." on the sampling-rate step. */
  samplingRatePurpose: string;
  /** `data-tutorial` anchor on the header, for tutorials that point at it. */
  headerTutorialAnchor?: string;
  /** Show a summary + trace preview on the 'ready' step (stacked layout). */
  readyStep?: {
    message: string;
    tracePreviewCaption?: string;
    cellIndexBase?: 0 | 1;
  };
  /** Theory-tutorial prompt; hidden while a tutorial is running. */
  theoryTutorial?: { prompt: string; onStart: () => void };
  /** Footer content, e.g. community feedback links. */
  footer?: JSX.Element;
  hasFile: boolean;
  onReset: () => void;
  onLoadDemo: (opts: DemoLoadRequest) => void;
}

function ShapeSummary(props: { shape: [number, number]; rate?: number | null }): JSX.Element {
  return (
    <div class="info-summary">
      <span>{props.shape[0].toLocaleString()} cells</span>
      <span class="info-summary__sep">&middot;</span>
      <span>{props.shape[1].toLocaleString()} timepoints</span>
      <Show when={props.rate != null}>
        <span class="info-summary__sep">&middot;</span>
        <span>{props.rate} Hz</span>
      </Show>
    </div>
  );
}

export function ImportOverlay(props: ImportOverlayProps): JSX.Element {
  const store = () => props.store;
  const stepInfo = () => STEP_LABELS[store().importStep()] ?? { num: 1, label: 'Load Data' };

  const [demoCells, setDemoCells] = createSignal(100);
  const [demoDuration, setDemoDuration] = createSignal(15);
  const [demoFps, setDemoFps] = createSignal(30);
  const [simConfig, setSimConfig] = createSignal<QualitativeSimConfig>(DEFAULT_QUALITATIVE_CONFIG);
  const [useRandomSeed, setUseRandomSeed] = createSignal(false);

  const durationDisplay = () => formatDuration(store().durationSeconds(), true);

  const requestDemo = () =>
    props.onLoadDemo({
      numCells: demoCells(),
      durationMinutes: demoDuration(),
      fps: demoFps(),
      qualitativeConfig: simConfig(),
      seed: useRandomSeed() ? 'random' : undefined,
    });

  const demoFields = (): JSX.Element => (
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
  );

  const randomSeedToggle = (): JSX.Element => (
    <label class="demo-data-row__checkbox">
      <input
        type="checkbox"
        checked={useRandomSeed()}
        onChange={(e) => setUseRandomSeed(e.currentTarget.checked)}
      />
      <span>Random seed</span>
    </label>
  );

  const theoryLink = (): JSX.Element => (
    <Show when={props.theoryTutorial && !isTutorialActive()}>
      <div class="theory-tutorial-link">
        <span>{props.theoryTutorial!.prompt}</span>
        <button class="btn-secondary btn-small" onClick={() => props.theoryTutorial!.onStart()}>
          Start Theory Tutorial
        </button>
      </div>
    </Show>
  );

  const fileSection = (): JSX.Element => (
    <>
      <FileDropZone store={store()} />
      <Show when={store().npzArrays()}>
        <NpzArraySelector store={store()} />
      </Show>
    </>
  );

  return (
    <main class="import-container">
      <header class="app-header" data-tutorial={props.headerTutorialAnchor}>
        <h1 class="app-header__title">{props.title}</h1>
        <span class="app-header__version">{props.version}</span>
        <p class="app-header__subtitle">{props.subtitle}</p>
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
          <button class="btn-secondary btn-small" onClick={() => props.onReset()}>
            Start Over
          </button>
        </div>
      </Show>

      {/* Step 1: load a file or generate synthetic data */}
      <Show when={store().importStep() === 'drop'}>
        <Show
          when={props.layout === 'split'}
          fallback={
            <>
              {fileSection()}
              <div class="demo-data-row">
                <span class="demo-data-row__divider">or generate synthetic data</span>
                <SimulationConfigurator config={simConfig()} onChange={setSimConfig} />
                {demoFields()}
                {randomSeedToggle()}
                <button class="btn-secondary" onClick={requestDemo}>
                  {props.demoButtonLabel}
                </button>
                {theoryLink()}
              </div>
            </>
          }
        >
          <div class="import-split">
            <div class="import-split__panel import-split__panel--file">
              <div class="import-split__heading">Load Your Data</div>
              {fileSection()}
            </div>

            <div class="import-split__divider">
              <span class="import-split__or">or</span>
            </div>

            <div class="import-split__panel import-split__panel--sim">
              <div class="import-split__heading">Generate Synthetic Data</div>
              <SimulationConfigurator config={simConfig()} onChange={setSimConfig} />
              {demoFields()}
              <div class="import-split__actions">
                {randomSeedToggle()}
                <button class="btn-primary" onClick={requestDemo}>
                  {props.demoButtonLabel}
                </button>
              </div>
            </div>
          </div>
          {theoryLink()}
        </Show>
      </Show>

      {/* Step 2: confirm dimensions */}
      <Show when={store().importStep() === 'confirm-dims'}>
        <div class="file-info-dimmed">
          <FileDropZone store={store()} />
        </div>
        <DimensionConfirmation store={store()} />
      </Show>

      {/* Step 3: sampling rate */}
      <Show when={store().importStep() === 'sampling-rate'}>
        <Show when={store().effectiveShape()}>{(shape) => <ShapeSummary shape={shape()} />}</Show>
        <SamplingRateInput store={store()} purpose={props.samplingRatePurpose} />
      </Show>

      {/* Step 4: validation */}
      <Show when={store().importStep() === 'validation'}>
        <Show when={store().effectiveShape()}>
          {(shape) => <ShapeSummary shape={shape()} rate={store().samplingRate()} />}
        </Show>
        <DataValidationReport store={store()} />
      </Show>

      {/* Ready: shown briefly before the dashboard mounts */}
      <Show when={props.readyStep && store().importStep() === 'ready'}>
        <div class="info-summary">
          <Show when={store().rawFile()}>
            {(file) => (
              <>
                <span>{file().name}</span>
                <span class="info-summary__sep">&middot;</span>
              </>
            )}
          </Show>
          <Show when={store().effectiveShape()}>
            {(shape) => (
              <>
                <span>{shape()[0].toLocaleString()} cells</span>
                <span class="info-summary__sep">&middot;</span>
                <span>{shape()[1].toLocaleString()} timepoints</span>
                <span class="info-summary__sep">&middot;</span>
              </>
            )}
          </Show>
          <span>{store().samplingRate()} Hz</span>
          <Show when={durationDisplay()}>
            <span class="info-summary__sep">&middot;</span>
            <span>{durationDisplay()}</span>
          </Show>
        </div>
        <Show when={store().validationResult()}>
          {(result) => (
            <Show when={result().warnings.length > 0}>
              <p class="text-warning" style="text-align: center; margin-bottom: 12px;">
                {result().warnings.length} warning{result().warnings.length > 1 ? 's' : ''}
              </p>
            </Show>
          )}
        </Show>
        <TracePreview
          store={store()}
          caption={props.readyStep!.tracePreviewCaption}
          cellIndexBase={props.readyStep!.cellIndexBase}
        />
        <div class="card ready-card">
          <p class="text-success" style="font-weight: 600; text-align: center;">
            {props.readyStep!.message}
          </p>
        </div>
      </Show>

      {props.footer}
    </main>
  );
}
