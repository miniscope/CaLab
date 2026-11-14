import { createMemo, createSignal, For, Show, type JSX } from 'solid-js';
import { SegmentedControl } from '@calab/ui';
import {
  createTimeWindow,
  formatElapsed,
  HistoryPlot,
  WholeRunStrip,
  type HistoryEvent,
  type TimeWindow,
} from '@calab/ui/chart';
import {
  groupKeys,
  HISTORY_GROUPS,
  type HistoryGroup,
  type RunHistory,
} from '../lib/run-history.ts';
import { AspectPlot } from '../lib/plot-size.tsx';

/** Shared state of the History views: the run, the time window, the open group, expanded or not. */
export interface HistoryUi {
  run: RunHistory;
  window: TimeWindow;
  expanded: () => boolean;
  setExpanded: (v: boolean) => void;
  /** The group the History tab shows. */
  group: () => HistoryGroup;
  setGroup: (g: HistoryGroup) => void;
  /** The selected series of each group (default: its first). */
  selected: (g: HistoryGroup) => string | undefined;
  select: (g: HistoryGroup, key: string) => void;
  /** End of the time axis: the recording's end, or now for a live run. */
  axisEnd: () => number;
  /** The window shown, stream seconds. */
  span: () => { t0: number; t1: number };
  /** Run events for the event lanes (pause/resume paired into spans). */
  events: () => readonly HistoryEvent[];
  /** The newest draw time of each plot, ms (measurement scripts read it with `?debug`). */
  drawMs: Record<string, number>;
}

const LANE_KIND: Record<string, string | undefined> = {
  flatfield: 'ff',
  warning: 'warn',
  gap: 'warn',
  error: 'warn',
  range: 'range',
  scale: 'scale',
  session: 'session',
};

export function createHistoryUi(run: RunHistory): HistoryUi {
  const window = createTimeWindow();
  const [expanded, setExpanded] = createSignal(false);
  const [group, setGroup] = createSignal<HistoryGroup>('imaging');
  const [selected, setSelected] = createSignal<Partial<Record<HistoryGroup, string>>>({});
  const axisEnd = () => {
    run.tick();
    return run.runEnd() ?? Math.max(run.now(), 1);
  };
  const events = createMemo((): HistoryEvent[] => {
    run.tick();
    const out: HistoryEvent[] = [];
    let pause: number | null = null;
    for (const e of run.events().list()) {
      if (e.kind === 'pause') pause = e.t;
      else if (e.kind === 'resume') {
        if (pause !== null) out.push({ t: pause, t1: e.t, kind: 'pause', label: 'Paused' });
        pause = null;
      } else {
        const kind = LANE_KIND[e.kind];
        if (kind) out.push({ t: e.t, kind, label: e.detail ?? e.kind });
      }
    }
    if (pause !== null) out.push({ t: pause, t1: run.now(), kind: 'pause', label: 'Paused' });
    return out;
  });
  return {
    run,
    window,
    expanded,
    setExpanded,
    group,
    setGroup: (g) => {
      setGroup(g);
      run.seen(g);
    },
    selected: (g) => selected()[g],
    select: (g, key) => setSelected({ ...selected(), [g]: key }),
    axisEnd,
    span: () => window.resolve(run.now(), axisEnd()),
    events,
    drawMs: {},
  };
}

/** One group's overlaid plot, wired to the shared window, cursor and events. */
export function GroupPlot(props: {
  ui: HistoryUi;
  group: HistoryGroup;
  height: number;
  compact?: boolean;
}): JSX.Element {
  const r = () => props.ui.run;
  const keys = createMemo(() => groupKeys(props.group, r().live()));
  return (
    <Show
      when={keys().length > 0}
      fallback={
        <p
          class="cala-muted cala-history__empty"
          style={{ height: `${props.height}px` }}
          data-testid={`history-${props.group}`}
          title="Cell diameter, PSF width and flatten σ estimates over the run arrive with the scale estimator (S2.4)."
        >
          No scale estimates yet
        </p>
      }
    >
      <HistoryPlot
        history={() => r().history()}
        keys={keys()}
        window={props.ui.span}
        now={() => r().now()}
        runEnd={() => r().runEnd()}
        events={props.ui.events}
        tick={() => r().tick()}
        height={props.height}
        selected={() => props.ui.selected(props.group) ?? keys()[0]}
        onSelect={(k) => props.ui.select(props.group, k)}
        inspected={props.ui.window.inspected}
        onInspect={(t) => props.ui.window.setInspected(t)}
        clockAt={(t) => r().clockAt(t)}
        onBrush={(a, b) => props.ui.window.setBrush(a, b)}
        onResetWindow={() => props.ui.window.setRun()}
        scaleGuides={props.group === 'scales'}
        compact={props.compact}
        label={HISTORY_GROUPS.find((g) => g.id === props.group)?.label}
        testid={`history-${props.group}`}
        onDraw={(ms) => (props.ui.drawMs[`${props.group}${props.compact ? '-run' : ''}`] = ms)}
      />
    </Show>
  );
}

/** The whole-run strip: the full run, the window as a rectangle; drag to brush. */
export function RunStrip(props: { ui: HistoryUi }): JSX.Element {
  const r = () => props.ui.run;
  return (
    <WholeRunStrip
      history={() => r().history()}
      seriesKey="cells"
      runEnd={props.ui.axisEnd}
      now={() => r().now()}
      window={props.ui.span}
      tick={() => r().tick()}
      onBrush={(a, b) => props.ui.window.setBrush(a, b)}
      onResetWindow={() => props.ui.window.setRun()}
      testid="history-strip"
    />
  );
}

const TAB_GROUPS = HISTORY_GROUPS.filter((g) => g.id !== 'convergence');

/** Expand / restore button of the History views. */
function ExpandButton(props: { ui: HistoryUi }): JSX.Element {
  const label = () =>
    props.ui.expanded() ? 'Restore the field of view' : 'Expand History into the large area';
  return (
    <button
      type="button"
      class="btn-secondary btn-small cala-icon-btn"
      data-testid="history-expand"
      aria-label={label()}
      title={label()}
      aria-pressed={props.ui.expanded()}
      onClick={() => props.ui.setExpanded(!props.ui.expanded())}
    >
      {props.ui.expanded() ? '⤡' : '⤢'}
    </button>
  );
}

/**
 * The History tab: one group at a time, with the expand button. The open
 * group's plot is sized by the shared aspect rule; the rest of the tab stays empty.
 */
export function HistoryTab(props: { ui: HistoryUi }): JSX.Element {
  return (
    <div class="cala-history" data-testid="history-tab">
      <div class="cala-history__bar">
        <SegmentedControl
          options={TAB_GROUPS.map((g) => ({
            value: g.id,
            label: (
              <>
                {g.label}
                <Show when={props.ui.run.attention().has(g.id)}>
                  <span class="cala-history__dot" title="A range stepped up or a warning" />
                </Show>
              </>
            ),
          }))}
          value={props.ui.group()}
          onChange={(v) => props.ui.setGroup(v)}
          aria-label="History group"
          size="sm"
          testid="history-group"
        />
        <ExpandButton ui={props.ui} />
      </div>
      <AspectPlot class="cala-history__plot">
        {(height) => (
          <For each={TAB_GROUPS}>
            {(g) => (
              <Show when={props.ui.group() === g.id}>
                <GroupPlot ui={props.ui} group={g.id} height={height()} />
              </Show>
            )}
          </For>
        )}
      </AspectPlot>
    </div>
  );
}

/** The expanded History's plots may be taller than the column's, still by aspect, px. */
const EXPANDED_MAX_PX = 340;

/** History in the large left area: the whole-run strip and every group, two columns. */
export function HistoryExpanded(props: { ui: HistoryUi }): JSX.Element {
  const range = () => {
    const s = props.ui.span();
    const span = s.t1 - s.t0;
    return `${formatElapsed(s.t0, span)} – ${formatElapsed(s.t1, span)}`;
  };
  const col = (ids: HistoryGroup[]) => (
    <div class="cala-history-x__col">
      <For each={ids}>
        {(id) => (
          <section class="cala-history-x__group">
            <h3 class="panel-label">{HISTORY_GROUPS.find((g) => g.id === id)?.label}</h3>
            <AspectPlot max={EXPANDED_MAX_PX}>
              {(height) => <GroupPlot ui={props.ui} group={id} height={height()} />}
            </AspectPlot>
          </section>
        )}
      </For>
    </div>
  );
  return (
    <div class="cala-history-x" data-testid="history-expanded">
      <div class="cala-history-x__head">
        <h2 class="panel-label">History</h2>
        <span class="cala-readout">{range()}</span>
        <ExpandButton ui={props.ui} />
      </div>
      <RunStrip ui={props.ui} />
      <div class="cala-history-x__cols">
        {col(['convergence', 'scales'])}
        {col(['imaging', 'motion', 'throughput'])}
      </div>
    </div>
  );
}
