/**
 * "Donate data" (docs/data-donation.md): send the open recording, lossless,
 * with its metadata, to the lab's cala benchmark set. Collapsed to one button
 * at the bottom of the Recording tab; nothing is encoded or uploaded until the
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
  type DonationLicense,
  type DonationMeta,
  type DonationRow,
} from '@calab/community';
import type { FrameSourceInfo } from '../lib/frame-source.ts';
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
import { WITHDRAWABLE, type DonationUiStore } from '../lib/donation-store.ts';
import type { DonationSource } from '../workers/donation-types.ts';

/** Form fields (strings as typed; converted on submit). */
interface DonationForm {
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
  license: DonationLicense;
  rights_attested: boolean;
  protocol_attested: boolean;
  contact_ok: boolean;
  credit_name: string;
  credit_lab: string;
  notes: string;
}

const STATUS_LABEL: Record<DonationRow['status'], string> = {
  uploading: 'uploading',
  uploaded: 'uploaded, awaiting review',
  approved: 'approved',
  rejected: 'rejected',
  ingested: 'received by the lab',
  withdrawn: 'withdrawn',
};

const optional = (s: string): string | null => (s.trim() === '' ? null : s.trim());

const CC_BY_URL = 'https://creativecommons.org/licenses/by/4.0/';

/** Who receives deletion requests (add addresses here; all are shown). */
const DELETION_CONTACTS = ['marcel91@g.ucla.edu'];

function DeletionContacts(): JSX.Element {
  return (
    <For each={DELETION_CONTACTS}>
      {(addr, i) => (
        <>
          {i() > 0 ? ', ' : ''}
          <a href={`mailto:${addr}?subject=${encodeURIComponent('CaLab data donation: delete')}`}>
            {addr}
          </a>
        </>
      )}
    </For>
  );
}

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
          Donate this recording
        </h2>
        <p class="cala-donate__lead">
          Send this recording to the cala benchmark set (only after you fill in a form). A single
          recording is enough: the raw video as recorded, no processing needed. Up to{' '}
          {Math.round(MAX_DONATION_BYTES / 1024 ** 3)} GB after compression, about 40 minutes of 600
          x 600 Miniscope V4 video.
        </p>
        <ul class="cala-donate__why">
          <li>
            <strong>cala gets better on your kind of data.</strong> Donated recordings go into the
            benchmark set that cala is developed and tuned against.
          </li>
          <li>
            <strong>Co-authorship.</strong> If your dataset is used in a benchmark or dataset paper,
            you are offered co-authorship. Every use of a donation is verified and logged against
            it, so no use goes uncredited.
          </li>
          <li>
            <strong>Credit and control stay with you.</strong> The data is kept within the lab and
            licensed{' '}
            <a href={CC_BY_URL} target="_blank" rel="noopener noreferrer">
              CC BY 4.0
            </a>
            : any use must credit you and your lab. You can ask for it to be deleted at any time (
            <DeletionContacts />
            ).
          </li>
        </ul>
        <Show when={!expanded()}>
          <button
            type="button"
            class="cala-donate__button"
            data-testid="donate-open"
            onClick={() => setOpen(true)}
          >
            Donate data
          </button>
        </Show>
      </div>
      <Show when={expanded()}>
        <p class="cala-muted">
          The raw frames are compressed without loss in this browser and uploaded with the metadata
          below. File paths are never sent, only file names. The lab reviews each donation before it
          is used. Withdraw it under "My donations" below; once the lab has taken it in, email{' '}
          <DeletionContacts /> and it is deleted.
        </p>
        <Show
          when={signedIn()}
          fallback={
            <div class="cala-donate__auth">
              <p class="cala-muted">
                Donating needs a sign-in with your email address (separate from other CaLab
                sign-ins).
              </p>
              <AuthGate
                user={donationUser}
                authLoading={donationAuthLoading}
                signInWithEmail={signInForDonation}
                signOut={signOutDonation}
                prompt="Sign in to donate or to see your donations"
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
        {open() ? 'Hide my donations' : 'My donations'}
      </button>
      <Show when={open()}>
        <Show
          when={signedIn()}
          fallback={
            <div class="cala-donate__auth">
              <p class="cala-muted">Sign in with the email you donated with.</p>
              <AuthGate
                user={donationUser}
                authLoading={donationAuthLoading}
                signInWithEmail={signInForDonation}
                signOut={signOutDonation}
                prompt="Sign in to donate or to see your donations"
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

function DonationFormView(props: DonatePanelProps & { onClose: () => void }): JSX.Element {
  // eslint-disable-next-line solid/reactivity -- initial value only
  const fpsKnown = props.info.fps;
  const [form, setForm] = createStore<DonationForm>({
    indicator: '',
    species: '',
    brain_region: '',
    scope: '',
    expression: '',
    preparation: '',
    behavior: '',
    depth_um: '',
    led_power: '',
    fps: fpsKnown === null ? '' : String(fpsKnown),
    license: 'cc-by-4.0',
    rights_attested: false,
    protocol_attested: false,
    contact_ok: false,
    credit_name: '',
    credit_lab: '',
    notes: '',
  });
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
  const fpsOk = () => Number.isFinite(fps()) && fps() > 0 && fps() <= 1000;
  const depthOk = () =>
    form.depth_um.trim() === '' ||
    (Number.isFinite(Number(form.depth_um)) &&
      Number(form.depth_um) >= 0 &&
      Number(form.depth_um) <= 10000);
  const missing = (): string[] => {
    const m: string[] = [];
    if (!form.indicator.trim()) m.push('indicator');
    if (!form.species.trim()) m.push('species');
    if (!form.brain_region.trim()) m.push('brain region');
    if (!form.scope.trim()) m.push('scope');
    if (!fpsOk()) m.push('frame rate');
    if (!depthOk()) m.push('a depth of 0 to 10000 um');
    if (!form.credit_name.trim()) m.push('your name (for credit)');
    if (!form.credit_lab.trim()) m.push('your lab (for credit)');
    if (!form.rights_attested || !form.protocol_attested) m.push('both confirmations');
    return m;
  };
  const blocked = (): string | null => {
    if (!props.source) return 'This recording cannot be donated (no files to read).';
    if (bpp() === null) return `${props.info.bitDepth}-bit video cannot be donated.`;
    if (tooBig()) {
      return `About ${formatBytes(estimate())} compressed: above the ${formatBytes(MAX_DONATION_BYTES)} limit per donation.`;
    }
    if (props.donation.active()) return 'Another donation is running.';
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
      license: form.license,
      rights_attested: form.rights_attested,
      protocol_attested: form.protocol_attested,
      contact_ok: form.contact_ok,
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
        metaJson: buildMetaJson(i, props.version, fps()),
      };
      await props.donation.start(job, props.label);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    }
  }

  const text = (
    key: Exclude<
      keyof DonationForm,
      'license' | 'rights_attested' | 'protocol_attested' | 'contact_ok'
    >,
    label: string,
    opts: { required?: boolean; list?: string; max?: number; placeholder?: string } = {},
  ) => (
    <label class="cala-donate__field">
      <span>
        {label}
        {opts.required ? ' *' : ''}
      </span>
      <input
        type="text"
        value={form[key]}
        list={opts.list}
        maxLength={opts.max ?? 128}
        placeholder={opts.placeholder}
        required={opts.required}
        onInput={(e) => setForm(key, e.currentTarget.value)}
      />
    </label>
  );

  return (
    <form class="cala-donate__form" onSubmit={(e) => void submit(e)} data-testid="donate-form">
      <datalist id="cala-donate-indicators">
        <For each={fieldOptions().indicators}>{(o) => <option value={o} />}</For>
      </datalist>
      <datalist id="cala-donate-species">
        <For each={fieldOptions().species}>{(o) => <option value={o} />}</For>
      </datalist>
      <datalist id="cala-donate-regions">
        <For each={fieldOptions().brainRegions}>{(o) => <option value={o} />}</For>
      </datalist>
      <datalist id="cala-donate-scopes">
        <For each={fieldOptions().microscopeTypes}>{(o) => <option value={o} />}</For>
      </datalist>

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
            This is above the {formatBytes(MAX_DONATION_BYTES)} limit per donation. Contact the lab
            to donate longer recordings.
          </p>
        </Show>
      </fieldset>

      <fieldset class="cala-donate__group">
        <legend>Biology</legend>
        {text('indicator', 'Indicator', { required: true, list: 'cala-donate-indicators' })}
        {text('species', 'Species', { required: true, list: 'cala-donate-species' })}
        {text('brain_region', 'Brain region', { required: true, list: 'cala-donate-regions' })}
        {text('expression', 'Expression', { placeholder: 'virus or transgenic line' })}
        {text('preparation', 'Preparation', { placeholder: 'GRIN lens, cranial window, ...' })}
        {text('behavior', 'Behavior', { max: 256, placeholder: 'open field, head-fixed, ...' })}
      </fieldset>

      <fieldset class="cala-donate__group">
        <legend>Optics</legend>
        {text('scope', 'Scope', {
          required: true,
          list: 'cala-donate-scopes',
          placeholder: 'UCLA Miniscope v4, Inscopix, own wireless, ...',
        })}
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

      <fieldset class="cala-donate__group">
        <legend>License</legend>
        <p class="cala-donate__note">
          <a href={CC_BY_URL} target="_blank" rel="noopener noreferrer">
            CC BY 4.0
          </a>
          : the data is kept within the lab, and any use must credit you and your lab as entered
          under Credit below.
        </p>
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
          I have the right to share this data and agree to share it under CC BY 4.0. *
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
        <label class="cala-donate__check">
          <input
            type="checkbox"
            checked={form.contact_ok}
            onChange={(e) => setForm('contact_ok', e.currentTarget.checked)}
          />{' '}
          You may contact me about co-authorship if the data is used in a paper.
        </label>
      </fieldset>

      <fieldset class="cala-donate__group">
        <legend>Credit (how you and your lab are attributed)</legend>
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
      return { text: `Registering the donation (${formatBytes(p.bytes)})...`, fraction: null };
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
            Thank you! Your donation ({formatBytes(done().bytes)}) arrived. The lab reviews it
            before it goes into the benchmark set.{' '}
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
      `Withdraw the donation of ${row.created_at.slice(0, 10)}? Its uploaded files are deleted.`,
    );
    if (ok) void d().withdraw(row.id);
  }
  return (
    <section class="cala-donate__mine" aria-label="My donations" data-testid="my-donations">
      <h3 class="cala-donate__subtitle">
        My donations{' '}
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
          <p class="cala-muted">{d().listState().loading ? 'Loading...' : 'No donations yet.'}</p>
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
