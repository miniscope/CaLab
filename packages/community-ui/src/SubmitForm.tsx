/**
 * Community submission form: the experiment-metadata fields every CaLab app
 * collects, rendered in the shared SubmitFormModal behind AuthGate.
 *
 * Field state comes from `createSubmitFormFields()` (submit-form-fields.ts), so an app's submit panel
 * owns one object instead of eleven signals, and reads the values back with
 * `fields.values()` when it builds its payload (see submission-payload.ts).
 * The app supplies only its wording: the demo notice, the privacy notice's
 * list of transmitted values, and the notes placeholder.
 */

import { Show, For, type Accessor, type JSX } from 'solid-js';
import type { AppLabel } from '@calab/community';
import {
  user,
  authLoading,
  signInWithEmail,
  signOut,
  fieldOptions,
  fieldOptionsLoading,
} from '@calab/community';
import { SubmitFormModal } from './SubmitFormModal.tsx';
import { SearchableField, type FieldSignal } from './SearchableField.tsx';
import { AuthGate } from './AuthGate.tsx';
import { PrivacyNotice } from './PrivacyNotice.tsx';
import type { SubmitFormFields } from './submit-form-fields.ts';

export interface SubmitFormProps {
  fields: SubmitFormFields;
  /** The app's id (its build-time `__APP_ID__`), used for field-request links. */
  appId: AppLabel;
  isDemo: Accessor<boolean>;
  /** Shown at the top of the form for demo data. */
  demoNotice: JSX.Element;
  /** What the app transmits, for the privacy notice. */
  privacySharedItems: JSX.Element;
  notesPlaceholder: string;
  onClose: () => void;
  onSubmit: () => void;
  submitting: Accessor<boolean>;
  validationErrors: Accessor<string[]>;
  submitError: Accessor<string | null>;
}

function TextField(props: {
  label: string;
  signal: FieldSignal;
  type?: 'text' | 'number';
  placeholder?: string;
}): JSX.Element {
  return (
    <div class="submit-panel__field">
      <label>{props.label}</label>
      <input
        type={props.type ?? 'text'}
        value={props.signal.get()}
        onInput={(e) => props.signal.set(e.currentTarget.value)}
        placeholder={props.placeholder ?? 'Optional'}
        min={props.type === 'number' ? '0' : undefined}
      />
    </div>
  );
}

export function SubmitForm(props: SubmitFormProps): JSX.Element {
  const f = () => props.fields.signals;

  return (
    <SubmitFormModal onClose={props.onClose}>
      <Show when={props.isDemo()}>
        <div class="submit-panel__demo-notice">{props.demoNotice}</div>
      </Show>

      <AuthGate
        user={user}
        authLoading={authLoading}
        signInWithEmail={signInWithEmail}
        signOut={signOut}
      />

      <Show when={user()}>
        {/* Experiment metadata fields — hidden for demo data */}
        <Show when={!props.isDemo()}>
          <SearchableField
            label="Calcium Indicator"
            required
            options={fieldOptions().indicators}
            signal={f().indicator}
            placeholder="e.g. GCaMP6f (AAV)"
            fieldName="indicator"
            appLabel={props.appId}
            loading={fieldOptionsLoading()}
          />
          <SearchableField
            label="Species"
            required
            options={fieldOptions().species}
            signal={f().species}
            placeholder="e.g. mouse"
            fieldName="species"
            appLabel={props.appId}
            loading={fieldOptionsLoading()}
          />
          <SearchableField
            label="Brain Region"
            required
            options={fieldOptions().brainRegions}
            signal={f().brainRegion}
            placeholder="e.g. cortex"
            fieldName="brain_region"
            appLabel={props.appId}
            loading={fieldOptionsLoading()}
          />
          <SearchableField
            label="Microscope Type"
            options={fieldOptions().microscopeTypes}
            signal={f().microscopeType}
            placeholder="e.g. 2-photon"
            fieldName="microscope_type"
            appLabel={props.appId}
            loading={fieldOptionsLoading()}
          />
          <SearchableField
            label="Cell Type"
            options={fieldOptions().cellTypes}
            signal={f().cellType}
            placeholder="e.g. pyramidal cell"
            fieldName="cell_type"
            appLabel={props.appId}
            loading={fieldOptionsLoading()}
          />

          <TextField label="Imaging Depth (um)" type="number" signal={f().imagingDepth} />
          <TextField label="Virus / Construct" signal={f().virusConstruct} />
          <TextField
            label="Time Since Injection (days)"
            type="number"
            signal={f().timeSinceInjection}
          />
        </Show>

        {/* General optional fields — always visible */}
        <TextField label="Lab Name" signal={f().labName} />
        <TextField label="ORCID" signal={f().orcid} placeholder="0000-0000-0000-0000" />

        <div class="submit-panel__field">
          <label>Notes</label>
          <textarea
            value={f().notes.get()}
            onInput={(e) => f().notes.set(e.currentTarget.value)}
            placeholder={props.notesPlaceholder}
            rows={3}
          />
        </div>

        <PrivacyNotice
          sharedItems={props.privacySharedItems}
          retainedItems={
            <>
              Your raw fluorescence traces, deconvolved activity, and any file data remain entirely
              in your browser's memory. No trace data is ever transmitted to any server.
            </>
          }
        />

        <Show when={props.validationErrors().length > 0}>
          <div class="submit-panel__errors">
            <For each={props.validationErrors()}>
              {(issue) => <p class="submit-panel__error-item">{issue}</p>}
            </For>
          </div>
        </Show>

        <Show when={props.submitError()}>
          <div class="submit-panel__errors">
            <p class="submit-panel__error-item">{props.submitError()}</p>
          </div>
        </Show>

        <button
          class="btn-primary"
          onClick={() => props.onSubmit()}
          disabled={!props.fields.requiredFieldsFilled() || props.submitting()}
        >
          {props.submitting() ? 'Submitting...' : 'Submit Parameters'}
        </button>
      </Show>
    </SubmitFormModal>
  );
}
