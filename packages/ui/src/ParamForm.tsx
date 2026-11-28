import { createMemo, createSignal, For, Show, type JSX } from 'solid-js';
import {
  blockTitle,
  checkField,
  schemaFields,
  type ParamField,
  type ParamLevel,
  type ParamSchema,
} from '@calab/core';
import { HelpTip } from './HelpTip.tsx';
import { SegmentedControl } from './SegmentedControl.tsx';

/** Where a field's value comes from: `default`, `ui` (edited here) or `file:<name>`. */
export type ParamSourceTag = string;

/** What the app adds to one field: a test id, a reason it cannot change, a line under it. */
export interface ParamFieldExtras {
  testid?: string;
  /** Why the field cannot be changed now (null or absent: it can). Shown as its tooltip. */
  disabled?: string | null;
  /** A line under the field (a derived value, a consequence). */
  note?: JSX.Element;
}

export interface ParamFormProps {
  schema: ParamSchema;
  /** The level rendered: `main` (the sheet) or `advanced` (its Advanced section). */
  level: ParamLevel;
  /** The value in force at a pointer (the schema default when nothing sets it). */
  value: (pointer: string) => unknown;
  /** Where the value at a pointer comes from (absent or `default`: no badge). */
  source?: (pointer: string) => ParamSourceTag;
  /** A valid new value (null for a nullable field left empty). */
  onChange: (pointer: string, value: unknown) => void;
  /** Back to the default (absent: no reset). */
  onReset?: (pointer: string) => void;
  /** Which fields of the level are shown (absent: all with a built-in widget). */
  include?: (field: ParamField) => boolean;
  /** Titles of the blocks, over the schema's (`{ optics: 'Microscope' }`). */
  groupTitles?: Record<string, string>;
  /** Block order (absent: schema order); blocks not listed follow in schema order. */
  groupOrder?: string[];
  extras?: (field: ParamField) => ParamFieldExtras | undefined;
  /** Widgets the app provides, by pointer or by `x-widget` name. */
  widgets?: Record<string, (field: ParamField) => JSX.Element>;
  testid?: string;
}

/** Unit suffixes as shown beside a number. */
const UNIT_TEXT: Record<string, string> = {
  um: 'µm',
  px: 'px',
  s: 's',
  Hz: 'Hz',
  frames: 'frames',
  MB: 'MB',
  sigma: 'σ',
  d: '× d',
  ratio: '',
  count: '',
  none: '',
  r: '',
  visits_per_frame: 'visits / frame',
  cells: 'cells',
};

/** The unit shown beside a value, '' for a plain number. */
export function unitText(unit: string): string {
  return UNIT_TEXT[unit] ?? unit;
}

/** A field's value as short text (a chip, a summary): `16 px`, `Thorough`, `on`. */
export function formatParam(field: ParamField, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (field.choices) {
    const c = field.choices.find((x) => x.value === value);
    if (c) return c.label;
  }
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'number') {
    const u = unitText(field.unit);
    return u ? `${value} ${u}` : String(value);
  }
  return JSON.stringify(value);
}

/** The range of a number field as text (`4–64 px`), '' when it has none. */
function rangeText(f: ParamField): string {
  const u = unitText(f.unit);
  const suffix = u ? ` ${u}` : '';
  if (f.minimum !== undefined && f.maximum !== undefined)
    return `${f.minimum}–${f.maximum}${suffix}`;
  if (f.minimum !== undefined) return `≥ ${f.minimum}${suffix}`;
  if (f.maximum !== undefined) return `≤ ${f.maximum}${suffix}`;
  return '';
}

/** A short label of a source tag: `file`, `set`. */
function sourceLabel(tag: ParamSourceTag): string {
  if (tag.startsWith('file:')) return 'file';
  if (tag === 'ui') return 'set';
  return tag;
}

function sourceTitle(tag: ParamSourceTag): string {
  if (tag.startsWith('file:')) return `From the config file ${tag.slice(5)}`;
  if (tag === 'ui') return 'Set here';
  return tag;
}

/**
 * A form rendered from a params schema: the fields of one level, grouped by block, each with
 * the widget its type asks for (checkbox, segmented choice or select, number with its unit and
 * range). A typed value is checked against the schema before `onChange`; an invalid one stays in
 * the field with its message. Each field that does not hold its default shows where its value
 * comes from, and a reset.
 */
export function ParamForm(p: ParamFormProps): JSX.Element {
  const all = createMemo(() => schemaFields(p.schema));
  const shown = createMemo(() =>
    all().filter((f) => {
      if (f.level !== p.level) return false;
      if (p.include) return p.include(f);
      return f.kind !== 'other' && !f.widget;
    }),
  );
  const groups = createMemo(() => {
    const order: string[] = [];
    const by = new Map<string, ParamField[]>();
    for (const f of shown()) {
      if (!by.has(f.block)) {
        by.set(f.block, []);
        order.push(f.block);
      }
      by.get(f.block)!.push(f);
    }
    const ranked = p.groupOrder ?? [];
    const rank = (b: string) => {
      const i = ranked.indexOf(b);
      return i < 0 ? ranked.length + order.indexOf(b) : i;
    };
    return [...order]
      .sort((a, b) => rank(a) - rank(b))
      .map((b) => ({ block: b, fields: by.get(b)! }));
  });
  return (
    <div class="param-form" data-testid={p.testid} data-level={p.level}>
      <For each={groups()}>
        {(g) => (
          <fieldset class="param-form__group" data-block={g.block}>
            <legend class="param-form__legend">
              {p.groupTitles?.[g.block] ?? blockTitle(p.schema, g.block)}
            </legend>
            <For each={g.fields}>{(f) => <FieldRow form={p} field={f} />}</For>
          </fieldset>
        )}
      </For>
    </div>
  );
}

function FieldRow(props: { form: ParamFormProps; field: ParamField }): JSX.Element {
  const f = props.field;
  const p = props.form;
  const extras = () => p.extras?.(f);
  const source = () => p.source?.(f.pointer) ?? 'default';
  const custom = p.widgets?.[f.pointer] ?? (f.widget ? p.widgets?.[f.widget] : undefined);
  const id = `param-${f.pointer.slice(1).replace(/\//g, '-')}`;
  const help = () =>
    [
      f.description,
      rangeText(f) ? `Range ${rangeText(f)}.` : '',
      f.refinedByData ? 'A starting value: the run may refine it from the data.' : '',
    ]
      .filter(Boolean)
      .join(' ');
  return (
    <div
      class="param-form__field"
      classList={{ 'param-form__field--off': !!extras()?.disabled }}
      data-pointer={f.pointer}
      data-source={source()}
      title={extras()?.disabled ?? undefined}
    >
      <div class="param-form__row">
        <Show
          when={custom}
          fallback={
            <Show
              when={f.kind === 'boolean'}
              fallback={
                <>
                  <label class="param-form__label" for={id}>
                    {f.title}
                  </label>
                  <Show when={f.kind === 'enum'} fallback={<NumberInput {...props} id={id} />}>
                    <EnumInput {...props} id={id} />
                  </Show>
                </>
              }
            >
              <label class="param-form__check">
                <input
                  id={id}
                  type="checkbox"
                  data-testid={extras()?.testid}
                  disabled={!!extras()?.disabled}
                  checked={p.value(f.pointer) === true}
                  onChange={(e) => p.onChange(f.pointer, e.currentTarget.checked)}
                />
                {f.title}
              </label>
            </Show>
          }
        >
          {custom!(f)}
        </Show>
        <span class="param-form__aside">
          <Show when={source() !== 'default'}>
            <span
              class="param-form__source"
              data-testid={`param-source-${f.pointer.slice(1).replace(/\//g, '-')}`}
              title={sourceTitle(source())}
            >
              {sourceLabel(source())}
            </span>
            <Show when={p.onReset}>
              <button
                type="button"
                class="param-form__reset"
                aria-label={`Reset ${f.title} to its default`}
                title={`Reset to the default (${formatParam(f, f.default)})`}
                onClick={() => p.onReset!(f.pointer)}
              >
                ↺
              </button>
            </Show>
          </Show>
          <Show when={help()}>
            <span class="param-form__help">
              <HelpTip label={`About ${f.title}`} popClass="param-form__pop">
                {help()}
              </HelpTip>
            </span>
          </Show>
        </span>
      </div>
      <Show when={extras()?.note}>
        <div class="param-form__note">{extras()!.note}</div>
      </Show>
    </div>
  );
}

function EnumInput(props: { form: ParamFormProps; field: ParamField; id: string }): JSX.Element {
  const f = props.field;
  const p = props.form;
  const extras = () => p.extras?.(f);
  const choices = f.choices ?? [];
  const key = (v: unknown) => JSON.stringify(v);
  const byKey = new Map(choices.map((c) => [key(c.value), c.value]));
  return (
    <Show
      when={choices.length <= 4 && !extras()?.disabled}
      fallback={
        <select
          id={props.id}
          class="param-form__select"
          data-testid={extras()?.testid}
          disabled={!!extras()?.disabled}
          value={key(p.value(f.pointer))}
          onChange={(e) => p.onChange(f.pointer, byKey.get(e.currentTarget.value))}
        >
          <For each={choices}>
            {(c) => (
              <option value={key(c.value)} title={c.description}>
                {c.label}
              </option>
            )}
          </For>
        </select>
      }
    >
      <SegmentedControl
        size="sm"
        aria-label={f.title}
        testid={extras()?.testid}
        value={key(p.value(f.pointer))}
        options={choices.map((c) => ({
          value: key(c.value),
          label: c.label,
          ...(c.description ? { title: c.description } : {}),
        }))}
        onChange={(v) => p.onChange(f.pointer, byKey.get(v))}
      />
    </Show>
  );
}

function NumberInput(props: { form: ParamFormProps; field: ParamField; id: string }): JSX.Element {
  const f = props.field;
  const p = props.form;
  const extras = () => p.extras?.(f);
  const shown = () => {
    const v = p.value(f.pointer);
    return typeof v === 'number' ? String(v) : '';
  };
  const [error, setError] = createSignal<string | null>(null);
  const commit = (text: string) => {
    const t = text.trim();
    if (t === '') {
      if (f.nullable) {
        setError(null);
        p.onChange(f.pointer, null);
      } else setError('A value is needed.');
      return;
    }
    const n = Number(t);
    if (!Number.isFinite(n)) {
      setError('Not a number.');
      return;
    }
    if (f.kind === 'integer' && !Number.isInteger(n)) {
      setError('A whole number is needed.');
      return;
    }
    const issues = checkField(p.schema, f.pointer, n);
    if (issues.length > 0) {
      setError(
        `${issues[0].message.replace(/^must/, 'Must')}${unitText(f.unit) ? ` ${unitText(f.unit)}` : ''}.`,
      );
      return;
    }
    setError(null);
    p.onChange(f.pointer, n);
  };
  const u = unitText(f.unit);
  return (
    <span class="param-form__number">
      <input
        id={props.id}
        type="text"
        inputmode="decimal"
        class="param-form__input"
        classList={{ 'param-form__input--invalid': error() !== null }}
        aria-invalid={error() !== null}
        data-testid={extras()?.testid}
        disabled={!!extras()?.disabled}
        placeholder={f.nullable ? (f.derived ? 'auto' : '—') : ''}
        value={shown()}
        onChange={(e) => commit(e.currentTarget.value)}
      />
      <Show when={u}>
        <span class="param-form__unit">{u}</span>
      </Show>
      <Show when={error()}>
        <span class="param-form__error" role="alert">
          {error()}
        </span>
      </Show>
    </span>
  );
}
