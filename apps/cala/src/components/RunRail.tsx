/**
 * The run rail: always in view, the one place for the run's live figures. A stage track
 * (Discover, Final settle, Extract) with the line under it and the stage controls, then Cells,
 * Speed, Workers, Refinement and Memory, each on a declared range. Exact numbers are in each
 * figure's tooltip. The figures are sampled at most twice a second and on every change of
 * stage, never per batch.
 */
import { createEffect, createMemo, createSignal, on, onCleanup, Show, untrack } from 'solid-js';
import type { JSX } from 'solid-js';
import {
  Icon,
  Meter,
  MeterRow,
  Sparkline,
  StageTrack,
  type StageSegment,
  type StageState,
} from '@calab/ui';
import type { CellStore } from '../lib/cell-store.ts';
import type { Pass2Store } from '../lib/pass2-store.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import type { ConvergenceState } from '../lib/qc.ts';
import { totalWasmHeapBytes } from '../lib/memory-telemetry.ts';
import {
  formatBytes,
  RAIL_MEMORY_MAX,
  RAIL_SPEED_RANGE,
  RAIL_VISIT_RANGE,
  RailHistory,
  railKey,
  railLabel,
  railStages,
  railStatus,
  trackPosition,
  VISIT_BAND,
  type RailTrackInput,
} from '../lib/rail-view.ts';
import { createSampled } from '../lib/sampled.ts';
import { achievedSpeed } from '../lib/speed-track.ts';
import { fmtVisitRate, visitHoldText } from '../lib/visit-rate.ts';
import { workByKind } from '../lib/work-meter.ts';
import { busyWorkers, plannedSettleFrames } from '../lib/work-display.ts';
import { createSteps } from './Steps.tsx';
import { crossMilestones, delight, milestoneNote } from '../lib/delight.ts';
import { createTween } from '../lib/tween.ts';

/** Live figures refresh at most this often, ms (2 Hz). */
const SAMPLE_MS = 500;

const CONV_LABEL: Record<ConvergenceState, string> = {
  waiting: 'Waiting for cells',
  discovering: 'Discovering cells',
  settling: 'Cells still changing',
  converged: 'Converged',
};

/** One session of a multi-session run on the rail's session ribbon. */
export interface RailSession {
  name: string;
  state: StageState;
  /** The record's status word (pending, written, skipped, failed) and its note. */
  status: string;
}

export interface RunRailProps {
  pipeline: PipelineStore;
  pass2: Pass2Store;
  cells: CellStore;
  live?: boolean;
  /** The recording's frame rate, Hz (0: unknown): the Speed figure's "x real time". */
  fps?: number;
  /** A multi-session run: "Session 2/3" and each session's state (null: not one). */
  sessions?: { label: string; items: RailSession[] } | null;
  /** Stop the Final settle now (the footprints refined so far become the final library). */
  onStopSettling?: () => void;
  /** The export (`ExportMenu`): the rail's one primary button once there is a result. */
  export?: JSX.Element;
}

const n0 = (v: number): string => Math.round(v).toLocaleString('en-US');

interface Snapshot {
  track: RailTrackInput & { discover: string };
  cells: number | null;
  libraryVersion: number;
  lag: number | null;
  conv: { state: ConvergenceState; reason: string };
  speed: { fps: number | null; read: number | null; target: number | null; floor: number | null };
  workers: { busy: number | null; count: number };
  visits: {
    achieved: number | null;
    target: number | null;
    holding: boolean;
    holdFps: number | null;
  };
  memory: number;
}

/** The run rail (see the module comment). Testids `run-strip*` and `run-step-*` are kept. */
export function RunRail(props: RunRailProps): JSX.Element {
  const s = () => props.pipeline;
  const p = () => props.pass2;
  const c = () => props.cells;
  const steps = createSteps(() => ({
    pipeline: s(),
    cells: c(),
    pass2: p(),
    live: props.live,
    sessionRun: props.sessions != null,
  }));

  const phase = () =>
    railKey({
      discover: s().status(),
      extract: p().status(),
      settling: c().status()?.lookback?.settling === true,
      finalLibrary: c().status()?.final === true,
      setupPhase: s().setup()?.phase ?? '',
      noFrames: s().processed() === 0,
      libraryVersion: c().library()?.version ?? -1,
      hasWork: s().work() !== null,
      hasVisits: s().visitAchieved() !== null,
    });

  const read = (): Snapshot => {
    const lb = c().status()?.lookback;
    const total = s().plan()?.frameCount ?? 0;
    const settleFrames = plannedSettleFrames(
      total,
      s().runParams()?.engine.settle.final_max_frames ?? 0,
    );
    const st = steps();
    const running = s().status() === 'running' || s().status() === 'paused';
    const target = s().paceTarget();
    const gov = c().status()?.lookback?.csettle?.governor ?? null;
    const cur = st.find((v) => v.state === 'running' || v.state === 'paused');
    const discoverNow = cur?.key === 'discover';
    const achieved = discoverNow
      ? achievedSpeed({ running, target, governor: gov, maxFps: s().workMaxFps() })
      : null;
    const work = s().work();
    const by = work ? workByKind(work) : null;
    const visitOn = discoverNow && s().visitMode() === 'on';
    const hold = s().visitHold();
    const lag = c().metrics().lag.at(-1);
    return {
      track: {
        steps: st,
        live: props.live === true,
        total,
        settleFrames,
        setup: s().setup(),
        processed: s().processed(),
        settleFed: lb?.settle?.fed ?? 0,
        // The settle reports its total once it starts; the plan's until then.
        settleTotal: lb?.settle?.total || settleFrames,
        extractDone: p().processed(),
        // Extract reports its total after its first batch; the recording's until then.
        extractTotal: p().total() || total,
        discover: s().status(),
      },
      // Zero until the first library of a run; a dash only before any run.
      cells: c().library()?.ids.length ?? (s().status() === 'idle' ? null : 0),
      libraryVersion: c().version(),
      lag: lag === null || lag === undefined ? null : lag,
      conv: c().convergence(),
      speed: {
        fps: achieved ?? cur?.fps ?? null,
        read: cur?.fps ?? null,
        target: discoverNow && !props.live ? target : null,
        floor: discoverNow && !props.live ? Math.round(s().floor().fps) : null,
      },
      workers: {
        // Busy only while a stage runs: after the run the last reading is not a measurement.
        busy: by && cur ? busyWorkers(by.totals, by.count) : null,
        count: by?.count ?? 0,
      },
      visits: {
        achieved: visitOn ? s().visitAchieved() : null,
        target: visitOn ? s().visitTarget() : null,
        holding: visitOn && visitHoldText(hold, target) !== null,
        holdFps: hold,
      },
      memory: totalWasmHeapBytes(),
    };
  };

  // One snapshot per beat or change of stage; nothing else here reads the fast stores.
  const snap = createSampled(read, phase, SAMPLE_MS);

  const history = new RailHistory();
  const [hist, setHist] = createSignal(
    { x: [] as number[], cells: [] as number[], cellsMax: 10, workers: 0 },
    { equals: false },
  );
  createEffect(
    on(
      () => s().status(),
      (st) => {
        if (st === 'starting') {
          history.reset();
          setHist({ x: [], cells: [], cellsMax: history.cellsMax, workers: 0 });
        }
      },
    ),
  );

  const stages = createMemo(() => railStages(snap().track));
  createEffect(() => {
    const v = snap();
    const x = trackPosition(stages());
    // Not while starting: the last run's library is still loaded then.
    const sampling = v.track.discover !== 'idle' && v.track.discover !== 'starting';
    if (v.cells !== null && sampling) history.addCells(x, v.cells);
    if (sampling) history.addWorkers(v.workers.count);
    setHist({
      x: history.x.slice(),
      cells: history.cells.slice(),
      cellsMax: history.cellsMax,
      workers: history.workers,
    });
  });

  // ---- Fun touches (`delight.ts`): all fed by the 2 Hz snapshot, none touch the run. ----
  const fun = delight();
  /** A cell-count milestone of this run, shown for about 2 s (null: none). */
  const [moment, setMoment] = createSignal<{ at: number; note: string } | null>(null);
  const fired = new Set<number>();
  // Primed on the first reading, so a remount mid-run (or after it) does not replay milestones.
  let lastCells: number | null = null;
  let momentTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(
      () => s().status(),
      (st) => {
        if (st === 'starting') {
          fired.clear();
          lastCells = 0;
        }
      },
    ),
  );
  createEffect(() => {
    const v = snap();
    const st = v.track.discover;
    // Not while starting or idle: the last run's library is still loaded then.
    if (v.cells === null || st === 'idle' || st === 'starting') return;
    if (lastCells === null) {
      lastCells = v.cells;
      return;
    }
    const crossed = crossMilestones(lastCells, v.cells, fired);
    lastCells = v.cells;
    const at = crossed.at(-1);
    if (at === undefined || !untrack(fun.on)) return;
    setMoment({ at, note: milestoneNote(at) });
    clearTimeout(momentTimer);
    momentTimer = setTimeout(() => setMoment(null), 2000);
  });
  onCleanup(() => clearTimeout(momentTimer));

  /** A stage that just finished in this session (its check eases in), or 'all' when Extract did. */
  const [flash, setFlash] = createSignal<string | null>(null);
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  let lastStates: Record<string, string> | null = null;
  createEffect(() => {
    const now: Record<string, string> = {};
    for (const st of snap().track.steps) now[st.key] = st.state;
    const prev = lastStates;
    lastStates = now;
    if (!prev || !untrack(fun.on)) return;
    const done = Object.keys(now).filter(
      (k) => now[k] === 'done' && (prev[k] === 'running' || prev[k] === 'paused'),
    );
    if (done.length === 0) return;
    setFlash(done.includes('extract') ? 'all' : done[done.length - 1]);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => setFlash(null), 2600);
  });
  onCleanup(() => clearTimeout(flashTimer));

  const status = createMemo(() => railStatus(snap().track));
  const segments = (): StageSegment[] => stages().map((x) => x.segment);
  const stepNow = () =>
    snap().track.steps.find((v) => v.state === 'running' || v.state === 'paused')?.key ?? null;

  // The Cala mark's calcium pulse while Discover runs (CSS on the root attribute).
  createEffect(() => {
    const running = stepNow() === 'discover' && s().status() === 'running';
    const root = document.documentElement;
    if (running) root.setAttribute('data-cala-run', 'discover');
    else root.removeAttribute('data-cala-run');
  });
  onCleanup(() => document.documentElement.removeAttribute('data-cala-run'));

  return (
    <section
      class="cala-rail"
      aria-label="Run"
      data-testid="run-strip"
      data-state={status().state}
      data-flash={flash() ?? undefined}
    >
      {/* The live region: only the stage word, so the 2 Hz figures are not announced. */}
      <strong class="cala-visually-hidden" role="status" data-testid="run-strip-stage">
        {status().stage}
      </strong>
      <Show when={props.sessions}>
        {(ses) => (
          <div class="cala-rail__sessions">
            <span class="cala-rail__session-label cala-num" data-testid="run-strip-session">
              {ses().label}
            </span>
            <StageTrack
              class="cala-rail__ribbon"
              label="Sessions"
              testid="run-session"
              stages={ses().items.map((it, i) => ({
                id: String(i + 1),
                label: String(i + 1),
                hue: {
                  color: 'var(--ink-2)',
                  tint: 'var(--inset)',
                  ink: 'var(--surface)',
                },
                weight: 1,
                state: it.state,
                title: `Session ${i + 1}: ${it.name} · ${it.status}`,
              }))}
            />
          </div>
        )}
      </Show>
      <StageTrack stages={segments()} testid="run-step" label="Run stages" />
      <div class="cala-rail__line">
        <span class="cala-rail__label cala-num" data-testid="pipeline-readout">
          {railLabel(snap().track)}
        </span>
        <span class="cala-rail__controls">
          <Show when={stepNow() === 'discover'}>
            <button
              type="button"
              class="btn-secondary btn-small cala-icon-btn"
              aria-label={s().status() === 'paused' ? 'Resume' : 'Pause'}
              title={s().status() === 'paused' ? 'Resume' : 'Pause'}
              data-testid="strip-pause"
              onClick={() => s().togglePause()}
            >
              <Icon name={s().status() === 'paused' ? 'play' : 'pause'} size={14} />
            </button>
            <button
              type="button"
              class="btn-secondary btn-small cala-icon-btn"
              aria-label={props.live ? 'Stop the live run' : 'End Discover'}
              title={
                props.live
                  ? 'Stop the live run: the cells found so far become the final library.'
                  : 'End Discover here: the cells found so far become the final library.'
              }
              data-testid="strip-discover-end"
              onClick={() => void s().finishEarly()}
            >
              <Icon name="stop" size={14} />
            </button>
          </Show>
          <Show when={stepNow() === 'settle' && props.onStopSettling}>
            <button
              type="button"
              class="btn-secondary btn-small cala-icon-btn"
              aria-label="Stop Final settle"
              title="Stop the Final settle now: the footprints refined so far become the final library."
              data-testid="strip-settle-stop"
              onClick={() => props.onStopSettling?.()}
            >
              <Icon name="stop" size={14} />
            </button>
          </Show>
          <Show when={stepNow() === 'extract'}>
            <button
              type="button"
              class="btn-secondary btn-small cala-icon-btn"
              aria-label="Cancel Extract"
              title="Cancel Extract."
              data-testid="strip-extract-cancel"
              onClick={() => p().cancel()}
            >
              <Icon name="stop" size={14} />
            </button>
          </Show>
        </span>
      </div>
      {/* Empty (and hidden by CSS) until the export has something to show. */}
      <div class="cala-rail__export">{props.export}</div>
      <div class="cala-rail__figs">
        <CellsFigure snap={snap()} hist={hist()} moment={moment()} motion={fun.motion()} />
        <SpeedFigure snap={snap()} stepNow={stepNow()} recordingFps={props.fps ?? 0} />
        <WorkersFigure snap={snap()} n={hist().workers} />
        <RefinementFigure snap={snap()} />
      </div>
      <div
        class="cala-rail__memory"
        title={
          'WebAssembly memory summed over the page and its workers, sampled every 2 s. ' +
          'Its limits: it is not the tab’s whole footprint (worker JavaScript heaps, ' +
          'transferred buffers and GPU memory are not visible to the page), and WebAssembly ' +
          'memory never shrinks during a run, so it shows the high-water mark. ' +
          'Fixed range 0 to 4 GB (one WebAssembly instance can address at most 4 GB).'
        }
        data-testid="run-rail-memory"
      >
        <MeterRow
          label="Memory"
          value={snap().memory > 0 ? snap().memory : null}
          min={0}
          max={RAIL_MEMORY_MAX}
          format={formatBytes}
          size="sm"
        />
        <Icon name="info" size={14} class="cala-rail__info" />
      </div>
    </section>
  );
}

function Fig(p: {
  name: JSX.Element;
  value: JSX.Element;
  unit?: string;
  title: string;
  testid: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div class="cala-fig" title={p.title} data-testid={p.testid}>
      <span class="cala-fig__name">{p.name}</span>
      <span class="cala-fig__value num">
        {p.value}
        <Show when={p.unit}>
          <span class="unit"> {p.unit}</span>
        </Show>
      </span>
      <div class="cala-fig__mark">{p.children}</div>
    </div>
  );
}

/** "Not measured": a grey dash (a fresh node per use). */
const dash = (): JSX.Element => (
  <span class="cala-fig__dash" aria-label="not measured">
    –
  </span>
);

function CellsFigure(p: {
  snap: Snapshot;
  hist: { x: number[]; cells: number[]; cellsMax: number };
  /** A milestone just reached (a pop and a short note), or null. */
  moment: { at: number; note: string } | null;
  /** Motion allowed (fun touches on, no reduced-motion preference): the number counts up. */
  motion: boolean;
}): JSX.Element {
  // The shown number eases to each new 2 Hz reading; the label and tooltip keep the exact one.
  const shown = createTween(
    () => p.snap.cells,
    () => p.motion,
  );
  const conv = () => p.snap.conv;
  /**
   * After Discover only Converged stays a status (the ok check); a run that ended while cells
   * were still changing shows a neutral dot, so the dot never reads as live work.
   */
  const dotState = (): string =>
    p.snap.track.steps[0].state === 'done' && conv().state !== 'converged'
      ? 'waiting'
      : conv().state;
  const dotWord = (): string =>
    p.snap.track.steps[0].state === 'done' && conv().state !== 'converged'
      ? `${CONV_LABEL[conv().state]} at the end of Discover`
      : CONV_LABEL[conv().state];
  const title = () => {
    const n = p.snap.cells;
    const lib =
      n === null
        ? 'no library yet'
        : `${n0(n)} cells in library v${p.snap.libraryVersion}` +
          (p.snap.lag !== null ? ` · lag ${n0(p.snap.lag)} frames` : '');
    return `${lib}. ${dotWord()}: ${conv().reason}. Sparkline: cells along the run, fixed range 0 to ${n0(p.hist.cellsMax)}.`;
  };
  return (
    <Fig
      name={
        <>
          Cells
          <span
            class={`cala-fig__status cala-fig__status--${dotState()}`}
            data-testid="convergence-status"
          >
            <Show when={conv().state === 'converged'} fallback={<i aria-hidden="true" />}>
              <Icon name="check" size={12} />
            </Show>
            <span class="cala-visually-hidden">{dotWord()}</span>
          </span>
          <span
            class="cala-fig__axis cala-num"
            title="The sparkline's fixed range: 0 to this, rounded up; it never shrinks in a run."
          >
            0–{n0(p.hist.cellsMax)}
          </span>
        </>
      }
      value={
        <>
          <span
            class="cala-fig__count"
            classList={{ 'cala-pop': p.moment !== null }}
            data-testid="cells-readout"
            aria-label={`${p.snap.cells ?? 0} cells`}
          >
            {p.snap.cells === null ? dash() : n0(shown() ?? p.snap.cells)}
          </span>
          <Show when={p.moment} keyed>
            {(m) => (
              <span class="cala-moment" data-testid="cells-milestone" data-at={m.at}>
                {m.note}
              </span>
            )}
          </Show>
        </>
      }
      title={title()}
      testid="run-rail-cells"
    >
      <span class="cala-fig__spark">
        <Sparkline
          values={p.hist.cells}
          x={p.hist.x}
          xMax={1}
          range={[0, p.hist.cellsMax]}
          width={84}
          height={22}
          color="var(--stage-discover)"
          label="Cells along the run"
          format={(v) => `${n0(v)} cells`}
        />
      </span>
    </Fig>
  );
}

function SpeedFigure(p: {
  snap: Snapshot;
  stepNow: string | null;
  recordingFps: number;
}): JSX.Element {
  const sp = () => p.snap.speed;
  const targetWord = () => {
    const t = sp().target;
    return t === null ? '' : t > 0 ? `target ${n0(t)}` : 'target Max';
  };
  const title = () => {
    const parts: string[] = [];
    const f = sp().fps;
    parts.push(f !== null ? `${f.toFixed(1)} fps achieved` : 'not running');
    if (f !== null && p.recordingFps > 0)
      parts.push(`${(f / p.recordingFps).toFixed(1)}× real time`);
    if (sp().read !== null && sp().read !== f) parts.push(`${sp().read!.toFixed(1)} frames/s read`);
    if (sp().target !== null)
      parts.push(sp().target! > 0 ? `target ${sp().target} fps` : 'target Max (unpaced)');
    if (sp().floor !== null && sp().floor! > 0)
      parts.push(
        `floor ${sp().floor} fps (the slowest speed that still gains anything; grey tick)`,
      );
    parts.push('fixed range 10 to 500 fps, log');
    return parts.join(' · ');
  };
  const tone = () =>
    p.stepNow === 'settle' ? 'settle' : p.stepNow === 'extract' ? 'extract' : 'discover';
  return (
    <Fig
      name={
        <>
          Speed <span class="cala-fig__sub">{targetWord()}</span>
        </>
      }
      value={sp().fps !== null ? n0(sp().fps!) : dash()}
      unit="fps"
      title={title()}
      testid="speed-headline"
    >
      <Meter
        value={sp().fps}
        min={RAIL_SPEED_RANGE.min}
        max={RAIL_SPEED_RANGE.max}
        scale="log"
        target={sp().target !== null && sp().target! > 0 ? sp().target! : undefined}
        marks={sp().floor !== null && sp().floor! > 0 ? [sp().floor!] : undefined}
        tone={tone()}
        label="Speed"
        format={(v) => `${v.toFixed(1)} fps`}
      />
    </Fig>
  );
}

function WorkersFigure(p: { snap: Snapshot; n: number }): JSX.Element {
  const busy = () => p.snap.workers.busy;
  return (
    <Fig
      name="Workers busy"
      value={
        <>
          {busy() !== null ? busy()!.toFixed(1) : dash()}
          <span class="unit"> / {p.n > 0 ? p.n : '–'}</span>
        </>
      }
      title={`${busy() !== null ? busy()!.toFixed(2) : 'not measured'} of ${p.n > 0 ? p.n : '–'} workers busy over the last second (their busy shares added up). Fixed range 0 to ${p.n > 0 ? p.n : '–'}: the most workers counted in this run.`}
      testid="run-rail-workers"
    >
      <Meter
        value={busy()}
        min={0}
        max={Math.max(1, p.n)}
        label="Workers busy"
        format={(v) => `${v.toFixed(1)} of ${p.n}`}
      />
    </Fig>
  );
}

function RefinementFigure(p: { snap: Snapshot }): JSX.Element {
  const v = () => p.snap.visits;
  const band = (): [number, number] | undefined => {
    const t = v().target;
    return t !== null ? [t * VISIT_BAND[0], t * VISIT_BAND[1]] : undefined;
  };
  const title = () => {
    const a = v().achieved;
    const t = v().target;
    if (a === null && t === null)
      return 'Refinement visits per Discover frame: measured while Discover runs.';
    return [
      `${a !== null ? fmtVisitRate(a) : 'not measured'} visits per frame`,
      t !== null
        ? `target ${fmtVisitRate(t)}, allowed ${fmtVisitRate(t * VISIT_BAND[0])} to ${fmtVisitRate(t * VISIT_BAND[1])} (shaded)`
        : '',
      v().holding && v().holdFps !== null
        ? `holding the run at ${n0(v().holdFps!)} fps to keep refinement up (amber)`
        : '',
      'fixed range 0 to 0.5',
    ]
      .filter(Boolean)
      .join(' · ');
  };
  return (
    <Fig
      name={
        <>
          Refinement
          <Show when={v().holding}>
            <span class="cala-fig__warn" data-testid="run-rail-visit-hold">
              <Icon name="warning" size={12} />
              <span class="cala-visually-hidden">holding the run's speed</span>
            </span>
          </Show>
        </>
      }
      value={v().achieved !== null ? v().achieved!.toFixed(2) : dash()}
      unit="/frame"
      title={title()}
      testid="run-rail-refinement"
    >
      <Meter
        value={v().achieved}
        min={RAIL_VISIT_RANGE.min}
        max={RAIL_VISIT_RANGE.max}
        target={v().target ?? undefined}
        band={band()}
        tone={v().holding ? 'warning' : 'discover'}
        label="Refinement visits per frame"
        format={(x) => `${x.toFixed(2)} visits per frame`}
      />
    </Fig>
  );
}
