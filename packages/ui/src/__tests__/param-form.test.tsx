import { describe, it, expect, afterEach, vi } from 'vitest';
import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { getAt, setAt, type ParamSchema } from '@calab/core';
import { ParamForm, formatParam } from '../ParamForm.tsx';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
});

function mount(fn: () => import('solid-js').JSX.Element): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  dispose = render(fn, host);
  return host;
}

const SCHEMA: ParamSchema = {
  type: 'object',
  properties: {
    scales: { $ref: '#/$defs/Scales', title: 'Scales', default: {} },
    stages: { $ref: '#/$defs/Stages', title: 'Stages', default: {} },
  },
  $defs: {
    Scales: {
      type: 'object',
      properties: {
        diameter_um: {
          type: ['number', 'null'],
          title: 'Expected cell diameter',
          description: 'At the sample.',
          minimum: 1,
          maximum: 200,
          default: null,
          'x-unit': 'um',
          'x-level': 'main',
        },
        diameter_px: {
          type: ['number', 'null'],
          title: 'Diameter in pixels',
          minimum: 4,
          maximum: 64,
          default: 10,
          'x-unit': 'px',
          'x-level': 'advanced',
        },
        hidden: { type: 'number', title: 'Hidden', default: 1, 'x-level': 'internal' },
      },
    },
    Stages: {
      type: 'object',
      properties: {
        find: { type: 'boolean', title: 'Find new cells', default: true, 'x-level': 'main' },
        level: { $ref: '#/$defs/Level', title: 'Level', default: 'a', 'x-level': 'main' },
      },
    },
    Level: {
      oneOf: [
        { type: 'string', const: 'a', title: 'A' },
        { type: 'string', const: 'b', title: 'B' },
      ],
    },
  },
};

const DEFAULTS = {
  scales: { diameter_um: null, diameter_px: 10, hidden: 1 },
  stages: { find: true, level: 'a' },
};

/** A form over one layer of edits, as an app wires it. */
function harness(level: 'main' | 'advanced') {
  const [layer, setLayer] = createSignal<Record<string, unknown>>({});
  const onChange = vi.fn((ptr: string, v: unknown) => setLayer((l) => setAt(l, ptr, v)));
  const host = mount(() => (
    <ParamForm
      schema={SCHEMA}
      level={level}
      value={(ptr) => {
        const v = getAt(layer(), ptr);
        return v !== undefined ? v : getAt(DEFAULTS, ptr);
      }}
      source={(ptr) => (getAt(layer(), ptr) !== undefined ? 'ui' : 'default')}
      onChange={onChange}
      onReset={(ptr) => setLayer({ ...layer(), [ptr.split('/')[1]]: {} })}
      extras={(f) => (f.pointer === '/stages/find' ? { testid: 'find-toggle' } : undefined)}
      testid="form"
    />
  ));
  return { host, onChange, layer };
}

const input = (host: HTMLElement, ptr: string) =>
  host.querySelector<HTMLInputElement>(`[data-pointer="${ptr}"] input`)!;

function type(el: HTMLInputElement, text: string) {
  el.value = text;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('ParamForm', () => {
  it('renders the fields of its level grouped by block, never internal ones', () => {
    const { host } = harness('main');
    const legends = [...host.querySelectorAll('legend')].map((l) => l.textContent);
    expect(legends).toEqual(['Scales', 'Stages']);
    const ptrs = [...host.querySelectorAll('[data-pointer]')].map((e) =>
      e.getAttribute('data-pointer'),
    );
    expect(ptrs).toEqual(['/scales/diameter_um', '/stages/find', '/stages/level']);
    expect(host.textContent).toContain('µm');
    expect(host.querySelector('[data-testid="find-toggle"]')).not.toBeNull();
    expect(host.querySelector('[role="radiogroup"]')).not.toBeNull();
  });

  it('commits a valid number, refuses one out of range and accepts empty as null', () => {
    const { host, onChange } = harness('advanced');
    const px = input(host, '/scales/diameter_px');
    expect(px.value).toBe('10');
    type(px, '16');
    expect(onChange).toHaveBeenLastCalledWith('/scales/diameter_px', 16);
    type(px, '80');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Must be at most 64 px.');
    type(px, '');
    expect(onChange).toHaveBeenLastCalledWith('/scales/diameter_px', null);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows where a changed value comes from, and a reset', () => {
    const { host } = harness('main');
    expect(host.querySelector('.param-form__source')).toBeNull();
    type(input(host, '/scales/diameter_um'), '20');
    const badge = host.querySelector('[data-testid="param-source-scales-diameter_um"]');
    expect(badge?.textContent).toBe('set');
    host.querySelector<HTMLButtonElement>('.param-form__reset')!.click();
    expect(host.querySelector('.param-form__source')).toBeNull();
    expect(input(host, '/scales/diameter_um').value).toBe('');
  });

  it('sets booleans and choices', () => {
    const { host, onChange } = harness('main');
    host.querySelector<HTMLInputElement>('[data-testid="find-toggle"]')!.click();
    expect(onChange).toHaveBeenLastCalledWith('/stages/find', false);
    host.querySelectorAll<HTMLButtonElement>('[role="radio"]')[1].click();
    expect(onChange).toHaveBeenLastCalledWith('/stages/level', 'b');
  });

  it('formats a value with its unit or choice label', () => {
    const f = {
      pointer: '/x',
      block: 'x',
      title: 'X',
      description: '',
      kind: 'number' as const,
      nullable: false,
      default: 1,
      unit: 'um',
      level: 'main' as const,
      refinedByData: false,
    };
    expect(formatParam(f, 12)).toBe('12 µm');
    expect(formatParam(f, null)).toBe('—');
    expect(formatParam({ ...f, kind: 'enum', choices: [{ value: 'a', label: 'A' }] }, 'a')).toBe(
      'A',
    );
  });
});
