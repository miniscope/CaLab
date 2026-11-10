// Incremental, store-only ZIP writer with ZIP64, for archives too big to hold in memory.
//
// `zipFiles` (fflate) builds the whole archive in memory and writes 32-bit
// sizes only, so any entry of 4 GiB or more is corrupt. This writer pushes
// bytes to a sink as they are produced and writes the ZIP64 records (extended
// local/central extra fields, ZIP64 end-of-central-directory record and
// locator) whenever an entry or the archive needs them. Entries are stored
// uncompressed (what `np.savez` does).
//
// Two ways to add an entry:
//   - `addFile(name, bytes)`: whole entry in hand, CRC known, no data descriptor;
//   - `addStream(name, size, chunks)`: the size is declared up front (the
//     local header carries it), chunks are written as they arrive and the CRC
//     follows in a data descriptor (general-purpose flag bit 3).
// Readers that go through the central directory (Python's zipfile, numpy,
// unzip, 7-zip) read both. Entries use ZIP64 when 4 GiB or more, or when the
// writer is created with `forceZip64` (for testing the ZIP64 records on a small file).

/** Where bytes go. A sink must not transfer or keep a chunk past its `write` promise unless it copies it. */
export interface ByteSink {
  write(chunk: Uint8Array): void | Promise<void>;
}

const U32_MAX = 0xffff_ffff;
const U16_MAX = 0xffff;
const TWO32 = 2 ** 32;

// CRC-32 (IEEE), slice-by-8.
const CRC_TABLES: Uint32Array[] = (() => {
  const t0 = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t0[n] = c >>> 0;
  }
  const tables = [t0];
  for (let s = 1; s < 8; s++) {
    const prev = tables[s - 1];
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) t[n] = (t0[prev[n] & 0xff] ^ (prev[n] >>> 8)) >>> 0;
    tables.push(t);
  }
  return tables;
})();

/** CRC-32 of `data`, continuing from `prev` (0 to start). */
export function crc32(data: Uint8Array, prev = 0): number {
  const [t0, t1, t2, t3, t4, t5, t6, t7] = CRC_TABLES;
  let c = ~prev;
  let i = 0;
  const n = data.length;
  for (; i + 8 <= n; i += 8) {
    const a = data[i] ^ (c & 0xff);
    const b = data[i + 1] ^ ((c >>> 8) & 0xff);
    const d = data[i + 2] ^ ((c >>> 16) & 0xff);
    const e = data[i + 3] ^ (c >>> 24);
    c =
      t7[a] ^
      t6[b] ^
      t5[d] ^
      t4[e] ^
      t3[data[i + 4]] ^
      t2[data[i + 5]] ^
      t1[data[i + 6]] ^
      t0[data[i + 7]];
  }
  for (; i < n; i++) c = t0[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function setU64(v: DataView, at: number, value: number): void {
  v.setUint32(at, value % TWO32, true);
  v.setUint32(at + 4, Math.floor(value / TWO32), true);
}

interface Entry {
  nameBytes: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  /** Sizes are stored as ZIP64 (extra field with 8-byte sizes). */
  big: boolean;
  flags: number;
}

export interface ZipStreamOptions {
  /** Write every entry and the end records as ZIP64, whatever the sizes. */
  forceZip64?: boolean;
  /** Modification time for every entry (default: now). */
  mtime?: Date;
}

export class ZipStreamWriter {
  private readonly entries: Entry[] = [];
  private readonly force: boolean;
  private readonly dosTime: number;
  private readonly dosDate: number;
  private readonly sink: ByteSink;
  private pos = 0;
  private finished = false;

  constructor(sink: ByteSink, options: ZipStreamOptions = {}) {
    this.sink = sink;
    this.force = options.forceZip64 === true;
    const d = options.mtime ?? new Date();
    this.dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    this.dosDate =
      (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  }

  /** Bytes written so far. */
  get bytesWritten(): number {
    return this.pos;
  }

  private async put(chunk: Uint8Array): Promise<void> {
    this.pos += chunk.length;
    await this.sink.write(chunk);
  }

  private localHeader(
    nameBytes: Uint8Array,
    flags: number,
    crc: number,
    size: number,
    big: boolean,
  ): Uint8Array {
    const extra = big ? 20 : 0;
    const out = new Uint8Array(30 + nameBytes.length + extra);
    const v = new DataView(out.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, big ? 45 : 20, true);
    v.setUint16(6, flags, true);
    v.setUint16(8, 0, true); // stored
    v.setUint16(10, this.dosTime, true);
    v.setUint16(12, this.dosDate, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, big ? U32_MAX : size, true);
    v.setUint32(22, big ? U32_MAX : size, true);
    v.setUint16(26, nameBytes.length, true);
    v.setUint16(28, extra, true);
    out.set(nameBytes, 30);
    if (big) {
      const e = 30 + nameBytes.length;
      v.setUint16(e, 1, true);
      v.setUint16(e + 2, 16, true);
      setU64(v, e + 4, size); // uncompressed
      setU64(v, e + 12, size); // compressed (stored)
    }
    return out;
  }

  private begin(name: string, size: number): { nameBytes: Uint8Array; big: boolean } {
    if (this.finished) throw new Error('The archive is finished.');
    if (!Number.isSafeInteger(size) || size < 0) throw new RangeError(`Bad entry size ${size}.`);
    return { nameBytes: new TextEncoder().encode(name), big: this.force || size >= U32_MAX };
  }

  /** Add an entry from bytes in hand. */
  async addFile(name: string, data: Uint8Array): Promise<void> {
    const { nameBytes, big } = this.begin(name, data.length);
    const flags = 0x800; // UTF-8 names
    const crc = crc32(data);
    const offset = this.pos;
    await this.put(this.localHeader(nameBytes, flags, crc, data.length, big));
    if (data.length > 0) await this.put(data);
    this.entries.push({ nameBytes, crc, size: data.length, offset, big, flags });
  }

  /**
   * Add an entry whose `size` is known but whose bytes arrive as chunks. The
   * chunks must total `size` exactly.
   */
  async addStream(
    name: string,
    size: number,
    chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): Promise<void> {
    const { nameBytes, big } = this.begin(name, size);
    const flags = 0x808; // UTF-8 names, data descriptor
    const offset = this.pos;
    await this.put(this.localHeader(nameBytes, flags, 0, size, big));
    let crc = 0;
    let written = 0;
    for await (const chunk of chunks) {
      crc = crc32(chunk, crc);
      written += chunk.length;
      if (written > size) throw new RangeError(`${name}: more than the declared ${size} bytes.`);
      await this.put(chunk);
    }
    if (written !== size) {
      throw new RangeError(`${name}: ${written} bytes written, ${size} declared.`);
    }
    const dd = new Uint8Array(big ? 24 : 16);
    const v = new DataView(dd.buffer);
    v.setUint32(0, 0x08074b50, true);
    v.setUint32(4, crc, true);
    if (big) {
      setU64(v, 8, size);
      setU64(v, 16, size);
    } else {
      v.setUint32(8, size, true);
      v.setUint32(12, size, true);
    }
    await this.put(dd);
    this.entries.push({ nameBytes, crc, size, offset, big, flags });
  }

  /** Write the central directory and end records. */
  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const cdStart = this.pos;
    for (const e of this.entries) {
      const bigOffset = e.offset >= U32_MAX;
      const zip64 = e.big || bigOffset;
      const fields = (e.big ? 16 : 0) + (bigOffset ? 8 : 0);
      const extra = zip64 ? 4 + fields : 0;
      const out = new Uint8Array(46 + e.nameBytes.length + extra);
      const v = new DataView(out.buffer);
      v.setUint32(0, 0x02014b50, true);
      v.setUint16(4, zip64 ? 45 : 20, true); // made by
      v.setUint16(6, zip64 ? 45 : 20, true); // needed
      v.setUint16(8, e.flags, true);
      v.setUint16(10, 0, true);
      v.setUint16(12, this.dosTime, true);
      v.setUint16(14, this.dosDate, true);
      v.setUint32(16, e.crc, true);
      v.setUint32(20, e.big ? U32_MAX : e.size, true);
      v.setUint32(24, e.big ? U32_MAX : e.size, true);
      v.setUint16(28, e.nameBytes.length, true);
      v.setUint16(30, extra, true);
      v.setUint32(42, bigOffset ? U32_MAX : e.offset, true);
      out.set(e.nameBytes, 46);
      if (zip64) {
        let at = 46 + e.nameBytes.length;
        v.setUint16(at, 1, true);
        v.setUint16(at + 2, fields, true);
        at += 4;
        if (e.big) {
          setU64(v, at, e.size);
          setU64(v, at + 8, e.size);
          at += 16;
        }
        if (bigOffset) setU64(v, at, e.offset);
      }
      await this.put(out);
    }
    const cdSize = this.pos - cdStart;
    const count = this.entries.length;
    const needZip64 = this.force || count >= U16_MAX || cdStart >= U32_MAX || cdSize >= U32_MAX;
    if (needZip64) {
      const rec = new Uint8Array(56 + 20);
      const v = new DataView(rec.buffer);
      v.setUint32(0, 0x06064b50, true);
      setU64(v, 4, 44);
      v.setUint16(12, 45, true);
      v.setUint16(14, 45, true);
      v.setUint32(16, 0, true);
      v.setUint32(20, 0, true);
      setU64(v, 24, count);
      setU64(v, 32, count);
      setU64(v, 40, cdSize);
      setU64(v, 48, cdStart);
      v.setUint32(56, 0x07064b50, true);
      v.setUint32(60, 0, true);
      setU64(v, 64, this.pos); // offset of the ZIP64 end record
      v.setUint32(72, 1, true);
      await this.put(rec);
    }
    const eocd = new Uint8Array(22);
    const v = new DataView(eocd.buffer);
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(8, needZip64 ? U16_MAX : count, true);
    v.setUint16(10, needZip64 ? U16_MAX : count, true);
    v.setUint32(12, needZip64 ? U32_MAX : cdSize, true);
    v.setUint32(16, needZip64 ? U32_MAX : cdStart, true);
    await this.put(eocd);
  }
}
