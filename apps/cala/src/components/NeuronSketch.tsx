import type { JSX } from 'solid-js';

/**
 * A small line sketch of a neuron for empty states: a soma, a few dendrites and an axon, with a
 * slow calcium glow in the soma. Decoration only (hidden from assistive tech and when the Fun
 * touches switch is off; still with reduced motion). Theme inks.
 */
export function NeuronSketch(props: { size?: number; class?: string }): JSX.Element {
  return (
    <svg
      class={`cala-neuron${props.class ? ' ' + props.class : ''}`}
      width={props.size ?? 72}
      height={props.size ?? 72}
      viewBox="0 0 72 72"
      aria-hidden="true"
    >
      <g class="cala-neuron__ink" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <path d="M30 31c-5-4-9-10-10-17" />
        <path d="M23 21c-4 0-7-2-10-5" />
        <path d="M41 30c3-6 9-10 16-11" />
        <path d="M49 21c2-4 2-8 1-11" />
        <path d="M29 41c-7 2-13 6-17 12" />
        <path d="M18 47c-4-1-8 0-11 2" />
        <path d="M40 42c3 7 4 15 3 24" />
        <path d="M42 56c4 1 7 4 9 8" />
      </g>
      <ellipse class="cala-neuron__glow" cx="35.5" cy="36" rx="9" ry="8" />
      <ellipse class="cala-neuron__soma" cx="35.5" cy="36" rx="7" ry="6.2" />
      <circle class="cala-neuron__nucleus" cx="36.5" cy="35" r="2" />
    </svg>
  );
}
