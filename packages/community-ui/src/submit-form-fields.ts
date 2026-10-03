// Signal-backed state for the community submit form (see SubmitForm.tsx).

import { createSignal, type Accessor } from 'solid-js';
import type { FieldSignal } from './SearchableField.tsx';
import type { FormFields } from './submission-payload.ts';

const FIELD_KEYS = [
  'indicator',
  'species',
  'brainRegion',
  'labName',
  'orcid',
  'virusConstruct',
  'timeSinceInjection',
  'notes',
  'microscopeType',
  'cellType',
  'imagingDepth',
] as const satisfies readonly (keyof FormFields)[];

/** Signal-backed state for every submit-form field. */
export interface SubmitFormFields {
  /** One get/set pair per field, for binding inputs. */
  signals: Record<keyof FormFields, FieldSignal>;
  /** Snapshot of the current values. */
  values: () => FormFields;
  /** Empty every field (after a successful submission). */
  clear: () => void;
  /** Indicator, species and brain region are filled in, or the data is a demo. */
  requiredFieldsFilled: Accessor<boolean>;
}

/**
 * Create the form state. `isDemo` relaxes the required fields: demo
 * submissions record 'simulated' for them instead.
 */
export function createSubmitFormFields(isDemo: Accessor<boolean>): SubmitFormFields {
  const signals = {} as Record<keyof FormFields, FieldSignal>;
  for (const key of FIELD_KEYS) {
    const [get, set] = createSignal('');
    signals[key] = { get, set };
  }
  return {
    signals,
    values: () => {
      const out = {} as FormFields;
      for (const key of FIELD_KEYS) out[key] = signals[key].get();
      return out;
    },
    clear: () => {
      for (const key of FIELD_KEYS) signals[key].set('');
    },
    requiredFieldsFilled: () =>
      isDemo() ||
      (signals.indicator.get().trim() !== '' &&
        signals.species.get().trim() !== '' &&
        signals.brainRegion.get().trim() !== ''),
  };
}
