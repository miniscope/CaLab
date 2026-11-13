// Lazy ZIP reader (ZIP64-aware) over a Blob or File, for archives too big to load whole.
//
// `parseNpz` (fflate) reads the whole archive into memory, caps what it
// decompresses and reads no ZIP64 records. This reader reads only the end of
// the file and its central directory up front; each entry is then read on
// demand, and a stored (uncompressed) entry can be read in byte ranges, so a
// multi-GB `traces.npy` is never in memory at once. It reads what
// `ZipStreamWriter` and `np.savez` write (stored entries, ZIP64 when needed)
// and also deflated entries (`np.savez_compressed`), whole, through the
// platform's `DecompressionStream('deflate-raw')`.

/** Something with `size` and `slice(start, end).arrayBuffer()` (a Blob or File). */
export interface ZipSource {
  readonly size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

/** One entry of the central directory. */
export interface ZipEntry {
  name: string;
  /** 0 stored, 8 deflated. */
  method: number;
  compressedSize: number;
  size: number;
  /** Offset of the entry's local header. */
  localOffset: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const U32_MAX = 0xffff_ffff;
const U16_MAX = 0xffff;
const TWO32 = 2 ** 32;
/** The end-of-central-directory record is at most 22 bytes plus a 64 KiB comment from the end. */
const EOCD_SEARCH = 22 + 65535;

async function bytesAt(src: ZipSource, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await src.slice(start, Math.min(end, src.size)).arrayBuffer());
}

function u64(v: DataView, o: number): number {
  return v.getUint32(o, true) + v.getUint32(o + 4, true) * TWO32;
}

export class ZipArchive {
  private readonly byName: Map<string, ZipEntry>;
  /** Data offsets found from the local headers, by entry name. */
  private readonly dataStarts = new Map<string, number>();

  private constructor(
    private readonly src: ZipSource,
    readonly entries: readonly ZipEntry[],
  ) {
    this.byName = new Map(entries.map((e) => [e.name, e]));
  }

  /** Read the directory of `src` (its tail only). Throws when it is not a ZIP archive. */
  static async open(src: ZipSource): Promise<ZipArchive> {
    const size = src.size;
    if (size < 22) throw new Error('Not a ZIP archive: the file is too small.');
    const tailStart = Math.max(0, size - EOCD_SEARCH);
    const tail = await bytesAt(src, tailStart, size);
    const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tv.getUint32(i, true) === SIG_EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('Not a ZIP archive: no end-of-central-directory record.');
    let count = tv.getUint16(eocd + 10, true);
    let cdSize = tv.getUint32(eocd + 12, true);
    let cdOffset = tv.getUint32(eocd + 16, true);
    if (count === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
      // ZIP64: the locator sits just before the EOCD record.
      const locAt = tailStart + eocd - 20;
      const loc = await bytesAt(src, locAt, locAt + 20);
      const lv = new DataView(loc.buffer, loc.byteOffset, loc.byteLength);
      if (loc.length < 20 || lv.getUint32(0, true) !== SIG_ZIP64_LOCATOR)
        throw new Error('Damaged ZIP64 archive: no ZIP64 locator.');
      const recAt = u64(lv, 8);
      const rec = await bytesAt(src, recAt, recAt + 56);
      const rv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
      if (rec.length < 56 || rv.getUint32(0, true) !== SIG_ZIP64_EOCD)
        throw new Error('Damaged ZIP64 archive: no ZIP64 end-of-central-directory record.');
      count = u64(rv, 32);
      cdSize = u64(rv, 40);
      cdOffset = u64(rv, 48);
    }
    if (cdOffset + cdSize > size) throw new Error('Damaged ZIP archive: truncated directory.');
    const cd = await bytesAt(src, cdOffset, cdOffset + cdSize);
    const v = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
    const entries: ZipEntry[] = [];
    let p = 0;
    const utf8 = new TextDecoder();
    for (let k = 0; k < count; k++) {
      if (p + 46 > cd.length || v.getUint32(p, true) !== SIG_CENTRAL)
        throw new Error('Damaged ZIP archive: bad central directory entry.');
      const method = v.getUint16(p + 10, true);
      let compressedSize = v.getUint32(p + 20, true);
      let usize = v.getUint32(p + 24, true);
      const nameLen = v.getUint16(p + 28, true);
      const extraLen = v.getUint16(p + 30, true);
      const commentLen = v.getUint16(p + 32, true);
      let localOffset = v.getUint32(p + 42, true);
      const name = utf8.decode(cd.subarray(p + 46, p + 46 + nameLen));
      // ZIP64 extended information: the 64-bit values of the fields that are 0xffffffff, in order.
      let e = p + 46 + nameLen;
      const extraEnd = e + extraLen;
      while (e + 4 <= extraEnd) {
        const id = v.getUint16(e, true);
        const len = v.getUint16(e + 2, true);
        if (id === 0x0001) {
          let q = e + 4;
          if (usize === U32_MAX) {
            usize = u64(v, q);
            q += 8;
          }
          if (compressedSize === U32_MAX) {
            compressedSize = u64(v, q);
            q += 8;
          }
          if (localOffset === U32_MAX) localOffset = u64(v, q);
        }
        e += 4 + len;
      }
      entries.push({ name, method, compressedSize, size: usize, localOffset });
      p = extraEnd + commentLen;
    }
    return new ZipArchive(src, entries);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  entry(name: string): ZipEntry {
    const e = this.byName.get(name);
    if (!e) throw new Error(`The archive has no ${name}.`);
    return e;
  }

  /** Offset of an entry's data in the file (read from its local header once). */
  async dataStart(name: string): Promise<number> {
    const known = this.dataStarts.get(name);
    if (known !== undefined) return known;
    const e = this.entry(name);
    const h = await bytesAt(this.src, e.localOffset, e.localOffset + 30);
    const hv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    if (h.length < 30 || hv.getUint32(0, true) !== SIG_LOCAL)
      throw new Error(`Damaged ZIP archive: bad local header for ${name}.`);
    const start = e.localOffset + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
    this.dataStarts.set(name, start);
    return start;
  }

  /** The whole entry, decompressed. */
  async read(name: string): Promise<Uint8Array> {
    const e = this.entry(name);
    const start = await this.dataStart(name);
    const raw = await bytesAt(this.src, start, start + e.compressedSize);
    if (e.method === 0) return raw;
    if (e.method !== 8) throw new Error(`${name} uses an unsupported compression (${e.method}).`);
    const stream = new Blob([raw as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /**
   * Bytes `[from, to)` of a stored entry (no decompression; a deflated entry
   * is read whole and sliced).
   */
  async readRange(name: string, from: number, to: number): Promise<Uint8Array> {
    const e = this.entry(name);
    if (from < 0 || to < from || to > e.size)
      throw new RangeError(`Bytes ${from}..${to} are not in ${name} (${e.size} bytes).`);
    if (e.method !== 0) return (await this.read(name)).subarray(from, to);
    const start = await this.dataStart(name);
    return bytesAt(this.src, start + from, start + to);
  }
}
