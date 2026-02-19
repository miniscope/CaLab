/**
 * Unified save-and-share panel for CaTune.
 * Thin orchestrator that manages form state and delegates to:
 *  - SubmitForm for the modal form rendering
 *  - GroundTruthControls for demo ground truth UI
 *  - submitToSupabase for the actual submission logic
 */

import { createSignal, Show } from 'solid-js';
import { tauRise, tauDecay, lambda, filterEnabled } from '../../lib/viz-store.ts';
import {
  samplingRate,
  effectiveShape,
  rawFile,
  parsedData,
  durationSeconds,
  isDemo,
  demoPreset,
  groundTruthLocked,
} from '../../lib/data-store.ts';
import { buildExportData, downloadExport } from '@calab/io';
import {
  validateSubmission,
  loadFieldOptions,
  supabaseEnabled,
  submitToSupabase,
} from '../../lib/community/index.ts';
import type { CommunitySubmission } from '../../lib/community/index.ts';
import { GroundTruthControls, GroundTruthNotices } from './GroundTruthControls.tsx';
import { SubmitForm } from './SubmitForm.tsx';
import { SubmissionSummary } from './SubmissionSummary.tsx';
import '../../styles/community.css';

const APP_VERSION: string = import.meta.env.VITE_APP_VERSION || 'dev';

export function SubmitPanel() {
  // --- UI state ---
  const [formOpen, setFormOpen] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  const [lastSubmission, setLastSubmission] = createSignal<CommunitySubmission | null>(null);
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

  // --- Derived ---
  const requiredFieldsFilled = () =>
    isDemo() ||
    (indicator().trim() !== '' && species().trim() !== '' && brainRegion().trim() !== '');

  // --- Handlers ---

  function handleExport(): void {
    const fs = samplingRate() ?? 30;
    const shape = effectiveShape();
    const file = rawFile();

    const exportData = buildExportData(
      tauRise(),
      tauDecay(),
      lambda(),
      fs,
      filterEnabled(),
      {
        sourceFilename: file?.name,
        numCells: shape?.[0],
        numTimepoints: shape?.[1],
      },
      APP_VERSION,
    );

    downloadExport(exportData);
  }

  async function handleSubmit(): Promise<void> {
    setSubmitError(null);
    setValidationErrors([]);

    const fs = samplingRate() ?? 30;
    const shape = effectiveShape();
    const data = parsedData();

    const validation = validateSubmission({
      tauRise: tauRise(),
      tauDecay: tauDecay(),
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
          tauRise: tauRise(),
          tauDecay: tauDecay(),
          lambda: lambda(),
          samplingRate: fs,
          filterEnabled: filterEnabled(),
          numCells: shape?.[0],
          recordingLengthS: durationSeconds() ?? undefined,
          datasetData: data?.data,
          isDemo: isDemo(),
          demoPresetId: demoPreset()?.id,
          rawFileName: rawFile()?.name,
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

  function handleDismissSummary(): void {
    setLastSubmission(null);
  }

  return (
    <div class="submit-panel" data-tutorial="export-panel">
      {/* Parameter summary row */}
      <div class="submit-panel__summary">
        <span>
          rise: {(tauRise() * 1000).toFixed(1)}ms, decay: {(tauDecay() * 1000).toFixed(1)}ms,
          lambda: {lambda().toExponential(2)}
        </span>
      </div>

      {/* Action buttons */}
      <div class="submit-panel__actions">
        <Show when={!isDemo()}>
          <button class="btn-primary btn-small" onClick={handleExport}>
            Export Locally
          </button>
        </Show>

        <GroundTruthControls />

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

      <GroundTruthNotices />

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
          requiredFieldsFilled={requiredFieldsFilled}
          validationErrors={validationErrors}
          submitError={submitError}
          indicator={{ get: indicator, set: setIndicator }}
          species={{ get: species, set: setSpecies }}
          brainRegion={{ get: brainRegion, set: setBrainRegion }}
          microscopeType={{ get: microscopeType, set: setMicroscopeType }}
          cellType={{ get: cellType, set: setCellType }}
          imagingDepth={{ get: imagingDepth, set: setImagingDepth }}
          virusConstruct={{ get: virusConstruct, set: setVirusConstruct }}
          timeSinceInjection={{ get: timeSinceInjection, set: setTimeSinceInjection }}
          labName={{ get: labName, set: setLabName }}
          orcid={{ get: orcid, set: setOrcid }}
          notes={{ get: notes, set: setNotes }}
        />
      </Show>
    </div>
  );
}
