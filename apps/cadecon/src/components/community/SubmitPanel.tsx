/**
 * CaDecon submit panel — always visible, with disabled button before completion.
 * Thin orchestrator that manages form state and delegates to:
 *  - SubmitForm (@calab/community-ui) for the modal form rendering
 *  - SubmissionSummary for the post-submission card
 *  - submitToSupabase for the actual submission logic
 */

import { createSignal, Show } from 'solid-js';
import {
  validateSubmission,
  loadFieldOptions,
  supabaseEnabled,
  submitToSupabase,
} from '../../lib/community/index.ts';
import type { CadeconSubmission } from '../../lib/community/index.ts';
import {
  runState,
  currentTauRise,
  currentTauDecay,
  convergenceHistory,
  alphaValues,
  pveValues,
  cellResultLookup,
  currentIteration,
  convergedAtIteration,
} from '../../lib/iteration-store.ts';
import {
  upsampleFactor,
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
  demoIndicator,
  groundTruthLocked,
  bridgeExportDone,
  importStore,
} from '../../lib/data-store.ts';
import {
  GroundTruthControls,
  GroundTruthNotices,
  SubmitForm,
  createSubmitFormFields,
} from '@calab/community-ui';
import { SubmissionSummary } from './SubmissionSummary.tsx';
import { ExportButton } from './ExportButton.tsx';
import { isBridgeAutorun } from '../../lib/bridge-effects.ts';
import '../../styles/community.css';

const APP_VERSION: string = import.meta.env.VITE_APP_VERSION || 'dev';

export function SubmitPanel() {
  // --- UI state ---
  const [formOpen, setFormOpen] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  const [lastSubmission, setLastSubmission] = createSignal<CadeconSubmission | null>(null);
  const [submitError, setSubmitError] = createSignal<string | null>(null);
  const [validationErrors, setValidationErrors] = createSignal<string[]>([]);

  const fields = createSubmitFormFields(isDemo);

  const isComplete = () => runState() === 'complete';
  const isConverged = () => convergedAtIteration() !== null;

  function submitButtonTitle(): string | undefined {
    if (groundTruthLocked()) return 'Disabled — ground truth was viewed';
    if (!isComplete()) return 'Available after convergence or manual stop';
    return undefined;
  }

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
        fields.values(),
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
          hpFilterEnabled: hpFilterEnabled(),
          lpFilterEnabled: lpFilterEnabled(),
          alphaValues: alphaValues(),
          pveValues: pveValues(),
          perTraceResults: Object.fromEntries(cellResultLookup()),
          durationSeconds: durationSeconds(),
          numIterations: currentIteration(),
          converged: isConverged(),
          numCells: effectiveShape()?.[0],
          recordingLengthS: durationSeconds() ?? undefined,
          datasetData: parsedData()?.data,
          dataSource: dataSource(),
          demoIndicator: demoIndicator() ?? undefined,
        },
        APP_VERSION,
      );

      setLastSubmission(result);
      fields.clear();
      setFormOpen(false);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Submission failed');
    } finally {
      setSubmitting(false);
    }
  }

  function handleDismissSummary(): void {
    setLastSubmission(null);
  }

  return (
    <div class="submit-panel" data-tutorial="submit-panel">
      {/* Kernel result summary + converged badge — only when complete */}
      <Show when={isComplete()}>
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
      </Show>

      {/* Action buttons */}
      <div class="submit-panel__actions">
        <ExportButton />
        <GroundTruthControls state={importStore} />

        <Show when={supabaseEnabled}>
          <button
            class="btn-secondary btn-small"
            onClick={() => {
              setFormOpen((prev) => !prev);
              loadFieldOptions();
            }}
            disabled={!isComplete() || groundTruthLocked()}
            title={submitButtonTitle()}
          >
            {formOpen() ? 'Cancel' : 'Submit to Community'}
          </button>
        </Show>
      </div>

      <Show when={isBridgeAutorun() && bridgeExportDone()}>
        <div class="submit-panel__autoexport-notice">Results auto-exported to Python</div>
      </Show>

      <GroundTruthNotices state={importStore} />

      <Show when={!isComplete() && !groundTruthLocked()}>
        <p class="submit-panel__disabled-hint">
          Export and submission available after convergence or manual stop
        </p>
      </Show>

      {/* Submission summary card */}
      <Show when={lastSubmission()}>
        {(submission) => (
          <SubmissionSummary
            submission={submission()}
            onDismiss={handleDismissSummary}
            onDelete={handleDismissSummary}
          />
        )}
      </Show>

      {/* Metadata form modal */}
      <Show when={formOpen() && !lastSubmission()}>
        <SubmitForm
          onClose={() => setFormOpen(false)}
          onSubmit={handleSubmit}
          submitting={submitting}
          validationErrors={validationErrors}
          submitError={submitError}
          fields={fields}
          appId={__APP_ID__}
          isDemo={isDemo}
          demoNotice={<>You're running on simulated demo data — submitting is encouraged!</>}
          notesPlaceholder="Optional notes about this dataset or run"
          privacySharedItems={
            <>
              When you submit, CaDecon sends only: kernel parameters (tau_rise, tau_decay, beta),
              aggregate statistics (median alpha, median PVE, mean event rate), run configuration,
              your experimental metadata (indicator, species, brain region), and a dataset
              fingerprint for duplicate detection.
            </>
          }
        />
      </Show>
    </div>
  );
}
