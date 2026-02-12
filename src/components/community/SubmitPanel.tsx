/**
 * Unified save-and-share panel for CaTune.
 * Replaces the standalone ExportPanel as the single action point.
 *
 * Provides:
 *  - "Export Locally" button (always available, preserves existing export behavior)
 *  - "Submit to Community" button (shown when Supabase is configured)
 *  - Metadata form with required + optional fields
 *  - AuthGate for authentication before submission
 *  - PrivacyNotice inline in the form
 *  - SubmissionSummary after successful submission
 */

import { createSignal, Show, For, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import { tauRise, tauDecay, lambda } from '../../lib/viz-store';
import {
  samplingRate,
  effectiveShape,
  rawFile,
  parsedData,
  durationSeconds,
} from '../../lib/data-store';
import { computeAR2 } from '../../lib/ar2';
import { buildExportData, downloadExport } from '../../lib/export';
import { submitParameters } from '../../lib/community/community-service';
import {
  validateSubmission,
  computeQualityScore,
} from '../../lib/community/quality-checks';
import { computeDatasetHash } from '../../lib/community/dataset-hash';
import { user } from '../../lib/community/community-store';
import { supabaseEnabled } from '../../lib/supabase';
import type {
  SubmissionPayload,
  CommunitySubmission,
} from '../../lib/community/types';
import { AuthGate } from './AuthGate';
import { PrivacyNotice } from './PrivacyNotice';
import { SubmissionSummary } from './SubmissionSummary';
import '../../styles/community.css';

/** Datalist suggestion values for common metadata fields. */
const INDICATOR_SUGGESTIONS = [
  'GCaMP6f (AAV)',
  'GCaMP7f (AAV)',
  'GCaMP7f (transgenic)',
  'GCaMP8f (AAV)',
  'OGB-1 (dye)',
  'jGCaMP8f (AAV)',
];

const SPECIES_SUGGESTIONS = [
  'mouse',
  'rat',
  'zebrafish',
  'drosophila',
  'macaque',
];

const BRAIN_REGION_SUGGESTIONS = [
  'cortex',
  'hippocampus',
  'striatum',
  'cerebellum',
  'thalamus',
  'VTA',
  'NAc',
];

export function SubmitPanel() {
  // --- Local state ---
  const [formOpen, setFormOpen] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  const [lastSubmission, setLastSubmission] =
    createSignal<CommunitySubmission | null>(null);
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

  // --- Derived ---
  const requiredFieldsFilled = () =>
    indicator().trim() !== '' &&
    species().trim() !== '' &&
    brainRegion().trim() !== '';

  // --- Handlers ---

  const handleExport = () => {
    const fs = samplingRate() ?? 30;
    const shape = effectiveShape();
    const file = rawFile();

    const exportData = buildExportData(tauRise(), tauDecay(), lambda(), fs, {
      sourceFilename: file?.name,
      numCells: shape?.[0],
      numTimepoints: shape?.[1],
    });

    downloadExport(exportData);
  };

  const handleSubmit = async () => {
    setSubmitError(null);
    setValidationErrors([]);

    const fs = samplingRate() ?? 30;
    const shape = effectiveShape();
    const data = parsedData();

    // Validate parameters
    const validation = validateSubmission({
      tauRise: tauRise(),
      tauDecay: tauDecay(),
      lambda: lambda(),
      samplingRate: fs,
      numCells: shape?.[0],
      recordingLengthS: durationSeconds() ?? undefined,
    });

    if (!validation.valid) {
      setValidationErrors(validation.issues);
      return;
    }

    setSubmitting(true);

    try {
      // Compute dataset hash from parsed data
      let datasetHash = 'no-data';
      if (data?.data) {
        const floatData =
          data.data instanceof Float64Array
            ? data.data
            : new Float64Array(data.data);
        datasetHash = await computeDatasetHash(floatData);
      }

      // Compute AR2 and quality score
      const ar2 = computeAR2(tauRise(), tauDecay(), fs);
      const qualityScore = computeQualityScore({
        tauRise: tauRise(),
        tauDecay: tauDecay(),
        lambda: lambda(),
        samplingRate: fs,
        numCells: shape?.[0],
        recordingLengthS: durationSeconds() ?? undefined,
      });

      // Build payload
      const payload: SubmissionPayload = {
        tau_rise: tauRise(),
        tau_decay: tauDecay(),
        lambda: lambda(),
        sampling_rate: fs,
        ar2_g1: ar2.g1,
        ar2_g2: ar2.g2,
        indicator: indicator().trim(),
        species: species().trim(),
        brain_region: brainRegion().trim(),
        lab_name: labName().trim() || undefined,
        orcid: orcid().trim() || undefined,
        virus_construct: virusConstruct().trim() || undefined,
        time_since_injection_days: timeSinceInjection()
          ? parseInt(timeSinceInjection(), 10)
          : undefined,
        notes: notes().trim() || undefined,
        num_cells: shape?.[0],
        recording_length_s: durationSeconds() ?? undefined,
        fps: fs,
        dataset_hash: datasetHash,
        quality_score: qualityScore,
        catune_version: import.meta.env.VITE_APP_VERSION || 'dev',
      };

      const result = await submitParameters(payload);
      setLastSubmission(result);

      // Clear form
      setIndicator('');
      setSpecies('');
      setBrainRegion('');
      setLabName('');
      setOrcid('');
      setVirusConstruct('');
      setTimeSinceInjection('');
      setNotes('');
      setFormOpen(false);
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : 'Submission failed',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleDismissSummary = () => {
    setLastSubmission(null);
  };

  return (
    <div class="submit-panel" data-tutorial="export-panel">
      {/* Parameter summary row */}
      <div class="submit-panel__summary">
        <span>
          rise: {(tauRise() * 1000).toFixed(1)}ms, decay:{' '}
          {(tauDecay() * 1000).toFixed(1)}ms, lambda:{' '}
          {lambda().toExponential(2)}
        </span>
      </div>

      {/* Action buttons */}
      <div class="submit-panel__actions">
        <button class="btn-primary btn-small" onClick={handleExport}>
          Export Locally
        </button>
        <Show when={supabaseEnabled}>
          <button
            class="btn-secondary btn-small"
            onClick={() => setFormOpen((prev) => !prev)}
          >
            {formOpen() ? 'Cancel' : 'Submit to Community'}
          </button>
        </Show>
      </div>

      {/* Submission summary card (shown after successful submission) */}
      <Show when={lastSubmission()}>
        {(submission) => (
          <SubmissionSummary
            submission={submission()}
            onDismiss={handleDismissSummary}
            onDelete={handleDismissSummary}
          />
        )}
      </Show>

      {/* Metadata form — rendered as a centered modal via Portal */}
      <Show when={formOpen() && !lastSubmission()}>
        <Portal mount={document.body}>
          <div
            class="submit-modal__backdrop"
            onClick={(e) => { if (e.target === e.currentTarget) setFormOpen(false); }}
            ref={(el) => {
              const handleKey = (e: KeyboardEvent) => {
                if (e.key === 'Escape') setFormOpen(false);
              };
              document.addEventListener('keydown', handleKey);
              onCleanup(() => document.removeEventListener('keydown', handleKey));
            }}
          >
            <div class="submit-modal__content">
              <h3 class="submit-modal__title">Submit to Community</h3>
              <AuthGate />

              <Show when={user()}>
                {/* Required fields */}
                <div class="submit-panel__field">
                  <label>
                    Calcium Indicator <span class="submit-panel__required-marker">*</span>
                  </label>
                  <input
                    type="text"
                    list="indicator-suggestions"
                    value={indicator()}
                    onInput={(e) => setIndicator(e.currentTarget.value)}
                    placeholder="e.g. GCaMP6f (AAV)"
                  />
                  <datalist id="indicator-suggestions">
                    <For each={INDICATOR_SUGGESTIONS}>
                      {(s) => <option value={s} />}
                    </For>
                  </datalist>
                </div>

                <div class="submit-panel__field">
                  <label>
                    Species <span class="submit-panel__required-marker">*</span>
                  </label>
                  <input
                    type="text"
                    list="species-suggestions"
                    value={species()}
                    onInput={(e) => setSpecies(e.currentTarget.value)}
                    placeholder="e.g. mouse"
                  />
                  <datalist id="species-suggestions">
                    <For each={SPECIES_SUGGESTIONS}>
                      {(s) => <option value={s} />}
                    </For>
                  </datalist>
                </div>

                <div class="submit-panel__field">
                  <label>
                    Brain Region <span class="submit-panel__required-marker">*</span>
                  </label>
                  <input
                    type="text"
                    list="brain-region-suggestions"
                    value={brainRegion()}
                    onInput={(e) => setBrainRegion(e.currentTarget.value)}
                    placeholder="e.g. cortex"
                  />
                  <datalist id="brain-region-suggestions">
                    <For each={BRAIN_REGION_SUGGESTIONS}>
                      {(s) => <option value={s} />}
                    </For>
                  </datalist>
                </div>

                {/* Optional fields */}
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

                <div class="submit-panel__field">
                  <label>Notes</label>
                  <textarea
                    value={notes()}
                    onInput={(e) => setNotes(e.currentTarget.value)}
                    placeholder="Optional notes about this dataset or tuning"
                    rows={3}
                  />
                </div>

                <PrivacyNotice />

                {/* Validation errors */}
                <Show when={validationErrors().length > 0}>
                  <div class="submit-panel__errors">
                    <For each={validationErrors()}>
                      {(issue) => <p class="submit-panel__error-item">{issue}</p>}
                    </For>
                  </div>
                </Show>

                {/* Submit error */}
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
            </div>
          </div>
        </Portal>
      </Show>
    </div>
  );
}
