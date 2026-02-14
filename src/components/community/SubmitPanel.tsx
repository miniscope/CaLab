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
  isDemo,
  demoPreset,
  groundTruthVisible,
  groundTruthLocked,
  revealGroundTruth,
  toggleGroundTruthVisibility,
} from '../../lib/data-store';
import { computeAR2 } from '../../lib/ar2';
import { buildExportData, downloadExport } from '../../lib/export';
import { submitParameters } from '../../lib/community/community-service';
import {
  validateSubmission,
  computeQualityScore,
} from '../../lib/community/quality-checks';
import { computeDatasetHash } from '../../lib/community/dataset-hash';
import {
  user,
  fieldOptions,
  fieldOptionsLoading,
  loadFieldOptions,
} from '../../lib/community/community-store';
import { supabaseEnabled } from '../../lib/supabase';
import type {
  SubmissionPayload,
  CommunitySubmission,
} from '../../lib/community/types';
import { buildFieldOptionRequestUrl } from '../../lib/community/github-issue-url';
import { SearchableSelect } from './SearchableSelect';
import { AuthGate } from './AuthGate';
import { PrivacyNotice } from './PrivacyNotice';
import { SubmissionSummary } from './SubmissionSummary';
import '../../styles/community.css';

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
  const [microscopeType, setMicroscopeType] = createSignal('');
  const [cellType, setCellType] = createSignal('');
  const [imagingDepth, setImagingDepth] = createSignal('');

  // --- Derived ---
  const requiredFieldsFilled = () =>
    isDemo() ||
    (indicator().trim() !== '' &&
    species().trim() !== '' &&
    brainRegion().trim() !== '');

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
        indicator: isDemo() ? 'simulated' : indicator().trim(),
        species: isDemo() ? 'simulated' : species().trim(),
        brain_region: isDemo() ? 'simulated' : brainRegion().trim(),
        lab_name: labName().trim() || undefined,
        orcid: orcid().trim() || undefined,
        virus_construct: isDemo() ? undefined : virusConstruct().trim() || undefined,
        time_since_injection_days: isDemo() ? undefined
          : timeSinceInjection() ? parseInt(timeSinceInjection(), 10) : undefined,
        notes: notes().trim() || undefined,
        microscope_type: isDemo() ? undefined : microscopeType().trim() || undefined,
        imaging_depth_um: isDemo() ? undefined
          : imagingDepth() ? parseFloat(imagingDepth()) : undefined,
        cell_type: isDemo() ? undefined : cellType().trim() || undefined,
        num_cells: shape?.[0],
        recording_length_s: durationSeconds() ?? undefined,
        fps: fs,
        dataset_hash: datasetHash,
        quality_score: qualityScore,
        data_source: rawFile() ? 'user' : 'demo',
        catune_version: import.meta.env.VITE_APP_VERSION || 'dev',
        extra_metadata: isDemo() && demoPreset()
          ? { demo_preset: demoPreset()!.id }
          : undefined,
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
      setMicroscopeType('');
      setCellType('');
      setImagingDepth('');
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
        <Show when={!isDemo()}>
          <button class="btn-primary btn-small" onClick={handleExport}>
            Export Locally
          </button>
        </Show>
        <Show when={isDemo()}>
          <button
            class="btn-primary btn-small"
            onClick={() => {
              if (!groundTruthLocked()) {
                revealGroundTruth();
              } else {
                toggleGroundTruthVisibility();
              }
            }}
          >
            {groundTruthVisible() ? 'Hide Ground Truth' : 'Show Ground Truth'}
          </button>
        </Show>
        <Show when={supabaseEnabled}>
          <button
            class="btn-secondary btn-small"
            onClick={() => {
              setFormOpen((prev) => !prev);
              loadFieldOptions();
            }}
            disabled={groundTruthLocked()}
            title={groundTruthLocked() ? 'Community submission disabled — ground truth was viewed' : undefined}
          >
            {formOpen() ? 'Cancel' : 'Submit to Community'}
          </button>
        </Show>
      </div>

      <Show when={isDemo()}>
        <Show when={!groundTruthLocked()}>
          <div class="submit-panel__gt-warning">
            Revealing ground truth will disable community submission
          </div>
        </Show>
        <Show when={groundTruthLocked()}>
          <div class="submit-panel__gt-locked-notice">
            Community submission disabled — ground truth was viewed. Reload demo data to re-enable.
          </div>
        </Show>
      </Show>

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

              <Show when={isDemo()}>
                <div class="submit-panel__demo-notice">
                  You're tuning on simulated demo data — submitting is encouraged!
                  This helps the community see what parameters work well for the demo dataset.
                </div>
              </Show>

              <AuthGate />

              <Show when={user()}>
                {/* Experiment metadata fields — hidden for demo data */}
                <Show when={!isDemo()}>
                  {/* Required fields */}
                  <div class="submit-panel__field">
                    <label>
                      Calcium Indicator <span class="submit-panel__required-marker">*</span>
                    </label>
                    <SearchableSelect
                      options={fieldOptions().indicators}
                      value={indicator()}
                      onChange={setIndicator}
                      placeholder={fieldOptionsLoading() ? 'Loading...' : 'e.g. GCaMP6f (AAV)'}
                    />
                    <div class="submit-panel__request-link">
                      Don't see yours? <a href={buildFieldOptionRequestUrl('indicator')} target="_blank" rel="noopener noreferrer">Request it</a>
                    </div>
                  </div>

                  <div class="submit-panel__field">
                    <label>
                      Species <span class="submit-panel__required-marker">*</span>
                    </label>
                    <SearchableSelect
                      options={fieldOptions().species}
                      value={species()}
                      onChange={setSpecies}
                      placeholder={fieldOptionsLoading() ? 'Loading...' : 'e.g. mouse'}
                    />
                    <div class="submit-panel__request-link">
                      Don't see yours? <a href={buildFieldOptionRequestUrl('species')} target="_blank" rel="noopener noreferrer">Request it</a>
                    </div>
                  </div>

                  <div class="submit-panel__field">
                    <label>
                      Brain Region <span class="submit-panel__required-marker">*</span>
                    </label>
                    <SearchableSelect
                      options={fieldOptions().brainRegions}
                      value={brainRegion()}
                      onChange={setBrainRegion}
                      placeholder={fieldOptionsLoading() ? 'Loading...' : 'e.g. cortex'}
                    />
                    <div class="submit-panel__request-link">
                      Don't see yours? <a href={buildFieldOptionRequestUrl('brain_region')} target="_blank" rel="noopener noreferrer">Request it</a>
                    </div>
                  </div>

                  {/* Optional experiment fields */}
                  <div class="submit-panel__field">
                    <label>Microscope Type</label>
                    <SearchableSelect
                      options={fieldOptions().microscopeTypes}
                      value={microscopeType()}
                      onChange={setMicroscopeType}
                      placeholder={fieldOptionsLoading() ? 'Loading...' : 'e.g. 2-photon'}
                    />
                    <div class="submit-panel__request-link">
                      Don't see yours? <a href={buildFieldOptionRequestUrl('microscope_type')} target="_blank" rel="noopener noreferrer">Request it</a>
                    </div>
                  </div>

                  <div class="submit-panel__field">
                    <label>Cell Type</label>
                    <SearchableSelect
                      options={fieldOptions().cellTypes}
                      value={cellType()}
                      onChange={setCellType}
                      placeholder={fieldOptionsLoading() ? 'Loading...' : 'e.g. pyramidal cell'}
                    />
                    <div class="submit-panel__request-link">
                      Don't see yours? <a href={buildFieldOptionRequestUrl('cell_type')} target="_blank" rel="noopener noreferrer">Request it</a>
                    </div>
                  </div>

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

                {/* General optional fields — always visible */}
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
