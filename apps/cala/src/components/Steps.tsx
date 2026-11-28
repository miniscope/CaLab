/**
 * The run's three main steps (Discover, Final settle, Extract): the run rail's stage track and
 * the Run tab's step list share one view (`lib/step-view.ts`), so they always agree. In the
 * list the running step is a panel with its meter rows; every other step is one line.
 */
import { Icon, MeterRow } from '@calab/ui';
import { formatElapsed } from '@calab/ui/chart';
import { visitHoldText } from '../lib/visit-rate.ts';
import { createEffect, createSignal, For, on, Show, type JSX } from 'solid-js';
import type { CellStore } from '../lib/cell-store.ts';
import type { Pass2Store } from '../lib/pass2-store.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import { extractAfterDiscover } from '../lib/run-stages.ts';
import { CSETTLE, SETTLE } from '../lib/settle.ts';
import { lookbackFacts, notSettled, settleNote, type LookbackFacts } from '../lib/lookback-text.ts';
import { RAIL_SPEED_RANGE } from '../lib/rail-view.ts';
import { ASSUMED_FPS } from '../lib/miniscope-meta.ts';
import { createSampled } from '../lib/sampled.ts';
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

/** The step rows refresh at most this often, ms (2 Hz). */
const SAMPLE_MS = 500;

/** The Final settle's visits-per-frame row: declared range. */
const SETTLE_VISIT_RANGE = { min: 0, max: 1 } as const;

/** The Background settle row: re-read frames per live frame, up to the highest ceiling a user can pick. */
const CSETTLE_RANGE = { min: 0, max: Math.max(...CSETTLE.rates) } as const;

const n0 = (v: number): string => Math.round(v).toLocaleString('en-US');

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

/** A row with a figure and no meter (a count with no declared end), aligned with the meter rows. */
function FactRow(props: {
  label: string;
  value: number | null;
  unit?: string;
  title?: string;
}): JSX.Element {
  return (
    <div class="meter-row cala-fact-row" title={props.title}>
      <span class="meter-row__label">{props.label}</span>
      <span aria-hidden="true" />
      <span class="meter-row__value num">
        <Show when={props.value !== null} fallback={<span class="meter-row__dash">–</span>}>
          {n0(props.value!)}
          <Show when={props.unit}>
            <span class="unit"> {props.unit}</span>
          </Show>
        </Show>
      </span>
    </div>
  );
}

/** The running step's panel: header (name, state, %, frames/s, time left), a bar, then its body. */
export function StepPanel(props: { step: StepView; children?: JSX.Element }): JSX.Element {
  const v = () => props.step;
  const measured = () => v().fraction != null && (v().state === 'running' || v().state === 'done');
  return (
    <section
      class={`cala-step cala-step--${v().state} cala-stage--${v().key}`}
      data-testid={`step-panel-${v().key}`}
      data-state={v().state}
      aria-label={v().label}
    >
      <div class="cala-step__head">
        <strong class="cala-step__name">{v().label}</strong>
        <span class="cala-step__state">{STATE_WORD[v().state]}</span>
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
      <Show when={v().note}>
        <p class="cala-step__note">{v().note}</p>
      </Show>
      {props.children}
    </section>
  );
}

/**
 * A step that is not running, in one line: done is the stage hue with ✓ and its result
 * ("✓ Discover · 383 cells · 0:48"), stopped has ✕, waiting and off are a swatch and a word.
 */
export function StepLine(props: {
  step: StepView;
  /** What the step produced (shown when done), after the name, joined by " · ". */
  facts?: string[];
  /** Wall seconds the step took (done only; null: not timed). */
  seconds?: number | null;
  children?: JSX.Element;
}): JSX.Element {
  const v = () => props.step;
  const facts = (): string[] => {
    const st = v().state;
    if (st === 'done') {
      const out = [...(props.facts ?? [])];
      if (props.seconds != null) out.push(formatElapsed(props.seconds));
      return out;
    }
    if (st === 'off' || st === 'error') return [STATE_WORD[st], ...(v().note ? [v().note] : [])];
    return [STATE_WORD[st]];
  };
  return (
    <div
      class={`cala-stepline cala-stepline--${v().state} cala-stage--${v().key}`}
      data-testid={`step-panel-${v().key}`}
      data-state={v().state}
      role="group"
      aria-label={v().label}
    >
      <span class="cala-stepline__mark" aria-hidden="true">
        <Show
          when={v().state === 'done'}
          fallback={
            <Show when={v().state === 'error'} fallback={<i class="cala-stepline__swatch" />}>
              <Icon name="cross" size={12} />
            </Show>
          }
        >
          <Icon name="check" size={12} />
        </Show>
      </span>
      <strong class="cala-stepline__name">{v().label}</strong>
      <span class="cala-stepline__facts cala-num">
        <For each={facts()}>{(f) => <span class="cala-stepline__fact">{f}</span>}</For>
        {props.children}
      </span>
    </div>
  );
}

/** A step in the list: its panel while it runs (or is paused), else its one line. */
export function StepBlock(props: {
  step: StepView;
  /** The panel's body while the step runs. */
  body: JSX.Element;
  facts?: string[];
  seconds?: number | null;
  /** Extra content on the one line (a note). */
  line?: JSX.Element;
}): JSX.Element {
  const open = () => props.step.state === 'running' || props.step.state === 'paused';
  return (
    <Show
      when={open()}
      fallback={
        <StepLine step={props.step} facts={props.facts} seconds={props.seconds}>
          {props.line}
        </StepLine>
      }
    >
      <StepPanel step={props.step}>{props.body}</StepPanel>
    </Show>
  );
}

/** The look-back figures of the run now, sampled at 2 Hz (null: no look-back status). */
export function createLookbackFacts(
  cells: () => CellStore,
  key: () => string,
): () => LookbackFacts | null {
  return createSampled(
    () => {
      const st = cells().status();
      return st?.lookback ? lookbackFacts(st.lookback, st.final ?? false) : null;
    },
    key,
    SAMPLE_MS,
  );
}

/** Discover's rows on a look-back run: cells waiting for data, frames re-read, Background settle. */
/** The lag row's declared range, seconds of recording (History's slow-loop lag starts on the same range). */
export const LAG_RANGE_S = 60;

export function DiscoverBody(props: {
  pipeline: PipelineStore;
  cells: CellStore;
  step: StepView;
  /** The recording's frame rate, Hz (0: unknown, `ASSUMED_FPS` is used). */
  fps?: number;
  children?: JSX.Element;
}): JSX.Element {
  // One reading for the look-back figures, the cell count and the lag, so the rows always agree.
  const snap = createSampled(
    () => {
      const st = props.cells.status();
      const lag = props.cells.metrics().lag.at(-1);
      return {
        facts: st?.lookback ? lookbackFacts(st.lookback, st.final ?? false) : null,
        cells: props.cells.library()?.ids.length ?? 0,
        lag: lag === null || lag === undefined ? null : lag,
      };
    },
    () => props.step.state,
    SAMPLE_MS,
  );
  const cellCount = () => snap().cells;
  const fps = () => (props.fps && props.fps > 0 ? props.fps : ASSUMED_FPS);
  const shown = () => (props.pipeline.lookbackRun() ? snap().facts : null);
  return (
    <div
      class="cala-step__body cala-step__rows cala-step__rows--discover"
      data-testid="discover-rows"
    >
      <Show when={shown()}>
        {(f) => (
          <>
            <MeterRow
              label="Cells waiting for data"
              value={f().inNeed}
              min={0}
              max={Math.max(1, cellCount(), f().inNeed)}
              display={`${n0(f().inNeed)} / ${n0(Math.max(cellCount(), f().inNeed))}`}
              tone="discover"
              size="sm"
              format={(v) => `${n0(v)} of ${n0(cellCount())} cells waiting for look-back data`}
            />
            <FactRow
              label="Look-back re-read"
              value={f().reread}
              unit="frames"
              title={`${n0(f().reread)} past frames re-read for ${n0(f().births)} new cells`}
            />
            <Show when={f().csettle}>
              {(cs) => (
                <MeterRow
                  label="Background settle"
                  value={cs().perLive}
                  min={CSETTLE_RANGE.min}
                  max={CSETTLE_RANGE.max}
                  target={cs().ceiling}
                  tone="settle"
                  size="sm"
                  display={cs().perLive !== null ? cs().perLive!.toFixed(2) : undefined}
                  unit="/ live frame"
                  format={(v) =>
                    `${v.toFixed(2)} saved frames re-read per live frame, ceiling ${cs().ceiling}`
                  }
                />
              )}
            </Show>
            <Show when={settleNote(f())}>{(note) => <p class="cala-step__note">{note()}</p>}</Show>
          </>
        )}
      </Show>
      <Show when={props.step.state === 'running' || props.step.state === 'paused'}>
        <MeterRow
          label="Lag behind reading"
          value={snap().lag}
          min={0}
          max={LAG_RANGE_S * fps()}
          tone="neutral"
          size="sm"
          display={snap().lag !== null ? n0(snap().lag!) : undefined}
          unit="frames"
          format={(v) =>
            `the cell model is ${n0(v)} frames (${(v / fps()).toFixed(1)} s) behind the frames read; fixed range 0 to ${LAG_RANGE_S} s`
          }
          testid="discover-lag"
        />
      </Show>
      {props.children}
    </div>
  );
}

/** The Final settle's body: its rows (its rate over the pass is on the time strip). */
export function SettleBody(props: {
  pipeline: PipelineStore;
  cells: CellStore;
  step: StepView;
  children?: JSX.Element;
}): JSX.Element {
  const facts = createLookbackFacts(
    () => props.cells,
    () => props.step.state,
  );
  const settled = createSampled(
    () =>
      settledSummary(
        settlednessFromHints(
          Array.from(props.cells.library()?.ids ?? []),
          props.cells.stillMoving(),
          SETTLE.movingK,
        ),
      ),
    () => props.step.state,
    SAMPLE_MS,
  );
  const s = () => facts()?.settle ?? null;
  const moving = () => s()?.moving ?? null;
  return (
    <div class="cala-step__body cala-step__rows" data-testid="settle-facts">
      <MeterRow
        label="Frames re-read"
        value={s() && s()!.total > 0 ? s()!.fed : null}
        min={0}
        max={Math.max(1, s()?.total ?? 1)}
        display={s() ? `${n0(s()!.fed)} / ${n0(s()!.total)}` : undefined}
        tone="settle"
        size="sm"
        format={(v) => `${n0(v)} of ${n0(s()?.total ?? 0)} frames`}
      />
      <MeterRow
        label="Cells still moving"
        value={moving()?.above ?? null}
        min={0}
        max={Math.max(1, moving()?.cells ?? 1)}
        target={moving() ? SETTLE.movingShare * moving()!.cells : undefined}
        display={
          moving()
            ? `${n0(moving()!.above)} / ${n0(moving()!.cells)}${notSettled(moving()!) ? '' : ' ✓'}`
            : undefined
        }
        tone="settle"
        size="sm"
        format={(v) =>
          `${n0(v)} of ${n0(moving()?.cells ?? 0)} cells still moving more than ${SETTLE.movingK}x their noise; settled below the tick`
        }
      />
      <MeterRow
        label="Footprints settled"
        value={settled()?.settled ?? null}
        min={0}
        max={Math.max(1, settled()?.total ?? 1)}
        display={settled() ? `${n0(settled()!.settled)} / ${n0(settled()!.total)}` : undefined}
        tone="settle"
        size="sm"
        format={(v) => `${n0(v)} of ${n0(settled()?.total ?? 0)} footprints settled`}
      />
      <MeterRow
        label="Visits per frame"
        value={s()?.visitsPerFrame ?? null}
        min={SETTLE_VISIT_RANGE.min}
        max={SETTLE_VISIT_RANGE.max}
        display={s()?.visitsPerFrame != null ? s()!.visitsPerFrame!.toFixed(2) : undefined}
        tone="settle"
        size="sm"
        format={(v) => `${v.toFixed(2)} refinement visits per settle frame`}
      />
      {props.children}
    </div>
  );
}

/** Extract's body: its rate over the recording and its rows. */
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
  const snap = createSampled(
    () => ({
      done: p().processed(),
      total: p().total(),
      fps: p().status() === 'running' && p().fps() > 0 ? p().fps() : null,
      cells: p().result()?.cells ?? props.cells.library()?.ids.length ?? 0,
      gpu: p().motionBackend() === 'webgpu',
    }),
    () => p().status(),
    SAMPLE_MS,
  );
  return (
    <div class="cala-step__body cala-step__rows" data-testid="extract-facts">
      <RateChart samples={samples()} testid="extract-rate" />
      <div data-testid="pass2-readout">
        <MeterRow
          label="Frames solved"
          value={snap().total > 0 ? snap().done : null}
          min={0}
          max={Math.max(1, snap().total)}
          display={`${n0(snap().done)} / ${n0(snap().total)}`}
          tone="extract"
          size="sm"
          format={(v) => `${n0(v)} of ${n0(snap().total)} frames solved`}
        />
      </div>
      <MeterRow
        label="Speed"
        value={snap().fps}
        min={RAIL_SPEED_RANGE.min}
        max={RAIL_SPEED_RANGE.max}
        scale="log"
        tone="extract"
        size="sm"
        unit="fps"
        display={snap().fps !== null ? n0(snap().fps!) : undefined}
        format={(v) =>
          `${v.toFixed(1)} frames per second${snap().gpu ? ', warp on WebGPU' : ''}; fixed range 10 to 500, log`
        }
      />
      <FactRow
        label="Traces"
        value={snap().cells}
        unit="cells"
        title="Cells whose traces Extract solves, every frame of the recording"
      />
      {props.children}
    </div>
  );
}

/** The step a key names. */
export const stepOf = (steps: StepView[], key: StepKey): StepView =>
  steps.find((v) => v.key === key)!;
