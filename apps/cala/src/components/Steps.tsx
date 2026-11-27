/**
 * The run's three main steps (Discover, Final settle, Extract): the stepper above the tabs and
 * the step panels in the Run tab share one view (`lib/step-view.ts`), so they always agree.
 */
import { Icon } from '@calab/ui';
import { visitHoldText } from '../lib/visit-rate.ts';
import { createEffect, createSignal, For, on, Show, type JSX } from 'solid-js';
import type { CellStore } from '../lib/cell-store.ts';
import type { Pass2Store } from '../lib/pass2-store.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import { extractAfterDiscover } from '../lib/run-stages.ts';
import { SETTLE } from '../lib/settle.ts';
import {
  STATE_WORD,
  stepNumbers,
  stepViews,
  type StepKey,
  type StepView,
} from '../lib/step-view.ts';
import {
  formatDuration,
  linePath,
  plannedSettleFrames,
  settledSummary,
  settlednessFromHints,
  speedPos,
} from '../lib/work-display.ts';

export interface StepSources {
  pipeline: PipelineStore;
  cells: CellStore;
  pass2: Pass2Store;
  live?: boolean;
  /** A multi-session run (it always Extracts each session). */
  sessionRun?: boolean;
}

/** The three steps now, from the stores. */
export function createSteps(src: () => StepSources): () => StepView[] {
  return () => {
    const o = src();
    const s = o.pipeline;
    const p = o.pass2;
    const lb = o.cells.status()?.lookback;
    const total = s.plan()?.frameCount ?? 0;
    const settleTotal =
      lb?.settle?.total ??
      (Number.isFinite(total) ? plannedSettleFrames(total, SETTLE.maxFrames) : 0);
    return stepViews({
      live: o.live === true,
      discover: s.status(),
      processed: s.processed(),
      total,
      discoverFps: s.fps(),
      lookback: s.lookback() && s.lookbackBlocked() === null,
      lookbackRun: s.lookbackRun(),
      settling: lb?.settling === true,
      settleFed: lb?.settle?.fed ?? 0,
      settleTotal,
      settleFps: s.work()?.lookback.kinds.end.framesPerS ?? 0,
      finalLibrary: o.cells.status()?.final ?? false,
      inNeed: lb && s.lookbackRun() ? lb.inNeed : null,
      extract: p.status(),
      extractDone: p.processed(),
      extractTotal: p.total(),
      extractFps: p.fps(),
      autoExtract: o.sessionRun === true || extractAfterDiscover(),
      factorRun: s.factorRun(),
      // The visit hold, only while it binds (below the user's target, or any hold at Max).
      visitHold: visitHoldText(s.visitHold(), s.paceTarget()) !== null ? s.visitHold() : null,
    });
  };
}

const pct = (v: StepView): string =>
  v.state === 'off' ? 'off' : v.fraction !== null ? `${Math.floor(100 * v.fraction)} %` : '';

/** The stepper: three boxes with arrows, each filling with its own progress. Fixed size. */
export function StepStepper(props: { steps: StepView[] }): JSX.Element {
  return (
    <ol class="cala-steps" data-testid="run-steps" aria-label="Steps">
      <For each={props.steps}>
        {(v, i) => (
          <>
            <Show when={i() > 0}>
              <li class="cala-steps__arrow" aria-hidden="true">
                →
              </li>
            </Show>
            <li
              class={`cala-steps__box cala-steps__box--${v.state} cala-stage--${v.key}`}
              data-testid={`run-step-${v.key}`}
              data-state={v.state}
              title={`${v.label}: ${STATE_WORD[v.state]}${v.note ? ` (${v.note})` : ''}`}
            >
              <span
                class="cala-steps__fill"
                style={{
                  width: `${100 * (v.state === 'off' ? 0 : (v.fraction ?? (v.state === 'running' ? 1 : 0)))}%`,
                }}
              />
              <span class="cala-steps__text">
                <span class="cala-steps__name">
                  <Show when={v.state === 'done'}>
                    <Icon name="check" size={12} />{' '}
                  </Show>
                  {v.label}
                </span>
                <span class="cala-steps__num cala-num">
                  {pct(v)}
                  {v.fps !== null ? ` · ${Math.round(v.fps)} fps` : ''}
                </span>
              </span>
            </li>
          </>
        )}
      </For>
    </ol>
  );
}

/** A frames/s trace over a step's progress (x 0..1), on the fixed 10 to 500 fps log scale. */
function RateChart(props: { samples: { x: number; fps: number }[]; testid: string }): JSX.Element {
  const W = 300;
  const H = 36;
  const d = () =>
    linePath(
      props.samples.map((q) => q.x * W),
      props.samples.map((q) => H - 2 - (H - 4) * speedPos(q.fps)),
    );
  return (
    <svg
      class="cala-step__chart"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Frames per second over the step (fixed 10 to 500, log)"
      data-testid={props.testid}
    >
      <line
        class="cala-step__grid"
        x1="0"
        x2={W}
        y1={H - 2 - (H - 4) * speedPos(100)}
        y2={H - 2 - (H - 4) * speedPos(100)}
      />
      <path class="cala-step__line" d={d()} vector-effect="non-scaling-stroke" />
    </svg>
  );
}

/** One step's panel: header (name, state, %, frames/s, time left), a bar, then its own body. */
export function StepPanel(props: { step: StepView; children?: JSX.Element }): JSX.Element {
  const v = () => props.step;
  const measured = () => v().fraction != null && (v().state === 'running' || v().state === 'done');
  return (
    <section
      class={`cala-step cala-step--${v().state} cala-stage--${v().key}`}
      data-testid={`step-panel-${v().key}`}
      aria-label={v().label}
    >
      <div class="cala-step__head">
        <strong class="cala-step__name">{v().label}</strong>
        <span class="cala-step__state">
          <Show when={v().state === 'done'}>
            <Icon name="check" size={12} />{' '}
          </Show>
          {STATE_WORD[v().state]}
        </span>
        <span class="cala-step__nums cala-num">{stepNumbers(v(), formatDuration)}</span>
      </div>
      <div
        class="cala-step__bar"
        // Only a started step with a known end is a progress bar (a live stream has none).
        role={measured() ? 'progressbar' : undefined}
        aria-label={v().label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={measured() ? Math.round(100 * (v().fraction ?? 0)) : undefined}
      >
        <i style={{ width: `${100 * (v().state === 'off' ? 0 : (v().fraction ?? 0))}%` }} />
      </div>
      {/* Always one line, so the panel keeps its height when the note comes and goes. */}
      <p class="cala-step__note">{v().note || ' '}</p>
      {props.children}
    </section>
  );
}

/** The Final settle's body: its rate over the pass, cells still moving, and footprints settled. */
export function SettleBody(props: {
  pipeline: PipelineStore;
  cells: CellStore;
  step: StepView;
  children?: JSX.Element;
}): JSX.Element {
  const [samples, setSamples] = createSignal<{ x: number; fps: number }[]>([]);
  createEffect(
    on(
      () => props.pipeline.status(),
      (st) => {
        if (st === 'starting') setSamples([]);
      },
    ),
  );
  createEffect(
    on(
      () => props.pipeline.work(),
      (r) => {
        const st = props.cells.status()?.lookback?.settle;
        const fps = r?.lookback.kinds.end.framesPerS ?? 0;
        if (props.step.state !== 'running' || !st || st.total <= 0 || !(fps > 0)) return;
        setSamples((prev) => [...prev, { x: Math.min(1, st.fed / st.total), fps }]);
      },
      { defer: true },
    ),
  );
  const moving = () => {
    const m = props.cells.status()?.lookback?.settle?.moving;
    return m && m.cells > 0
      ? `${m.above.toLocaleString('en-US')} of ${m.cells.toLocaleString('en-US')} cells still moving`
      : 'cells still moving: not measured yet';
  };
  const settled = () =>
    settledSummary(
      settlednessFromHints(
        Array.from(props.cells.library()?.ids ?? []),
        props.cells.stillMoving(),
        SETTLE.movingK,
      ),
    );
  return (
    <div class="cala-step__body">
      <RateChart samples={samples()} testid="settle-rate" />
      <div class="cala-step__facts cala-num" data-testid="settle-facts">
        <span>{props.step.state === 'off' ? '–' : moving()}</span>
        <span>
          footprints settled:{' '}
          {settled()
            ? `${settled()!.settled.toLocaleString('en-US')} of ${settled()!.total.toLocaleString('en-US')}`
            : 'not measured yet'}
        </span>
      </div>
      {props.children}
    </div>
  );
}

/** Extract's body: its rate over the recording and the traces solved so far. */
export function ExtractBody(props: {
  pipeline: PipelineStore;
  pass2: Pass2Store;
  cells: CellStore;
  children?: JSX.Element;
}): JSX.Element {
  const p = () => props.pass2;
  const [samples, setSamples] = createSignal<{ x: number; fps: number }[]>([]);
  createEffect(
    on(
      () => p().status(),
      (st, prev) => {
        if (st === 'running' && prev !== 'running') setSamples([]);
      },
    ),
  );
  createEffect(
    on(
      () => p().processed(),
      (done) => {
        const tot = p().total();
        const fps = p().fps();
        if (p().status() !== 'running' || tot <= 0 || !(fps > 0)) return;
        const x = Math.min(1, done / tot);
        setSamples((prev) =>
          prev.length > 0 && x - prev[prev.length - 1].x < 0.005 ? prev : [...prev, { x, fps }],
        );
      },
      { defer: true },
    ),
  );
  const cells = () => p().result()?.cells ?? props.cells.library()?.ids.length ?? 0;
  return (
    <div class="cala-step__body">
      <RateChart samples={samples()} testid="extract-rate" />
      <div class="cala-step__facts cala-num" data-testid="extract-facts">
        <span>
          traces: {cells().toLocaleString('en-US')} cells ×{' '}
          {p().processed().toLocaleString('en-US')} frames solved
        </span>
      </div>
      {props.children}
    </div>
  );
}

/** The step a key names. */
export const stepOf = (steps: StepView[], key: StepKey): StepView =>
  steps.find((v) => v.key === key)!;
