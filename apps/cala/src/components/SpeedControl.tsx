import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from 'solid-js';
import type { JSX } from 'solid-js';
import { Icon, MeterRow, SegmentedBar, SegmentedControl } from '@calab/ui';
import { placeAxisLabels } from '@calab/ui/chart';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import type { CellStore } from '../lib/cell-store.ts';
import { curveWords, CURVE_PRESETS, planLine, presetCurve } from '../lib/speed-schedule.ts';
import { AUTO_BUDGETS, budgetLabel } from '../lib/speed-auto.ts';
import { RAIL_VISIT_RANGE, VISIT_BAND } from '../lib/rail-view.ts';
import { createSampled } from '../lib/sampled.ts';
import {
  VISIT_RATE,
  fmtVisitRate,
  maxRepeatText,
  visitHoldText,
  visitRateText,
} from '../lib/visit-rate.ts';
import { planPath, speedPos } from '../lib/work-display.ts';
import {
  achievedSpeed,
  belowFloorNote,
  DONE_TEXT,
  CAP_CHOICES,
  capLabel,
  floorWords,
  fpsToPos,
  fpsToStep,
  loadSpeedSettings,
  nudgeFps,
  saveSpeedSettings,
  snapFps,
  SPEED_SCALE,
  SPEED_TICKS,
  speedStatusText,
  stepToFps,
  TRACK_STEPS,
  CURVE_PRESET_IDS,
  type CurvePresetId,
  type SpeedMode,
  type SpeedSettings,
} from '../lib/speed-track.ts';

/** Keyboard steps wait this long for the next one before they count as one change (a drag commits on release). */
const KEY_DEBOUNCE_MS = 400;

/** Live marks (floor, max now, achieved, refinement, Auto's budget) refresh at most this often, ms. */
const SAMPLE_MS = 500;

/** The track's inset from its row's ends, px (`.cala-speed__track` left and right). */
const TRACK_INSET_PX = 8;

/** The Curve preview's rows, px: the plot, then the share-of-recording labels. */
const PREVIEW = { top: 4, bot: 40, axis: 52, height: 56, left: 28, right: 4 } as const;

const NO_BUFFER_REASON =
  "Background settle on a live stream needs the stream's raw frames on disk, which is not built yet.";

const MODE_LABELS: Record<SpeedMode, string> = {
  max: 'Max',
  fixed: 'Fixed',
  curve: 'Curve',
  auto: 'Auto',
};
const MODE_TITLES: Record<SpeedMode, string> = {
  max: 'No pacing: Discover as fast as the machine goes; all settling is the Final settle after the last frame.',
  fixed: 'Read the recording at a target speed; the spare time goes to Background settle.',
  curve: 'The target steps down over the recording: fast while cells are found, slower after.',
  auto: 'Pick how much longer than a Max run you will wait; Auto sets the speed so Discover finishes about then, never below the slowest useful speed. The Final settle comes after.',
};

/**
 * The Speed block of the Run panel (Max and Fixed): a fixed log track from 10
 * to 500 fps with a separate Max stop, the floor and "max now" marks, the
 * status line, and the Background settle cap. Curve mode swaps the thumb for a preset (a step
 * schedule of the target over the recording, `lib/speed-schedule.ts`). Every change goes through the
 * store (`setPaceFps` logs the run-record event; the cap goes to the worker). Auto mode is a time
 * budget (`lib/speed-auto.ts`): the track gives way to a choice of extra time over a Max run.
 */
export function SpeedControl(props: {
  pipeline: PipelineStore;
  cells: CellStore;
  /** A live stream: the input rate sets the pace; the track is greyed. */
  live?: boolean;
  /** Frame rate of the recording or stream, Hz (0 when unknown). */
  fps: number;
}): JSX.Element {
  const s = () => props.pipeline;
  // What the user set in this block, as saved. Not read back from the store: a URL override
  // (`?debug&pacefps`, `?csrate`) must never leak into the saved settings.
  let saved: SpeedSettings = loadSpeedSettings();
  const save = (patch: Partial<SpeedSettings>) => {
    saved = { ...saved, ...patch };
    saveSpeedSettings(saved);
  };
  const [fixedFps, setFixedFps] = createSignal(saved.fixedFps);
  const [preset, setPreset] = createSignal<CurvePresetId>(saved.preset);
  const [budget, setBudget] = createSignal<number>(saved.autoBudget);
  /** The thumb while a change is in progress (not yet committed). */
  const [draft, setDraft] = createSignal<number | null>(null);
  let dragging = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));

  /** Why a target cannot be chosen (no look-back workers); null when it can. Streams have their own state. */
  const pinned = () => (props.live ? null : s().lookbackBlocked());

  // A pinned control stays at Max whatever was saved; when the pin lifts the saved speed returns.
  // Neither is a user change (their own sources), and neither is saved. A target that came from
  // the URL (`?debug&pacefps`, a measurement override) is left alone.
  let pinnedFrom: number | null = null;
  /** The curve as set (a preset, or a run record's replayed curve), restored as it was. */
  let pinnedCurve: ReturnType<PipelineStore['speedCurve']> = null;
  let pinnedAuto: number | null = null;
  createEffect(() => {
    const why = pinned();
    untrack(() => {
      const curve = s().speedCurve();
      const auto = s().autoBudget();
      if (why !== null && (s().paceTarget() > 0 || curve || auto !== null) && !s().paceFromUrl()) {
        pinnedAuto = auto;
        pinnedFrom = curve || auto !== null ? null : s().paceTarget();
        pinnedCurve = curve;
        s().setPaceFps(0, 'pinned');
      } else if (
        why === null &&
        (pinnedFrom !== null || pinnedCurve !== null || pinnedAuto !== null)
      ) {
        if (s().paceTarget() === 0 && pinnedAuto !== null) s().setAutoBudget(pinnedAuto);
        else if (s().paceTarget() === 0 && pinnedCurve !== null)
          s().setSpeedCurve(pinnedCurve.curve, {
            preset: pinnedCurve.preset,
            normalize: pinnedCurve.normalize,
          });
        else if (s().paceTarget() === 0 && pinnedFrom !== null)
          s().setPaceFps(pinnedFrom, 'pin lifted');
        pinnedFrom = null;
        pinnedCurve = null;
        pinnedAuto = null;
      }
    });
  });

  const target = () => s().paceTarget();
  const shown = () => draft() ?? (target() > 0 ? target() : null);
  const mode = (): SpeedMode =>
    s().autoBudget() !== null
      ? 'auto'
      : s().speedCurve()
        ? 'curve'
        : shown() !== null
          ? 'fixed'
          : 'max';
  const liveNow = () => ({ floorFps: floorFps(), seeAllFps: s().floor().estimate.seeAllFps });

  const floor = () => s().floor();
  const floorFps = () => {
    const f = floor();
    return Math.round(f.fps);
  };
  const words = createMemo(() => floorWords(floor()));
  const maxNow = () => (s().workMaxFps() > 0 ? Math.round(s().workMaxFps()) : null);
  /** The Discover visit rate's target in force (the engine's schedule; the fixed value before). */
  const visitTarget = () => s().visitTarget() ?? VISIT_RATE.target;
  /** What "max now" means: the fastest this machine reads frames, or keeps refinement up. */
  const maxTitle = () =>
    s().workMaxVisitLimited()
      ? `The fastest this machine can go now while keeping refinement at ${fmtVisitRate(visitTarget())} visits/frame. Reading frames alone could go faster.`
      : 'The fastest this machine can go now.';
  const marks = () => [...SPEED_TICKS, floorFps()];
  const gov = () => props.cells.status()?.lookback?.csettle?.governor ?? null;
  const running = () => s().status() === 'running' || s().status() === 'paused';
  /** Discover has read its last frame: the block shows the setting for the next run, not a pre-run promise. */
  const done = () => s().status() === 'done';
  const lookbackOn = () => s().lookback() && s().lookbackBlocked() === null;
  const cap = () => (s().csettle() ? s().csettleCeiling() : 0);
  /** Frames in the recording (0 when unknown or a stream). */
  const total = () => {
    const n = s().plan()?.frameCount ?? 0;
    return Number.isFinite(n) ? n : 0;
  };

  const achieved = (): number | null =>
    achievedSpeed({
      running: running(),
      target: target(),
      governor: gov(),
      maxFps: s().workMaxFps(),
    });

  // ---- changes ----

  function commit(fps: number): void {
    const f = snapFps(fps, marks());
    setFixedFps(f);
    s().setPaceFps(f, 'setting');
    save({ mode: 'fixed', fixedFps: f });
  }
  function setMode(m: SpeedMode): void {
    if (m === 'curve') {
      s().setSpeedCurve(presetCurve(preset()), { preset: preset() });
      // Before the run the target stays where it was; the curve sets it when Discover starts.
    } else if (m === 'auto') s().setAutoBudget(budget());
    else if (m === 'max') s().setPaceFps(0, 'setting');
    else s().setPaceFps(fixedFps(), 'setting');
    save({ mode: m, fixedFps: fixedFps(), preset: preset(), autoBudget: budget() });
  }
  function choosePreset(id: CurvePresetId): void {
    setPreset(id);
    if (mode() === 'curve') s().setSpeedCurve(presetCurve(id), { preset: id });
    save({ preset: id });
  }
  function chooseBudget(share: number): void {
    setBudget(share);
    if (mode() === 'auto') s().setAutoBudget(share);
    save({ autoBudget: share });
  }
  function commitDraft(): void {
    clearTimeout(timer);
    dragging = false;
    const d = draft();
    setDraft(null);
    if (d !== null && d !== target()) commit(d);
  }
  /** A key press waits for the next one (400 ms) before it counts as one change. */
  function holdDraft(fps: number): void {
    setDraft(fps);
    clearTimeout(timer);
    timer = setTimeout(commitDraft, KEY_DEBOUNCE_MS);
  }
  function onSlide(e: InputEvent & { currentTarget: HTMLInputElement }): void {
    if (pinned() !== null) return;
    const fps = stepToFps(Number(e.currentTarget.value), marks());
    if (dragging) setDraft(fps);
    else holdDraft(fps);
  }
  function onKey(e: KeyboardEvent): void {
    if (pinned() !== null || e.altKey || e.ctrlKey || e.metaKey) return;
    const cur = shown() ?? fixedFps();
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = nudgeFps(cur, 1, e.shiftKey);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = nudgeFps(cur, -1, e.shiftKey);
    else if (e.key === 'PageUp') next = nudgeFps(cur, 1, true);
    else if (e.key === 'PageDown') next = nudgeFps(cur, -1, true);
    else if (e.key === 'Home') next = SPEED_SCALE.lo;
    else if (e.key === 'End') next = SPEED_SCALE.hi;
    if (next === null) return;
    e.preventDefault();
    holdDraft(next);
  }
  function setCap(v: number): void {
    if (v === 0) s().setCsettle(false);
    else {
      s().setCsettleCeiling(v);
      s().setCsettle(true);
    }
    save({ cap: v });
  }

  const pct = (fps: number) => `${(100 * fpsToPos(fps)).toFixed(2)}%`;

  // ---- live marks, sampled at most twice a second ----
  const live = createSampled(
    () => {
      const visitOn = running() && !done() && s().visitMode() === 'on';
      const t = visitOn ? (s().visitTarget() ?? VISIT_RATE.target) : null;
      return {
        floor: floorFps(),
        maxNow: maxNow(),
        achieved: achieved(),
        visits: {
          on: visitOn,
          achieved: visitOn ? s().visitAchieved() : null,
          target: t,
          hold: visitOn ? visitHoldText(s().visitHold(), s().paceTarget(), t ?? undefined) : null,
          holdFps: s().visitHold(),
          text: visitOn
            ? visitRateText(
                s().visitMode(),
                s().visitSchedule(),
                s().visitTarget(),
                s().visitYield(),
              )
            : null,
        },
        budget: mode() === 'auto' && running() ? s().autoBudgetUse() : null,
      };
    },
    () => `${s().status()}|${mode()}|${pinned() ?? ''}`,
    SAMPLE_MS,
  );

  // ---- the track's width, for its labels and the Curve preview ----
  const [trackW, setTrackW] = createSignal(0);
  let trackRo: ResizeObserver | undefined;
  const bindTrack = (el: HTMLDivElement) => {
    const measure = () => {
      const w = Math.floor(el.getBoundingClientRect().width);
      if (w > 0) setTrackW(w);
    };
    queueMicrotask(measure);
    if (typeof ResizeObserver === 'undefined') return;
    trackRo?.disconnect();
    trackRo = new ResizeObserver(measure);
    trackRo.observe(el);
  };
  onCleanup(() => trackRo?.disconnect());

  /** The labels over the track (floor, max now), placed so they never overlap. */
  const topLabels = createMemo(() => {
    const w = trackW();
    if (!(w > 0) || props.live) return [];
    const inner = Math.max(1, w - 2 * TRACK_INSET_PX);
    const at = (fps: number) => TRACK_INSET_PX + inner * fpsToPos(fps);
    const v = live();
    const out = [{ x: at(v.floor), text: `floor ${v.floor}`, priority: 1 }];
    if (v.maxNow !== null) out.push({ x: at(v.maxNow), text: `max ${v.maxNow}`, priority: 2 });
    return placeAxisLabels(out, { x0: 0, x1: w, charPx: 6.2, gap: 6 });
  });
  const anchorShift = { start: '0', middle: '-50%', end: '-100%' } as const;

  /** The Curve preview: the plan as a step line, share of the recording against fps (log). */
  const curvePreview = createMemo(() => {
    if (mode() !== 'curve') return null;
    const w = trackW();
    if (!(w > 0)) return null;
    const armed = running() ? s().armedCurve() : null;
    const c = armed?.curve ?? s().speedCurve()?.curve;
    if (!c) return null;
    const v = live();
    const plan = planLine(c, { floorFps: v.floor, seeAllFps: s().floor().estimate.seeAllFps });
    const seg = { x0: PREVIEW.left, x1: w - PREVIEW.right };
    const y = (fps: number) => PREVIEW.bot - (PREVIEW.bot - PREVIEW.top) * speedPos(fps);
    return {
      w,
      d: planPath(plan, seg, PREVIEW.top, PREVIEW.bot),
      floorY: v.floor > 0 ? y(v.floor) : null,
      grid: [30, 100, 300].map((f) => ({ f, y: y(f) })),
      seg,
      // Where Discover is now, as a share of the recording.
      nowX:
        running() && total() > 0
          ? seg.x0 + (seg.x1 - seg.x0) * Math.min(1, untrack(s().processed) / total())
          : null,
    };
  });

  const cappedReason = (): string | null =>
    props.live
      ? NO_BUFFER_REASON
      : pinned() !== null
        ? `Needs look-back: ${pinned()}`
        : !s().lookback()
          ? 'Needs look-back refinement: tick it below.'
          : null;

  // What the run follows: the curve after the minimum-step rule, and a note when steps merged.
  const curveLine = () => {
    const armed = running() ? s().armedCurve() : null;
    const c = armed?.curve ?? s().speedCurve()?.curve;
    if (!c) return '';
    const words = curveWords(c, liveNow());
    const n = armed?.merged ?? 0;
    return n > 0 ? `${words} (${n} short step${n === 1 ? '' : 's'} merged)` : words;
  };
  const speedLine = () =>
    speedStatusText({
      running: running(),
      target: target(),
      floor: floorFps(),
      governor: gov(),
      settleOn: lookbackOn() && cap() > 0,
      done: done(),
    });
  const autoLine = () =>
    done()
      ? `Auto, ${budgetLabel(budget())} time budget. ${DONE_TEXT}`
      : !running()
        ? `Auto: Discover will aim to finish within ${budgetLabel(budget())} of a Max run's time, never slower than the slowest useful speed (${floorFps()} fps). The Final settle comes after.`
        : `Auto, ${budgetLabel(budget())} time budget: target now ${target() > 0 ? `${target()} fps` : 'Max'}. ${speedLine()}`;
  const status = () =>
    mode() === 'auto'
      ? autoLine()
      : mode() === 'curve' && done()
        ? `Curve: ${curveLine()}. ${DONE_TEXT}`
        : mode() === 'curve' && !running()
          ? `Discover will follow the curve: ${curveLine()}.`
          : mode() === 'curve' && s().armedCurve()?.merged
            ? `Following the curve: ${curveLine()}. ${speedLine()}`
            : speedLine();
  const belowNote = () => (mode() === 'fixed' ? belowFloorNote(shown() ?? 0, floorFps()) : null);

  // Only at Max (mode 'max'; a curve or Auto run has its own target).
  const repeatLine = () => (mode() === 'max' ? maxRepeatText(target()) : null);

  const capSelect = (cls: string): JSX.Element => (
    <label class={cls}>
      <span class={props.live ? 'cala-speed__cap-name--main' : undefined}>Background settle</span>
      <select
        class="cala-view-select"
        data-testid="speed-cap"
        aria-label="Background settle cap"
        disabled={cappedReason() !== null}
        title={cappedReason() ?? 'At most this many saved frames are re-read per live frame.'}
        value={String(cap())}
        onChange={(e) => setCap(Number(e.currentTarget.value))}
      >
        <For each={CAP_CHOICES}>
          {(v) => <option value={String(v)}>{capLabel(v, props.live)}</option>}
        </For>
      </select>
    </label>
  );

  return (
    <section
      class="cala-speed"
      classList={{ 'cala-speed--live': props.live === true }}
      data-testid="speed-control"
      data-mode={mode()}
      aria-label="Speed"
    >
      <div class="cala-speed__head">
        <h3 class="cala-speed__title">Speed</h3>
        <Show
          when={!props.live}
          fallback={<span class="cala-muted cala-speed__tag">Live stream</span>}
        >
          <SegmentedControl<SpeedMode>
            aria-label="Speed mode"
            size="sm"
            testid="speed-mode"
            value={mode()}
            onChange={setMode}
            options={(['max', 'fixed', 'curve', 'auto'] as const).map((m) => ({
              value: m,
              label: MODE_LABELS[m],
              title: m === 'fixed' && pinned() !== null ? (pinned() as string) : MODE_TITLES[m],
              disabled: pinned() !== null && m !== 'max',
              testid: `speed-mode-${m}`,
            }))}
          />
        </Show>
      </div>

      <Show when={mode() === 'curve' && !props.live}>
        <label class="cala-speed__preset">
          <span>Curve</span>
          <select
            class="cala-view-select"
            data-testid="speed-preset"
            aria-label="Speed curve"
            title={CURVE_PRESETS[preset()].title}
            value={preset()}
            onChange={(e) => choosePreset(e.currentTarget.value as CurvePresetId)}
          >
            <For each={CURVE_PRESET_IDS}>
              {(id) => <option value={id}>{CURVE_PRESETS[id].label}</option>}
            </For>
          </select>
        </label>
      </Show>
      <Show when={mode() === 'auto' && !props.live}>
        <label class="cala-speed__preset">
          <span>Extra time</span>
          <select
            class="cala-view-select"
            data-testid="speed-budget"
            aria-label="Auto time budget"
            title="How much longer than a Max run you will wait."
            value={String(budget())}
            onChange={(e) => chooseBudget(Number(e.currentTarget.value))}
          >
            <For each={AUTO_BUDGETS}>
              {(b) => <option value={String(b)}>{budgetLabel(b)}</option>}
            </For>
          </select>
        </label>
      </Show>
      <Show when={!props.live}>
        <p class="cala-speed__line" data-testid="speed-status">
          {pinned() !== null ? `Pinned at Max: ${pinned()}` : status()}
        </p>
        <Show when={repeatLine()}>
          {(line) => (
            <p class="cala-speed__line" data-testid="speed-max-repeat">
              {line()}
            </p>
          )}
        </Show>
      </Show>

      <Show when={props.live || mode() === 'max' || mode() === 'fixed'}>
        <div
          class="cala-speed__trackrow"
          classList={{ 'cala-speed__trackrow--off': props.live || done() }}
        >
          <div
            class="cala-speed__trackwrap"
            ref={bindTrack}
            aria-hidden={props.live ? 'true' : undefined}
          >
            <For each={topLabels()}>
              {(l) => (
                <span
                  class="cala-speed__marklabel"
                  style={{ left: `${l.x}px`, transform: `translateX(${anchorShift[l.anchor]})` }}
                  data-testid={l.text.startsWith('floor') ? 'speed-floor-label' : 'speed-max-label'}
                  title={l.text.startsWith('floor') ? words().detail : maxTitle()}
                >
                  {l.text}
                </span>
              )}
            </For>
            <div class="cala-speed__track">
              <Show when={!props.live}>
                <div
                  class="cala-speed__nogain"
                  data-testid="speed-nogain"
                  style={{ width: pct(live().floor) }}
                  title="No gain here: every kind of work is already fully served, so going slower only adds idle time."
                />
                <Show when={live().maxNow}>
                  {(m) => (
                    <div
                      class="cala-speed__above"
                      style={{ left: pct(m()) }}
                      title={`Above what this machine reaches now: a target here behaves as Max. ${maxTitle()}`}
                    />
                  )}
                </Show>
                <Show when={live().achieved}>
                  {(a) => <div class="cala-speed__achieved" style={{ width: pct(a()) }} />}
                </Show>
              </Show>
              <For each={SPEED_TICKS}>
                {(t) => (
                  <>
                    <i class="cala-speed__tick" style={{ left: pct(t) }} />
                    <span class="cala-speed__ticklabel num" style={{ left: pct(t) }}>
                      {t}
                    </span>
                  </>
                )}
              </For>
              <Show when={!props.live}>
                <i class="cala-speed__mark" style={{ left: pct(live().floor) }} />
                <Show when={live().maxNow}>
                  {(m) => <i class="cala-speed__mark" style={{ left: pct(m()) }} />}
                </Show>
              </Show>
              <Show when={props.live && props.fps >= SPEED_SCALE.lo}>
                <i
                  class="cala-speed__mark cala-speed__mark--stream"
                  style={{ left: pct(props.fps) }}
                />
                <span
                  class="cala-speed__marklabel cala-speed__marklabel--stream"
                  style={{ left: pct(props.fps) }}
                  data-testid="speed-stream-label"
                >
                  stream {Math.round(props.fps)}
                </span>
              </Show>
            </div>
            <Show when={!props.live}>
              <input
                type="range"
                class="cala-speed__range"
                classList={{ 'cala-speed__range--max': mode() === 'max' }}
                data-testid="speed-slider"
                min={fpsToStep(SPEED_SCALE.lo)}
                max={TRACK_STEPS}
                step={1}
                value={fpsToStep(shown() ?? fixedFps())}
                disabled={pinned() !== null || done()}
                aria-label="Target speed, frames per second"
                aria-valuetext={
                  mode() === 'max'
                    ? 'Max'
                    : `${shown()} frames per second${(shown() as number) < floorFps() ? ', no gain here' : ''}`
                }
                onInput={onSlide}
                onKeyDown={onKey}
                onChange={commitDraft}
                onPointerDown={(e) => {
                  dragging = true;
                  // Keeps the release coming here even when it happens outside the element.
                  try {
                    e.currentTarget.setPointerCapture(e.pointerId);
                  } catch {
                    // No capture (a synthetic event): the change and blur commits still run.
                  }
                }}
                onPointerUp={commitDraft}
                onPointerCancel={commitDraft}
                onLostPointerCapture={commitDraft}
                onBlur={commitDraft}
              />
            </Show>
          </div>
          {/* The Max stop: at Max the thumb sits here, so the target is always visible. */}
          <button
            type="button"
            class="cala-speed__maxstop"
            classList={{ 'cala-speed__maxstop--on': mode() === 'max' && !props.live }}
            data-testid="speed-max"
            aria-pressed={mode() === 'max'}
            disabled={props.live === true || done()}
            title={MODE_TITLES.max}
            onClick={() => setMode('max')}
          >
            <Show when={mode() === 'max' && !props.live}>
              <span class="cala-speed__thumb" data-testid="speed-max-thumb" aria-hidden="true" />
            </Show>
            Max
          </button>
        </div>
      </Show>

      {/* Curve: the plan along the recording in place of the thumb. */}
      <Show when={!props.live && mode() === 'curve'}>
        <div class="cala-speed__preview" ref={bindTrack} data-testid="speed-curve-preview">
          <Show when={curvePreview()}>
            {(cp) => (
              <svg
                width={cp().w}
                height={PREVIEW.height}
                viewBox={`0 0 ${cp().w} ${PREVIEW.height}`}
                role="img"
                aria-label={`The curve's target over the recording: ${curveLine()}`}
              >
                <rect
                  class="cala-speed__preview-ground"
                  x={cp().seg.x0}
                  y={PREVIEW.top}
                  width={cp().seg.x1 - cp().seg.x0}
                  height={PREVIEW.bot - PREVIEW.top}
                />
                <For each={cp().grid}>
                  {(g) => (
                    <>
                      <line
                        class="cala-speed__preview-grid"
                        x1={cp().seg.x0}
                        x2={cp().seg.x1}
                        y1={g.y}
                        y2={g.y}
                      />
                      <text x={cp().seg.x0 - 4} y={g.y + 3} text-anchor="end">
                        {g.f}
                      </text>
                    </>
                  )}
                </For>
                <Show when={cp().floorY}>
                  {(y) => (
                    <line
                      class="cala-speed__preview-floor"
                      x1={cp().seg.x0}
                      x2={cp().seg.x1}
                      y1={y()}
                      y2={y()}
                    />
                  )}
                </Show>
                <path class="cala-speed__preview-plan" d={cp().d} />
                <Show when={cp().nowX}>
                  {(x) => (
                    <line
                      class="cala-speed__preview-now"
                      x1={x()}
                      x2={x()}
                      y1={PREVIEW.top}
                      y2={PREVIEW.bot}
                    />
                  )}
                </Show>
                <text x={cp().seg.x0} y={PREVIEW.axis} text-anchor="start">
                  0 %
                </text>
                <text x={(cp().seg.x0 + cp().seg.x1) / 2} y={PREVIEW.axis} text-anchor="middle">
                  of the recording, fps log 10–500 (dotted: floor)
                </text>
                <text x={cp().seg.x1} y={PREVIEW.axis} text-anchor="end">
                  100 %
                </text>
              </svg>
            )}
          </Show>
        </div>
      </Show>

      {/* Auto: the time budget, before a run as a plan, during one as the share used. */}
      <Show when={!props.live && mode() === 'auto'}>
        <div class="cala-speed__budget" data-testid="speed-auto-budget">
          <Show
            when={live().budget}
            fallback={
              <div class="cala-speed__budget-plan">
                <SegmentedBar
                  parts={[
                    { id: 'max', label: 'A Max run', value: 1, color: 'var(--stage-discover)' },
                    {
                      id: 'extra',
                      label: `Extra time ${budgetLabel(budget())}`,
                      value: budget(),
                      color: 'var(--stage-discover-tint)',
                    },
                  ]}
                  total={1 + budget()}
                  format={(v) => `${v.toFixed(1)}× a Max run's time`}
                  label="Auto time budget"
                />
                <span class="cala-speed__budget-note">
                  Discover may take up to {1 + budget()}× a Max run's time
                </span>
              </div>
            }
          >
            {(b) => (
              <MeterRow
                label="Budget used"
                value={b().usedS}
                min={0}
                max={Math.max(1, b().budgetS)}
                tone={b().usedS > b().budgetS ? 'warning' : 'discover'}
                size="sm"
                display={`${Math.round(b().usedS)} / ${Math.round(b().budgetS)}`}
                unit="s"
                format={(v) =>
                  `${Math.round(v)} of ${Math.round(b().budgetS)} s of Discover's budget used`
                }
              />
            )}
          </Show>
        </div>
      </Show>

      {/* Refinement visits per Discover frame, on the rail's range and band. */}
      <Show when={!props.live && live().visits.on}>
        <div class="cala-speed__refine" title={live().visits.text ?? undefined}>
          <MeterRow
            label="Refinement"
            value={live().visits.achieved}
            min={RAIL_VISIT_RANGE.min}
            max={RAIL_VISIT_RANGE.max}
            target={live().visits.target ?? undefined}
            band={
              live().visits.target !== null
                ? [live().visits.target! * VISIT_BAND[0], live().visits.target! * VISIT_BAND[1]]
                : undefined
            }
            tone={live().visits.hold ? 'warning' : 'discover'}
            size="sm"
            display={
              live().visits.achieved !== null ? live().visits.achieved!.toFixed(2) : undefined
            }
            unit="/frame"
            format={(v) => `${v.toFixed(2)} visits per frame`}
            testid="speed-visit-rate"
          />
          <Show when={live().visits.hold}>
            {(why) => (
              <p class="cala-speed__hold" data-testid="speed-visit-hold" title={why()}>
                <Icon name="warning" size={12} />
                Held at {Math.round(live().visits.holdFps ?? 0)} fps to keep refinement up
              </p>
            )}
          </Show>
        </div>
      </Show>

      <Show when={!props.live}>
        <Show when={belowNote()}>
          {(note) => (
            <p class="cala-speed__line cala-muted" data-testid="speed-below-floor">
              {note()}{' '}
              <button type="button" class="cala-speed__link" onClick={() => commit(floorFps())}>
                Move to {floorFps()}
              </button>
            </p>
          )}
        </Show>
        <Show when={floor().aboveMax}>
          <p class="cala-speed__line cala-muted">
            Max is close to the floor here: Fixed offers one position.
          </p>
        </Show>
        <div class="cala-speed__foot">
          <span class="cala-muted" data-testid="speed-floor-line" title={words().detail}>
            {words().line}
          </span>
        </div>
        <details class="cala-speed__advanced" data-testid="speed-advanced">
          <summary>Advanced</summary>
          {capSelect('cala-speed__cap')}
        </details>
      </Show>
      <Show when={props.live}>
        <div class="cala-speed__cap cala-speed__cap--main">
          {capSelect('cala-speed__cap')}
          <span class="cala-muted cala-speed__hint">
            Lower it for closed-loop work: settling keeps footprints moving.
          </span>
        </div>
        <p class="cala-speed__line cala-muted" data-testid="speed-live-reason">
          {NO_BUFFER_REASON}
        </p>
        <Show when={s().visitMode() === 'cap-only'}>
          <p
            class="cala-speed__line cala-muted"
            data-testid="speed-visit-live"
            title={`On a recording, Discover keeps cell refinement at its target (${VISIT_RATE.target} visits per frame while new cells turn up, lower once they stop) and slows down when the workers fall behind. A live stream cannot slow down, so it keeps only the cap of 4/3 of the target: on a slow machine it may refine less than a recording would.`}
          >
            Refinement capped at{' '}
            {fmtVisitRate((visitTarget() * VISIT_RATE.cap) / VISIT_RATE.target)} visits/frame (no
            floor on a live stream
            {s().visitSchedule() === 'auto' ? '; Auto: follows the new cells' : ''}).
          </p>
        </Show>
      </Show>
    </section>
  );
}
