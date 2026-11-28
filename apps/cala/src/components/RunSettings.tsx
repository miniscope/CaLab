/**
 * The run's settings. The setup page (`SetupSettings`) edits them before Run: the params' main
 * fields and an Advanced section rendered from the schema, and config files. The Run tab shows
 * what the run started with, read-only (`SettingsSummary`): one line of chips that opens to each
 * value asked for and where it came from.
 */
import { createSignal, For, Show, type JSX } from 'solid-js';
import { Badge, formatParam, Icon, ParamForm, type ParamFieldExtras } from '@calab/ui';
import { getAt, layerEntries, schemaFields, type ParamField } from '@calab/core';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import { FINAL_SETTLE_LEVELS, type FinalSettleLevel } from '../lib/settle.ts';
import { appliesText, type SettingsContext } from './DiscoverSettings.tsx';
import {
  isRefusal,
  PARAMS_SCHEMA,
  readConfigFile,
  type ConfigRefusal,
} from '../lib/config-file.ts';
import type { ParamsLayer } from '../lib/run-params.ts';
import { SET_AT_START, sheetShows } from '../lib/sheet-fields.ts';

export interface RunSettingsProps {
  pipeline: PipelineStore;
  context: SettingsContext;
  /** Extract is running: Find new cells cannot change under it. */
  extractRunning?: boolean;
  /** Width of the recording's frames, px (0: none open); the optics' binning may follow it. */
  frameWidth: number;
  /** Saving the sheet's values into the open project (absent: no project). */
  projectParams?: ProjectParams;
}

/** Saving the sheet's values into the project file (`docs/projects.md`, "Settings layers"). */
export interface ProjectParams {
  /** The values can be saved (a project is open and can be changed). */
  canSave: () => boolean;
  /** The session "This session only" saves to (null: the run has several streams). */
  session: () => string | null;
  /** Save `layer` as project defaults, or as the session's own values. */
  save: (scope: 'project' | 'stream', layer: ParamsLayer) => Promise<boolean>;
}

const GROUP_TITLES = { scales: 'Cell size', optics: 'Microscope', stages: 'Stages' };
const GROUP_ORDER = ['scales', 'optics', 'lookback', 'settle', 'stages'];
const DIAMETER_PX = '/scales/cell_diameter_px';
const DIAMETER_UM = '/scales/expected_cell_diameter_um';

const px1 = (v: number): string => (Math.round(v * 10) / 10).toString();

/** The setting fields of the setup page. */
export function RunSettingsFields(props: RunSettingsProps): JSX.Element {
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
          note: (
            <Show when={!s().params.value('/stages/extract')}>
              <span data-testid="discover-only-note">
                Discover only: the run writes the footprints with the traces Discover solved as it
                read, and no Extract.
              </span>
            </Show>
          ),
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

/**
 * Load config / Save config, the loaded file, and what Load found in it; with a project, Save as
 * project defaults (or for this session only).
 */
export function ConfigBar(props: {
  pipeline: PipelineStore;
  projectParams?: ProjectParams;
}): JSX.Element {
  const params = () => props.pipeline.params;
  const [refusal, setRefusal] = createSignal<ConfigRefusal | null>(null);
  /** The run file or export loaded last, to load again with or without the data's values. */
  const [lastFile, setLastFile] = createSignal<File | null>(null);
  const [pin, setPin] = createSignal(false);
  const [sessionOnly, setSessionOnly] = createSignal(false);
  let input: HTMLInputElement | undefined;
  const load = async (file: File, pinDerived = false) => {
    const r = await readConfigFile(file, { pinDerived });
    if (isRefusal(r)) {
      setRefusal({ ...r, message: `${file.name}: ${r.message}` });
      return;
    }
    setRefusal(null);
    setLastFile(r.derived ? file : null);
    setPin(pinDerived);
    params().load(r);
  };
  const edits = () => Object.keys(params().edits()).length;
  const pp = () => props.projectParams;
  const saveToProject = async () => {
    const p = pp();
    if (!p) return;
    const scope = sessionOnly() && p.session() !== null ? 'stream' : 'project';
    if (await p.save(scope, params().edits())) params().dropEdits();
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
          title="Load settings from a config file (calab-config JSON), a run file (calab-run.json) or a past export (.npz): what that run asked for."
          onClick={() => input?.click()}
        >
          Load config…
        </button>
        <input
          ref={input}
          type="file"
          accept=".json,.npz,application/json"
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
      <Show when={lastFile() && params().file()?.derived}>
        {(derived) => (
          <div class="cala-sheet__config-row">
            <label
              class="param-form__check"
              title="Off: the run measures these again from its own data. On: they are set to the values the loaded run measured (an exact repeat)."
            >
              <input
                type="checkbox"
                data-testid="config-pin-derived"
                checked={pin()}
                onChange={(e) => void load(lastFile()!, e.currentTarget.checked)}
              />
              Also pin what the data set ({Object.keys(derived()).join(', ')})
            </label>
          </div>
        )}
      </Show>
      <Show when={pp()?.canSave()}>
        <div class="cala-sheet__config-row">
          <button
            type="button"
            class="btn-secondary btn-small"
            data-testid="config-save-defaults"
            disabled={edits() === 0}
            title={
              sessionOnly()
                ? "Save the values set here (and the loaded file's) as this session's own: they apply to its runs only."
                : "Save the values set here (and the loaded file's) as the project's defaults: every run of the project starts from them."
            }
            onClick={() => void saveToProject()}
          >
            {sessionOnly() ? 'Save for this session' : 'Save as project defaults'}
          </button>
          <Show when={pp()!.session() !== null}>
            <label class="param-form__check">
              <input
                type="checkbox"
                data-testid="config-session-only"
                checked={sessionOnly()}
                onChange={(e) => setSessionOnly(e.currentTarget.checked)}
              />
              This session only
            </label>
          </Show>
        </div>
      </Show>
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

/** Where a requested value came from, for a chip's tooltip. */
export function sourceText(src: string): string {
  if (src.startsWith('file:')) return `From ${src.slice(5)}`;
  if (src === 'project') return "From the project's defaults";
  if (src === 'step') return 'From the plan step';
  if (src === 'stream') return "This session's own value";
  return 'Set on the setup page';
}

/** The fields the summary line names with chips of its own. */
const SUMMARY_OWN = new Set([
  '/lookback/enabled',
  '/settle/final/level',
  '/stages/extract',
  '/stages/find_new_cells',
]);

/**
 * The settings the run started with, read-only: chips on one line (one per further value it
 * asked for), opening to each asked-for value with its source. They are changed on the setup
 * page (`onChangeSettings`); only Find new cells applies to the running pipeline at once.
 */
export function SettingsSummary(
  props: RunSettingsProps & {
    /** Back to the setup page with these settings, to change them and run again. */
    onChangeSettings?: () => void;
  },
): JSX.Element {
  const s = () => props.pipeline;
  const lookbackOn = () => s().lookbackRun();
  const level = () =>
    FINAL_SETTLE_LEVELS[s().runFinalSettleLevel() as FinalSettleLevel]?.label ?? '';
  const fields = new Map(schemaFields(PARAMS_SCHEMA).map((f) => [f.pointer, f]));
  /** Every value the run asked for (not a default), with where it came from. */
  const asked = () => {
    const r = s().runRequest();
    if (!r) return [];
    return Object.keys(r.sources)
      .filter((ptr) => fields.has(ptr))
      .map((ptr) => {
        const f = fields.get(ptr)!;
        return {
          ptr,
          own: SUMMARY_OWN.has(ptr),
          title: f.title,
          value: formatParam(f, getAt(r.requested, ptr)),
          source: sourceText(r.sources[ptr]),
        };
      });
  };
  return (
    <details
      class="cala-run__section cala-run__summary"
      aria-label="Settings used"
      data-testid="run-settings"
    >
      <summary class="cala-run__summary-line" data-testid="settings-summary">
        <span class="cala-run__summary-name">Settings used</span>
        <Badge tone="neutral" testid="settings-chip-lookback">
          Look-back {lookbackOn() ? 'on' : 'off'}
        </Badge>
        <Show when={lookbackOn()}>
          <Badge tone="neutral">Final settle {level()}</Badge>
        </Show>
        <Badge tone="neutral" testid="settings-chip-extract">
          {s().extractRun() ? 'Extract after Discover' : 'Discover only'}
        </Badge>
        <Show when={!s().discover()}>
          <Badge tone="neutral">No new cells</Badge>
        </Show>
        <For each={asked().filter((a) => !a.own)}>
          {(c) => (
            <span title={c.source}>
              <Badge tone="neutral" testid="settings-chip-param">
                {c.title} {c.value}
              </Badge>
            </span>
          )}
        </For>
      </summary>
      <div class="cala-run__summary-body" data-testid="settings-used">
        <Show
          when={asked().length > 0}
          fallback={<p class="cala-muted">Every setting at its default.</p>}
        >
          <dl class="cala-run__used">
            <For each={asked()}>
              {(a) => (
                <div class="cala-run__used-row" data-testid="settings-used-row" data-ptr={a.ptr}>
                  <dt>{a.title}</dt>
                  <dd>
                    {a.value} <span class="cala-muted">({a.source})</span>
                  </dd>
                </div>
              )}
            </For>
          </dl>
        </Show>
        <div class="cala-run__footer">
          <label
            class="cala-check"
            title={
              props.extractRunning
                ? 'Extract is running.'
                : 'Applies to the running Discover at once: off, no new cells are added.'
            }
          >
            <input
              type="checkbox"
              data-testid="run-more-settings"
              disabled={props.extractRunning === true}
              checked={s().discover()}
              onChange={(e) => s().setDiscover(e.currentTarget.checked)}
            />
            Find new cells
          </label>
          <Show when={props.onChangeSettings}>
            <button
              type="button"
              class="btn-secondary btn-small"
              data-testid="change-settings"
              title="Back to the setup page with these settings, to change them and run again (a running run stops)"
              onClick={() => props.onChangeSettings?.()}
            >
              Change settings and run again
            </button>
          </Show>
        </div>
      </div>
    </details>
  );
}
