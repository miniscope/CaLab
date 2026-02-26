/**
 * Form field wrapper around SearchableSelect with label and "Request it" link.
 * Used in community submission forms across CaLab apps.
 *
 * Prop-driven: the caller provides field state, options, and loading indicator.
 */

import { Show } from 'solid-js';
import type { Accessor, Setter } from 'solid-js';
import { SearchableSelect } from './SearchableSelect.tsx';
import type { AppLabel } from '@calab/community';
import { buildFieldOptionRequestUrl } from '@calab/community';
import './styles/community.css';

/** Signal pair for a string form field. */
export interface FieldSignal {
  get: Accessor<string>;
  set: Setter<string>;
}

export interface SearchableFieldProps {
  label: string;
  required?: boolean;
  options: string[];
  signal: FieldSignal;
  placeholder: string;
  fieldName: 'indicator' | 'species' | 'brain_region' | 'microscope_type' | 'cell_type';
  appLabel: AppLabel;
  loading?: boolean;
}

export function SearchableField(props: SearchableFieldProps) {
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
        placeholder={props.loading ? 'Loading...' : props.placeholder}
      />
      <div class="submit-panel__request-link">
        Don't see yours?{' '}
        <a
          href={buildFieldOptionRequestUrl(props.fieldName, props.appLabel)}
          target="_blank"
          rel="noopener noreferrer"
        >
          Request it
        </a>
      </div>
    </div>
  );
}
