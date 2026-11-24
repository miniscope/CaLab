/**
 * A form field that offers presets in a click-to-open dropdown, with "Other…"
 * for a custom value (then a text box appears). Unlike a <datalist>, the
 * presets show on click in every browser.
 */
import { createSignal, For, Show, untrack, type JSX } from 'solid-js';

/** The dropdown value that switches to the text box. */
export const OTHER = '__other__';

export interface PresetFieldProps {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  required?: boolean;
  /** Longest custom value, characters. */
  max?: number;
  /** Shown in the custom text box. */
  placeholder?: string;
}

export function PresetField(props: PresetFieldProps): JSX.Element {
  // A value that is not a preset (typed earlier, or restored) opens the text box.
  const [other, setOther] = createSignal(
    untrack(() => props.value !== '' && !props.options.includes(props.value)),
  );
  const selected = () => (other() ? OTHER : props.value);

  return (
    <label class="cala-donate__field">
      <span>
        {props.label}
        {props.required ? ' *' : ''}
      </span>
      <span class="cala-donate__preset">
        <select
          value={selected()}
          aria-label={props.label}
          onChange={(e) => {
            const v = e.currentTarget.value;
            if (v === OTHER) {
              setOther(true);
              props.onChange('');
            } else {
              setOther(false);
              props.onChange(v);
            }
          }}
        >
          <option value="">choose</option>
          <For each={props.options}>{(o) => <option value={o}>{o}</option>}</For>
          <option value={OTHER}>Other…</option>
        </select>
        <Show when={other()}>
          <input
            type="text"
            value={props.value}
            maxLength={props.max ?? 128}
            placeholder={props.placeholder ?? 'type your own'}
            aria-label={`${props.label} (other)`}
            ref={(el) => queueMicrotask(() => el.focus())}
            onInput={(e) => props.onChange(e.currentTarget.value)}
          />
        </Show>
      </span>
    </label>
  );
}
