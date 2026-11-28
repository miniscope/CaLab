import { For, Show, type JSX } from 'solid-js';
import { Icon } from './Icon.tsx';
import { pct } from './range.ts';
import type { StageHue } from './tones.ts';

/**
 * State of one stage. waiting: tint only; running: fills to `fraction`; done: full hue with a
 * check mark (never the ok green); off: hatched grey, not part of this run; error: critical
 * outline with a cross.
 */
export type StageState = 'waiting' | 'running' | 'done' | 'off' | 'error';

/** One stage segment of the track. */
export interface StageSegment {
  id: string;
  label: string;
  /** A stage hue token, or explicit colours for an app with its own stages. */
  hue: StageHue | { color: string; tint: string; ink: string };
  /** Expected share of the run (any positive unit; segments are sized by weight / total weight). */
  weight: number;
  state: StageState;
  /**
   * Done fraction in [0, 1] while running (clamped; ignored in the other states). `null`: the
   * stage has no known end (a live stream), so the segment is not a progress bar.
   */
  fraction?: number | null;
  /**
   * Share of the segment, in [0, 0.5], drawn hatched in the stage hue at its start: a lead-in
   * phase (setup work before the stage's own progress). The fill covers it like the rest.
   */
  leadIn?: number;
  /** Hover text (e.g. the exact count and percent). */
  title?: string;
}

export interface StageTrackProps {
  stages: StageSegment[];
  /** Accessible name of the track (default "Run stages"). */
  label?: string;
  class?: string;
  /** Root testid; each segment gets `<testid>-<id>`. */
  testid?: string;
}

const STATE_WORD: Record<StageState, string> = {
  waiting: 'waiting',
  running: 'running',
  done: 'done',
  off: 'off',
  error: 'error',
};

/** Label ink over a stage's full hue: white on Discover and Final settle, the text ink on Extract's orange. */
const ON_FILL: Record<StageHue, string> = {
  discover: 'var(--ink-on-fill)',
  settle: 'var(--ink-on-fill)',
  extract: 'var(--ink-1)',
};

function colours(h: StageSegment['hue']): { color: string; tint: string; ink: string } {
  if (typeof h !== 'string') return h;
  return { color: `var(--stage-${h})`, tint: `var(--stage-${h}-tint)`, ink: ON_FILL[h] };
}

/** True when the segment is a progress bar: not off, and with a known end. */
export function stageMeasured(s: Pick<StageSegment, 'state' | 'fraction'>): boolean {
  return s.state !== 'off' && s.fraction !== null;
}

/** Fill fraction of a segment in its state: done 1, running the clamped fraction, else 0. */
export function stageFill(s: Pick<StageSegment, 'state' | 'fraction'>): number {
  if (s.state === 'done') return 1;
  if (s.state !== 'running') return 0;
  const f = s.fraction ?? 0;
  return Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : 0;
}

/**
 * One bar of run stages, each segment sized by its expected share and filling in its stage
 * hue. The label sits inside the segment in two layers, the text ink over the tint and the
 * on-fill ink clipped to the fill, so it stays legible at any fill.
 */
export function StageTrack(p: StageTrackProps): JSX.Element {
  const total = () => p.stages.reduce((a, s) => a + (s.weight > 0 ? s.weight : 0), 0) || 1;
  return (
    <div
      class={`stage-track${p.class ? ' ' + p.class : ''}`}
      role="group"
      aria-label={p.label ?? 'Run stages'}
      data-testid={p.testid}
    >
      <For each={p.stages}>
        {(s) => {
          const c = () => colours(s.hue);
          const fill = () => stageFill(s);
          const measured = () => stageMeasured(s);
          const lead = () => Math.min(0.5, Math.max(0, s.leadIn ?? 0));
          return (
            <div
              class={`stage-track__seg stage-track__seg--${s.state}`}
              style={{
                'flex-grow': String(s.weight > 0 ? s.weight / total() : 0),
                '--stage-color': c().color,
                '--stage-tint': c().tint,
                '--stage-on-fill': c().ink,
                '--stage-fill': pct(fill()),
              }}
              role={measured() ? 'progressbar' : 'img'}
              aria-label={`${s.label}: ${STATE_WORD[s.state]}`}
              aria-valuemin={measured() ? 0 : undefined}
              aria-valuemax={measured() ? 100 : undefined}
              aria-valuenow={measured() ? Math.round(fill() * 100) : undefined}
              title={s.title}
              data-state={s.state}
              data-testid={p.testid ? `${p.testid}-${s.id}` : undefined}
            >
              <Show when={lead() > 0}>
                <span class="stage-track__lead" style={{ width: pct(lead()) }} aria-hidden="true" />
              </Show>
              <span class="stage-track__fill" aria-hidden="true" />
              <span class="stage-track__label" aria-hidden="true">
                <StageLabel seg={s} />
              </span>
              <span class="stage-track__label stage-track__label--on-fill" aria-hidden="true">
                <StageLabel seg={s} />
              </span>
            </div>
          );
        }}
      </For>
    </div>
  );
}

function StageLabel(p: { seg: StageSegment }): JSX.Element {
  return (
    <>
      <Show when={p.seg.state === 'done'}>
        <Icon name="check" size={12} />
      </Show>
      <Show when={p.seg.state === 'error'}>
        <Icon name="cross" size={12} />
      </Show>
      <span>{p.seg.label}</span>
    </>
  );
}
