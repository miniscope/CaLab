/**
 * The Run tab's settings: before the first run, the pre-run sheet (the params' main fields and
 * an Advanced section rendered from the schema, config files, and the Run button); after it, one
 * summary line of chips that opens to the same fields, whose changes apply on Restart.
 */
import { createSignal, For, Show, type JSX } from 'solid-js';
import { Badge, formatParam, Icon, ParamForm, type ParamFieldExtras } from '@calab/ui';
import { getAt, layerEntries, schemaFields, type ParamField } from '@calab/core';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import { FINAL_SETTLE_LEVELS, type FinalSettleLevel } from '../lib/settle.ts';
import { appliesText, type SettingsContext } from './DiscoverSettings.tsx';
import { isRefusal, PARAMS_SCHEMA, readConfig, type ConfigRefusal } from '../lib/config-file.ts';
import { SET_AT_START, sheetShows } from '../lib/sheet-fields.ts';

export interface RunSettingsProps {
  pipeline: PipelineStore;
  context: SettingsContext;
  /** Extract after Discover: the setting, and whether a session run forces it on. */
  autoExtract: boolean;
  onAutoExtract: (on: boolean) => void;
  sessionRun: boolean;
  /** Extract is running: Find new cells cannot change under it. */
  extractRunning?: boolean;
  /** Width of the recording's frames, px (0: none open); the optics' binning may follow it. */
  frameWidth: number;
}

const GROUP_TITLES = { scales: 'Cell size', optics: 'Microscope', stages: 'Stages' };
const GROUP_ORDER = ['scales', 'optics', 'lookback', 'settle', 'stages'];
const DIAMETER_PX = '/scales/cell_diameter_px';
const DIAMETER_UM = '/scales/expected_cell_diameter_um';

const px1 = (v: number): string => (Math.round(v * 10) / 10).toString();

/** The setting fields, shared by the sheet and the summary's disclosure. */
function RunSettingsFields(props: RunSettingsProps): JSX.Element {
  const s = () => props.pipeline;
  const params = () => s().params;
  const blocked = () => (props.context === 'setup' ? null : s().lookbackBlocked());
  const lookbackOn = () => s().lookback() && blocked() === null;
  const applies = () => appliesText(props.context);
  const plan = () => params().diameter(props.frameWidth);
  /** The run in progress started with another level than the one chosen now. */
  const pending = () =>
    props.context !== 'setup' &&
    s().lookbackRun() &&
    (s().status() === 'running' || s().status() === 'paused' || s().status() === 'starting') &&
    s().runFinalSettleLevel() !== s().finalSettleLevel();

  const value = (ptr: string): unknown => {
    if (ptr === '/stages/extract') return props.autoExtract || props.sessionRun;
    if (ptr === '/lookback/enabled') return lookbackOn();
    // The pixel field is empty while the µm diameter gives the pixels.
    if (ptr === DIAMETER_PX && plan().source === 'optics') return null;
    return params().value(ptr);
  };

  const diameterNote = (): JSX.Element => {
    const d = plan();
    const issue = d.issues[0];
    if (issue) return <span class="cala-sheet__issue">{issue.message}</span>;
    if (d.source === 'optics' && d.px !== null)
      return (
        <span data-testid="derived-diameter">
          = <b>{px1(d.px)} px</b> at {d.umPerPx!.toPrecision(3)} µm per pixel
        </span>
      );
    if (d.overridesUm)
      return <span>The diameter in pixels (Advanced) is set and is used instead.</span>;
    return (
      <span data-testid="derived-diameter">
        Not set: the run uses {px1(d.px ?? 0)} px. Give the microscope below to set it in µm.
      </span>
    );
  };

  const extras = (f: ParamField): ParamFieldExtras | undefined => {
    switch (f.pointer) {
      case '/lookback/enabled':
        return {
          testid: 'lookback-toggle',
          disabled: blocked(),
          note: (
            <Show when={s().lookback() ? blocked() : null}>
              {(why) => (
                <span data-testid="lookback-note">
                  Look-back off: {why()} Footprints get no refinement after Discover.
                </span>
              )}
            </Show>
          ),
        };
      case '/settle/final/level':
        return {
          testid: 'final-settle-level',
          disabled: lookbackOn() ? null : 'Needs Look-back.',
          note: (
            <Show when={pending()}>
              <span data-testid="final-settle-pending" title={applies()}>
                this run: {FINAL_SETTLE_LEVELS[s().runFinalSettleLevel() as FinalSettleLevel].label}
                {props.context === 'separate' ? ', next session: ' : ', next start: '}
                {FINAL_SETTLE_LEVELS[s().finalSettleLevel()].label}
              </span>
            </Show>
          ),
        };
      case '/stages/extract':
        return {
          testid: 'extract-after-discover',
          disabled: props.sessionRun
            ? 'A run always Extracts each session once its Discover is done, and writes the results.'
            : null,
        };
      case '/stages/find_new_cells':
        return {
          testid: 'run-more-settings',
          disabled: props.extractRunning === true ? 'Extract is running.' : null,
        };
      case DIAMETER_UM:
        return { testid: 'expected-cell-diameter', note: diameterNote() };
      case DIAMETER_PX: {
        const d = plan();
        return {
          testid: 'cell-diameter-px',
          note:
            d.source === 'optics' && d.px !== null ? (
              <span>Empty: {px1(d.px)} px from the µm diameter.</span>
            ) : undefined,
        };
      }
      default:
        return undefined;
    }
  };

  const form = (level: 'main' | 'advanced', testid: string) => (
    <ParamForm
      schema={PARAMS_SCHEMA}
      level={level}
      value={value}
      source={(ptr) => params().source(ptr)}
      onChange={(ptr, v) => params().set(ptr, v)}
      onReset={(ptr) => params().reset(ptr)}
      include={(f) => sheetShows(f, lookbackOn())}
      groupTitles={GROUP_TITLES}
      groupOrder={GROUP_ORDER}
      extras={extras}
      testid={testid}
    />
  );

  return (
    <div class="cala-sheet__fields">
      {form('main', 'params-main')}
      <details class="cala-sheet__advanced" data-testid="params-advanced">
        <summary>Advanced</summary>
        {form('advanced', 'params-advanced-form')}
      </details>
    </div>
  );
}

/** Load config / Save config, the loaded file, and what Load found in it. */
function ConfigBar(props: { pipeline: PipelineStore }): JSX.Element {
  const params = () => props.pipeline.params;
  const [refusal, setRefusal] = createSignal<ConfigRefusal | null>(null);
  let input: HTMLInputElement | undefined;
  const load = async (file: File) => {
    const r = readConfig(await file.text(), file.name);
    if (isRefusal(r)) {
      setRefusal({ ...r, message: `${file.name}: ${r.message}` });
      return;
    }
    setRefusal(null);
    params().load(r);
  };
  const save = () => {
    const blob = new Blob([params().saveText()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'cala-config.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 0);
  };
  const count = () => Object.keys(params().sources()).length;
  /** The loaded file's values that the app's own settings replace at each start. */
  const appSet = () => {
    const f = params().file();
    if (!f) return [];
    return [...layerEntries(PARAMS_SCHEMA, f.layer).keys()]
      .filter((ptr) => SET_AT_START[ptr])
      .map((ptr) => ({ ptr, why: SET_AT_START[ptr] }));
  };
  return (
    <div class="cala-sheet__config" data-testid="config-bar">
      <div class="cala-sheet__config-row">
        <button
          type="button"
          class="btn-secondary btn-small"
          data-testid="config-load"
          title="Load settings from a config file (calab-config JSON)."
          onClick={() => input?.click()}
        >
          Load config…
        </button>
        <input
          ref={input}
          type="file"
          accept=".json,application/json"
          hidden
          data-testid="config-load-input"
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            if (f) void load(f);
          }}
        />
        <button
          type="button"
          class="btn-secondary btn-small"
          data-testid="config-save"
          title="Save the values set here (not the defaults) as a config file."
          onClick={save}
        >
          Save config…
        </button>
        <Show when={params().file()}>
          {(f) => (
            <span class="cala-sheet__config-file" data-testid="config-file">
              {f().name}
              <button
                type="button"
                class="cala-sheet__config-clear"
                title="Back to the defaults: forget the file and every value set here."
                onClick={() => {
                  setRefusal(null);
                  params().clear();
                }}
              >
                Clear
              </button>
            </span>
          )}
        </Show>
        <span class="cala-sheet__config-count" data-testid="config-count">
          {count() === 0 ? 'All defaults' : `${count()} set`}
        </span>
      </div>
      <Show when={appSet().length > 0}>
        <ul class="cala-sheet__config-warn" data-testid="config-app-set" role="status">
          <For each={appSet()}>
            {(a) => (
              <li>
                <Icon name="warning" size={12} /> <code>{a.ptr}</code> is set by {a.why} at each
                start; the file's value is not used.
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={params().unknown().length > 0}>
        <ul class="cala-sheet__config-warn" data-testid="config-warnings" role="status">
          <For each={params().unknown()}>
            {(u) => (
              <li>
                <Icon name="warning" size={12} /> <code>{u.pointer}</code> is not a setting
                {u.suggestion ? (
                  <>
                    {' '}
                    (did you mean <code>{u.suggestion}</code>?)
                  </>
                ) : null}
                ; kept in the file, not used.
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={refusal()}>
        {(r) => (
          <div class="cala-sheet__config-error" data-testid="config-error" role="alert">
            <Icon name="cross" size={12} /> {r().message}
            <For each={r().errors}>
              {(e) => (
                <div>
                  <code>{e.pointer}</code> {e.message}
                </div>
              )}
            </For>
          </div>
        )}
      </Show>
    </div>
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

/** Before the first run: config files, the settings, the slots for further pre-run choices, and Run. */
export function PreRunSheet(
  props: RunSettingsProps & { onRun: () => void; children?: JSX.Element },
): JSX.Element {
  const issues = () => props.pipeline.params.diameter(props.frameWidth).issues;
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
          <p class="cala-sheet__lede">Settings are read when Discover starts.</p>
        </div>
        <button
          type="button"
          class="btn-primary cala-sheet__run"
          data-testid="run-start"
          disabled={issues().length > 0}
          title={issues()[0]?.message}
          onClick={() => props.onRun()}
        >
          <Icon name="play" size={14} /> Run
        </button>
      </div>
      <ConfigBar pipeline={props.pipeline} />
      <RunSettingsFields {...props} />
      <SheetSlot id="repeatable" title="Repeatable runs" />
      <SheetSlot id="seed" title="Start from footprints of a past run" />
      <SheetSlot id="crop" title="Crop region" />
      {props.children}
    </section>
  );
}

/** The fields the summary line names with chips of its own. */
const SUMMARY_OWN = new Set([
  '/lookback/enabled',
  '/settle/final/level',
  '/stages/extract',
  '/stages/find_new_cells',
]);

/**
 * After Run: the settings the run started with as chips (one per further value it asked for),
 * and a disclosure with the fields. Start-time settings apply on Restart (in a Separate session
 * run, from the next session).
 */
export function SettingsSummary(props: RunSettingsProps): JSX.Element {
  const s = () => props.pipeline;
  const lookbackOn = () => s().lookbackRun();
  const level = () =>
    FINAL_SETTLE_LEVELS[s().runFinalSettleLevel() as FinalSettleLevel]?.label ?? '';
  const appliesOn = () =>
    props.context === 'separate' ? 'applies from the next session' : 'applies on Restart';
  const fields = new Map(schemaFields(PARAMS_SCHEMA).map((f) => [f.pointer, f]));
  const asked = () => {
    const r = s().runRequest();
    if (!r) return [];
    return Object.keys(r.sources)
      .filter((ptr) => !SUMMARY_OWN.has(ptr) && fields.has(ptr))
      .map((ptr) => {
        const f = fields.get(ptr)!;
        const src = r.sources[ptr];
        return {
          text: `${f.title} ${formatParam(f, getAt(r.requested, ptr))}`,
          title: src.startsWith('file:') ? `From ${src.slice(5)}` : 'Set in the sheet',
        };
      });
  };
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
        <For each={asked()}>
          {(c) => (
            <span title={c.title}>
              <Badge tone="neutral" testid="settings-chip-param">
                {c.text}
              </Badge>
            </span>
          )}
        </For>
        <span class="cala-run__summary-applies">{appliesOn()}</span>
      </summary>
      <div class="cala-run__summary-body">
        <ConfigBar pipeline={props.pipeline} />
        <RunSettingsFields {...props} />
      </div>
    </details>
  );
}
