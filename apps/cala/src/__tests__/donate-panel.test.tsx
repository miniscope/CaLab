import { describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { DonationFormView } from '../components/DonatePanel.tsx';
import type { DonationUiStore } from '../lib/donation-store.ts';
import type { FrameSourceInfo } from '../lib/frame-source.ts';

// uPlot (pulled in through @calab/ui) needs a real browser (matchMedia).
vi.mock('uplot', () => ({ default: class {} }));
vi.mock('@dschz/solid-uplot', () => ({ SolidUplot: () => null }));

const info = {
  width: 64,
  height: 48,
  frameCount: 30,
  bitDepth: 8,
  fps: 20,
  fpsSource: 'metadata',
  files: [],
} as unknown as FrameSourceInfo;

const donation = {
  active: () => false,
  start: vi.fn(),
} as unknown as DonationUiStore;

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const dispose = render(
    () => (
      <DonationFormView
        info={info}
        source={{ entries: [] }}
        label="rec"
        version="test"
        donation={donation}
        onClose={() => {}}
      />
    ),
    host,
  );
  return { host, dispose };
}

describe('Donate form', () => {
  it('offers both sharing choices with neither preselected, and blocks submit', () => {
    const { host, dispose } = mount();
    const radios = host.querySelectorAll<HTMLInputElement>('input[name="donate-sharing"]');
    expect([...radios].map((r) => r.value)).toEqual(['public', 'lab']);
    expect([...radios].some((r) => r.checked)).toBe(false);
    const submit = host.querySelector<HTMLButtonElement>('[data-testid="donate-submit"]')!;
    expect(submit.disabled).toBe(true);
    expect(host.textContent).toContain('a choice: public on DANDI or CaLab only');
    dispose();
  });

  it('shows the text of the chosen option', () => {
    const { host, dispose } = mount();
    const lab = host.querySelector<HTMLInputElement>('input[value="lab"]')!;
    lab.click();
    expect(host.querySelector('[data-testid="donate-sharing-text"]')!.textContent).toMatch(
      /^Only the CaLab team uses your recording/,
    );
    dispose();
  });

  it('no longer mentions co-authorship', () => {
    const { host, dispose } = mount();
    expect(host.textContent?.toLowerCase()).not.toContain('co-authorship');
    dispose();
  });

  it('offers presets in dropdowns for every descriptive field, with Other…', () => {
    const { host, dispose } = mount();
    const select = (label: string) =>
      host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    for (const label of [
      'Indicator',
      'Species',
      'Brain region',
      'Expression',
      'Preparation',
      'Behavior',
      'Strain / genotype',
      'Scope',
    ]) {
      const s = select(label);
      expect(s, label).not.toBeNull();
      // "choose", at least one preset, "Other…"
      expect(s.options.length, label).toBeGreaterThan(2);
      expect(s.options[s.options.length - 1].textContent, label).toBe('Other…');
    }
    expect([...select('Scope').options].map((o) => o.value)).toContain('UCLA Miniscope v4');
    expect([...select('Species').options].map((o) => o.value)).toContain('mouse');
    dispose();
  });

  it('a preset fills the field; Other… opens a text box for a custom value', () => {
    const { host, dispose } = mount();
    const scope = host.querySelector<HTMLSelectElement>('select[aria-label="Scope"]')!;
    scope.value = 'UCLA Miniscope v4';
    scope.dispatchEvent(new Event('change'));
    expect(host.textContent).not.toContain('Still needed: indicator, species, brain region, scope');
    expect(host.querySelector('input[aria-label="Scope (other)"]')).toBeNull();

    scope.value = '__other__';
    scope.dispatchEvent(new Event('change'));
    const custom = host.querySelector<HTMLInputElement>('input[aria-label="Scope (other)"]')!;
    expect(custom).not.toBeNull();
    custom.value = 'my own scope';
    custom.dispatchEvent(new Event('input'));
    expect(scope.value).toBe('__other__');
    expect(custom.value).toBe('my own scope');
    dispose();
  });
});
