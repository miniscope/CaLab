import { createSignal, For, type JSX } from 'solid-js';
import { DashboardPanel } from '@calab/ui';
import type { CellStore } from '../lib/cell-store.ts';
import type { FrameSourceInfo } from '../lib/frame-source.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import type { ViewerStore } from '../lib/viewer-store.ts';
import { CellCountPlot, LagPlot, TimingText } from './CellsPanel.tsx';
import { FlickerTrace } from './FlickerTrace.tsx';
import { FrameViewer } from './FrameViewer.tsx';
import { InfoPanel } from './InfoPanel.tsx';
import { MotionTrace } from './MotionTrace.tsx';
import { QcTable } from './QcTable.tsx';

interface Tab {
  id: string;
  label: string;
  content: JSX.Element;
}

/**
 * Secondary plots and panels behind tabs, under the video. Every tab stays
 * mounted (hidden with display:none) so its plot keeps up while out of view;
 * the whole strip can be collapsed to give the video more room.
 */
export function DetailsTabs(props: {
  store: PipelineStore;
  cells: CellStore;
  viewer: ViewerStore;
  info: FrameSourceInfo;
}): JSX.Element {
  const tabs: Tab[] = [
    { id: 'qc', label: 'Cell QC', content: <QcTable cells={props.cells} /> },
    { id: 'cells', label: 'Cells', content: <CellCountPlot cells={props.cells} /> },
    { id: 'lag', label: 'Lag', content: <LagPlot cells={props.cells} /> },
    { id: 'motion', label: 'Motion', content: <MotionTrace store={props.store} /> },
    { id: 'flicker', label: 'Flicker', content: <FlickerTrace store={props.store} /> },
    {
      id: 'timing',
      label: 'Timing',
      content: <TimingText store={props.store} cells={props.cells} />,
    },
    // A live stream has no file to scrub through (the recording is opened once
    // per mount, so this is read once on purpose).
    // eslint-disable-next-line solid/reactivity
    ...(props.info.live
      ? []
      : [{ id: 'raw', label: 'Raw file', content: <FrameViewer store={props.viewer} /> }]),
    { id: 'recording', label: 'Recording', content: <InfoPanel info={props.info} /> },
  ];
  const [active, setActive] = createSignal('qc');
  const [open, setOpen] = createSignal(true);

  return (
    <DashboardPanel
      id="details"
      variant="data"
      class={`cala-details${open() ? '' : ' cala-details--closed'}`}
    >
      <div class="cala-tabs__bar" role="tablist">
        <For each={tabs}>
          {(tab) => (
            <button
              type="button"
              role="tab"
              aria-selected={open() && active() === tab.id}
              class="cala-tabs__tab"
              classList={{ 'cala-tabs__tab--active': open() && active() === tab.id }}
              onClick={() => {
                setActive(tab.id);
                setOpen(true);
              }}
            >
              {tab.label}
            </button>
          )}
        </For>
        <button
          type="button"
          class="cala-tabs__toggle"
          aria-expanded={open()}
          aria-label={open() ? 'Hide plots' : 'Show plots'}
          title={open() ? 'Hide plots (more room for the video)' : 'Show plots'}
          onClick={() => setOpen((v) => !v)}
        >
          <svg
            class={`panel-collapse-chevron${open() ? ' panel-collapse-chevron--open' : ''}`}
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
          >
            <path
              d="M3 4.5L6 7.5L9 4.5"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>
      <div class="cala-tabs__content" hidden={!open()}>
        <For each={tabs}>
          {(tab) => (
            <div role="tabpanel" style={{ display: active() === tab.id ? 'block' : 'none' }}>
              {tab.content}
            </div>
          )}
        </For>
      </div>
    </DashboardPanel>
  );
}
