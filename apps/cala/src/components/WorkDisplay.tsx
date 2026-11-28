/**
 * The worker squares of the Compute block: one 28 px square per worker (a browser thread), like
 * a CPU monitor. A square fills from the bottom with one colour per job, each as tall as that
 * job's share of the worker's last second; the busy percent sits under the square, not on the
 * fill. The squares follow the work readings (about once a second). The layout arithmetic is in
 * `lib/work-display.ts` (tested).
 */
import { createMemo, Index, Show, untrack, type JSX } from 'solid-js';
import { HelpTip, Icon, Legend, type LegendItem } from '@calab/ui';
import type { CellStore } from '../lib/cell-store.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import { WORK_KIND_LABELS, WORK_KINDS, workByKind, type WorkKind } from '../lib/work-meter.ts';
import {
  BG_SETTLE_HATCH,
  displayState,
  gridGroups,
  IDLE_COLOR,
  KIND_COLOR,
  rowAriaLabel,
  rowBusy,
  squareStack,
  squareTitle,
  stoppedLookbackRows,
} from '../lib/work-display.ts';

/**
 * Fill of a work kind: its colour, except Background settle, which is hatched so it differs
 * from Final settle by more than lightness. In SVG the hatch is the `cala-work-hatch` pattern
 * the time strip defines.
 */
export function kindFill(k: WorkKind, target: 'html' | 'svg'): string {
  if (k !== 'bgSettle') return KIND_COLOR[k];
  return target === 'svg' ? 'url(#cala-work-hatch)' : BG_SETTLE_HATCH;
}

/** The legend of the work kinds (the squares and the time strip's work row share it). */
export const KIND_LEGEND: LegendItem[] = [
  ...WORK_KINDS.map((k): LegendItem => ({
    label: WORK_KIND_LABELS[k],
    color: KIND_COLOR[k],
    hatched: k === 'bgSettle',
  })),
  { label: WORK_KIND_LABELS.spare, color: IDLE_COLOR },
];

export interface WorkerSquaresProps {
  pipeline: PipelineStore;
  cells: CellStore;
  live?: boolean;
}

export function WorkerSquares(props: WorkerSquaresProps): JSX.Element {
  const s = () => props.pipeline;
  const lb = () => props.cells.status()?.lookback;
  const state = () =>
    displayState({
      status: s().status(),
      live: props.live === true,
      settling: lb()?.settling === true,
    });
  // Paused: the squares keep their last values (the workers go quiet, which is not a reading).
  let lastBy: ReturnType<typeof workByKind> | null = null;
  const by = createMemo(() => {
    const r = s().work();
    if (untrack(() => s().status()) === 'paused' && lastBy) return lastBy;
    lastBy = r ? workByKind(r) : null;
    return lastBy;
  });
  const groups = () => gridGroups(by());
  const wholeStopped = () => lb()?.error !== undefined;
  const stoppedFlags = createMemo(() =>
    stoppedLookbackRows(by()?.workers ?? [], s().work()?.lookback.capacity, wholeStopped()),
  );
  const dim = () => state() === 'paused' || state() === 'done';

  return (
    <div
      class="cala-work"
      classList={{ 'cala-work--dim': dim(), 'cala-work--idle': state() === 'idle' }}
      style={{ '--kind-idle': IDLE_COLOR }}
      data-testid="work-display"
      data-state={state()}
    >
      <div class="cala-work__head">
        <span class="cala-work__title">Workers</span>
        <HelpTip label="About the worker squares" testid="work-help" popClass="cala-work__help">
          <p data-testid="work-caption">
            Each square is one worker (a browser thread). It fills from the bottom with one colour
            per job, each as tall as that job's share of the last second; the figure under it is how
            busy the worker was over that second (100: the whole second). Hover a square for its
            split. Extract is not shown: it runs after Discover, on its own.
          </p>
        </HelpTip>
      </div>
      <div class="cala-work__cores" data-testid="work-grid">
        <Index each={groups()}>
          {(g) => (
            <div class="cala-work__group">
              <span class="cala-work__group-label">{g().label}</span>
              <div class="cala-work__squares">
                <Index each={g().squares}>
                  {(sq) => {
                    const stopped = () => stoppedFlags()[sq().index] === true;
                    const busyPct = () => Math.round(100 * rowBusy(sq().row));
                    return (
                      <div
                        class="cala-work__cell"
                        role="img"
                        aria-label={
                          stopped() ? `${sq().label}: stopped` : rowAriaLabel(sq().label, sq().row)
                        }
                        title={
                          stopped()
                            ? `${sq().label}: stopped (see the console).`
                            : squareTitle(sq().label, sq().row)
                        }
                        data-testid="work-square"
                        data-state={stopped() ? 'stopped' : busyPct() > 0 ? 'busy' : 'idle'}
                      >
                        <span
                          class="cala-work__sq"
                          classList={{ 'cala-work__sq--stopped': stopped() }}
                        >
                          <Show when={!stopped()}>
                            <span class="cala-work__fill">
                              <Index each={squareStack(sq().row)}>
                                {(seg) => (
                                  <i
                                    data-kind={seg().kind}
                                    style={{
                                      height: `${seg().pct}%`,
                                      background: kindFill(seg().kind, 'html'),
                                    }}
                                  />
                                )}
                              </Index>
                            </span>
                          </Show>
                        </span>
                        <span class="cala-work__pct num" data-testid="work-square-pct">
                          <Show when={!stopped()} fallback={<Icon name="cross" size={11} />}>
                            {busyPct()}
                          </Show>
                        </span>
                      </div>
                    );
                  }}
                </Index>
              </div>
            </div>
          )}
        </Index>
        <Show when={groups().length === 0}>
          <p class="cala-work__empty">The workers show once a run starts.</p>
        </Show>
      </div>
      <Legend items={KIND_LEGEND} label="Jobs" class="cala-work__legend" testid="work-legend" />
    </div>
  );
}
