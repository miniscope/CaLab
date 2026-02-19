/**
 * Modal form for community parameter submission.
 * Rendered via Portal as a centered overlay with Escape key dismissal.
 */

import { Show, For, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { Accessor, Setter } from 'solid-js';
import { isDemo } from '../../lib/data-store.ts';
import { user, fieldOptions, fieldOptionsLoading } from '../../lib/community/community-store.ts';
import { buildFieldOptionRequestUrl } from '../../lib/community/github-issue-url.ts';
import { SearchableSelect } from './SearchableSelect.tsx';
import { AuthGate } from './AuthGate.tsx';
import { PrivacyNotice } from './PrivacyNotice.tsx';

/** Signal pair for a string form field. */
export interface FieldSignal {
  get: Accessor<string>;
  set: Setter<string>;
}

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
    <Portal mount={document.body}>
      <div
        class="submit-modal__backdrop"
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onClose();
        }}
        ref={(el) => {
          const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') props.onClose();
          };
          document.addEventListener('keydown', handleKey);
          onCleanup(() => document.removeEventListener('keydown', handleKey));
        }}
      >
        <div class="submit-modal__content">
          <h3 class="submit-modal__title">Submit to Community</h3>

          <Show when={isDemo()}>
            <div class="submit-panel__demo-notice">
              You're tuning on simulated demo data — submitting is encouraged! This helps the
              community see what parameters work well for the demo dataset.
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
              />
              <SearchableField
                label="Species"
                required
                options={fieldOptions().species}
                signal={props.species}
                placeholder="e.g. mouse"
                fieldName="species"
              />
              <SearchableField
                label="Brain Region"
                required
                options={fieldOptions().brainRegions}
                signal={props.brainRegion}
                placeholder="e.g. cortex"
                fieldName="brain_region"
              />
              <SearchableField
                label="Microscope Type"
                options={fieldOptions().microscopeTypes}
                signal={props.microscopeType}
                placeholder="e.g. 2-photon"
                fieldName="microscope_type"
              />
              <SearchableField
                label="Cell Type"
                options={fieldOptions().cellTypes}
                signal={props.cellType}
                placeholder="e.g. pyramidal cell"
                fieldName="cell_type"
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
        </div>
      </div>
    </Portal>
  );
}

// ---------------------------------------------------------------------------
// Internal helper: SearchableSelect field with label and "request" link
// ---------------------------------------------------------------------------

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
          href={buildFieldOptionRequestUrl(props.fieldName)}
          target="_blank"
          rel="noopener noreferrer"
        >
          Request it
        </a>
      </div>
    </div>
  );
}
