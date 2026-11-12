import type { JSX } from 'solid-js';
import { Tabs, type TabItem } from '@calab/ui';
import type { CellStore } from '../lib/cell-store.ts';
import type { FrameSourceInfo } from '../lib/frame-source.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import type { ViewerStore } from '../lib/viewer-store.ts';
import { CellCountPlot, LagPlot, TimingText } from './CellsPanel.tsx';
import { FlatFieldPanel } from './FlatFieldPanel.tsx';
import { FlickerTrace } from './FlickerTrace.tsx';
import { FrameViewer } from './FrameViewer.tsx';
import { InfoPanel } from './InfoPanel.tsx';
import { MotionTrace } from './MotionTrace.tsx';
import { QcTable } from './QcTable.tsx';
import { SidePanel } from './SidePanel.tsx';

/**
 * Pipeline details behind tabs, at the foot of the right-hand column. Every
 * tab stays mounted (hidden with display:none) so its plot keeps up while out
 * of view; the panel collapses to give the cell viewer more room.
 */
export function DetailsTabs(props: {
  store: PipelineStore;
  cells: CellStore;
  viewer: ViewerStore;
  info: FrameSourceInfo;
}): JSX.Element {
  const tabs: TabItem[] = [
    { id: 'qc', label: 'Cell QC', content: <QcTable cells={props.cells} /> },
    { id: 'cells', label: 'Cells', content: <CellCountPlot cells={props.cells} /> },
    { id: 'lag', label: 'Lag', content: <LagPlot cells={props.cells} /> },
    { id: 'motion', label: 'Motion', content: <MotionTrace store={props.store} /> },
    { id: 'flicker', label: 'Flicker', content: <FlickerTrace store={props.store} /> },
    {
      id: 'flatfield',
      label: 'Flat field',
      content: (
        <FlatFieldPanel store={props.store} width={props.info.width} height={props.info.height} />
      ),
    },
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
  return (
    <SidePanel id="details" title="Details" class="cala-details">
      <Tabs
        tabs={tabs}
        defaultTab="qc"
        class="cala-details__tabs"
        panelClass="cala-details__panel"
      />
    </SidePanel>
  );
}
