import type { JSX } from 'solid-js';

interface ToggleSwitchProps {
  label: string;
  description: string | JSX.Element;
  checked: boolean;
  onChange: (checked: boolean) => void;
  class?: string;
  style?: string;
}

export function ToggleSwitch(props: ToggleSwitchProps): JSX.Element {
  return (
    <div
      class={`param-panel__toggle-group${props.class ? ' ' + props.class : ''}`}
      style={props.style}
    >
      <label class="param-panel__toggle">
        <input
          type="checkbox"
          checked={props.checked}
          onChange={(e) => props.onChange(e.currentTarget.checked)}
        />
        <div>
          <span class="param-panel__toggle-label">{props.label}</span>
          <span class="param-panel__toggle-desc">{props.description}</span>
        </div>
      </label>
    </div>
  );
}
