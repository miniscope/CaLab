// The Donate form's fields and checks (apps/cala/docs/data-donation.md), kept
// out of the component so they can be tested without a DOM.
import type { DonationSharing, SubjectSex } from '@calab/community';

export type AgeUnit = 'D' | 'W' | 'M' | 'Y';

/** Form fields (strings as typed; converted on submit). */
export interface DonationForm {
  indicator: string;
  species: string;
  brain_region: string;
  scope: string;
  expression: string;
  preparation: string;
  behavior: string;
  depth_um: string;
  led_power: string;
  fps: string;
  /** Null until the donor picks one; nothing is preselected. */
  sharing: DonationSharing | null;
  subject_id: string;
  subject_sex: SubjectSex | '';
  age_value: string;
  age_unit: AgeUnit;
  /** YYYY-MM-DD from <input type="date">. */
  session_date: string;
  genotype: string;
  rights_attested: boolean;
  protocol_attested: boolean;
  credit_name: string;
  credit_lab: string;
  notes: string;
}

export const SHARING_TEXT: Record<DonationSharing, { label: string; text: string }> = {
  public: {
    label: 'Public on DANDI (CC BY 4.0)',
    text: 'After review, your recording is published in the CaLab shared recordings collection on DANDI, where anyone can download it, e.g. to test and improve their pipelines. You and your lab are listed as contributors on its citable DOI. You can withdraw it until the next version of the collection is published; published versions are permanent.',
  },
  lab: {
    label: 'CaLab only',
    text: 'Only the CaLab team uses your recording, to develop and benchmark cala. The raw data is never shared; results computed from it may appear in papers, which acknowledge your lab. You can have it deleted at any time, or ask us to make it public later.',
  },
};

const SUBJECT_ID = /^[A-Za-z0-9-]{1,64}$/;
const MIN_SESSION_DATE = '1990-01-01';
/** Largest age accepted, in the unit typed (100 years in days). */
const MAX_AGE = 36500;

export function emptyForm(fps: number | null): DonationForm {
  return {
    indicator: '',
    species: '',
    brain_region: '',
    scope: '',
    expression: '',
    preparation: '',
    behavior: '',
    depth_um: '',
    led_power: '',
    fps: fps === null ? '' : String(fps),
    sharing: null,
    subject_id: '',
    subject_sex: '',
    age_value: '',
    age_unit: 'D',
    session_date: '',
    genotype: '',
    rights_attested: false,
    protocol_attested: false,
    credit_name: '',
    credit_lab: '',
    notes: '',
  };
}

/** "90" + days -> "P90D"; null for anything but a whole number from 1 to 36500. */
export function ageToIso(value: string, unit: AgeUnit): string | null {
  const v = value.trim();
  if (!/^\d+$/.test(v)) return null;
  const n = Number(v);
  if (n < 1 || n > MAX_AGE) return null;
  return `P${n}${unit}`;
}

/** The local calendar date as YYYY-MM-DD (what <input type="date"> shows as today). */
export function todayIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** True for a real calendar date (rejects 2020-02-30, 2020-13-01 and the like). */
function isCalendarDate(v: string): boolean {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function sessionDateOk(v: string, today: Date): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !isCalendarDate(v)) return false;
  return v >= MIN_SESSION_DATE && v <= todayIso(today);
}

/** What still blocks the Donate button, as words for "Still needed: ...". */
export function missingFields(form: DonationForm, today: Date): string[] {
  const m: string[] = [];
  const fps = Number(form.fps);
  const depth = Number(form.depth_um);
  if (!form.sharing) m.push('a choice: public on DANDI or CaLab only');
  if (!form.indicator.trim()) m.push('indicator');
  if (!form.species.trim()) m.push('species');
  if (!form.brain_region.trim()) m.push('brain region');
  if (!form.scope.trim()) m.push('scope');
  if (!(Number.isFinite(fps) && fps > 0 && fps <= 1000)) m.push('frame rate');
  if (form.depth_um.trim() !== '' && !(Number.isFinite(depth) && depth >= 0 && depth <= 10000)) {
    m.push('a depth of 0 to 10000 um');
  }
  if (!SUBJECT_ID.test(form.subject_id.trim())) m.push('animal ID (letters, digits, dashes)');
  if (!form.subject_sex) m.push('sex');
  if (ageToIso(form.age_value, form.age_unit) === null) m.push('age');
  if (!sessionDateOk(form.session_date, today)) m.push('recording date');
  if (!form.credit_name.trim()) m.push('your name (for credit)');
  if (!form.credit_lab.trim()) m.push('your lab (for credit)');
  if (!form.rights_attested || !form.protocol_attested) m.push('both confirmations');
  return m;
}
