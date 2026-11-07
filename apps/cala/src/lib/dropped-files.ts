/**
 * Collect the files of a drag-and-drop, descending into dropped folders.
 *
 * `webkitGetAsEntry` is the only way to read a dropped directory. Each file
 * comes back with its path as plain data (`FolderEntry.relPath`): a property
 * set on the File object would be lost when the entries are posted to the
 * frame worker, merging sibling device folders into one.
 */
import { entriesFromFiles, type FolderEntry } from './frame-source.ts';

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function walk(entry: FileSystemEntry, out: FolderEntry[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    // entry.fullPath starts with '/'.
    out.push({ file, relPath: entry.fullPath.replace(/^\//, '') });
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns results in batches until it yields an empty list.
    for (;;) {
      const batch = await readEntries(reader);
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, out);
    }
  }
}

export async function filesFromDrop(dt: DataTransfer): Promise<FolderEntry[]> {
  const roots = Array.from(dt.items ?? [])
    .map((item) => (item.kind === 'file' ? item.webkitGetAsEntry?.() : null))
    .filter((e): e is FileSystemEntry => e != null);
  if (roots.length === 0) return entriesFromFiles(Array.from(dt.files));
  const out: FolderEntry[] = [];
  for (const entry of roots) await walk(entry, out);
  return out;
}
