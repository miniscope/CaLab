import { describe, expect, it } from 'vitest';
import {
  ageToIso,
  emptyForm,
  missingFields,
  SHARING_TEXT,
  todayIso,
  type DonationForm,
} from '../lib/donation-form.ts';

const TODAY = new Date('2026-11-23T12:00:00Z');

function filled(over: Partial<DonationForm> = {}): DonationForm {
  return {
    ...emptyForm(20),
    indicator: 'GCaMP8m',
    species: 'mouse',
    brain_region: 'M1',
    scope: 'UCLA v4',
    credit_name: 'Jane Doe',
    credit_lab: 'Doe Lab',
    rights_attested: true,
    protocol_attested: true,
    sharing: 'public',
    subject_id: 'm7',
    subject_sex: 'F',
    age_value: '90',
    age_unit: 'D',
    session_date: '2026-11-20',
    ...over,
  };
}

describe('donation form', () => {
  it('starts with no sharing choice and the known frame rate', () => {
    const f = emptyForm(20);
    expect(f.sharing).toBeNull();
    expect(f.fps).toBe('20');
    expect(emptyForm(null).fps).toBe('');
  });

  it('writes ISO 8601 ages', () => {
    expect(ageToIso('90', 'D')).toBe('P90D');
    expect(ageToIso(' 12 ', 'W')).toBe('P12W');
    expect(ageToIso('3', 'M')).toBe('P3M');
    expect(ageToIso('1', 'Y')).toBe('P1Y');
    for (const bad of ['', '0', '-3', '2.5', 'abc', '100000']) {
      expect(ageToIso(bad, 'D')).toBeNull();
    }
  });

  it('a complete form needs nothing', () => {
    expect(missingFields(filled(), TODAY)).toEqual([]);
  });

  it('needs a sharing choice', () => {
    expect(missingFields(filled({ sharing: null }), TODAY)).toContain(
      'a choice: public on DANDI or CaLab only',
    );
  });

  it('checks the subject fields', () => {
    expect(missingFields(filled({ subject_id: '' }), TODAY)).toContain(
      'animal ID (letters, digits, dashes)',
    );
    expect(missingFields(filled({ subject_id: 'mouse 7' }), TODAY)).toContain(
      'animal ID (letters, digits, dashes)',
    );
    expect(missingFields(filled({ subject_sex: '' }), TODAY)).toContain('sex');
    expect(missingFields(filled({ age_value: '' }), TODAY)).toContain('age');
    expect(missingFields(filled({ session_date: '' }), TODAY)).toContain('recording date');
    expect(missingFields(filled({ session_date: '2026-11-25' }), TODAY)).toContain(
      'recording date',
    );
    expect(missingFields(filled({ session_date: '1989-01-01' }), TODAY)).toContain(
      'recording date',
    );
  });

  it('accepts today as the recording date', () => {
    expect(missingFields(filled({ session_date: todayIso(TODAY) }), TODAY)).toEqual([]);
  });

  it('keeps the existing checks', () => {
    expect(missingFields(filled({ indicator: ' ' }), TODAY)).toContain('indicator');
    expect(missingFields(filled({ fps: '0' }), TODAY)).toContain('frame rate');
    expect(missingFields(filled({ depth_um: '20000' }), TODAY)).toContain(
      'a depth of 0 to 10000 um',
    );
    expect(missingFields(filled({ credit_lab: '' }), TODAY)).toContain('your lab (for credit)');
    expect(missingFields(filled({ protocol_attested: false }), TODAY)).toContain(
      'both confirmations',
    );
  });

  it('has the agreed sharing texts', () => {
    expect(SHARING_TEXT.public.text).toMatch(/^After review, your recording is published/);
    expect(SHARING_TEXT.public.text).toMatch(/published versions are permanent\.$/);
    expect(SHARING_TEXT.lab.text).toMatch(/^Only the CaLab team uses your recording/);
    expect(SHARING_TEXT.lab.text).toMatch(/or ask us to make it public later\.$/);
  });
});
