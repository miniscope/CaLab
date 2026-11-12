import { For, type JSX } from 'solid-js';

export interface SegmentedOption<T extends string> {
  value: T;
  label: JSX.Element;
  title?: string;
  disabled?: boolean;
  testid?: string;
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (v: T) => void;
  'aria-label': string;
  /** Default 'md'. */
  size?: 'sm' | 'md';
  class?: string;
  testid?: string;
}

/** Single-choice button group (radiogroup). Left/Right arrows move the selection. */
export function SegmentedControl<T extends string>(p: SegmentedControlProps<T>): JSX.Element {
  const move = (dir: 1 | -1) => {
    const opts = p.options;
    const n = opts.length;
    let i = opts.findIndex((o) => o.value === p.value);
    for (let k = 0; k < n; k++) {
      i = (i + dir + n) % n;
      if (!opts[i].disabled) {
        p.onChange(opts[i].value);
        return;
      }
    }
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (dir === 0) return;
    e.preventDefault();
    const group = e.currentTarget as HTMLElement;
    move(dir);
    // Keep focus on the newly selected option once it has re-rendered.
    queueMicrotask(() => group.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
  };
  return (
    <div
      class={`segmented segmented--${p.size ?? 'md'}${p.class ? ' ' + p.class : ''}`}
      role="radiogroup"
      aria-label={p['aria-label']}
      data-testid={p.testid}
      onKeyDown={onKeyDown}
    >
      <For each={p.options}>
        {(o) => (
          <button
            type="button"
            role="radio"
            aria-checked={p.value === o.value}
            class="segmented__option"
            classList={{ 'segmented__option--active': p.value === o.value }}
            title={o.title}
            disabled={o.disabled}
            data-testid={o.testid}
            onClick={() => p.onChange(o.value)}
          >
            {o.label}
          </button>
        )}
      </For>
    </div>
  );
}
