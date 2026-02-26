/**
 * Clickable trace legend with color swatches.
 * Each item toggles a series on/off. Supports solid and dashed swatches.
 */

import { Show, For, type Accessor, type Setter, type JSX } from 'solid-js';
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
function InfoPopover(props: { content: JSX.Element }) {
  let open = false;
  let ref: HTMLDivElement | undefined;

  const toggle = () => {
    open = !open;
    if (ref) ref.style.display = open ? 'block' : 'none';
  };

  return (
    <>
      <button class="trace-legend__info-btn" title="What do these traces mean?" onClick={toggle}>
        ?
      </button>
      <div ref={ref} class="trace-legend__popover" style={{ display: 'none' }}>
        {props.content}
      </div>
    </>
  );
}
