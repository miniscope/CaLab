/**
 * The Run tab's settings: before the first run, the pre-run sheet (every setting read when
 * Discover starts, and the Run button); after it, one summary line of chips that opens to the
 * same fields, whose changes apply on Restart.
 */
import { Show, type JSX } from 'solid-js';
import { Badge, Icon } from '@calab/ui';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import { FINAL_SETTLE_LEVELS, type FinalSettleLevel } from '../lib/settle.ts';
import { DiscoverSettings, type SettingsContext } from './DiscoverSettings.tsx';

export interface RunSettingsProps {
  pipeline: PipelineStore;
  context: SettingsContext;
  /** Extract after Discover: the setting, and whether a session run forces it on. */
  autoExtract: boolean;
  onAutoExtract: (on: boolean) => void;
  sessionRun: boolean;
}

/** The setting fields, shared by the sheet and the summary's disclosure. */
function RunSettingsFields(props: RunSettingsProps): JSX.Element {
  const s = () => props.pipeline;
  return (
    <>
      <div class="cala-run__footer">
        <DiscoverSettings pipeline={s()} context={props.context} />
        <label
          class="cala-check"
          classList={{ 'cala-check--off': props.sessionRun }}
          title={
            props.sessionRun
              ? 'A session run always Extracts each session once its Discover is done.'
              : 'On by default: Extract starts as soon as Discover has its final cell set.'
          }
        >
          <input
            type="checkbox"
            data-testid="extract-after-discover"
            disabled={props.sessionRun}
            checked={props.autoExtract || props.sessionRun}
            onChange={(e) => props.onAutoExtract(e.currentTarget.checked)}
          />
          Extract after Discover
        </label>
        <label
          class="cala-check"
          data-testid="run-more-settings"
          title="On by default. Off: Discover keeps tracking the cells it already has but finds no new ones. Applies at once, also during a run."
        >
          <input
            type="checkbox"
            checked={s().discover()}
            onChange={(e) => s().setDiscover(e.currentTarget.checked)}
          />
          Find new cells
        </label>
      </div>
      <Show when={s().lookback() ? s().lookbackBlocked() : null}>
        {(why) => (
          <p class="cala-muted cala-run__line" data-testid="lookback-note">
            Look-back off: {why()} Footprints get no refinement after Discover.
          </p>
        )}
      </Show>
    </>
  );
}

/**
 * A labelled mount point in the pre-run sheet for one more pre-run choice. It is in the DOM
 * (hidden) until it gets content, so the sheet's order and spacing do not depend on it.
 */
export function SheetSlot(props: {
  id: string;
  title: string;
  children?: JSX.Element;
}): JSX.Element {
  const filled = () => props.children !== undefined && props.children !== null;
  return (
    <section
      class="cala-sheet__slot"
      data-slot={props.id}
      data-testid={`prerun-slot-${props.id}`}
      aria-label={props.title}
      hidden={!filled()}
    >
      <h4 class="cala-sheet__slot-title">{props.title}</h4>
      {props.children}
    </section>
  );
}

/** Before the first run: the settings, the slots for further pre-run choices, and Run. */
export function PreRunSheet(
  props: RunSettingsProps & { onRun: () => void; children?: JSX.Element },
): JSX.Element {
  return (
    <section
      class="cala-run__section cala-sheet"
      aria-labelledby="run-settings"
      data-testid="run-settings"
    >
      <div class="cala-sheet__head" data-testid="prerun-sheet">
        <div class="cala-sheet__titles">
          <h3 id="run-settings" class="cala-sheet__title">
            Before the run
          </h3>
          <p class="cala-sheet__lede">
            The recording is open. Pick the settings, then Run; they are read when Discover starts.
          </p>
        </div>
        <button
          type="button"
          class="btn-primary cala-sheet__run"
          data-testid="run-start"
          onClick={() => props.onRun()}
        >
          <Icon name="play" size={14} /> Run
        </button>
      </div>
      <RunSettingsFields {...props} />
      <SheetSlot id="repeatable" title="Repeatable runs" />
      <SheetSlot id="seed" title="Start from footprints of a past run" />
      <SheetSlot id="crop" title="Crop region" />
      {props.children}
    </section>
  );
}

/**
 * After Run: the settings the run started with as chips, and a disclosure with the fields.
 * Start-time settings apply on Restart (in a Separate session run, from the next session).
 */
export function SettingsSummary(props: RunSettingsProps): JSX.Element {
  const s = () => props.pipeline;
  const lookbackOn = () => s().lookbackRun();
  const level = () =>
    FINAL_SETTLE_LEVELS[s().runFinalSettleLevel() as FinalSettleLevel]?.label ?? '';
  const appliesOn = () =>
    props.context === 'separate' ? 'applies from the next session' : 'applies on Restart';
  return (
    <details
      class="cala-run__section cala-run__summary"
      aria-label="Settings"
      data-testid="run-settings"
    >
      <summary class="cala-run__summary-line" data-testid="settings-summary">
        <span class="cala-run__summary-name">Settings</span>
        <Badge tone="neutral" testid="settings-chip-lookback">
          Look-back {lookbackOn() ? 'on' : 'off'}
        </Badge>
        <Show when={lookbackOn()}>
          <Badge tone="neutral">Final settle {level()}</Badge>
        </Show>
        <Badge tone="neutral">
          {props.autoExtract || props.sessionRun ? 'Extract after Discover' : 'Extract by hand'}
        </Badge>
        <Show when={!s().discover()}>
          <Badge tone="neutral">No new cells</Badge>
        </Show>
        <span class="cala-run__summary-applies">{appliesOn()}</span>
      </summary>
      <div class="cala-run__summary-body">
        <RunSettingsFields {...props} />
      </div>
    </details>
  );
}
