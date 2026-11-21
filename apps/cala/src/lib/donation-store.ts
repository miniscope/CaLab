/**
 * The app's side of data donation (docs/data-donation.md): one
 * `DonationRunner` at a time over the real worker, the `@calab/community`
 * donation client and OPFS, its phase as a signal, and the donor's list of
 * donations. Lives as long as the app, so a donation keeps running when the
 * panel is hidden or another recording is opened.
 *
 * Encoded files wait in OPFS as flat `cala-donation-<id>-<name>` files
 * (through `OpfsWriterClient`): each is locked while this tab owns it, so the
 * app's sweep of leftover `cala-*` files removes those of a crashed tab and
 * never those of a running donation.
 */
import { createSignal, onCleanup } from 'solid-js';
import {
  createDonation,
  donationUploadUrl,
  finishDonation,
  listDonations,
  putPresigned,
  withdrawDonation,
  type DonationRow,
} from '@calab/community';
import { OPFS_PREFIX, OpfsWriterClient, opfsUsable } from './opfs-writer.ts';
import {
  DonationRunner,
  type DonationApi,
  type DonationJob,
  type DonationPhase,
  type DonationStore as DonationFiles,
  type WorkerLike,
} from './donation-runner.ts';

/** Shown when the browser cannot keep the encoded files. */
export const NO_OPFS_MESSAGE =
  'This browser cannot store the encoded recording before the upload (no usable origin private file system). Use a current Chrome, Edge or Firefox in a normal (not private) window.';

/** Statuses a donor can still withdraw. */
export const WITHDRAWABLE: ReadonlySet<DonationRow['status']> = new Set([
  'uploading',
  'uploaded',
  'approved',
]);

/** Encoded files of one donation, as flat OPFS files named after it. */
export function opfsDonationFiles(localId: string): DonationFiles {
  const opfs = OpfsWriterClient.shared();
  const full = (name: string) => `${OPFS_PREFIX}donation-${localId}-${name}`;
  return {
    async write(name, bytes) {
      await opfs.open(full(name));
      await opfs.write(full(name), 0, bytes, true);
      await opfs.close(full(name));
    },
    async read(name) {
      const file = await opfs.getFile(full(name));
      return new Uint8Array(await file.arrayBuffer());
    },
    remove: (name) => opfs.remove(full(name)),
  };
}

const api: DonationApi = {
  createDonation,
  donationUploadUrl,
  putPresigned,
  finishDonation,
  withdrawDonation,
};

function newWorker(): WorkerLike {
  return new Worker(new URL('../workers/donation-worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const ACTIVE: ReadonlySet<DonationPhase['kind']> = new Set([
  'encoding',
  'creating',
  'uploading',
  'finishing',
]);

export function createDonationStore() {
  const [phase, setPhase] = createSignal<DonationPhase>({ kind: 'idle' });
  /** The label of the recording being donated (the panel may show another). */
  const [label, setLabel] = createSignal<string | null>(null);
  const [donations, setDonations] = createSignal<DonationRow[]>([]);
  const [listState, setListState] = createSignal<{ loading: boolean; error: string | null }>({
    loading: false,
    error: null,
  });
  let runner: DonationRunner | null = null;

  const active = () => ACTIVE.has(phase().kind);

  // Leaving the page drops the donation: ask first while one is running.
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (!active()) return;
    e.preventDefault();
    e.returnValue = '';
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', onBeforeUnload);
    onCleanup(() => window.removeEventListener('beforeunload', onBeforeUnload));
  }

  async function refresh(): Promise<void> {
    setListState({ loading: true, error: null });
    try {
      setDonations(await listDonations());
      setListState({ loading: false, error: null });
    } catch (err) {
      setListState({ loading: false, error: messageOf(err) });
    }
  }

  async function start(job: DonationJob, recording: string): Promise<void> {
    if (active()) return;
    setLabel(recording);
    if (!(await opfsUsable())) {
      setPhase({ kind: 'error', message: NO_OPFS_MESSAGE, resumable: false });
      return;
    }
    runner = new DonationRunner({
      worker: newWorker,
      api,
      store: opfsDonationFiles(crypto.randomUUID()),
      onState: setPhase,
    });
    const end = await runner.run(job);
    if (end.kind === 'done') void refresh();
  }

  async function resume(): Promise<void> {
    const end = await runner?.resume();
    if (end?.kind === 'done') void refresh();
  }

  async function discard(): Promise<void> {
    await runner?.discard();
    setPhase({ kind: 'idle' });
    void refresh();
  }

  async function withdraw(id: string): Promise<void> {
    try {
      await withdrawDonation(id);
    } catch (err) {
      setListState({ loading: false, error: messageOf(err) });
      return;
    }
    await refresh();
  }

  return {
    phase,
    label,
    active,
    donations,
    listState,
    start,
    cancel: () => runner?.cancel(),
    resume,
    discard,
    /** Back to the form after a donation ended. */
    reset: () => {
      if (!active()) setPhase({ kind: 'idle' });
    },
    refresh,
    withdraw,
  };
}

export type DonationUiStore = ReturnType<typeof createDonationStore>;
