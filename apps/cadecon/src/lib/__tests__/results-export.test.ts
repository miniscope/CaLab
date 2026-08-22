// @vitest-environment node
//
// Node, not jsdom: fflate checks `instanceof Uint8Array`, and jsdom's
// TextEncoder returns arrays from another realm, so results.json would silently
// zip as a directory tree of byte-indexed entries. vitest.config.ts asks for
// node here via environmentMatchGlobs, but that option is gone in Vitest 4 and
// vite-plugin-solid forces jsdom, so the docblock is what actually applies it.

/**
 * Tests for the standalone results download.
 *
 * downloadResults() is fire-and-forget from the UI's point of view -- it hands
 * the browser a Blob and nothing reads the archive back -- so a wrong shape,
 * a wrong row order or an entirely empty payload would ship silently. These
 * tests unzip the Blob and parse the array back out to close that gap.
 *
 * data-store is mocked because the export only reads three signals from it
 * (rawFile, numTimepoints, samplingRate) and importing the real module pulls
 * in the WASM solver. iteration-store is driven for real, so the row ordering
 * and per-cell scalars come from the same memo the app uses.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot } from 'solid-js';
import { unzipSync } from 'fflate';
import { parseMat, parseNpy, processNpyResult } from '@calab/io';
import { downloadResults, FIELD_DESCRIPTIONS } from '../results-export.ts';
import { buildCaDeconResultsPayload } from '../export-utils.ts';
import { resetIterationState, updateTraceResult, cellSubsetKey } from '../iteration-store.ts';

// Hoisted above the imports by vitest, so the mocked data-store is what
// results-export.ts and export-utils.ts see.
const store = vi.hoisted(() => ({
  file: null as File | null,
  timepoints: 0,
  fs: 30,
}));

vi.mock('../data-store.ts', () => ({
  rawFile: () => store.file,
  numTimepoints: () => store.timepoints,
  samplingRate: () => store.fs,
}));

/** Register one finalized cell result (subsetIdx -1) with a recognizable trace. */
function addCell(cellIndex: number, sCounts: number[], alpha: number): void {
  updateTraceResult(cellSubsetKey(cellIndex, -1), {
    cellIndex,
    subsetIdx: -1,
    sCounts: new Float32Array(sCounts),
    alpha,
    baseline: 0,
    threshold: 0,
    pve: 0.5,
  });
}

/** Captured side effects of the anchor-click download dance. */
interface Download {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  revokedUrl: string | null;
}

/**
 * Stand-in for Blob that keeps its parts addressable, so the archive bytes can
 * be read back synchronously instead of awaiting Blob.arrayBuffer().
 */
class FakeBlob {
  constructor(
    readonly parts: ArrayBuffer[],
    readonly options?: { type?: string },
  ) {}
}

let blobs: FakeBlob[];
let anchor: { href: string; download: string; click: () => void };
let created: string[];
let appended: unknown[];
let removed: unknown[];
let revoked: string[];
let clicked: number;

beforeEach(() => {
  resetIterationState();
  store.file = null;
  store.timepoints = 0;
  store.fs = 30;

  blobs = [];
  created = [];
  appended = [];
  removed = [];
  revoked = [];
  clicked = 0;
  anchor = {
    href: '',
    download: '',
    click: () => {
      clicked++;
    },
  };

  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      created.push(tag);
      return anchor;
    },
    body: {
      appendChild: (el: unknown) => appended.push(el),
      removeChild: (el: unknown) => removed.push(el),
    },
  });
  vi.stubGlobal('Blob', FakeBlob);
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
    blobs.push(blob as unknown as FakeBlob);
    return `blob:mock-${blobs.length}`;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
    revoked.push(url);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Call downloadResults() inside a root so the store memos are read under an owner. */
function runDownload(): void {
  createRoot((dispose) => {
    try {
      downloadResults();
    } finally {
      dispose();
    }
  });
}

/** Run the download and return what hit the browser. */
function download(): Download {
  runDownload();
  expect(blobs).toHaveLength(1);
  return {
    filename: anchor.download,
    mimeType: blobs[0].options?.type ?? '',
    bytes: new Uint8Array(blobs[0].parts[0]),
    revokedUrl: revoked[0] ?? null,
  };
}

describe('downloadResults', () => {
  describe('happy path', () => {
    it('downloads a zip of activity.npy + results.json named after the source file', () => {
      store.file = new File([], 'traces.npy');
      store.timepoints = 3;
      addCell(0, [1, 2, 3], 1.5);
      addCell(1, [4, 5, 6], 2.5);

      const { filename, bytes } = download();

      expect(filename).toBe('traces_cadecon_results.zip');
      expect(Object.keys(unzipSync(bytes)).sort()).toEqual(['activity.npy', 'results.json']);
    });

    it('writes the activity matrix as [n_cells, n_timepoints] in C order', () => {
      store.file = new File([], 'traces.npy');
      store.timepoints = 3;
      addCell(0, [1, 2, 3], 1);
      addCell(1, [4, 5, 6], 2);

      const entries = unzipSync(download().bytes);
      const activity = parseNpy(new Uint8Array(entries['activity.npy']).buffer as ArrayBuffer);

      expect(activity.shape).toEqual([2, 3]);
      expect(activity.fortranOrder).toBe(false);
      expect(Array.from(activity.data)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('orders rows by ascending cell index, matching the per-cell scalars', () => {
      // Registered out of order: the export contract promises row i lines up
      // with alphas[i], which only holds if both sort the same way.
      store.file = new File([], 'traces.npy');
      store.timepoints = 2;
      addCell(5, [50, 51], 5);
      addCell(2, [20, 21], 2);

      const entries = unzipSync(download().bytes);
      const activity = parseNpy(new Uint8Array(entries['activity.npy']).buffer as ArrayBuffer);
      const results = JSON.parse(new TextDecoder().decode(entries['results.json']));

      expect(Array.from(activity.data)).toEqual([20, 21, 50, 51]);
      expect(results.alphas).toEqual([2, 5]);
    });

    it('embeds the results payload plus field descriptions in results.json', () => {
      store.file = new File([], 'traces.npy');
      store.timepoints = 2;
      store.fs = 15;
      addCell(0, [1, 0], 1);

      const entries = unzipSync(download().bytes);
      const results = JSON.parse(new TextDecoder().decode(entries['results.json']));

      expect(results.fs).toBe(15);
      expect(results.schema_version).toBe(1);
      for (const key of Object.keys(buildCaDeconResultsPayload())) {
        expect(results).toHaveProperty(key);
      }
      expect(Object.keys(results.field_descriptions).sort()).toEqual(
        Object.keys(FIELD_DESCRIPTIONS).sort(),
      );
    });

    it('writes activity.mat for a .mat import, transposing back to C order', () => {
      store.file = new File([], 'session.mat');
      store.timepoints = 3;
      addCell(0, [1, 2, 3], 1);
      addCell(1, [4, 5, 6], 2);

      const { filename, bytes } = download();
      const entries = unzipSync(bytes);

      expect(filename).toBe('session_cadecon_results.zip');
      expect(Object.keys(entries).sort()).toEqual(['activity.mat', 'results.json']);

      const parsed = parseMat(new Uint8Array(entries['activity.mat']).buffer as ArrayBuffer);
      const activity = processNpyResult(parsed.arrays['activity']);
      expect(activity.shape).toEqual([2, 3]);
      expect(Array.from(activity.data)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('matches the .mat extension case-insensitively', () => {
      store.file = new File([], 'Session.MAT');
      store.timepoints = 1;
      addCell(0, [1], 1);

      const { filename, bytes } = download();

      expect(filename).toBe('Session_cadecon_results.zip');
      expect(Object.keys(unzipSync(bytes))).toContain('activity.mat');
    });

    it('falls back to .npy for .npz imports rather than nesting a zip', () => {
      store.file = new File([], 'traces.npz');
      store.timepoints = 1;
      addCell(0, [1], 1);

      expect(Object.keys(unzipSync(download().bytes))).toContain('activity.npy');
    });

    it('names the archive without a source file (demo and bridge runs)', () => {
      store.file = null;
      store.timepoints = 1;
      addCell(0, [1], 1);

      const { filename, bytes } = download();

      expect(filename).toBe('cadecon_cadecon_results.zip');
      expect(Object.keys(unzipSync(bytes))).toContain('activity.npy');
    });

    it('appends and removes the anchor and revokes the object URL', () => {
      // The appendChild/removeChild pair is the Firefox workaround; the revoke
      // keeps the Blob from leaking for the life of the page.
      store.file = new File([], 'traces.npy');
      store.timepoints = 1;
      addCell(0, [1], 1);

      const { revokedUrl, mimeType } = download();

      expect(mimeType).toBe('application/zip');
      expect(created).toEqual(['a']);
      expect(clicked).toBe(1);
      expect(appended).toEqual([anchor]);
      expect(removed).toEqual([anchor]);
      expect(anchor.href).toBe('blob:mock-1');
      expect(revokedUrl).toBe('blob:mock-1');
    });
  });

  describe('error cases', () => {
    it('throws instead of downloading an empty archive when there are no results', () => {
      store.file = new File([], 'traces.npy');
      store.timepoints = 100;

      expect(runDownload).toThrow('No results to export');
      expect(blobs).toHaveLength(0);
    });

    it('throws when cells exist but no timepoints are known', () => {
      store.file = new File([], 'traces.npy');
      store.timepoints = 0;
      addCell(0, [1, 2, 3], 1);

      expect(runDownload).toThrow('No results to export');
      expect(blobs).toHaveLength(0);
    });
  });
});

/**
 * FIELD_DESCRIPTIONS lives in results-export.ts while the payload it documents
 * is built in export-utils.ts, so nothing but this test stops a newly added
 * field from shipping undocumented (or a renamed one from leaving a stale
 * description behind). The key set is state-independent, so an empty store is
 * enough to enumerate it.
 */
const SIBLING_FILE_KEYS = ['activity']; // documents activity.<ext>, not a results.json key

describe('FIELD_DESCRIPTIONS', () => {
  describe('happy path', () => {
    it('documents every results.json key and nothing else', () => {
      const payloadKeys = Object.keys(buildCaDeconResultsPayload()).sort();
      const documented = Object.keys(FIELD_DESCRIPTIONS)
        .filter((k) => !SIBLING_FILE_KEYS.includes(k))
        .sort();
      expect(documented).toEqual(payloadKeys);
    });

    it('documents the sibling activity array', () => {
      for (const key of SIBLING_FILE_KEYS) {
        expect(FIELD_DESCRIPTIONS[key]).toBeTruthy();
      }
    });
  });
});
