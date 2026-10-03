/**
 * Unified save-and-share panel for CaTune.
 * Thin orchestrator that manages form state and delegates to:
 *  - SubmitForm (@calab/community-ui) for the modal form rendering
 *  - GroundTruthControls (@calab/community-ui) for demo ground truth UI
 *  - submitToSupabase for the actual submission logic
 */

import { createSignal, Show } from 'solid-js';
import { tPeak, fwhm, lambda, filterEnabled } from '../../lib/viz-store.ts';
import {
  samplingRate,
  effectiveShape,
  rawFile,
  parsedData,
  durationSeconds,
  isDemo,
  dataSource,
  demoIndicator,
  groundTruthLocked,
  bridgeUrl,
  bridgeExportDone,
  setBridgeExportDone,
  bridgeExportError,
  setBridgeExportError,
  importStore,
} from '../../lib/data-store.ts';
import { postParamsToBridge } from '@calab/io';
import { getSolverVersion } from '@calab/core/wasm';
import { buildExportData, downloadExport } from '../../lib/export.ts';
import type { CaTuneExport } from '../../lib/export.ts';
import {
  validateSubmission,
  loadFieldOptions,
  supabaseEnabled,
  submitToSupabase,
  deleteSubmission,
} from '../../lib/community/index.ts';
import type { CatuneSubmission } from '../../lib/community/index.ts';
import {
  GroundTruthControls,
  GroundTruthNotices,
  SubmitForm,
  SubmissionSummary,
  createSubmitFormFields,
} from '@calab/community-ui';
import '../../styles/community.css';

const APP_VERSION: string = import.meta.env.VITE_APP_VERSION || 'dev';

export function SubmitPanel() {
  // --- UI state ---
  const [formOpen, setFormOpen] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  const [lastSubmission, setLastSubmission] = createSignal<CatuneSubmission | null>(null);
  const [submitError, setSubmitError] = createSignal<string | null>(null);
  const [validationErrors, setValidationErrors] = createSignal<string[]>([]);

  const fields = createSubmitFormFields(isDemo);

  // --- Handlers ---

  function buildCurrentExport(solverVersion?: string): CaTuneExport {
    const fs = samplingRate() ?? 30;
    const shape = effectiveShape();
    const file = rawFile();

    return buildExportData(
      tPeak(),
      fwhm(),
      lambda(),
      fs,
      filterEnabled(),
      {
        sourceFilename: file?.name,
        numCells: shape?.[0],
        numTimepoints: shape?.[1],
      },
      APP_VERSION,
      solverVersion,
    );
  }

  function handleExport(): void {
    downloadExport(buildCurrentExport());
  }

  function handleBridgeExport(): void {
    const url = bridgeUrl();
    if (!url) return;
    setBridgeExportError(null);
    getSolverVersion()
      .then((solverVersion) => postParamsToBridge(url, buildCurrentExport(solverVersion)))
      .then(() => setBridgeExportDone(true))
      .catch((err: unknown) => {
        setBridgeExportError(err instanceof Error ? err.message : 'Bridge export failed');
      });
  }

  async function handleSubmit(): Promise<void> {
    setSubmitError(null);
    setValidationErrors([]);

    const fs = samplingRate() ?? 30;
    const shape = effectiveShape();
    const data = parsedData();

    const validation = validateSubmission({
      tPeak: tPeak(),
      fwhm: fwhm(),
      lambda: lambda(),
      samplingRate: fs,
    });

    if (!validation.valid) {
      setValidationErrors(validation.issues);
      return;
    }

    setSubmitting(true);

    try {
      const result = await submitToSupabase(
        fields.values(),
        {
          tPeak: tPeak(),
          fwhm: fwhm(),
          lambda: lambda(),
          samplingRate: fs,
          filterEnabled: filterEnabled(),
          numCells: shape?.[0],
          recordingLengthS: durationSeconds() ?? undefined,
          datasetData: data?.data,
          dataSource: dataSource(),
          demoIndicator: demoIndicator() ?? undefined,
          rawFileName: rawFile()?.name,
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
    <div class="submit-panel" data-tutorial="export-panel">
      {/* Parameter summary row */}
      <div class="submit-panel__summary">
        <span>
          peak: {(tPeak() * 1000).toFixed(1)}ms, FWHM: {(fwhm() * 1000).toFixed(1)}ms, lambda:{' '}
          {lambda().toExponential(2)}
        </span>
      </div>

      {/* Action buttons */}
      <div class="submit-panel__actions">
        <Show when={!isDemo()}>
          <Show
            when={bridgeUrl() && !bridgeExportDone()}
            fallback={
              <button class="btn-primary btn-small" onClick={handleExport}>
                Export Locally
              </button>
            }
          >
            <button class="btn-primary btn-small" onClick={handleBridgeExport}>
              Export to Python
            </button>
          </Show>
        </Show>

        <Show when={bridgeExportError()}>
          <span class="submit-panel__error" role="alert">
            {bridgeExportError()}
          </span>
        </Show>

        <GroundTruthControls state={importStore} />

        <Show when={supabaseEnabled}>
          <button
            class="btn-secondary btn-small"
            onClick={() => {
              setFormOpen((prev) => !prev);
              loadFieldOptions();
            }}
            disabled={groundTruthLocked()}
            title={
              groundTruthLocked()
                ? 'Community submission disabled — ground truth was viewed'
                : undefined
            }
          >
            {formOpen() ? 'Cancel' : 'Submit to Community'}
          </button>
        </Show>
      </div>

      <GroundTruthNotices state={importStore} />

      {/* Submission summary card */}
      <Show when={lastSubmission()}>
        {(submission) => (
          <SubmissionSummary
            submission={submission()}
            renderParams={(s: CatuneSubmission) => (
              <>
                <span>tau_rise: {(s.tau_rise * 1000).toFixed(1)}ms</span>
                <span>tau_decay: {(s.tau_decay * 1000).toFixed(1)}ms</span>
                <span>lambda: {s.lambda.toExponential(2)}</span>
              </>
            )}
            onDismiss={handleDismissSummary}
            onDelete={deleteSubmission}
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
          demoNotice={
            <>
              You're tuning on simulated demo data — submitting is encouraged! This helps the
              community see what parameters work well for the demo dataset.
            </>
          }
          notesPlaceholder="Optional notes about this dataset or tuning"
          privacySharedItems={
            <>
              When you submit, CaTune sends only: parameter values (tau_rise, tau_decay, lambda),
              AR2 coefficients, sampling rate, your experimental metadata (indicator, species, brain
              region), and a dataset fingerprint for duplicate detection.
            </>
          }
        />
      </Show>
    </div>
  );
}
