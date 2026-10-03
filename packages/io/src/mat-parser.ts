// .mat parser - MATLAB Level 5 MAT-file format (v5 / v6 / v7).
//
// A .mat file is a 128-byte header followed by a sequence of "data elements",
// each of which (for the files we care about) is either a matrix (miMATRIX) or
// a zlib-compressed matrix (miCOMPRESSED). MATLAB's `save` writes each variable
// as its own top-level element, so a .mat holds multiple named variables --
// exactly like a .npz. We therefore return an NpzResult so the existing
// multi-array selection UI works unchanged.
//
// Numeric arrays are stored column-major (Fortran order), so we set
// `fortranOrder: true` and let processNpyResult() transpose 2D arrays to C
// order, identical to how Fortran-order .npy files are handled.
//
// NOT supported: v7.3 files, which are HDF5-based and require a full HDF5
// reader. These are detected and reported with a clear remediation message.
// Non-numeric variables (structs, cells, chars, sparse) are skipped, and named
// in the error if the file turns out to hold nothing else.
//
// Compressed (v7) variables are inflated in a streaming fashion against a
// decompressed-size cap (see size-limit.ts), so a zlib bomb is stopped after
// at most one chunk past the cap instead of being inflated in full. Every
// offset read from the file is bounds-checked; a truncated or corrupt file
// raises a "Not a valid .mat file" error rather than a bare RangeError.
//
// Reference: MAT-File Format, MathWorks (Level 5).

import { Unzlib } from 'fflate';
import type { NpyResult, NpzResult, NumericTypedArray } from '@calab/core';
import {
  DecompressedSizeLimitError,
  resolveSizeLimit,
  type ArchiveParseOptions,
} from './size-limit.ts';

// --- MAT data element storage types (miXXX) ---
const miINT8 = 1;
const miUINT8 = 2;
const miINT16 = 3;
const miUINT16 = 4;
const miINT32 = 5;
const miUINT32 = 6;
const miSINGLE = 7;
const miDOUBLE = 9;
const miINT64 = 12;
const miUINT64 = 13;
const miMATRIX = 14;
const miCOMPRESSED = 15;

// --- MATLAB array classes (mxXXX), stored in the low byte of the array flags ---
const mxDOUBLE = 6;
const mxUINT64 = 15;
// Numeric classes are the contiguous range mxDOUBLE(6)..mxUINT64(15). Anything
// below that (cell, struct, object, char, sparse) is skipped.

// Names for the skippable classes, so a file with no usable arrays can say what
// it did contain -- traces nested in a struct is a common MATLAB layout and an
// unexplained "no numeric arrays" is a dead end for that user.
const NON_NUMERIC_CLASS_NAMES: Record<number, string> = {
  1: 'cell array',
  2: 'struct',
  3: 'object',
  4: 'char array',
  5: 'sparse matrix',
};

interface StorageInfo {
  Ctor: new (buffer: ArrayBuffer, byteOffset: number, length: number) => NumericTypedArray;
  size: number;
  get:
    | 'getInt8'
    | 'getUint8'
    | 'getInt16'
    | 'getUint16'
    | 'getInt32'
    | 'getUint32'
    | 'getFloat32'
    | 'getFloat64';
  dtype: string;
}

const STORAGE: Record<number, StorageInfo> = {
  [miINT8]: { Ctor: Int8Array, size: 1, get: 'getInt8', dtype: '<i1' },
  [miUINT8]: { Ctor: Uint8Array, size: 1, get: 'getUint8', dtype: '<u1' },
  [miINT16]: { Ctor: Int16Array, size: 2, get: 'getInt16', dtype: '<i2' },
  [miUINT16]: { Ctor: Uint16Array, size: 2, get: 'getUint16', dtype: '<u2' },
  [miINT32]: { Ctor: Int32Array, size: 4, get: 'getInt32', dtype: '<i4' },
  [miUINT32]: { Ctor: Uint32Array, size: 4, get: 'getUint32', dtype: '<u4' },
  [miSINGLE]: { Ctor: Float32Array, size: 4, get: 'getFloat32', dtype: '<f4' },
  [miDOUBLE]: { Ctor: Float64Array, size: 8, get: 'getFloat64', dtype: '<f8' },
};

interface Tag {
  mdtype: number;
  byteCount: number;
  dataStart: number; // absolute byte offset where the element's data begins
  elementEnd: number; // absolute byte offset where the next element begins
}

/** Error for structurally invalid files (out-of-range offsets, bad sizes). */
function corrupt(detail: string): Error {
  return new Error(`Not a valid .mat file: ${detail}`);
}

/** Throw unless `[start, start + length)` lies inside `buffer`. */
function checkRange(buffer: ArrayBuffer, start: number, length: number, what: string): void {
  if (start < 0 || length < 0 || start + length > buffer.byteLength) {
    throw corrupt(
      `${what} runs past the end of the data (needs bytes ${start}..${start + length}, ` +
        `have ${buffer.byteLength}); the file is truncated or corrupt`,
    );
  }
}

// Compressed input is fed to the inflater in chunks this size, so the output
// can overshoot the cap by at most ~1032x this (deflate's maximum ratio)
// before the check fires: ~16 MiB.
const INFLATE_CHUNK_BYTES = 16 * 1024;

/** Running total of inflated bytes for one parseMat call. */
interface InflateBudget {
  used: number;
  limit: number;
}

/**
 * Inflate a zlib stream, failing as soon as the running total across the file
 * exceeds the budget -- without first materialising the whole output.
 */
function inflateCapped(compressed: Uint8Array, budget: InflateBudget): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const inflater = new Unzlib((chunk) => {
    total += chunk.length;
    if (budget.used + total > budget.limit) {
      throw new DecompressedSizeLimitError('.mat', budget.used + total, budget.limit);
    }
    chunks.push(chunk);
  });
  try {
    if (compressed.length === 0) inflater.push(compressed, true);
    for (let i = 0; i < compressed.length; i += INFLATE_CHUNK_BYTES) {
      const end = Math.min(i + INFLATE_CHUNK_BYTES, compressed.length);
      inflater.push(compressed.subarray(i, end), end === compressed.length);
    }
  } catch (err) {
    if (err instanceof DecompressedSizeLimitError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw corrupt(`compressed variable could not be decompressed (${msg})`);
  }
  budget.used += total;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Read a data-element tag at `offset`.
 *
 * Handles both the standard 8-byte tag and the "small element" compressed tag
 * (where the byte count is packed into the upper 16 bits of the first word and
 * up to 4 bytes of data follow inline). Matches scipy's read_tag logic.
 */
function readTag(view: DataView, offset: number, le: boolean): Tag {
  checkRange(view.buffer as ArrayBuffer, offset, 8, 'data element tag');
  const raw = view.getUint32(offset, le);
  const upper = raw >>> 16;
  if (upper !== 0) {
    // Small element format: [byteCount(2) | mdtype(2)] then <=4 data bytes.
    // A count above 4 means we are not looking at a real tag, so stop rather
    // than let a misread cascade into bogus offsets.
    if (upper > 4) {
      throw new Error(
        `Not a valid .mat file: small data element claims ${upper} bytes (maximum is 4)`,
      );
    }
    return {
      mdtype: raw & 0xffff,
      byteCount: upper,
      dataStart: offset + 4,
      elementEnd: offset + 8,
    };
  }
  // Standard format: 4-byte type, 4-byte count, then data.
  const mdtype = raw;
  const byteCount = view.getUint32(offset + 4, le);
  const dataStart = offset + 8;
  // Data is padded to an 8-byte boundary, EXCEPT compressed elements, which
  // the MAT spec explicitly leaves unpadded (scipy/MATLAB write them flush).
  const padded = mdtype === miCOMPRESSED ? byteCount : byteCount + ((8 - (byteCount % 8)) % 8);
  return { mdtype, byteCount, dataStart, elementEnd: dataStart + padded };
}

/**
 * Read a numeric data element into a typed array.
 *
 * Uses a zero-copy view when the data is little-endian and correctly aligned;
 * otherwise copies element-by-element via DataView (handles big-endian files
 * and unaligned offsets). 64-bit integers are widened to Float64 since JS typed
 * arrays used downstream are not BigInt-based.
 */
function readNumericData(
  buffer: ArrayBuffer,
  dataStart: number,
  byteCount: number,
  mdtype: number,
  le: boolean,
): { data: NumericTypedArray; dtype: string } {
  checkRange(buffer, dataStart, byteCount, 'numeric data');
  if (mdtype === miINT64 || mdtype === miUINT64) {
    const view = new DataView(buffer);
    const count = Math.floor(byteCount / 8);
    const out = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const v =
        mdtype === miINT64
          ? view.getBigInt64(dataStart + i * 8, le)
          : view.getBigUint64(dataStart + i * 8, le);
      out[i] = Number(v);
    }
    return { data: out, dtype: '<f8' };
  }

  const info = STORAGE[mdtype];
  if (!info) {
    throw new Error(`Unsupported .mat numeric storage type: ${mdtype}`);
  }
  const count = Math.floor(byteCount / info.size);

  // Zero-copy view when safe.
  if (le && dataStart % info.size === 0) {
    return { data: new info.Ctor(buffer, dataStart, count), dtype: info.dtype };
  }

  // Fallback: copy via DataView (big-endian or unaligned).
  const view = new DataView(buffer);
  const arr = new info.Ctor(new ArrayBuffer(count * info.size), 0, count);
  const getter = info.get;
  for (let i = 0; i < count; i++) {
    arr[i] = view[getter](dataStart + i * info.size, le) as number;
  }
  return { data: arr, dtype: info.dtype };
}

/** A parsed numeric variable, or the reason a variable was passed over. */
type MatrixEntry = { name: string; result: NpyResult } | { name: string; skipped: string };

/**
 * Parse a single miMATRIX element body into a named NpyResult.
 *
 * Non-numeric classes (struct/cell/char/sparse/object) are reported as skipped
 * rather than treated as an error, so the caller can name them if nothing
 * usable turns up.
 */
function parseMatrix(buffer: ArrayBuffer, start: number, le: boolean): MatrixEntry {
  const view = new DataView(buffer);
  let off = start;

  // 1. Array flags (miUINT32, 2 words). Low byte of word 0 is the class.
  const flagsTag = readTag(view, off, le);
  checkRange(buffer, flagsTag.dataStart, 4, 'array flags');
  const flags0 = view.getUint32(flagsTag.dataStart, le);
  const arrayClass = flags0 & 0xff;
  off = flagsTag.elementEnd;

  // 2. Dimensions (miINT32).
  const dimsTag = readTag(view, off, le);
  checkRange(buffer, dimsTag.dataStart, dimsTag.byteCount, 'array dimensions');
  const ndim = Math.floor(dimsTag.byteCount / 4);
  const dims: number[] = [];
  for (let i = 0; i < ndim; i++) {
    dims.push(view.getInt32(dimsTag.dataStart + i * 4, le));
  }
  off = dimsTag.elementEnd;

  // 3. Array name (miINT8).
  const nameTag = readTag(view, off, le);
  checkRange(buffer, nameTag.dataStart, nameTag.byteCount, 'array name');
  const name = new TextDecoder('latin1')
    .decode(new Uint8Array(buffer, nameTag.dataStart, nameTag.byteCount))
    .trim();
  off = nameTag.elementEnd;

  // Skip non-numeric classes (cell, struct, object, char, sparse).
  if (arrayClass < mxDOUBLE || arrayClass > mxUINT64) {
    return {
      name: name || 'unnamed',
      skipped: NON_NUMERIC_CLASS_NAMES[arrayClass] ?? `class ${arrayClass}`,
    };
  }

  const label = name || 'unnamed';
  if (dims.length < 2 || dims.some((d) => d < 0)) {
    throw corrupt(`variable "${label}" has invalid dimensions [${dims.join(', ')}]`);
  }
  const expected = dims.reduce((a, b) => a * b, 1);
  if (!Number.isSafeInteger(expected)) {
    throw corrupt(`variable "${label}" dimensions [${dims.join(', ')}] overflow`);
  }

  // 4. Real part (pr). Imaginary part, if present, is ignored.
  const prTag = readTag(view, off, le);
  const { data, dtype } = readNumericData(
    buffer,
    prTag.dataStart,
    prTag.byteCount,
    prTag.mdtype,
    le,
  );

  if (data.length !== expected) {
    throw corrupt(
      `variable "${label}" declares dimensions [${dims.join(', ')}] (${expected} elements) ` +
        `but stores ${data.length}`,
    );
  }

  // MATLAB stores column-major; mark Fortran order so 2D arrays get transposed.
  return { name: label, result: { data, shape: dims, dtype, fortranOrder: true } };
}

/**
 * Parse a top-level data element (compressed or matrix) into `arrays` /
 * `arrayNames`, recording non-numeric variables in `skipped` instead.
 */
function parseTopLevelElement(
  buffer: ArrayBuffer,
  tag: Tag,
  le: boolean,
  arrays: Record<string, NpyResult>,
  arrayNames: string[],
  skipped: string[],
  budget: InflateBudget,
): void {
  const collect = (entry: MatrixEntry): void => {
    if ('skipped' in entry) {
      skipped.push(`${entry.name} (${entry.skipped})`);
      return;
    }
    arrays[entry.name] = entry.result;
    arrayNames.push(entry.name);
  };

  if (tag.mdtype === miCOMPRESSED) {
    const compressed = new Uint8Array(buffer, tag.dataStart, tag.byteCount);
    // inflateCapped returns a fresh, offset-0 buffer, safe for DataView/typed-array views.
    const infBuf = inflateCapped(compressed, budget).buffer as ArrayBuffer;
    const infView = new DataView(infBuf);
    const innerTag = readTag(infView, 0, le);
    if (innerTag.mdtype === miMATRIX) {
      collect(parseMatrix(infBuf, innerTag.dataStart, le));
    }
    return;
  }

  if (tag.mdtype === miMATRIX) {
    collect(parseMatrix(buffer, tag.dataStart, le));
  }
  // Other top-level element types are not expected; ignore silently.
}

/**
 * Parse a MATLAB Level 5 .mat buffer into named numeric arrays.
 *
 * @param buffer - The raw ArrayBuffer from reading a .mat file
 * @param options - Optional cap on the total bytes inflated from compressed
 *        (v7) variables; default 1 GiB (`DEFAULT_MAX_DECOMPRESSED_BYTES`)
 * @returns NpzResult with parsed arrays and their variable names
 * @throws DecompressedSizeLimitError if compressed variables inflate past the cap
 * @throws Error for v7.3 (HDF5) files, invalid headers, truncated or corrupt
 *         data, or files with no numeric arrays
 */
export function parseMat(buffer: ArrayBuffer, options?: ArchiveParseOptions): NpzResult {
  const budget: InflateBudget = { used: 0, limit: resolveSizeLimit(options) };
  if (buffer.byteLength < 128) {
    throw new Error('Not a valid .mat file: file too small for header');
  }

  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  // Header description text (bytes 0-115). MATLAB writes a signature here.
  const desc = new TextDecoder('latin1').decode(bytes.subarray(0, 116));

  // v7.3 files are HDF5-based ("MATLAB 7.3 MAT-file..." signature, or a raw
  // HDF5 magic \x89HDF). We cannot parse HDF5 without a heavy dependency.
  const isHdf5Magic =
    bytes[0] === 0x89 && bytes[1] === 0x48 && bytes[2] === 0x44 && bytes[3] === 0x46;
  if (/MATLAB 7\.3/.test(desc) || isHdf5Magic) {
    throw new Error(
      'This is a MATLAB v7.3 (HDF5) .mat file, which is not supported. ' +
        "Re-save in MATLAB with save('file.mat', 'var', '-v7') or export the " +
        'array to .npy / .npz.',
    );
  }

  // Endian indicator (bytes 126-127): 'IM' => little-endian, 'MI' => big-endian.
  const e0 = bytes[126];
  const e1 = bytes[127];
  let littleEndian: boolean;
  if (e0 === 0x49 && e1 === 0x4d) {
    littleEndian = true;
  } else if (e0 === 0x4d && e1 === 0x49) {
    littleEndian = false;
  } else {
    throw new Error('Not a valid .mat file: missing endian indicator (expected v5/v6/v7 format)');
  }

  const arrays: Record<string, NpyResult> = {};
  const arrayNames: string[] = [];
  const skipped: string[] = [];

  let offset = 128;
  while (offset + 8 <= buffer.byteLength) {
    const tag = readTag(view, offset, littleEndian);
    const isVariable = tag.mdtype === miMATRIX || tag.mdtype === miCOMPRESSED;
    // A variable whose data runs past the end of the file is a truncated
    // download or a corrupt file: say so instead of silently dropping it (only
    // the last element's alignment padding may be missing). Anything else past
    // the end (trailing padding/garbage) just ends the scan.
    if (tag.dataStart + tag.byteCount > buffer.byteLength) {
      if (isVariable) {
        throw corrupt(
          `variable at byte ${offset} claims ${tag.byteCount} bytes but only ` +
            `${buffer.byteLength - tag.dataStart} remain; the file is truncated or corrupt`,
        );
      }
      break;
    }
    // Guard against a corrupt tag that would not advance the cursor.
    if (tag.elementEnd <= offset) break;
    parseTopLevelElement(buffer, tag, littleEndian, arrays, arrayNames, skipped, budget);
    offset = tag.elementEnd;
  }
  // Fewer than 8 bytes left: zero padding is harmless, anything else is the
  // start of a tag that was cut off.
  if (offset < buffer.byteLength && offset + 8 > buffer.byteLength) {
    if (bytes.subarray(offset).some((b) => b !== 0)) {
      throw corrupt(
        `${buffer.byteLength - offset} stray bytes at the end; the file is truncated or corrupt`,
      );
    }
  }

  if (arrayNames.length === 0) {
    // Name what was skipped: arrays nested inside a struct or cell are invisible
    // to this reader, and that is the most likely reason a real file lands here.
    const found = skipped.length > 0 ? ` Found instead: ${skipped.join(', ')}.` : '';
    throw new Error(
      '.mat file contains no numeric arrays. Expected a numeric matrix ' +
        `(cells x timepoints) saved as a top-level variable.${found} Arrays nested ` +
        'inside a struct or cell are not read -- save the matrix itself with ' +
        "save('traces.mat', 'traces', '-v7').",
    );
  }

  return { arrays, arrayNames };
}
