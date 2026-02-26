/**
 * Modal form for community parameter submission.
 * Uses shared SubmitFormModal shell from @calab/ui.
 */

import { Show, For } from 'solid-js';
import type { Accessor, Setter } from 'solid-js';
import { SubmitFormModal, SearchableField } from '@calab/ui';
import type { FieldSignal } from '@calab/ui';
import { isDemo } from '../../lib/data-store.ts';
import { user, fieldOptions, fieldOptionsLoading } from '../../lib/community/index.ts';
import { AuthGate } from './AuthGate.tsx';
import { PrivacyNotice } from './PrivacyNotice.tsx';

export interface SubmitFormProps {
  onClose: () => void;
  onSubmit: () => void;
  submitting: Accessor<boolean>;
  requiredFieldsFilled: Accessor<boolean>;
  validationErrors: Accessor<string[]>;
  submitError: Accessor<string | null>;

  // Form field signals
  indicator: FieldSignal;
  species: FieldSignal;
  brainRegion: FieldSignal;
  microscopeType: FieldSignal;
  cellType: FieldSignal;
  imagingDepth: FieldSignal;
  virusConstruct: FieldSignal;
  timeSinceInjection: FieldSignal;
  labName: FieldSignal;
  orcid: FieldSignal;
  notes: FieldSignal;
}

export function SubmitForm(props: SubmitFormProps) {
  return (
    <SubmitFormModal onClose={props.onClose}>
      <Show when={isDemo()}>
        <div class="submit-panel__demo-notice">
          You're tuning on simulated demo data — submitting is encouraged! This helps the community
          see what parameters work well for the demo dataset.
        </div>
      </Show>

      <AuthGate />

      <Show when={user()}>
        {/* Experiment metadata fields — hidden for demo data */}
        <Show when={!isDemo()}>
          <SearchableField
            label="Calcium Indicator"
            required
            options={fieldOptions().indicators}
            signal={props.indicator}
            placeholder="e.g. GCaMP6f (AAV)"
            fieldName="indicator"
            appLabel="catune"
            loading={fieldOptionsLoading()}
          />
          <SearchableField
            label="Species"
            required
            options={fieldOptions().species}
            signal={props.species}
            placeholder="e.g. mouse"
            fieldName="species"
            appLabel="catune"
            loading={fieldOptionsLoading()}
          />
          <SearchableField
            label="Brain Region"
            required
            options={fieldOptions().brainRegions}
            signal={props.brainRegion}
            placeholder="e.g. cortex"
            fieldName="brain_region"
            appLabel="catune"
            loading={fieldOptionsLoading()}
          />
          <SearchableField
            label="Microscope Type"
            options={fieldOptions().microscopeTypes}
            signal={props.microscopeType}
            placeholder="e.g. 2-photon"
            fieldName="microscope_type"
            appLabel="catune"
            loading={fieldOptionsLoading()}
          />
          <SearchableField
            label="Cell Type"
            options={fieldOptions().cellTypes}
            signal={props.cellType}
            placeholder="e.g. pyramidal cell"
            fieldName="cell_type"
            appLabel="catune"
            loading={fieldOptionsLoading()}
          />

          <div class="submit-panel__field">
            <label>Imaging Depth (um)</label>
            <input
              type="number"
              value={props.imagingDepth.get()}
              onInput={(e) => props.imagingDepth.set(e.currentTarget.value)}
              placeholder="Optional"
              min="0"
            />
          </div>

          <div class="submit-panel__field">
            <label>Virus / Construct</label>
            <input
              type="text"
              value={props.virusConstruct.get()}
              onInput={(e) => props.virusConstruct.set(e.currentTarget.value)}
              placeholder="Optional"
            />
          </div>

          <div class="submit-panel__field">
            <label>Time Since Injection (days)</label>
            <input
              type="number"
              value={props.timeSinceInjection.get()}
              onInput={(e) => props.timeSinceInjection.set(e.currentTarget.value)}
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
            value={props.labName.get()}
            onInput={(e) => props.labName.set(e.currentTarget.value)}
            placeholder="Optional"
          />
        </div>

        <div class="submit-panel__field">
          <label>ORCID</label>
          <input
            type="text"
            value={props.orcid.get()}
            onInput={(e) => props.orcid.set(e.currentTarget.value)}
            placeholder="0000-0000-0000-0000"
          />
        </div>

        <div class="submit-panel__field">
          <label>Notes</label>
          <textarea
            value={props.notes.get()}
            onInput={(e) => props.notes.set(e.currentTarget.value)}
            placeholder="Optional notes about this dataset or tuning"
            rows={3}
          />
        </div>

        <PrivacyNotice />

        {/* Validation errors */}
        <Show when={props.validationErrors().length > 0}>
          <div class="submit-panel__errors">
            <For each={props.validationErrors()}>
              {(issue) => <p class="submit-panel__error-item">{issue}</p>}
            </For>
          </div>
        </Show>

        {/* Submit error */}
        <Show when={props.submitError()}>
          <div class="submit-panel__errors">
            <p class="submit-panel__error-item">{props.submitError()}</p>
          </div>
        </Show>

        <button
          class="btn-primary"
          onClick={props.onSubmit}
          disabled={!props.requiredFieldsFilled() || props.submitting()}
        >
          {props.submitting() ? 'Submitting...' : 'Submit Parameters'}
        </button>
      </Show>
    </SubmitFormModal>
  );
}
