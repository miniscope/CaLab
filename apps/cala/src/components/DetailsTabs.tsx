import { Show, type JSX } from 'solid-js';
import { Tabs, type TabItem } from '@calab/ui';
import type { CellStore } from '../lib/cell-store.ts';
import type { FrameSourceInfo } from '../lib/frame-source.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import type { ViewerStore } from '../lib/viewer-store.ts';
import { TimingText } from './CellsPanel.tsx';
import { FlatFieldPanel } from './FlatFieldPanel.tsx';
import { FrameViewer } from './FrameViewer.tsx';
import { HistoryTab, type HistoryUi } from './HistoryPanel.tsx';
import { InfoPanel } from './InfoPanel.tsx';
import { QcTable } from './QcTable.tsx';
import { SidePanel } from './SidePanel.tsx';

/** Smallest height of the History tab's plot, CSS px (it grows to the panel's height). */
const HISTORY_PLOT_MIN_PX = 140;

/**
 * Pipeline details behind tabs, at the foot of the right-hand column. Every
 * tab stays mounted (hidden with display:none) so its plot keeps up while out
 * of view; the panel collapses to give the cell viewer more room.
 *
 * History replaces the old Motion, Flicker, Cells and Lag tabs. While History
 * is expanded into the large area, its tab holds the field of view instead.
 */
export function DetailsTabs(props: {
  /** The live pipeline (absent: a saved result; give `flatField` and `recording`). */
  store?: PipelineStore;
  cells: CellStore;
  /** The open recording, for the Raw file tab (absent: no such tab). */
  viewer?: ViewerStore;
  /** The open recording's facts (absent: give `recording`). */
  info?: FrameSourceInfo;
  /** Contents of the Flat field and Recording tabs instead of the live ones (a saved result). */
  flatField?: () => JSX.Element;
  recording?: () => JSX.Element;
  ui: HistoryUi;
  active: string;
  onActive: (id: string) => void;
  /** The field of view, shown in the History tab while History is expanded. */
  fov: () => JSX.Element;
}): JSX.Element {
  const attention = () => props.ui.run.attention().size > 0;
  // The tabs are built once per mount: the live pipeline or one saved result.
  /* eslint-disable solid/reactivity */
  const tabs: TabItem[] = [
    { id: 'qc', label: 'Cell QC', content: <QcTable cells={props.cells} /> },
    {
      id: 'history',
      label: (
        <>
          History
          <Show when={attention()}>
            <span class="cala-history__dot" aria-hidden="true" />
          </Show>
        </>
      ),
      testid: 'tab-history',
      content: (
        <Show
          when={!props.ui.expanded()}
          fallback={<div class="cala-details__fov">{props.fov()}</div>}
        >
          <HistoryTab ui={props.ui} minHeight={HISTORY_PLOT_MIN_PX} />
        </Show>
      ),
    },
    {
      id: 'flatfield',
      label: 'Flat field',
      content: props.store ? (
        <FlatFieldPanel
          store={props.store}
          width={props.info?.width ?? 0}
          height={props.info?.height ?? 0}
        />
      ) : (
        props.flatField?.()
      ),
    },
    // A saved result has no timings and no file to scrub through.
    ...(props.store
      ? [
          {
            id: 'timing',
            label: 'Timing',
            content: <TimingText store={props.store} cells={props.cells} />,
          },
        ]
      : []),
    // A live stream has no file to scrub through (the recording is opened once
    // per mount, so this is read once on purpose).
    ...(props.info?.live || !props.viewer
      ? []
      : [{ id: 'raw', label: 'Raw file', content: <FrameViewer store={props.viewer} /> }]),
    {
      id: 'recording',
      label: 'Recording',
      content: props.info ? <InfoPanel info={props.info} /> : props.recording?.(),
    },
  ];
  /* eslint-enable solid/reactivity */
  return (
    <SidePanel
      id="details"
      title="Details"
      class={`cala-details${props.active === 'history' ? ' cala-details--grow' : ''}`}
    >
      <Tabs
        tabs={tabs}
        active={props.active}
        onChange={props.onActive}
        class="cala-details__tabs"
        panelClass="cala-details__panel"
      />
    </SidePanel>
  );
}
