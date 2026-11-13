/**
 * The session list a multi-session run is reviewed in before it starts:
 * sessions added from one or more picked folders, probed for their frames,
 * size and rate, ordered (recording start time, else path), reordered and
 * removed by the user, and checked (`validateSessions`).
 */
import { createSignal } from 'solid-js';
import type { SessionInput } from './frame-source.ts';
import type { DirHandleLike } from './directory-picker.ts';
import type { SessionProbeResult } from '../workers/frame-types.ts';
import type { PlannedSession } from './multi-run.ts';
import {
  defaultOrder,
  moveItem,
  parseRecordingStart,
  removeItem,
  uniqueResultsPaths,
  validateSessions,
  type SessionCandidate,
  type SessionCheck,
} from './sessions.ts';

/** Where the results go: a folder handle (File System Access API) or a zip download. */
export interface ResultsLocation {
  handle: DirHandleLike | null;
  /** For the list: the folder's name, or how the zip arrives. */
  label: string;
  /** Picked by the user (true) or the default, the first picked data folder. */
  chosen: boolean;
}

/** `recordingStartTime` from the nearest metaData.json that has one. */
export async function readStartMs(c: SessionCandidate): Promise<number | null> {
  for (const e of c.metaEntries) {
    try {
      const ms = parseRecordingStart(await e.file.text());
      if (ms !== null) return ms;
    } catch {
      // unreadable: try the next one
    }
  }
  return null;
}

/** `defaultOrder` over planned sessions. */
export function orderSessions(list: readonly PlannedSession[]): PlannedSession[] {
  return defaultOrder(list.map((s) => ({ dir: s.candidate.dir, startMs: s.startMs, s }))).map(
    (x) => x.s,
  );
}

export function toSessionInput(c: SessionCandidate): SessionInput {
  return { name: c.name, dir: c.dir, entries: c.entries };
}

export function createSessionList(probe: (s: SessionInput[]) => Promise<SessionProbeResult[]>) {
  const [items, setItems] = createSignal<PlannedSession[]>([]);
  const [reordered, setReordered] = createSignal(false);
  const [probing, setProbing] = createSignal(0);
  const [location, setLocation] = createSignal<ResultsLocation | null>(null);

  /** Results paths follow the list (unique, in order). */
  const withPaths = (list: PlannedSession[]): PlannedSession[] => {
    const paths = uniqueResultsPaths(list.map((s) => s.candidate.dir));
    return list.map((s, i) => ({ ...s, resultsPath: paths[i] }));
  };

  async function add(candidates: SessionCandidate[], handle: DirHandleLike | null): Promise<void> {
    const known = new Set(items().map((s) => s.candidate.id));
    const fresh = candidates.filter((c) => !known.has(c.id));
    if (fresh.length === 0) return;
    if (handle && !location()) setLocation({ handle, label: handle.name, chosen: false });
    setProbing((n) => n + 1);
    try {
      const [starts, probed] = await Promise.all([
        Promise.all(fresh.map(readStartMs)),
        probe(fresh.map(toSessionInput)).catch((err: unknown) =>
          fresh.map(() => ({ error: err instanceof Error ? err.message : String(err) })),
        ),
      ]);
      const added: PlannedSession[] = fresh.map((candidate, i) => {
        const r = probed[i];
        return {
          candidate,
          info: r && 'info' in r ? r.info : null,
          error: r && 'error' in r ? r.error : null,
          startMs: starts[i],
          resultsPath: '',
        };
      });
      const all = [...items(), ...orderSessions(added)];
      setItems(withPaths(reordered() ? all : orderSessions(all)));
    } finally {
      setProbing((n) => n - 1);
    }
  }

  function move(from: number, to: number): void {
    setReordered(true);
    setItems(withPaths(moveItem(items(), from, to)));
  }

  function remove(index: number): void {
    setItems(withPaths(removeItem(items(), index)));
  }

  /** Back to the default order (recording start time, else path). */
  function sortDefault(): void {
    setReordered(false);
    setItems(withPaths(orderSessions(items())));
  }

  function check(): SessionCheck {
    const list = items();
    const errors: string[] = [];
    for (const s of list) if (s.error) errors.push(`${s.candidate.name}: ${s.error}`);
    const ok = list.filter((s) => s.info !== null);
    const v = validateSessions(
      ok.map((s) => ({
        name: s.candidate.name,
        width: s.info!.width,
        height: s.info!.height,
        bitDepth: s.info!.bitDepth,
        fps: s.info!.fps,
      })),
    );
    return { errors: [...errors, ...v.errors], warnings: v.warnings };
  }

  function clear(): void {
    setItems([]);
    setReordered(false);
    setLocation(null);
  }

  return {
    items,
    probing: () => probing() > 0,
    location,
    setLocation,
    add,
    move,
    remove,
    sortDefault,
    check,
    clear,
  };
}

export type SessionList = ReturnType<typeof createSessionList>;
