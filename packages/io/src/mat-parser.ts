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
// Non-numeric variables (structs, cells, chars, sparse) are skipped.
//
// Reference: MAT-File Format, MathWorks (Level 5).

import { unzlibSync } from 'fflate';
import type { NpyResult, NpzResult, NumericTypedArray } from '@calab/core';

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

/**
 * Read a data-element tag at `offset`.
 *
 * Handles both the standard 8-byte tag and the "small element" compressed tag
 * (where the byte count is packed into the upper 16 bits of the first word and
 * up to 4 bytes of data follow inline). Matches scipy's read_tag logic.
 */
function readTag(view: DataView, offset: number, le: boolean): Tag {
  const raw = view.getUint32(offset, le);
  const upper = raw >>> 16;
  if (upper !== 0) {
    // Small element format: [byteCount(2) | mdtype(2)] then <=4 data bytes.
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

/**
 * Parse a single miMATRIX element body into a named NpyResult.
 *
 * Returns null for non-numeric classes (struct/cell/char/sparse/object), which
 * are skipped rather than treated as an error.
 */
function parseMatrix(
  buffer: ArrayBuffer,
  start: number,
  le: boolean,
): { name: string; result: NpyResult } | null {
  const view = new DataView(buffer);
  let off = start;

  // 1. Array flags (miUINT32, 2 words). Low byte of word 0 is the class.
  const flagsTag = readTag(view, off, le);
  const flags0 = view.getUint32(flagsTag.dataStart, le);
  const arrayClass = flags0 & 0xff;
  off = flagsTag.elementEnd;

  // 2. Dimensions (miINT32).
  const dimsTag = readTag(view, off, le);
  const ndim = Math.floor(dimsTag.byteCount / 4);
  const dims: number[] = [];
  for (let i = 0; i < ndim; i++) {
    dims.push(view.getInt32(dimsTag.dataStart + i * 4, le));
  }
  off = dimsTag.elementEnd;

  // 3. Array name (miINT8).
  const nameTag = readTag(view, off, le);
  const name = new TextDecoder('latin1')
    .decode(new Uint8Array(buffer, nameTag.dataStart, nameTag.byteCount))
    .trim();
  off = nameTag.elementEnd;

  // Skip non-numeric classes (cell, struct, object, char, sparse).
  if (arrayClass < mxDOUBLE || arrayClass > mxUINT64) {
    return null;
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

  // MATLAB stores column-major; mark Fortran order so 2D arrays get transposed.
  return { name: name || 'unnamed', result: { data, shape: dims, dtype, fortranOrder: true } };
}

/**
 * Parse a top-level data element (compressed or matrix) and add its variable
 * to `arrays`/`arrayNames` if it is a supported numeric matrix.
 */
function parseTopLevelElement(
  buffer: ArrayBuffer,
  tag: Tag,
  le: boolean,
  arrays: Record<string, NpyResult>,
  arrayNames: string[],
): void {
  if (tag.mdtype === miCOMPRESSED) {
    const compressed = new Uint8Array(buffer, tag.dataStart, tag.byteCount);
    const inflated = unzlibSync(compressed);
    // Copy to a standalone, offset-0 buffer for safe DataView/typed-array views.
    const infBuf = new Uint8Array(inflated).buffer as ArrayBuffer;
    const infView = new DataView(infBuf);
    const innerTag = readTag(infView, 0, le);
    if (innerTag.mdtype === miMATRIX) {
      const parsed = parseMatrix(infBuf, innerTag.dataStart, le);
      if (parsed) {
        arrays[parsed.name] = parsed.result;
        arrayNames.push(parsed.name);
      }
    }
    return;
  }

  if (tag.mdtype === miMATRIX) {
    const parsed = parseMatrix(buffer, tag.dataStart, le);
    if (parsed) {
      arrays[parsed.name] = parsed.result;
      arrayNames.push(parsed.name);
    }
  }
  // Other top-level element types are not expected; ignore silently.
}

/**
 * Parse a MATLAB Level 5 .mat buffer into named numeric arrays.
 *
 * @param buffer - The raw ArrayBuffer from reading a .mat file
 * @returns NpzResult with parsed arrays and their variable names
 * @throws Error for v7.3 (HDF5) files, invalid headers, or files with no
 *         numeric arrays
 */
export function parseMat(buffer: ArrayBuffer): NpzResult {
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

  let offset = 128;
  while (offset + 8 <= buffer.byteLength) {
    const tag = readTag(view, offset, littleEndian);
    // Guard against a corrupt tag that would not advance the cursor.
    if (tag.elementEnd <= offset || tag.elementEnd > buffer.byteLength) break;
    parseTopLevelElement(buffer, tag, littleEndian, arrays, arrayNames);
    offset = tag.elementEnd;
  }

  if (arrayNames.length === 0) {
    throw new Error(
      '.mat file contains no numeric arrays. CaDecon requires a numeric matrix ' +
        '(cells x timepoints) saved as a top-level variable.',
    );
  }

  return { arrays, arrayNames };
}
