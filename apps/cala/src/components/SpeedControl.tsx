import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from 'solid-js';
import type { JSX } from 'solid-js';
import { SegmentedControl } from '@calab/ui';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import type { CellStore } from '../lib/cell-store.ts';
import { curveWords, CURVE_PRESETS, presetCurve } from '../lib/speed-schedule.ts';
import { AUTO_BUDGETS, budgetLabel } from '../lib/speed-auto.ts';
import {
  VISIT_RATE,
  fmtVisitRate,
  maxRepeatText,
  visitHoldText,
  visitRateText,
} from '../lib/visit-rate.ts';
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

/** Two labels closer than this share of the track would overlap: the floor's goes to the left of its mark. */
const LABEL_CLASH = 0.22;

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

  const achieved = (): number | null =>
    achievedSpeed({
      running: running(),
      target: target(),
      governor: gov(),
      maxFps: s().workMaxFps(),
    });
  const timesReal = (fps: number) => (props.fps > 0 ? fps / props.fps : null);

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

  // The floor's mark label moves left of its mark where it would meet "max now".
  const clash = () => {
    const m = maxNow();
    return m !== null && Math.abs(fpsToPos(m) - fpsToPos(floorFps())) < LABEL_CLASH;
  };
  const pct = (fps: number) => `${(100 * fpsToPos(fps)).toFixed(2)}%`;

  const cappedReason = (): string | null =>
    props.live
      ? NO_BUFFER_REASON
      : pinned() !== null
        ? `Needs look-back: ${pinned()}`
        : !s().lookback()
          ? 'Needs look-back refinement: tick it below.'
          : null;

  const headline = () => {
    if (props.live) return props.fps > 0 ? props.fps.toFixed(1) : '-';
    const a = achieved();
    if (a !== null) return a.toFixed(1);
    if (mode() === 'curve') return !running() ? 'Curve' : target() > 0 ? String(target()) : 'Max';
    if (mode() === 'auto') return !running() ? 'Auto' : target() > 0 ? String(target()) : 'Max';
    return mode() === 'max' ? 'Max' : String(shown());
  };
  const unitText = () => {
    if (props.live) return 'fps from the stream · sets the pace';
    const curve = mode() === 'curve' || mode() === 'auto';
    const t = curve
      ? target() > 0
        ? String(target())
        : 'Max'
      : mode() === 'max'
        ? 'Max'
        : String(shown());
    const x = mode() === 'fixed' ? timesReal(shown() as number) : null;
    const xt = x !== null ? ` · ${x.toFixed(1)}× real time` : '';
    if (achieved() !== null) return `fps achieved · target ${t}${xt}`;
    if (mode() === 'auto')
      return running() ? `fps · Auto, ${budgetLabel(budget())} time budget` : '';
    return curve ? (running() ? 'fps · following the curve' : '') : `fps target${xt}`;
  };

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
  // The Discover visit rate's hold (`lib/visit-rate.ts`): the run goes slower than asked.
  const holdLine = () =>
    running() && !done() ? visitHoldText(s().visitHold(), s().paceTarget(), visitTarget()) : null;
  // The rate in force (Auto moves it with the new cells visits find), while Discover runs.
  const rateLine = () =>
    running() && !done() && s().visitMode() === 'on'
      ? visitRateText(s().visitMode(), s().visitSchedule(), s().visitTarget(), s().visitYield())
      : null;

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
      <div class="cala-speed__answer" data-testid="speed-headline">
        <span class="cala-speed__figure">{headline()}</span>
        <span class="cala-speed__unit">{unitText()}</span>
      </div>
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
        <Show when={rateLine()}>
          {(line) => (
            <p
              class="cala-speed__line"
              data-testid="speed-visit-rate"
              title={
                s().visitSchedule() === 'auto'
                  ? `Discover's refinement visits per frame (Auto): ${VISIT_RATE.target} while visits keep finding new cells, sliding down to ${fmtVisitRate(VISIT_RATE.autoFloor)} as new cells stop turning up, and back up when they appear again. It follows what the visits find, never how fast this machine is, so the same recording gets the same visits on any machine.`
                  : `Discover keeps cell refinement at ${VISIT_RATE.target} visits per frame (fixed), so results do not depend on how fast this machine is.`
              }
            >
              {line()}
            </p>
          )}
        </Show>
        <Show when={holdLine()}>
          {(line) => (
            <p
              class="cala-speed__line"
              data-testid="speed-visit-hold"
              title={`Discover keeps cell refinement between 2/3 and 4/3 of its target (now ${fmtVisitRate(visitTarget())} visits per frame), so results do not depend on how fast this machine is. When the workers cannot keep up with the target, the run is held slower than the Speed setting.`}
            >
              {line()}
            </p>
          )}
        </Show>
      </Show>

      <div
        class="cala-speed__trackrow"
        classList={{
          'cala-speed__trackrow--off': props.live || done(),
          'cala-speed__trackrow--curve': mode() === 'curve' || mode() === 'auto',
        }}
      >
        <div class="cala-speed__trackwrap" aria-hidden={props.live ? 'true' : undefined}>
          <div class="cala-speed__track">
            <Show when={!props.live}>
              <div
                class="cala-speed__nogain"
                data-testid="speed-nogain"
                style={{ width: pct(floorFps()) }}
                title="No gain here: every kind of work is already fully served, so going slower only adds idle time."
              />
              <Show when={maxNow()}>
                {(m) => (
                  <div
                    class="cala-speed__above"
                    style={{ left: pct(m()) }}
                    title={`Above what this machine reaches now: a target here behaves as Max. ${maxTitle()}`}
                  />
                )}
              </Show>
              <Show when={achieved()}>
                {(a) => <div class="cala-speed__achieved" style={{ width: pct(a()) }} />}
              </Show>
            </Show>
            <For each={SPEED_TICKS}>
              {(t) => (
                <>
                  <i class="cala-speed__tick" style={{ left: pct(t) }} />
                  <span class="cala-speed__ticklabel" style={{ left: pct(t) }}>
                    {t}
                  </span>
                </>
              )}
            </For>
            <Show when={!props.live}>
              <i class="cala-speed__mark" style={{ left: pct(floorFps()) }} />
              <span
                class="cala-speed__marklabel"
                classList={{ 'cala-speed__marklabel--left': clash() }}
                style={{ left: pct(floorFps()) }}
                data-testid="speed-floor-label"
                title={words().line}
              >
                {words().mark}
              </span>
              <Show when={maxNow()}>
                {(m) => (
                  <>
                    <i class="cala-speed__mark" style={{ left: pct(m()) }} />
                    <span
                      class="cala-speed__marklabel"
                      style={{ left: pct(m()) }}
                      data-testid="speed-max-label"
                      title={maxTitle()}
                    >
                      max now {m()}
                    </span>
                  </>
                )}
              </Show>
              <span
                class="cala-speed__nogain-label"
                data-testid="speed-nogain-label"
                style={{ 'max-width': `calc(${pct(floorFps())} - 34px)` }}
              >
                no gain here
              </span>
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
          <Show when={!props.live && (mode() === 'max' || mode() === 'fixed')}>
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
          <Show when={!props.live && (mode() === 'curve' || mode() === 'auto')}>
            <span class="cala-muted" data-testid="speed-set-by">
              {mode() === 'auto' ? 'set by Auto' : 'set by the curve'}
            </span>
          </Show>
        </div>
        <button
          type="button"
          class="cala-speed__maxstop"
          classList={{ 'cala-speed__maxstop--on': mode() === 'max' && !props.live }}
          data-testid="speed-max"
          aria-pressed={mode() === 'max'}
          disabled={props.live === true || done() || mode() === 'curve' || mode() === 'auto'}
          title={MODE_TITLES.max}
          onClick={() => setMode('max')}
        >
          Max
        </button>
      </div>

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
