// Detail drawer for one donation: metadata, a decoded preview of the first
// chunk, approve / reject, and the benchmark flag.

import { type JSX, For, Show, createEffect, createSignal } from 'solid-js';
import {
  DONATION_MAX_CHUNK_BYTES,
  type DonationRow,
  donationPreviewUrl,
  reviewDonation,
  setDonationBenchmark,
} from '@calab/community';
import { Drawer } from './Drawer.tsx';
import {
  type DonationPreview,
  type StretchedImage,
  buildPreview,
  canBenchmark,
  canReview,
  fetchPresigned,
  formatBytes,
  formatCredit,
  formatDuration,
  formatSharing,
} from '../lib/donations.ts';

interface Props {
  donation: DonationRow;
  onClose: () => void;
  /** Called after a write so the list reloads. */
  onChanged: () => void;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const orDash = (v: unknown) => (v === null || v === undefined || v === '' ? '-' : String(v));

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

function fields(d: DonationRow): [string, string][] {
  return [
    ['ID', d.id],
    ['Status', d.status],
    ['Created', d.created_at.slice(0, 19).replace('T', ' ')],
    ['Updated', d.updated_at.slice(0, 19).replace('T', ' ')],
    ['User', d.user_id],
    ['Indicator', d.indicator],
    ['Species', d.species],
    ['Brain region', d.brain_region],
    ['Expression', orDash(d.expression)],
    ['Preparation', orDash(d.preparation)],
    ['Behavior', orDash(d.behavior)],
    ['Scope', d.scope],
    ['Size (px)', `${d.width} x ${d.height}`],
    ['Bit depth', `${8 * d.bytes_per_pixel}-bit`],
    ['Frames', `${d.n_frames.toLocaleString('en-US')} at ${d.fps} fps`],
    ['Length', formatDuration(d.n_frames, d.fps)],
    ['Depth (um)', orDash(d.depth_um)],
    ['LED power', orDash(d.led_power)],
    ['Declared size', `${formatBytes(d.declared_bytes)} in ${d.n_chunks} chunks`],
    ['cala version', d.cala_version],
    ['Dataset hash', orDash(d.dataset_hash)],
    ['License', d.license],
    ['Sharing', formatSharing(d)],
    [
      'Animal',
      `${orDash(d.subject_id)}, sex ${orDash(d.subject_sex)}, age ${orDash(d.subject_age)}`,
    ],
    ['Recording date', orDash(d.session_date)],
    ['Genotype', orDash(d.genotype)],
    ['DANDI path', orDash(d.dandi_path)],
    ['Published', d.published_at ? d.published_at.slice(0, 19).replace('T', ' ') : '-'],
    ['Rights attested', d.rights_attested ? 'yes' : 'no'],
    ['Protocol attested', d.protocol_attested ? 'yes' : 'no'],
    ['Contact OK', d.contact_ok ? 'yes' : 'no'],
    ['Credit', formatCredit(d) || '-'],
    ['Notes', orDash(d.notes)],
    ['Review note', orDash(d.review_note)],
  ];
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

function ImageCanvas(props: {
  label: string;
  image: StretchedImage;
  width: number;
  height: number;
}) {
  let canvas!: HTMLCanvasElement;
  createEffect(() => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(new ImageData(props.image.rgba, props.width, props.height), 0, 0);
  });
  return (
    <figure class="donation-preview__fig">
      <canvas
        ref={canvas}
        class="donation-preview__canvas"
        width={props.width}
        height={props.height}
        role="img"
        aria-label={props.label}
      />
      <figcaption>
        {props.label} (range {Math.round(props.image.min)} to {Math.round(props.image.max)})
      </figcaption>
    </figure>
  );
}

function PreviewPanel(props: { donation: DonationRow }): JSX.Element {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [preview, setPreview] = createSignal<DonationPreview | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const req = await donationPreviewUrl(props.donation.id);
      const gz = await fetchPresigned(req, DONATION_MAX_CHUNK_BYTES);
      setPreview(await buildPreview(gz, props.donation));
    } catch (e) {
      setError(`Preview failed: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="donation-section">
      <h4>Preview</h4>
      <button class="btn-secondary btn-small" disabled={busy()} onClick={() => void run()}>
        {busy() ? 'Decoding...' : preview() ? 'Reload preview' : 'Preview first chunk'}
      </button>
      <Show when={error()}>
        <div class="banner banner--error" role="alert">
          {error()}
        </div>
      </Show>
      <Show when={preview()}>
        {(p) => (
          <>
            <Show when={p().mismatches.length > 0}>
              <div class="banner banner--warn" role="alert">
                The chunk header disagrees with the declared metadata: {p().mismatches.join('; ')}
              </div>
            </Show>
            <p class="note">
              Frames {p().header.firstFrame} to {p().header.firstFrame + p().header.frames - 1} of{' '}
              {p().header.totalFrames}, {p().width} x {p().height}, {8 * p().header.bytesPerPixel}
              -bit. Contrast stretched min to max.
            </p>
            <div class="donation-preview">
              <ImageCanvas
                label={`Mean of ${p().header.frames} frames`}
                image={p().mean}
                width={p().width}
                height={p().height}
              />
              <ImageCanvas
                label="First frame"
                image={p().first}
                width={p().width}
                height={p().height}
              />
            </div>
          </>
        )}
      </Show>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Review and benchmark
// ---------------------------------------------------------------------------

function ReviewPanel(props: { donation: DonationRow; onChanged: () => void }): JSX.Element {
  const [note, setNote] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const decide = async (decision: 'approve' | 'reject') => {
    if (
      decision === 'reject' &&
      !confirm(`Reject donation ${props.donation.id.slice(0, 8)}? Its files are deleted.`)
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await reviewDonation(props.donation.id, decision, note().trim() || undefined);
      props.onChanged();
    } catch (e) {
      setError(`Could not ${decision}: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="donation-section">
      <h4>Review</h4>
      <label class="donation-field">
        <span>Note (optional, stored with the decision)</span>
        <textarea
          rows={2}
          maxLength={1000}
          value={note()}
          onInput={(e) => setNote(e.currentTarget.value)}
        />
      </label>
      <div class="donation-actions">
        <button
          class="btn-primary btn-small"
          disabled={busy()}
          onClick={() => void decide('approve')}
        >
          Approve
        </button>
        <button
          class="btn-secondary btn-small"
          disabled={busy()}
          onClick={() => void decide('reject')}
        >
          Reject
        </button>
      </div>
      <Show when={error()}>
        <div class="banner banner--error" role="alert">
          {error()}
        </div>
      </Show>
    </section>
  );
}

function BenchmarkPanel(props: { donation: DonationRow; onChanged: () => void }): JSX.Element {
  // Seeded from the row; the admin owns the edit until saved.
  // eslint-disable-next-line solid/reactivity
  const [inBenchmark, setInBenchmark] = createSignal(props.donation.in_benchmark);
  // eslint-disable-next-line solid/reactivity
  const [note, setNote] = createSignal(props.donation.benchmark_note ?? '');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [saved, setSaved] = createSignal(false);

  const dirty = () =>
    inBenchmark() !== props.donation.in_benchmark ||
    note().trim() !== (props.donation.benchmark_note ?? '');

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await setDonationBenchmark(props.donation.id, inBenchmark(), note().trim() || null);
      setSaved(true);
      props.onChanged();
    } catch (e) {
      setError(`Could not save: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="donation-section">
      <h4>Benchmark</h4>
      <Show
        when={canBenchmark(props.donation)}
        fallback={<p class="note">Available once the donation is approved.</p>}
      >
        <label class="filters__check">
          <input
            type="checkbox"
            checked={inBenchmark()}
            onChange={(e) => setInBenchmark(e.currentTarget.checked)}
          />
          In the cala benchmark set (the donor sees this)
        </label>
        <label class="donation-field">
          <span>Benchmark note</span>
          <input
            type="text"
            maxLength={500}
            value={note()}
            onInput={(e) => setNote(e.currentTarget.value)}
          />
        </label>
        <div class="donation-actions">
          <button
            class="btn-primary btn-small"
            disabled={busy() || !dirty()}
            onClick={() => void save()}
          >
            Save
          </button>
          <Show when={saved() && !dirty()}>
            <span class="note">Saved.</span>
          </Show>
        </div>
        <Show when={error()}>
          <div class="banner banner--error" role="alert">
            {error()}
          </div>
        </Show>
      </Show>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------

export function DonationDrawer(props: Props): JSX.Element {
  return (
    <Drawer title={`Donation ${props.donation.id.slice(0, 8)}`} onClose={() => props.onClose()}>
      <dl class="coldocs">
        <For each={fields(props.donation)}>
          {([k, v]) => (
            <>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </>
          )}
        </For>
      </dl>
      <section class="donation-section">
        <h4>Files</h4>
        <ul class="donation-files">
          <For each={props.donation.files}>
            {(f) => (
              <li>
                <code>{f.name}</code> <span class="note">{formatBytes(f.bytes)}</span>
              </li>
            )}
          </For>
        </ul>
      </section>
      <PreviewPanel donation={props.donation} />
      <Show when={canReview(props.donation)}>
        <ReviewPanel donation={props.donation} onChanged={() => props.onChanged()} />
      </Show>
      <BenchmarkPanel donation={props.donation} onChanged={() => props.onChanged()} />
    </Drawer>
  );
}
