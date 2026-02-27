import type { JSX } from 'solid-js';

interface ToggleSwitchProps {
  label: string;
  description: string | JSX.Element;
  checked: boolean;
  onChange: (checked: boolean) => void;
  class?: string;
  style?: string;
  disabled?: boolean;
}

export function ToggleSwitch(props: ToggleSwitchProps): JSX.Element {
  const titleText = () => {
    const desc = props.description;
    return typeof desc === 'string' ? desc : undefined;
  };

  return (
    <div
      class={`param-panel__toggle-group${props.class ? ' ' + props.class : ''}`}
      classList={{ 'param-panel__toggle-group--disabled': !!props.disabled }}
      style={props.style}
      title={titleText()}
    >
      <label class="param-panel__toggle">
        <input
          type="checkbox"
          checked={props.checked}
          disabled={props.disabled}
          onChange={(e) => props.onChange(e.currentTarget.checked)}
        />
        <span class="param-panel__toggle-label">{props.label}</span>
      </label>
    </div>
  );
}
