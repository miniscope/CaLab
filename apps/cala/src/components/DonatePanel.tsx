/**
 * "Share recording" (docs/data-donation.md): send the open recording, lossless,
 * with its metadata, to the CaLab team, public on DANDI or CaLab only. Collapsed to one button
 * at the bottom of the Run tab; nothing is encoded or uploaded until the
 * donor is signed in, has filled the form and ticked both consent boxes.
 *
 * The donation itself runs in the app-level `DonationUiStore` (so it keeps
 * going while the tab is hidden); this panel is its form, progress and the
 * donor's "My donations" list.
 */
import { createEffect, createSignal, For, on, Show, type JSX } from 'solid-js';
import { createStore } from 'solid-js/store';
import { ProgressBar } from '@calab/ui';
import { AuthGate } from '@calab/community-ui';
import {
  donationAuthLoading,
  donationUser,
  fieldOptions,
  loadFieldOptions,
  signInForDonation,
  signOutDonation,
  donationDandi,
  dandiFolderUrl,
  type DonationMeta,
  type DonationRow,
  BEHAVIOR_OPTIONS,
  EXPRESSION_OPTIONS,
  GENOTYPE_OPTIONS,
  PREPARATION_OPTIONS,
  SCOPE_MODEL_OPTIONS,
  type DonationSharing,
  type SubjectSex,
} from '@calab/community';
import type { FrameSourceInfo } from '../lib/frame-source.ts';
import { PresetField } from './PresetField.tsx';
import { recordingSidecars } from '../lib/frame-source.ts';
import { bytesPerPixelFor } from '../lib/donation-encode.ts';
import {
  buildMetaJson,
  estimateDonationBytes,
  formatBytes,
  MAX_DONATION_BYTES,
  type DonationJob,
  type DonationPhase,
} from '../lib/donation-runner.ts';
import {
  ageToIso,
  emptyForm,
  missingFields,
  SHARING_TEXT,
  type AgeUnit,
  type DonationForm,
} from '../lib/donation-form.ts';
import { WITHDRAWABLE, type DonationUiStore } from '../lib/donation-store.ts';
import type { DonationSource } from '../workers/donation-types.ts';

const STATUS_LABEL: Record<DonationRow['status'], string> = {
  uploading: 'uploading',
  uploaded: 'uploaded, awaiting review',
  approved: 'approved',
  rejected: 'rejected',
  ingested: 'received by the lab',
  withdrawn: 'withdrawn',
  published: 'published on DANDI',
};

const optional = (s: string): string | null => (s.trim() === '' ? null : s.trim());

const CC_BY_URL = 'https://creativecommons.org/licenses/by/4.0/';

export interface DonatePanelProps {
  donation: DonationUiStore;
  info: FrameSourceInfo;
  /** The open recording's files (null: nothing that can be donated). */
  source: DonationSource | null;
  label: string;
  version: string;
}

export function DonatePanel(props: DonatePanelProps): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const signedIn = () => {
    const u = donationUser();
    return u && !u.is_anonymous ? u : null;
  };

  // Field options and the donor's list, once the panel is open and someone is signed in.
  createEffect(
    on([open, signedIn], ([o, u]) => {
      if (!o) return;
      void loadFieldOptions();
      if (u) void props.donation.refresh();
    }),
  );

  const expanded = () => open() || props.donation.phase().kind !== 'idle';

  return (
    <section class="cala-donate" aria-labelledby="cala-donate-title" data-testid="donate">
      <div class="cala-donate__cta">
        <h2 id="cala-donate-title" class="cala-donate__title">
          Share this recording
        </h2>
        <p class="cala-donate__lead">
          Send this recording to the cala benchmark set (only after you fill in a form). A single
          recording is enough: the raw video as recorded, no processing needed. Up to{' '}
          {Math.round(MAX_DONATION_BYTES / 1024 ** 3)} GB after compression, about 40 minutes of 600
          x 600 Miniscope V4 video.
        </p>
        <ul class="cala-donate__why">
          <li>
            <strong>cala gets better on your kind of data.</strong> Shared recordings go into the
            benchmark set that cala is developed and tuned against.
          </li>
          <li>
            <strong>Share it with everyone, or only with us.</strong> Public recordings are
            published on{' '}
            <a href="https://dandiarchive.org" target="_blank" rel="noopener noreferrer">
              DANDI
            </a>{' '}
            under{' '}
            <a href={CC_BY_URL} target="_blank" rel="noopener noreferrer">
              CC BY 4.0
            </a>
            , where anyone can use them to test and improve their pipelines. Or keep it CaLab only:
            then only the CaLab team uses it, to improve cala.
          </li>
          <li>
            <strong>Credit.</strong> Labs that share publicly are listed as contributors on the
            collection's citable DOI, and everyone using the data is asked to cite it and
            acknowledge your lab. Our own papers acknowledge every lab whose data they use. To have
            a shared recording removed after the lab has taken it in, contact the CaLab team.
          </li>
        </ul>
        <Show when={!expanded()}>
          <button
            type="button"
            class="cala-donate__button"
            data-testid="donate-open"
            onClick={() => setOpen(true)}
          >
            Share recording
          </button>
        </Show>
      </div>
      <Show when={expanded()}>
        <p class="cala-muted">
          The raw frames are compressed without loss in this browser and uploaded with the metadata
          below. File paths are never sent, only file names. The lab reviews each shared recording
          first. Withdraw it under "My shared recordings" below until the lab has taken it in; after
          that, contact the CaLab team, naming the recording and the date you sent it. A public
          recording can be removed until the next version of the DANDI collection is published;
          published versions are permanent.
        </p>
        <Show
          when={signedIn()}
          fallback={
            <div class="cala-donate__auth">
              <p class="cala-muted">
                Sharing needs a sign-in with your email address (separate from other CaLab
                sign-ins).
              </p>
              <AuthGate
                user={donationUser}
                authLoading={donationAuthLoading}
                signInWithEmail={signInForDonation}
                signOut={signOutDonation}
                prompt="Sign in to share or to see your shared recordings"
              />
            </div>
          }
        >
          <Show
            when={props.donation.phase().kind === 'idle'}
            fallback={<DonationProgress donation={props.donation} />}
          >
            <DonationFormView
              info={props.info}
              source={props.source}
              label={props.label}
              version={props.version}
              donation={props.donation}
              onClose={() => setOpen(false)}
            />
          </Show>
          <MyDonations donation={props.donation} />
        </Show>
      </Show>
    </section>
  );
}

/**
 * "My donations" on the start page: a donor can check their donations
 * (status, "in benchmark", withdraw) without opening a recording.
 */
export function MyDonationsEntry(props: { donation: DonationUiStore }): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const signedIn = () => {
    const u = donationUser();
    return u && !u.is_anonymous ? u : null;
  };
  createEffect(
    on([open, signedIn], ([o, u]) => {
      if (o && u) void props.donation.refresh();
    }),
  );
  return (
    <section class="cala-donate-entry" data-testid="my-donations-entry">
      <button type="button" class="cala-donate__link" onClick={() => setOpen((v) => !v)}>
        {open() ? 'Hide my shared recordings' : 'My shared recordings'}
      </button>
      <Show when={open()}>
        <Show
          when={signedIn()}
          fallback={
            <div class="cala-donate__auth">
              <p class="cala-muted">Sign in with the email you shared with.</p>
              <AuthGate
                user={donationUser}
                authLoading={donationAuthLoading}
                signInWithEmail={signInForDonation}
                signOut={signOutDonation}
                prompt="Sign in to share or to see your shared recordings"
              />
            </div>
          }
        >
          <MyDonations donation={props.donation} />
        </Show>
      </Show>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

export function DonationFormView(props: DonatePanelProps & { onClose: () => void }): JSX.Element {
  // eslint-disable-next-line solid/reactivity -- initial value only
  const fpsKnown = props.info.fps;
  const [form, setForm] = createStore<DonationForm>(emptyForm(fpsKnown));
  const [submitError, setSubmitError] = createSignal<string | null>(null);

  const bpp = (): 1 | 2 | null => {
    try {
      return bytesPerPixelFor(props.info.bitDepth);
    } catch {
      return null;
    }
  };
  const estimate = () =>
    estimateDonationBytes(props.info.frameCount, props.info.width, props.info.height, bpp() ?? 1);
  const tooBig = () => estimate() > MAX_DONATION_BYTES;
  const fps = () => Number(form.fps);
  const missing = (): string[] => missingFields(form, new Date());
  const blocked = (): string | null => {
    if (!props.source) return 'This recording cannot be shared (no files to read).';
    if (bpp() === null) return `${props.info.bitDepth}-bit video cannot be shared.`;
    if (tooBig()) {
      return `About ${formatBytes(estimate())} compressed: above the ${formatBytes(MAX_DONATION_BYTES)} limit per shared recording.`;
    }
    if (props.donation.active()) return 'Another share is running.';
    return null;
  };

  async function timestampsOf(source: DonationSource): Promise<Uint8Array | undefined> {
    const entries =
      'entries' in source
        ? source.entries
        : source.sessions.length === 1
          ? source.sessions[0].entries
          : null;
    // Several sessions: their timestamps are separate files; none is sent.
    if (!entries) return undefined;
    const { timeStamps } = recordingSidecars(entries);
    return timeStamps ? new Uint8Array(await timeStamps.arrayBuffer()) : undefined;
  }

  async function submit(e: Event): Promise<void> {
    e.preventDefault();
    setSubmitError(null);
    const source = props.source;
    const b = bpp();
    if (!source || b === null || blocked() || missing().length > 0) return;
    const i = props.info;
    const meta: DonationMeta = {
      indicator: form.indicator.trim(),
      species: form.species.trim(),
      brain_region: form.brain_region.trim(),
      scope: form.scope.trim(),
      expression: optional(form.expression),
      preparation: optional(form.preparation),
      behavior: optional(form.behavior),
      depth_um: form.depth_um.trim() === '' ? null : Number(form.depth_um),
      led_power: optional(form.led_power),
      fps: fps(),
      width: i.width,
      height: i.height,
      n_frames: i.frameCount,
      bytes_per_pixel: b,
      cala_version: props.version,
      dataset_hash: null,
      sharing: form.sharing!,
      subject_id: form.subject_id.trim(),
      subject_sex: form.subject_sex as SubjectSex,
      subject_age: ageToIso(form.age_value, form.age_unit)!,
      session_date: form.session_date,
      genotype: optional(form.genotype),
      rights_attested: form.rights_attested,
      protocol_attested: form.protocol_attested,
      // Signing in with an email already lets the team reach the sharer (no separate opt-in).
      contact_ok: true,
      credit_name: optional(form.credit_name),
      credit_lab: optional(form.credit_lab),
      notes: optional(form.notes),
    };
    try {
      const job: DonationJob = {
        meta,
        encode: {
          source,
          fps: fps(),
          expect: {
            width: i.width,
            height: i.height,
            frameCount: i.frameCount,
            bitDepth: i.bitDepth,
          },
        },
        timestamps: await timestampsOf(source),
        metaJson: buildMetaJson(i, props.version, fps(), form.sharing!),
      };
      await props.donation.start(job, props.label);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    }
  }

  const text = (
    key: Exclude<
      keyof DonationForm,
      'sharing' | 'subject_sex' | 'age_unit' | 'rights_attested' | 'protocol_attested'
    >,
    label: string,
    opts: { required?: boolean; max?: number; placeholder?: string } = {},
  ) => (
    <label class="cala-donate__field">
      <span>
        {label}
        {opts.required ? ' *' : ''}
      </span>
      <input
        type="text"
        value={form[key]}
        maxLength={opts.max ?? 128}
        placeholder={opts.placeholder}
        required={opts.required}
        onInput={(e) => setForm(key, e.currentTarget.value)}
      />
    </label>
  );

  /** Fields with presets: a dropdown, or "Other…" for a custom value. */
  type PresetKey =
    | 'indicator'
    | 'species'
    | 'brain_region'
    | 'expression'
    | 'preparation'
    | 'behavior'
    | 'genotype'
    | 'scope';
  const preset = (
    key: PresetKey,
    label: string,
    options: readonly string[],
    opts: { required?: boolean; max?: number; placeholder?: string } = {},
  ) => (
    <PresetField
      label={label}
      value={form[key]}
      options={options}
      required={opts.required}
      max={opts.max}
      placeholder={opts.placeholder}
      onChange={(v) => setForm(key, v)}
    />
  );
  /** Specific models first, then the generic types. */
  const scopeOptions = () => [
    ...SCOPE_MODEL_OPTIONS,
    ...fieldOptions().microscopeTypes.filter((t) => !SCOPE_MODEL_OPTIONS.includes(t)),
  ];

  return (
    <form class="cala-donate__form" onSubmit={(e) => void submit(e)} data-testid="donate-form">
      <fieldset class="cala-donate__group">
        <legend>Recording</legend>
        <dl class="cala-info">
          <dt>Frame size</dt>
          <dd>
            {props.info.width} x {props.info.height} px, {props.info.bitDepth}-bit
            {bpp() ? ` (${bpp()} byte${bpp() === 1 ? '' : 's'} per pixel)` : ''}
          </dd>
          <dt>Frames</dt>
          <dd>{props.info.frameCount.toLocaleString()}</dd>
          <dt>Frame rate</dt>
          <dd>
            <Show
              when={fpsKnown === null}
              fallback={`${fpsKnown!.toFixed(2)} Hz (from ${props.info.fpsSource})`}
            >
              <input
                class="cala-donate__fps"
                type="number"
                min="0.1"
                max="1000"
                step="any"
                required
                value={form.fps}
                aria-label="Frame rate, Hz"
                onInput={(e) => setForm('fps', e.currentTarget.value)}
              />{' '}
              Hz <span class="cala-muted">(not in the files: please enter it)</span>
            </Show>
          </dd>
          <dt>Upload</dt>
          <dd data-testid="donate-estimate">
            about {formatBytes(estimate())}{' '}
            <span class="cala-muted">(lossless, ~1.65x smaller than the raw frames)</span>
          </dd>
        </dl>
        <Show when={tooBig()}>
          <p class="cala-warning" data-testid="donate-too-big">
            This is above the {formatBytes(MAX_DONATION_BYTES)} limit per shared recording. Contact
            the lab to share longer recordings.
          </p>
        </Show>
      </fieldset>

      <fieldset class="cala-donate__group">
        <legend>Biology</legend>
        {preset('indicator', 'Indicator', fieldOptions().indicators, { required: true })}
        {preset('species', 'Species', fieldOptions().species, { required: true })}
        {preset('brain_region', 'Brain region', fieldOptions().brainRegions, { required: true })}
        {preset('expression', 'Expression', EXPRESSION_OPTIONS, {
          placeholder: 'virus or transgenic line',
        })}
        {preset('preparation', 'Preparation', PREPARATION_OPTIONS)}
        {preset('behavior', 'Behavior', BEHAVIOR_OPTIONS, { max: 256 })}
      </fieldset>

      <fieldset class="cala-donate__group">
        <legend>Animal and session (DANDI needs these)</legend>
        {text('subject_id', 'Animal ID', {
          required: true,
          max: 64,
          placeholder: 'your label, e.g. m7 (letters, digits, dashes)',
        })}
        <label class="cala-donate__field">
          <span>Sex *</span>
          <select
            value={form.subject_sex}
            onChange={(e) =>
              setForm('subject_sex', e.currentTarget.value as DonationForm['subject_sex'])
            }
          >
            <option value="">choose</option>
            <option value="F">female</option>
            <option value="M">male</option>
            <option value="U">unknown</option>
            <option value="O">other</option>
          </select>
        </label>
        <label class="cala-donate__field">
          <span>Age at recording *</span>
          <span class="cala-donate__age">
            <input
              type="number"
              min="1"
              step="1"
              value={form.age_value}
              aria-label="Age"
              onInput={(e) => setForm('age_value', e.currentTarget.value)}
            />
            <select
              value={form.age_unit}
              aria-label="Age unit"
              onChange={(e) => setForm('age_unit', e.currentTarget.value as AgeUnit)}
            >
              <option value="D">days</option>
              <option value="W">weeks</option>
              <option value="M">months</option>
              <option value="Y">years</option>
            </select>
          </span>
        </label>
        <label class="cala-donate__field">
          <span>Recording date *</span>
          <input
            type="date"
            min="1990-01-01"
            value={form.session_date}
            onInput={(e) => setForm('session_date', e.currentTarget.value)}
          />
        </label>
        {preset('genotype', 'Strain / genotype', GENOTYPE_OPTIONS)}
      </fieldset>

      <fieldset class="cala-donate__group">
        <legend>Optics</legend>
        {preset('scope', 'Scope', scopeOptions(), { required: true })}
        <label class="cala-donate__field">
          <span>Depth (um)</span>
          <input
            type="number"
            min="0"
            max="10000"
            step="any"
            value={form.depth_um}
            onInput={(e) => setForm('depth_um', e.currentTarget.value)}
          />
        </label>
        {text('led_power', 'LED power', { max: 64 })}
      </fieldset>

      <fieldset class="cala-donate__group" data-testid="donate-sharing">
        <legend>Who may use it? *</legend>
        <For each={['public', 'lab'] as DonationSharing[]}>
          {(choice) => (
            <label class="cala-donate__choice">
              <input
                type="radio"
                name="donate-sharing"
                value={choice}
                checked={form.sharing === choice}
                onChange={() => setForm('sharing', choice)}
              />{' '}
              <strong>{SHARING_TEXT[choice].label}</strong>
            </label>
          )}
        </For>
        <Show when={form.sharing}>
          {(c) => (
            <p class="cala-donate__note" data-testid="donate-sharing-text">
              {SHARING_TEXT[c()].text}
            </p>
          )}
        </Show>
      </fieldset>

      <fieldset class="cala-donate__group">
        <legend>Consent</legend>
        <label class="cala-donate__check">
          <input
            type="checkbox"
            checked={form.rights_attested}
            data-testid="donate-rights"
            onChange={(e) => setForm('rights_attested', e.currentTarget.checked)}
          />{' '}
          I have the right to share this data under the option chosen above. *
        </label>
        <label class="cala-donate__check">
          <input
            type="checkbox"
            checked={form.protocol_attested}
            data-testid="donate-protocol"
            onChange={(e) => setForm('protocol_attested', e.currentTarget.checked)}
          />{' '}
          The recordings were made under an approved animal protocol. *
        </label>
      </fieldset>

      <fieldset class="cala-donate__group">
        <legend>Credit (public for public recordings)</legend>
        {text('credit_name', 'Name', { required: true, max: 100 })}
        {text('credit_lab', 'Lab', {
          required: true,
          max: 100,
          placeholder: 'lab name, institution',
        })}
        <label class="cala-donate__field">
          <span>Notes</span>
          <textarea
            maxLength={1000}
            rows={2}
            value={form.notes}
            onInput={(e) => setForm('notes', e.currentTarget.value)}
          />
        </label>
      </fieldset>

      <Show when={blocked()}>{(b) => <p class="cala-warning">{b()}</p>}</Show>
      <Show when={!blocked() && missing().length > 0}>
        <p class="cala-muted">Still needed: {missing().join(', ')}.</p>
      </Show>
      <Show when={submitError()}>
        {(m) => (
          <div class="error-card" role="alert">
            {m()}
          </div>
        )}
      </Show>
      <p class="cala-donate__actions">
        <button
          type="submit"
          class="btn-primary btn-small"
          data-testid="donate-submit"
          disabled={blocked() !== null || missing().length > 0}
        >
          Compress and upload
        </button>{' '}
        <button type="button" class="btn-secondary btn-small" onClick={() => props.onClose()}>
          Close
        </button>
      </p>
      <p class="cala-muted">
        The recording is first compressed into this browser's storage (it needs about the upload
        size free on disk), then uploaded. Keep this tab open until it is done.
      </p>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

function phaseText(p: DonationPhase): { text: string; fraction: number | null } {
  switch (p.kind) {
    case 'encoding':
      return {
        text: `Compressing: frame ${p.frames.toLocaleString()} of ${p.totalFrames.toLocaleString()}, ${p.chunks} chunk${p.chunks === 1 ? '' : 's'} (${formatBytes(p.bytes)})`,
        fraction: p.totalFrames > 0 ? p.frames / p.totalFrames : 0,
      };
    case 'creating':
      return {
        text: `Registering the shared recording (${formatBytes(p.bytes)})...`,
        fraction: null,
      };
    case 'uploading':
      return {
        text: `Uploading file ${p.index + 1} of ${p.count} (${p.name}): ${formatBytes(p.sentBytes)} of ${formatBytes(p.totalBytes)}${p.attempt > 1 ? `, retry ${p.attempt - 1}` : ''}`,
        fraction: p.totalBytes > 0 ? p.sentBytes / p.totalBytes : 0,
      };
    case 'finishing':
      return { text: 'Checking the uploaded files...', fraction: 1 };
    default:
      return { text: '', fraction: null };
  }
}

function DonationProgress(props: { donation: DonationUiStore }): JSX.Element {
  const d = () => props.donation;
  const p = () => d().phase();
  return (
    <div class="cala-donate__progress" data-testid="donate-progress">
      <Show when={d().label()}>
        {(l) => (
          <p class="cala-muted">
            Recording: <span class="cala-donate__label">{l()}</span>
          </p>
        )}
      </Show>
      <Show when={d().active()}>
        <ProgressBar
          fraction={phaseText(p()).fraction ?? 0}
          state="running"
          label={phaseText(p()).text}
          showPct={phaseText(p()).fraction !== null}
          testid="donate-progress-bar"
        />
        <p class="cala-donate__actions">
          <button
            type="button"
            class="btn-secondary btn-small"
            data-testid="donate-cancel"
            onClick={() => d().cancel()}
          >
            Cancel
          </button>
        </p>
      </Show>
      <Show when={p().kind === 'done' ? (p() as { bytes: number }) : null}>
        {(done) => (
          <p class="cala-donate__done" role="status">
            Thank you! Your shared recording ({formatBytes(done().bytes)}) arrived. The lab reviews
            it before it is used or published.{' '}
            <button type="button" class="btn-secondary btn-small" onClick={() => d().reset()}>
              Done
            </button>
          </p>
        )}
      </Show>
      <Show when={p().kind === 'cancelled'}>
        <p class="cala-muted" role="status">
          Cancelled; nothing was kept.{' '}
          <button type="button" class="btn-secondary btn-small" onClick={() => d().reset()}>
            Back to the form
          </button>
        </p>
      </Show>
      <Show when={p().kind === 'error' ? (p() as { message: string; resumable: boolean }) : null}>
        {(err) => (
          <div class="error-card" role="alert" data-testid="donate-error">
            <span>{err().message}</span>
            <p class="cala-donate__actions">
              <Show
                when={err().resumable}
                fallback={
                  <button type="button" class="btn-secondary btn-small" onClick={() => d().reset()}>
                    Back to the form
                  </button>
                }
              >
                <button
                  type="button"
                  class="btn-primary btn-small"
                  data-testid="donate-resume"
                  onClick={() => void d().resume()}
                >
                  Try again
                </button>{' '}
                <button
                  type="button"
                  class="btn-secondary btn-small"
                  onClick={() => void d().discard()}
                >
                  Discard
                </button>
              </Show>
            </p>
          </div>
        )}
      </Show>
    </div>
  );
}

// ---------------------------------------------------------------------------
// My donations
// ---------------------------------------------------------------------------

export function MyDonations(props: { donation: DonationUiStore }): JSX.Element {
  const d = () => props.donation;
  const [showWithdrawn, setShowWithdrawn] = createSignal(false);
  const withdrawnCount = () =>
    d()
      .donations()
      .filter((r) => r.status === 'withdrawn').length;
  const shown = () =>
    d()
      .donations()
      .filter((r) => showWithdrawn() || r.status !== 'withdrawn');
  /** The donation this tab is uploading right now (its row says "uploading"). */
  const liveId = () => {
    const p = d().phase();
    return p.kind === 'uploading' || p.kind === 'finishing' ? p.donationId : null;
  };
  const statusLabel = (row: DonationRow): string =>
    row.status === 'uploading' && row.id !== liveId()
      ? 'upload not finished (withdraw to remove it)'
      : (STATUS_LABEL[row.status] ?? row.status);
  function withdraw(row: DonationRow): void {
    const ok = window.confirm(
      `Withdraw the shared recording of ${row.created_at.slice(0, 10)}? Its uploaded files are deleted.`,
    );
    if (ok) void d().withdraw(row.id);
  }
  return (
    <section class="cala-donate__mine" aria-label="My shared recordings" data-testid="my-donations">
      <h3 class="cala-donate__subtitle">
        My shared recordings{' '}
        <button
          type="button"
          class="btn-secondary btn-small"
          disabled={d().listState().loading}
          onClick={() => void d().refresh()}
        >
          Refresh
        </button>
      </h3>
      <Show when={d().listState().error}>
        {(m) => (
          <div class="error-card" role="alert">
            {m()}
          </div>
        )}
      </Show>
      <Show
        when={shown().length > 0}
        fallback={
          <p class="cala-muted">
            {d().listState().loading ? 'Loading...' : 'No shared recordings yet.'}
          </p>
        }
      >
        <ul class="cala-donate__list">
          <For each={shown()}>
            {(row) => (
              <li class="cala-donate__item" data-testid="my-donation">
                <span>
                  {row.created_at.slice(0, 10)}: {row.indicator}, {row.brain_region}, {row.scope}{' '}
                  <span class="cala-muted">
                    ({row.n_frames.toLocaleString()} frames, {formatBytes(row.declared_bytes)})
                  </span>
                </span>
                <span class="cala-donate__status">
                  {statusLabel(row)}
                  <Show when={row.sharing === 'lab'}>
                    {' '}
                    <span class="cala-donate__badge">CaLab only</span>
                  </Show>
                  <Show
                    when={
                      row.status === 'published' && row.dandi_path && donationDandi
                        ? row.dandi_path
                        : null
                    }
                  >
                    {(path) => (
                      <>
                        {' '}
                        <a
                          href={dandiFolderUrl(donationDandi!, path())}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          on DANDI
                        </a>
                      </>
                    )}
                  </Show>
                  <Show when={row.in_benchmark}>
                    {' '}
                    <span class="cala-donate__badge" title={row.benchmark_note ?? undefined}>
                      in benchmark
                    </span>
                  </Show>
                  <Show when={WITHDRAWABLE.has(row.status)}>
                    {' '}
                    <button
                      type="button"
                      class="btn-secondary btn-small"
                      onClick={() => withdraw(row)}
                    >
                      Withdraw
                    </button>
                  </Show>
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={withdrawnCount() > 0}>
        <button type="button" class="cala-donate__link" onClick={() => setShowWithdrawn((v) => !v)}>
          {showWithdrawn() ? 'Hide' : 'Show'} withdrawn ({withdrawnCount()})
        </button>
      </Show>
    </section>
  );
}
