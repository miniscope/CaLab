/**
 * Collect the files of a drag-and-drop, descending into dropped folders.
 *
 * `webkitGetAsEntry` is the only way to read a dropped directory. Files found
 * that way carry no `webkitRelativePath`, so it is defined on each File (the
 * frame source groups files by it, exactly as for a `webkitdirectory` input).
 */

function withPath(file: File, path: string): File {
  Object.defineProperty(file, 'webkitRelativePath', { value: path, configurable: true });
  return file;
}

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function walk(entry: FileSystemEntry, out: File[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    // entry.fullPath starts with '/'.
    out.push(withPath(file, entry.fullPath.replace(/^\//, '')));
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

export async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries = Array.from(dt.items ?? [])
    .map((item) => (item.kind === 'file' ? item.webkitGetAsEntry?.() : null))
    .filter((e): e is FileSystemEntry => e != null);
  if (entries.length === 0) return Array.from(dt.files);
  const out: File[] = [];
  for (const entry of entries) await walk(entry, out);
  return out;
}
