/**
 * CaDecon submit panel — shown when run is complete.
 * Displays kernel result summary and provides "Submit to Community" action.
 * No ground truth lockout for CaDecon.
 */

import { createSignal, Show } from 'solid-js';
import { SubmitFormModal, SubmissionSummary as SharedSubmissionSummary } from '@calab/ui';
import { AuthGate } from './AuthGateWrapper.tsx';
import { PrivacyNotice } from './PrivacyNoticeWrapper.tsx';
import { SearchableSelect } from '@calab/ui';
import {
  validateSubmission,
  loadFieldOptions,
  supabaseEnabled,
  submitToSupabase,
  user,
  fieldOptions,
  fieldOptionsLoading,
  buildFieldOptionRequestUrl,
  deleteSubmission,
} from '../../lib/community/index.ts';
import type { CadeconSubmission, FormFields } from '../../lib/community/index.ts';
import {
  runState,
  currentTauRise,
  currentTauDecay,
  convergenceHistory,
  alphaValues,
  pveValues,
  perTraceResults,
  currentIteration,
  convergedAtIteration,
} from '../../lib/iteration-store.ts';
import {
  upsampleFactor,
  weightingEnabled,
  hpFilterEnabled,
  lpFilterEnabled,
  maxIterations,
  convergenceTol,
} from '../../lib/algorithm-store.ts';
import { numSubsets, targetCoverage } from '../../lib/subset-store.ts';
import {
  samplingRate,
  effectiveShape,
  parsedData,
  durationSeconds,
  isDemo,
  dataSource,
  demoPreset,
} from '../../lib/data-store.ts';
import '../../styles/community.css';

import type { Accessor, Setter } from 'solid-js';

interface FieldSignal {
  get: Accessor<string>;
  set: Setter<string>;
}

const APP_VERSION: string = import.meta.env.VITE_APP_VERSION || 'dev';

export function SubmitPanel() {
  // --- UI state ---
  const [formOpen, setFormOpen] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  const [lastSubmission, setLastSubmission] = createSignal<CadeconSubmission | null>(null);
  const [submitError, setSubmitError] = createSignal<string | null>(null);
  const [validationErrors, setValidationErrors] = createSignal<string[]>([]);

  // --- Form field signals ---
  const [indicator, setIndicator] = createSignal('');
  const [species, setSpecies] = createSignal('');
  const [brainRegion, setBrainRegion] = createSignal('');
  const [labName, setLabName] = createSignal('');
  const [orcid, setOrcid] = createSignal('');
  const [virusConstruct, setVirusConstruct] = createSignal('');
  const [timeSinceInjection, setTimeSinceInjection] = createSignal('');
  const [notes, setNotes] = createSignal('');
  const [microscopeType, setMicroscopeType] = createSignal('');
  const [cellType, setCellType] = createSignal('');
  const [imagingDepth, setImagingDepth] = createSignal('');

  const requiredFieldsFilled = () =>
    isDemo() ||
    (indicator().trim() !== '' && species().trim() !== '' && brainRegion().trim() !== '');

  // Only show when run is complete
  const isComplete = () => runState() === 'complete';
  const isConverged = () => convergedAtIteration() !== null;

  async function handleSubmit(): Promise<void> {
    setSubmitError(null);
    setValidationErrors([]);

    const fs = samplingRate() ?? 30;
    const tauRise = currentTauRise();
    const tauDecay = currentTauDecay();
    if (tauRise == null || tauDecay == null) {
      setSubmitError('No kernel parameters available');
      return;
    }

    const validation = validateSubmission({ tauRise, tauDecay, samplingRate: fs });
    if (!validation.valid) {
      setValidationErrors(validation.issues);
      return;
    }

    setSubmitting(true);

    // Get beta from latest convergence history
    const history = convergenceHistory();
    const beta = history.length > 0 ? history[history.length - 1].beta : null;

    try {
      const result = await submitToSupabase(
        {
          indicator: indicator(),
          species: species(),
          brainRegion: brainRegion(),
          labName: labName(),
          orcid: orcid(),
          virusConstruct: virusConstruct(),
          timeSinceInjection: timeSinceInjection(),
          notes: notes(),
          microscopeType: microscopeType(),
          cellType: cellType(),
          imagingDepth: imagingDepth(),
        },
        {
          tauRise,
          tauDecay,
          beta,
          samplingRate: fs,
          upsampleFactor: upsampleFactor(),
          numSubsets: numSubsets(),
          targetCoverage: targetCoverage(),
          maxIterations: maxIterations(),
          convergenceTol: convergenceTol(),
          weightingEnabled: weightingEnabled(),
          hpFilterEnabled: hpFilterEnabled(),
          lpFilterEnabled: lpFilterEnabled(),
          alphaValues: alphaValues(),
          pveValues: pveValues(),
          perTraceResults: perTraceResults(),
          durationSeconds: durationSeconds(),
          numIterations: currentIteration(),
          converged: isConverged(),
          numCells: effectiveShape()?.[0],
          recordingLengthS: durationSeconds() ?? undefined,
          datasetData: parsedData()?.data,
          dataSource: dataSource(),
          demoPresetId: demoPreset()?.id,
        },
        APP_VERSION,
      );

      setLastSubmission(result);
      clearFormFields();
      setFormOpen(false);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Submission failed');
    } finally {
      setSubmitting(false);
    }
  }

  function clearFormFields(): void {
    setIndicator('');
    setSpecies('');
    setBrainRegion('');
    setLabName('');
    setOrcid('');
    setVirusConstruct('');
    setTimeSinceInjection('');
    setNotes('');
    setMicroscopeType('');
    setCellType('');
    setImagingDepth('');
  }

  return (
    <Show when={isComplete()}>
      <div class="submit-panel" data-tutorial="submit-panel">
        {/* Kernel result summary */}
        <div class="submit-panel__summary">
          <span>
            rise: {((currentTauRise() ?? 0) * 1000).toFixed(1)}ms, decay:{' '}
            {((currentTauDecay() ?? 0) * 1000).toFixed(1)}ms
          </span>
        </div>
        <div class="submit-panel__converged-badge">
          <span class={isConverged() ? 'badge--converged' : 'badge--stopped'}>
            {isConverged()
              ? `Converged at iteration ${convergedAtIteration()}`
              : `Stopped at iteration ${currentIteration()}`}
          </span>
        </div>

        {/* Action buttons */}
        <div class="submit-panel__actions">
          <Show when={supabaseEnabled}>
            <button
              class="btn-secondary btn-small"
              onClick={() => {
                setFormOpen((prev) => !prev);
                loadFieldOptions();
              }}
            >
              {formOpen() ? 'Cancel' : 'Submit to Community'}
            </button>
          </Show>
        </div>

        {/* Submission summary card */}
        <Show when={lastSubmission()}>
          {(submission) => (
            <SharedSubmissionSummary
              submission={submission()}
              renderParams={(s: CadeconSubmission) => (
                <>
                  <span>tau_rise: {(s.tau_rise * 1000).toFixed(1)}ms</span>
                  <span>tau_decay: {(s.tau_decay * 1000).toFixed(1)}ms</span>
                  <span>iterations: {s.num_iterations}</span>
                  <span>{s.converged ? 'converged' : 'stopped'}</span>
                </>
              )}
              onDismiss={() => setLastSubmission(null)}
              onDelete={async (id: string) => {
                await deleteSubmission(id);
                setLastSubmission(null);
              }}
            />
          )}
        </Show>

        {/* Metadata form modal */}
        <Show when={formOpen() && !lastSubmission()}>
          <SubmitFormModal onClose={() => setFormOpen(false)}>
            <Show when={isDemo()}>
              <div class="submit-panel__demo-notice">
                You're running on simulated demo data — submitting is encouraged!
              </div>
            </Show>

            <AuthGate />

            <Show when={user()}>
              <Show when={!isDemo()}>
                <SearchableField
                  label="Calcium Indicator"
                  required
                  options={fieldOptions().indicators}
                  signal={{ get: indicator, set: setIndicator }}
                  placeholder="e.g. GCaMP6f (AAV)"
                  fieldName="indicator"
                />
                <SearchableField
                  label="Species"
                  required
                  options={fieldOptions().species}
                  signal={{ get: species, set: setSpecies }}
                  placeholder="e.g. mouse"
                  fieldName="species"
                />
                <SearchableField
                  label="Brain Region"
                  required
                  options={fieldOptions().brainRegions}
                  signal={{ get: brainRegion, set: setBrainRegion }}
                  placeholder="e.g. cortex"
                  fieldName="brain_region"
                />
                <SearchableField
                  label="Microscope Type"
                  options={fieldOptions().microscopeTypes}
                  signal={{ get: microscopeType, set: setMicroscopeType }}
                  placeholder="e.g. 2-photon"
                  fieldName="microscope_type"
                />
                <SearchableField
                  label="Cell Type"
                  options={fieldOptions().cellTypes}
                  signal={{ get: cellType, set: setCellType }}
                  placeholder="e.g. pyramidal cell"
                  fieldName="cell_type"
                />

                <div class="submit-panel__field">
                  <label>Imaging Depth (um)</label>
                  <input
                    type="number"
                    value={imagingDepth()}
                    onInput={(e) => setImagingDepth(e.currentTarget.value)}
                    placeholder="Optional"
                    min="0"
                  />
                </div>

                <div class="submit-panel__field">
                  <label>Virus / Construct</label>
                  <input
                    type="text"
                    value={virusConstruct()}
                    onInput={(e) => setVirusConstruct(e.currentTarget.value)}
                    placeholder="Optional"
                  />
                </div>

                <div class="submit-panel__field">
                  <label>Time Since Injection (days)</label>
                  <input
                    type="number"
                    value={timeSinceInjection()}
                    onInput={(e) => setTimeSinceInjection(e.currentTarget.value)}
                    placeholder="Optional"
                    min="0"
                  />
                </div>
              </Show>

              <div class="submit-panel__field">
                <label>Lab Name</label>
                <input
                  type="text"
                  value={labName()}
                  onInput={(e) => setLabName(e.currentTarget.value)}
                  placeholder="Optional"
                />
              </div>

              <div class="submit-panel__field">
                <label>ORCID</label>
                <input
                  type="text"
                  value={orcid()}
                  onInput={(e) => setOrcid(e.currentTarget.value)}
                  placeholder="0000-0000-0000-0000"
                />
              </div>

              <div class="submit-panel__field">
                <label>Notes</label>
                <textarea
                  value={notes()}
                  onInput={(e) => setNotes(e.currentTarget.value)}
                  placeholder="Optional notes about this dataset or run"
                  rows={3}
                />
              </div>

              <PrivacyNotice />

              <Show when={validationErrors().length > 0}>
                <div class="submit-panel__errors">
                  {validationErrors().map((issue) => (
                    <p class="submit-panel__error-item">{issue}</p>
                  ))}
                </div>
              </Show>

              <Show when={submitError()}>
                <div class="submit-panel__errors">
                  <p class="submit-panel__error-item">{submitError()}</p>
                </div>
              </Show>

              <button
                class="btn-primary"
                onClick={handleSubmit}
                disabled={!requiredFieldsFilled() || submitting()}
              >
                {submitting() ? 'Submitting...' : 'Submit Parameters'}
              </button>
            </Show>
          </SubmitFormModal>
        </Show>
      </div>
    </Show>
  );
}

// Internal helper: SearchableSelect field with label
interface SearchableFieldProps {
  label: string;
  required?: boolean;
  options: string[];
  signal: FieldSignal;
  placeholder: string;
  fieldName: 'indicator' | 'species' | 'brain_region' | 'microscope_type' | 'cell_type';
}

function SearchableField(props: SearchableFieldProps) {
  return (
    <div class="submit-panel__field">
      <label>
        {props.label}
        <Show when={props.required}>
          {' '}
          <span class="submit-panel__required-marker">*</span>
        </Show>
      </label>
      <SearchableSelect
        options={props.options}
        value={props.signal.get()}
        onChange={props.signal.set}
        placeholder={fieldOptionsLoading() ? 'Loading...' : props.placeholder}
      />
      <div class="submit-panel__request-link">
        Don't see yours?{' '}
        <a
          href={buildFieldOptionRequestUrl(props.fieldName, 'cadecon')}
          target="_blank"
          rel="noopener noreferrer"
        >
          Request it
        </a>
      </div>
    </div>
  );
}
