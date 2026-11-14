import { Show, type JSX } from 'solid-js';
import { DashboardPanel, Tabs, type TabItem } from '@calab/ui';
import type { CellStore } from '../lib/cell-store.ts';
import type { FrameSourceInfo } from '../lib/frame-source.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import type { ViewerStore } from '../lib/viewer-store.ts';
import { TimingText } from './CellsPanel.tsx';
import { FlatFieldPanel } from './FlatFieldPanel.tsx';
import { FrameViewer } from './FrameViewer.tsx';
import { HistoryTab, type HistoryUi } from './HistoryPanel.tsx';
import { InfoPanel } from './InfoPanel.tsx';
import { QcTable, type QcTableState } from './QcTable.tsx';

/**
 * The right-hand column: the run strip, always in view, over one row of tabs
 * (Run, Cell, QC, History and the pipeline details), one panel at a time with
 * the column's whole height. Arrow keys move between the tabs.
 *
 * Panels mount only while shown, except those whose state would be lost
 * (`keepMounted` on the tab): Run (the run's controls and export), Cell (the
 * trace window, the footprint version) and Raw file (its held display range).
 */
export function SideColumn(props: {
  strip: JSX.Element;
  tabs: TabItem[];
  active: string;
  onActive: (id: string) => void;
}): JSX.Element {
  return (
    <>
      {props.strip}
      <DashboardPanel id="side-tabs" variant="data" class="cala-side-tabs">
        <Tabs
          tabs={props.tabs}
          active={props.active}
          onChange={props.onActive}
          keepMounted={false}
          barClass="cala-side-tabs__bar"
          panelClass="cala-side-tabs__panel"
          panelDisplay="flex"
          aria-label="Panels"
          idBase="cala-side"
        />
      </DashboardPanel>
    </>
  );
}

/**
 * The pipeline-detail tabs after Run and Cell: QC, History, Flat field,
 * Timing, Raw file and Recording (a saved result: no Timing, no Raw file).
 * While History is expanded into the large area, its tab holds the field of
 * view instead.
 */
export function detailTabs(props: {
  /** The live pipeline (absent: a saved result; give `flatField` and `recording`). */
  store?: PipelineStore;
  cells: CellStore;
  /** The QC table's sort and filter (kept while its tab is hidden). */
  qc: QcTableState;
  /** The open recording, for the Raw file tab (absent: no such tab). */
  viewer?: ViewerStore;
  /** The open recording's facts (absent: give `recording`). */
  info?: FrameSourceInfo;
  /** Contents of the Flat field and Recording tabs instead of the live ones (a saved result). */
  flatField?: () => JSX.Element;
  recording?: () => JSX.Element;
  ui: HistoryUi;
  /** The field of view, shown in the History tab while History is expanded. */
  fov: () => JSX.Element;
}): TabItem[] {
  const attention = () => props.ui.run.attention().size > 0;
  // The tabs are built once per mount: the live pipeline or one saved result.
  /* eslint-disable solid/reactivity */
  const store = props.store;
  return [
    {
      id: 'qc',
      label: 'QC',
      title: 'Every cell with its QC metrics',
      testid: 'tab-qc',
      content: () => <QcTable cells={props.cells} state={props.qc} />,
    },
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
      content: () => (
        <Show
          when={!props.ui.expanded()}
          fallback={<div class="cala-details__fov">{props.fov()}</div>}
        >
          <HistoryTab ui={props.ui} />
        </Show>
      ),
    },
    {
      id: 'flatfield',
      label: 'Flat field',
      testid: 'tab-flatfield',
      content: () =>
        store ? (
          <FlatFieldPanel
            store={store}
            width={props.info?.width ?? 0}
            height={props.info?.height ?? 0}
          />
        ) : (
          props.flatField?.()
        ),
    },
    // A saved result has no timings and no file to scrub through.
    ...(store
      ? [
          {
            id: 'timing',
            label: 'Timing',
            testid: 'tab-timing',
            content: () => <TimingText store={store} cells={props.cells} />,
          },
        ]
      : []),
    // A live stream has no file to scrub through (the recording is opened once
    // per mount, so this is read once on purpose). Kept mounted: its held
    // display range would be lost.
    ...(props.info?.live || !props.viewer
      ? []
      : [
          {
            id: 'raw',
            label: 'Raw file',
            testid: 'tab-raw',
            keepMounted: true,
            content: () => <FrameViewer store={props.viewer!} />,
          },
        ]),
    {
      id: 'recording',
      label: 'Recording',
      testid: 'tab-recording',
      content: () => (props.info ? <InfoPanel info={props.info} /> : props.recording?.()),
    },
  ];
  /* eslint-enable solid/reactivity */
}
