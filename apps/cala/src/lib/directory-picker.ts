/**
 * Opening a folder with the File System Access API (`showDirectoryPicker`,
 * Chrome and Edge). Its permission prompt says "view files", where the
 * `<input webkitdirectory>` fallback says "Upload N files to this site",
 * which is misleading: nothing leaves the computer. Both routes produce the
 * same `FolderEntry` list, so everything downstream is unchanged.
 */
import type { FolderEntry } from './frame-source.ts';

/** The slice of a directory handle the walk uses (a mock in tests). */
export interface DirHandleLike {
  kind: 'directory';
  name: string;
  values(): AsyncIterable<DirHandleLike | FileHandleLike>;
}

export interface FileHandleLike {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
}

type PickerWindow = {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<DirHandleLike>;
};

/** True where `showDirectoryPicker` exists. Safe without a `window` (SSR, node). */
export function supportsDirectoryPicker(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as PickerWindow).showDirectoryPicker === 'function'
  );
}

/** True when the user dismissed the picker. */
export function isPickerAbort(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError'
  );
}

/**
 * Walk a directory handle depth first. Each entry's `relPath` starts with the
 * root's name, as `webkitRelativePath` does. Siblings are visited in name
 * order so the list does not depend on the file system's enumeration order.
 */
export async function entriesFromDirectoryHandle(root: DirHandleLike): Promise<FolderEntry[]> {
  const out: FolderEntry[] = [];
  const walk = async (dir: DirHandleLike, prefix: string): Promise<void> => {
    const children: Array<DirHandleLike | FileHandleLike> = [];
    for await (const child of dir.values()) children.push(child);
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      const path = `${prefix}/${child.name}`;
      if (child.kind === 'directory') await walk(child, path);
      else out.push({ file: await child.getFile(), relPath: path });
    }
  };
  await walk(root, root.name);
  return out;
}

/**
 * Show the read-only directory picker and walk the chosen folder. Resolves
 * `null` when the user cancels. Other errors (SecurityError, NotAllowedError)
 * propagate to the caller.
 */
export async function pickDirectory(): Promise<FolderEntry[] | null> {
  return (await pickDirectoryWithHandle())?.entries ?? null;
}

/**
 * `pickDirectory`, also returning the handle: a multi-session run writes its
 * results next to the data (`session-export.ts`) and asks for `readwrite` on
 * this handle when the run starts.
 */
export async function pickDirectoryWithHandle(): Promise<{
  entries: FolderEntry[];
  handle: DirHandleLike;
} | null> {
  const handle = await showPicker('read');
  return handle ? { entries: await entriesFromDirectoryHandle(handle), handle } : null;
}

/** The directory picker in `mode`; null when the user cancels or there is no picker. */
export async function showPicker(mode: 'read' | 'readwrite'): Promise<DirHandleLike | null> {
  const show = (window as PickerWindow).showDirectoryPicker;
  if (!show) return null;
  try {
    return await show.call(window, { mode });
  } catch (err) {
    if (isPickerAbort(err)) return null;
    throw err;
  }
}
