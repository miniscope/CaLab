import { For, Show, type JSX } from 'solid-js';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import { FINAL_SETTLE_LEVELS, type FinalSettleLevel } from '../lib/settle.ts';

/**
 * Where the Discover settings are shown, which decides when a change takes effect:
 * - `setup`: before a project's run plan starts (the project view);
 * - `prerun`: the pre-run sheet of one recording, before its first Run;
 * - `single`: the Run tab of one recording (the next Discover start);
 * - `separate`: a Separate session run (each session starts Discover again: the next session);
 * - `joint`: a Joint session run (one Discover over every session: the next run).
 */
export type SettingsContext = 'setup' | 'prerun' | 'single' | 'separate' | 'joint';

/** When a change to a start-time setting applies, in words. */
export function appliesText(ctx: SettingsContext): string {
  switch (ctx) {
    case 'setup':
      return 'Used by every session of this run. In a Separate run it can still be changed between sessions from the Run tab.';
    case 'prerun':
      return 'Read when Discover starts (Run).';
    case 'separate':
      return 'Read when Discover starts: in this Separate run a change applies from the next session.';
    case 'joint':
      return 'Read when Discover starts: a Joint run is one Discover over every session, so a change applies to the next run.';
    default:
      return 'Read when Discover starts: a change applies from the next start (restart with ↻).';
  }
}

const FINAL_SETTLE_HELP =
  'How much of the Final settle (the pass after the last frame that lets footprints converge) is read. Thorough: all of it (default). Standard: 87 %. Quick: 60 %, about 40 % faster, with slightly rougher edges and late-born cells.';

/**
 * The Discover settings that are read when Discover starts: Look-back and the Final settle
 * level. The values live in the pipeline store, so they can be chosen before any recording is
 * open (a multi-session run's setup) and are kept from one session to the next.
 */
export function DiscoverSettings(props: {
  pipeline: PipelineStore;
  context: SettingsContext;
}): JSX.Element {
  const s = () => props.pipeline;
  // Before a recording is open the feed says "open a recording first": that is not a reason here.
  const blocked = () => (props.context === 'setup' ? null : s().lookbackBlocked());
  const lookbackOn = () => s().lookback() && blocked() === null;
  const applies = () => appliesText(props.context);
  /** The run in progress started with another level than the one chosen now. */
  const pending = () =>
    props.context !== 'setup' &&
    s().lookbackRun() &&
    (s().status() === 'running' || s().status() === 'paused' || s().status() === 'starting') &&
    s().runFinalSettleLevel() !== s().finalSettleLevel();
  return (
    <div class="cala-run__settings" data-testid="discover-settings">
      <label
        class="cala-check"
        title={
          blocked() ??
          `On by default: Discover also re-reads earlier frames for each new cell and runs a Final settle after the last frame, so footprints converge. ${applies()}`
        }
      >
        <input
          type="checkbox"
          data-testid="lookback-toggle"
          disabled={blocked() !== null}
          checked={lookbackOn()}
          onChange={(e) => s().setLookback(e.currentTarget.checked)}
        />
        Look-back
      </label>
      <label
        class="cala-check"
        classList={{ 'cala-check--off': !lookbackOn() }}
        title={lookbackOn() ? `${FINAL_SETTLE_HELP} ${applies()}` : 'Needs Look-back.'}
      >
        Final settle
        <select
          data-testid="final-settle-level"
          disabled={!lookbackOn()}
          value={s().finalSettleLevel()}
          onChange={(e) => s().setFinalSettleLevel(e.currentTarget.value)}
        >
          <For each={Object.keys(FINAL_SETTLE_LEVELS) as FinalSettleLevel[]}>
            {(l) => (
              <option value={l} title={FINAL_SETTLE_LEVELS[l].help}>
                {FINAL_SETTLE_LEVELS[l].label}
              </option>
            )}
          </For>
        </select>
      </label>
      <Show when={pending()}>
        <span class="cala-muted" data-testid="final-settle-pending" title={applies()}>
          this run: {FINAL_SETTLE_LEVELS[s().runFinalSettleLevel() as FinalSettleLevel].label}
          {props.context === 'separate' ? ', next session: ' : ', next start: '}
          {FINAL_SETTLE_LEVELS[s().finalSettleLevel()].label}
        </span>
      </Show>
    </div>
  );
}
