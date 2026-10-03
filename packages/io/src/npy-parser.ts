// .npy binary format parser
// Parses NumPy .npy files into typed arrays with shape, dtype, and fortran_order metadata.
// Reference: https://numpy.org/doc/2.3/reference/generated/numpy.lib.format.html

import type { NpyResult, NumericTypedArray } from '@calab/core';

// Magic bytes: \x93NUMPY
const NPY_MAGIC = new Uint8Array([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]);

type TypedArrayCtor = {
  new (length: number): NumericTypedArray;
  new (buffer: ArrayBuffer, byteOffset: number, length: number): NumericTypedArray;
};

/** How one numpy element kind+size (e.g. `f4`) is decoded. */
interface DtypeInfo {
  /** Bytes per element on disk. */
  bytes: number;
  /** Typed array the elements are returned in. */
  out: TypedArrayCtor;
  /**
   * True when `out` has the same in-memory layout as the on-disk element, so a
   * little-endian, aligned buffer can be viewed without copying.
   */
  viewable: boolean;
  /** Read element `i` from `view` at `offset` (used for every non-view path). */
  read: (view: DataView, offset: number, littleEndian: boolean) => number;
}

/** IEEE 754 binary16 -> number. (DataView.getFloat16 is not yet universal.) */
function readFloat16(view: DataView, offset: number, littleEndian: boolean): number {
  const h = view.getUint16(offset, littleEndian);
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign * frac * 2 ** -24; // zero / subnormal
  if (exp === 0x1f) return frac ? NaN : sign * Infinity;
  return sign * (1 + frac / 1024) * 2 ** (exp - 15);
}

// Keyed by numpy's kind + itemsize (the descr without its byte-order char).
// 64-bit integers are widened to Float64 (exact up to 2^53; the downstream
// pipeline is floating point anyway), float16 to Float32, and bool to Uint8
// (0/1) -- the same choices as the .mat reader.
const DTYPES: Record<string, DtypeInfo> = {
  f8: { bytes: 8, out: Float64Array, viewable: true, read: (v, o, le) => v.getFloat64(o, le) },
  f4: { bytes: 4, out: Float32Array, viewable: true, read: (v, o, le) => v.getFloat32(o, le) },
  f2: { bytes: 2, out: Float32Array, viewable: false, read: readFloat16 },
  i8: {
    bytes: 8,
    out: Float64Array,
    viewable: false,
    read: (v, o, le) => Number(v.getBigInt64(o, le)),
  },
  i4: { bytes: 4, out: Int32Array, viewable: true, read: (v, o, le) => v.getInt32(o, le) },
  i2: { bytes: 2, out: Int16Array, viewable: true, read: (v, o, le) => v.getInt16(o, le) },
  i1: { bytes: 1, out: Int8Array, viewable: true, read: (v, o) => v.getInt8(o) },
  u8: {
    bytes: 8,
    out: Float64Array,
    viewable: false,
    read: (v, o, le) => Number(v.getBigUint64(o, le)),
  },
  u4: { bytes: 4, out: Uint32Array, viewable: true, read: (v, o, le) => v.getUint32(o, le) },
  u2: { bytes: 2, out: Uint16Array, viewable: true, read: (v, o, le) => v.getUint16(o, le) },
  u1: { bytes: 1, out: Uint8Array, viewable: true, read: (v, o) => v.getUint8(o) },
  // numpy bools are one byte, 0 or 1. Normalise anything else to 1.
  b1: { bytes: 1, out: Uint8Array, viewable: false, read: (v, o) => (v.getUint8(o) ? 1 : 0) },
};

const SUPPORTED_DTYPES_TEXT =
  'float16/32/64, int8/16/32/64, uint8/16/32/64 and bool, in either byte order';

/**
 * Parse a numpy dtype descriptor (`'<f8'`, `'>i4'`, `'|u1'`, `'|b1'`, ...)
 * into its decoder and byte order.
 */
function parseDescr(descr: string): { info: DtypeInfo; littleEndian: boolean } {
  const order = descr[0];
  const info = DTYPES[descr.slice(1)];
  // '|' (not applicable) is only valid for single-byte types; '=' (native) is
  // never written to files by numpy, so treat it as unknown.
  const orderOk = order === '<' || order === '>' || (order === '|' && info?.bytes === 1);
  if (!info || !orderOk) {
    throw new Error(
      `Unsupported dtype "${descr}". Only plain numeric arrays are supported ` +
        `(${SUPPORTED_DTYPES_TEXT}); convert with arr.astype("float32").`,
    );
  }
  return { info, littleEndian: order !== '>' };
}

/**
 * Parse the shape tuple body (e.g. `"3, 4"`, `"5,"`, `""`) and return the
 * shape plus its element count, rejecting anything that is not a tuple of
 * non-negative integers whose product is exactly representable.
 */
function parseShape(shapeStr: string): { shape: number[]; count: number } {
  const parts = shapeStr
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const shape: number[] = [];
  let count = 1; // a 0-d (scalar) array has one element
  for (const p of parts) {
    // numpy may write Python longs as `3L` in old (py2-era) files.
    const m = /^(\d+)L?$/.exec(p);
    const dim = m ? Number(m[1]) : NaN;
    if (!Number.isSafeInteger(dim)) {
      throw new Error(
        `Failed to parse .npy header: invalid dimension "${p}" in shape (${shapeStr})`,
      );
    }
    shape.push(dim);
    count *= dim;
    if (!Number.isSafeInteger(count)) {
      throw new Error(`Invalid .npy shape (${shapeStr}): element count overflows`);
    }
  }
  return { shape, count };
}

/**
 * Parse a .npy binary buffer into a typed array with metadata.
 *
 * Supported dtypes: float16/32/64, int8/16/32/64, uint8/16/32/64 and bool,
 * little- or big-endian. Little-endian float32/64 and 8-32-bit integers are
 * returned as zero-copy views where alignment allows; everything else is
 * decoded into a new array (float16 -> Float32Array, 64-bit integers ->
 * Float64Array, bool -> Uint8Array of 0/1, big-endian -> native order).
 * `dtype` in the result is always the on-disk descriptor (e.g. `'>i8'`), so it
 * can be shown to the user as-is.
 *
 * Fortran-order arrays are returned as stored with `fortranOrder: true`;
 * `processNpyResult` transposes 2D ones to C order.
 *
 * @param buffer - The raw ArrayBuffer from reading a .npy file
 * @returns NpyResult with typed data array, shape, dtype string, and fortran_order flag
 * @throws Error for invalid magic bytes, unsupported dtypes, malformed or
 *         overflowing shapes, truncated files, or corrupted headers
 */
export function parseNpy(buffer: ArrayBuffer): NpyResult {
  // Guard: buffer must be at least large enough for magic + version
  if (buffer.byteLength < 8) {
    throw new Error('Not a valid .npy file: file too small');
  }

  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // 1. Verify magic bytes: \x93NUMPY
  for (let i = 0; i < NPY_MAGIC.length; i++) {
    if (bytes[i] !== NPY_MAGIC[i]) {
      throw new Error('Not a valid .npy file: incorrect magic bytes');
    }
  }

  // 2. Read version
  const majorVersion = view.getUint8(6);
  const minorVersion = view.getUint8(7);

  // 3. Read header length (2 bytes for v1.0, 4 bytes for v2.0+)
  let headerLen: number;
  let headerOffset: number;

  if (majorVersion === 1) {
    if (buffer.byteLength < 10) {
      throw new Error('Not a valid .npy file: file too small for v1 header');
    }
    headerLen = view.getUint16(8, true); // little-endian
    headerOffset = 10;
  } else if (majorVersion >= 2) {
    if (buffer.byteLength < 12) {
      throw new Error('Not a valid .npy file: file too small for v2 header');
    }
    headerLen = view.getUint32(8, true); // little-endian, 4 bytes
    headerOffset = 12;
  } else {
    throw new Error(`Unsupported .npy version: ${majorVersion}.${minorVersion}`);
  }

  // 4. Parse header string (Python dict literal; ASCII for v1/v2, UTF-8 for v3)
  if (buffer.byteLength < headerOffset + headerLen) {
    throw new Error('Not a valid .npy file: file truncated in header');
  }
  const headerBytes = new Uint8Array(buffer, headerOffset, headerLen);
  const headerStr = new TextDecoder(majorVersion >= 3 ? 'utf-8' : 'ascii')
    .decode(headerBytes)
    .trim();

  // 5. Extract dict values via regex (safe string matching, no code execution)
  const descr = headerStr.match(/'descr'\s*:\s*'([^']+)'/)?.[1];
  const fortranMatch = headerStr.match(/'fortran_order'\s*:\s*(True|False)/)?.[1];
  const shapeMatch = headerStr.match(/'shape'\s*:\s*\(([^)]*)\)/)?.[1];

  if (!descr || !fortranMatch || shapeMatch === undefined || shapeMatch === null) {
    // Bound the echoed header: a corrupt file can claim a multi-MB header.
    const shown = headerStr.length > 200 ? `${headerStr.slice(0, 200)}...` : headerStr;
    throw new Error(`Failed to parse .npy header: ${shown}`);
  }

  const fortranOrder = fortranMatch === 'True';
  const { shape, count } = parseShape(shapeMatch);

  // 6. Look up dtype and byte order
  const { info, littleEndian } = parseDescr(descr);

  // 7. Compute data offset and validate size
  const dataOffset = headerOffset + headerLen;
  const expectedBytes = count * info.bytes;
  const actualBytes = buffer.byteLength - dataOffset;

  if (!Number.isSafeInteger(expectedBytes)) {
    throw new Error(`Invalid .npy shape (${shapeMatch}): byte size overflows`);
  }
  if (actualBytes < expectedBytes) {
    throw new Error(
      `File truncated: expected ${expectedBytes} bytes of data ` +
        `but only ${actualBytes} available`,
    );
  }

  // 8. Create typed array (zero-copy view when the layout already matches)
  let data: NumericTypedArray;
  if (info.viewable && (littleEndian || info.bytes === 1)) {
    if (dataOffset % info.bytes === 0) {
      data = new info.out(buffer, dataOffset, count);
    } else {
      // Unaligned (non-standard header padding): copy the bytes, then view.
      const slice = buffer.slice(dataOffset, dataOffset + expectedBytes);
      data = new info.out(slice, 0, count);
    }
  } else {
    data = new info.out(count);
    for (let i = 0; i < count; i++) {
      data[i] = info.read(view, dataOffset + i * info.bytes, littleEndian);
    }
  }

  return { data, shape, dtype: descr, fortranOrder };
}
