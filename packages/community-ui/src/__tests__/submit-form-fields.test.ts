import { describe, it, expect } from 'vitest';
import { createSignal } from 'solid-js';
import { createSubmitFormFields } from '../submit-form-fields.ts';

describe('createSubmitFormFields', () => {
  it('collects values and clears them', () => {
    const fields = createSubmitFormFields(() => false);
    fields.signals.indicator.set('GCaMP6f');
    fields.signals.notes.set('hello');

    const values = fields.values();
    expect(values.indicator).toBe('GCaMP6f');
    expect(values.notes).toBe('hello');
    expect(values.species).toBe('');
    expect(Object.keys(values)).toHaveLength(11);

    fields.clear();
    expect(fields.values().indicator).toBe('');
    expect(fields.values().notes).toBe('');
  });

  it('requires indicator, species and brain region unless the data is a demo', () => {
    const [demo, setDemo] = createSignal(false);
    const fields = createSubmitFormFields(demo);
    expect(fields.requiredFieldsFilled()).toBe(false);

    fields.signals.indicator.set('GCaMP6f');
    fields.signals.species.set('mouse');
    expect(fields.requiredFieldsFilled()).toBe(false);
    fields.signals.brainRegion.set('  ');
    expect(fields.requiredFieldsFilled()).toBe(false);
    fields.signals.brainRegion.set('cortex');
    expect(fields.requiredFieldsFilled()).toBe(true);

    fields.clear();
    setDemo(true);
    expect(fields.requiredFieldsFilled()).toBe(true);
  });
});
