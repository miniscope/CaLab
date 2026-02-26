/**
 * Clickable trace legend with color swatches.
 * Each item toggles a series on/off. Supports solid and dashed swatches.
 */

import { createSignal, Show, For, type Accessor, type Setter, type JSX } from 'solid-js';
import './styles/trace-legend.css';

export interface LegendItemConfig {
  key: string;
  color: string;
  label: string;
  visible: Accessor<boolean>;
  setVisible: Setter<boolean>;
  dashed?: boolean;
}

export interface TraceLegendProps {
  items: LegendItemConfig[];
  /** Optional "?" popover content */
  infoContent?: JSX.Element;
}

function LegendItem(props: LegendItemConfig) {
  const swatchClass = () =>
    props.dashed ? 'trace-legend__swatch trace-legend__swatch--dashed' : 'trace-legend__swatch';

  const swatchStyle = () =>
    props.dashed ? { 'border-color': props.color } : { background: props.color };

  return (
    <span
      class="trace-legend__item"
      classList={{ 'trace-legend__item--hidden': !props.visible() }}
      onClick={() => props.setVisible((v) => !v)}
    >
      <span class={swatchClass()} style={swatchStyle()} />
      {props.label}
    </span>
  );
}

export function TraceLegend(props: TraceLegendProps) {
  return (
    <div class="trace-legend">
      <Show when={props.infoContent}>
        <InfoPopover content={props.infoContent!} />
      </Show>
      <For each={props.items}>{(item) => <LegendItem {...item} />}</For>
    </div>
  );
}

/** Small "?" button with a toggle popover. */
function InfoPopover(props: { content: JSX.Element }): JSX.Element {
  const [open, setOpen] = createSignal(false);

  return (
    <>
      <button
        class="trace-legend__info-btn"
        title="What do these traces mean?"
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </button>
      <Show when={open()}>
        <div class="trace-legend__popover">{props.content}</div>
      </Show>
    </>
  );
}
