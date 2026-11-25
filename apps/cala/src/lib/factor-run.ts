/**
 * Factor runs (docs/superpowers/specs/2026-11-23-cala-factors-on-settle-design.md):
 * a live stream's Final settle and Extract read the factors Discover wrote
 * during the stream (slice 4). A recording's windows are compressed on the GPU
 * while Discover runs and its settle and Extract read those factors when
 * complete (the GPU route, what `?factors=gpu` asks for). Both are the default;
 * `?factors=0` turns them off. `?factors=file` (experimental) is the recording's
 * factor run on the CPU, and `?factors` on a recording is a `?compress` run.
 */
import type { CompressTiling } from '../workers/compress-types.ts';
import type { StageRun } from './run-stages.ts';

/** The tiling a factor run compresses on (two offset grids: no tile-line jump). */
export const FACTOR_TILING: CompressTiling = 'offset';

/** What the page's switches mean for one run. */
export interface FactorRunPlan {
  /** Compress the run's frames, on this tiling (null: no compression). */
  compress: CompressTiling | null;
  /** The slow loop settles on the factors after the stream ends (`SlowInit.factorSettle`). */
  factorSettle: boolean;
  /** A recording's factor run: the settle and Extract read the factors when complete (`SlowInit.factorFile`). */
  factorFile: boolean;
  /** A factor file run compressed on the GPU (the default, `?factors=gpu`; absent: on the CPU, `?factors=file`). */
  gpu?: boolean;
}

export function factorRunPlan(o: {
  live: boolean;
  /** `?factors` (or `?factors=file`) on the page. */
  factors: boolean;
  /** A recording's factor run (`?factors=file`, `?factors=gpu` or no switch). */
  factorsFile?: boolean;
  /** A factor file run compresses on the GPU (`?factors=gpu` or no switch). */
  factorsGpu?: boolean;
  /** No factor switch on the page: a stream is a factor run by default (`factorsFromPage`). */
  factorsDefault?: boolean;
  /** `?compress` on the page. */
  compress: boolean;
  discover: boolean;
  joint?: boolean;
}): FactorRunPlan {
  const none = { factorSettle: false, factorFile: false };
  if ((o.factors || o.factorsDefault) && o.live && o.discover)
    return { compress: FACTOR_TILING, factorSettle: true, factorFile: false };
  if (o.factorsFile && !o.live && o.discover && !o.joint)
    return {
      compress: FACTOR_TILING,
      factorSettle: false,
      factorFile: true,
      ...(o.factorsGpu ? { gpu: true } : {}),
    };
  if (o.factors || o.compress) return { compress: 'plain', ...none };
  return { compress: null, ...none };
}

export const FACTORS_FILE_JOINT =
  'cala: ?factors=file does not apply to a Joint run of several sessions; it runs as ?compress (plain tiles).';

export const FACTOR_TAIL_FILE =
  'The last frame is not in the factors (a window of one frame cannot be compressed).';

/** Why a recording's settle re-reads the file: how far the compressor was behind at Discover's end. */
export function fileBehindText(behind: number, msPerFrame: number, workers = 1): string {
  const n = Math.max(1, workers);
  const pool = n > 1 ? ` with ${n} workers` : '';
  const s =
    msPerFrame > 0 ? `, about ${Math.round((behind * msPerFrame) / 1000 / n)} s${pool},` : '';
  return `the compressor was ${behind.toLocaleString('en-US')} frames${s} behind when Discover ended`;
}

export const FACTORS_REVIEW_OFF =
  'cala: ?review is off with ?factors (the history review reads plain tiles only; a stream with ?factors compresses on offset grids).';

/** What the page's factor, compress and review switches ask for. */
export interface PageFactors {
  /** `?factors` or `?factors=file` (not `?factors=0`). */
  factors: boolean;
  /** A recording is a factor run: `?factors=file`, `?factors=gpu`, or the default. */
  factorsFile: boolean;
  /** A recording's windows are compressed on the GPU: `?factors=gpu`, or the default. */
  factorsGpu: boolean;
  /** No factor switch and no `?compress&review`: a live stream is a factor run, a recording a GPU one. */
  factorsDefault: boolean;
  /** `?compress`. */
  compressAsked: boolean;
  /** The page needs the compress worker (every page but `?factors=0` without `?compress`). */
  compressWorker: boolean;
  /** The history review runs (`?compress&review`, without an explicit `?factors`). */
  review: boolean;
  /** A console warning (null: none). */
  warn: string | null;
}

/**
 * Read the page's switches once. A stream is a factor run and a recording a GPU
 * factor run unless `?factors=0`; `?compress&review` asks for the review, which
 * reads plain tiles only, so it turns the default off. An explicit `?factors`
 * wins over `?review`.
 */
export function factorsFromPage(p: URLSearchParams): PageFactors {
  const off = p.get('factors') === '0';
  const factors = p.has('factors') && !off;
  const compressAsked = p.has('compress');
  const reviewAsked = compressAsked && p.has('review');
  const factorsDefault = !p.has('factors') && !reviewAsked;
  return {
    factors,
    factorsFile: p.get('factors') === 'file' || p.get('factors') === 'gpu' || factorsDefault,
    factorsGpu: p.get('factors') === 'gpu' || factorsDefault,
    factorsDefault,
    compressAsked,
    compressWorker: compressAsked || factors || factorsDefault,
    review: reviewAsked && !factors,
    warn: factors && p.has('review') ? FACTORS_REVIEW_OFF : null,
  };
}

/** The Results note of a `?factors` stream (the plain stream says `LIVE_NOTE`). */
export const FACTORS_LIVE_NOTE =
  "A live stream settles and extracts on the factors Discover wrote during the stream (there is no file to re-read; ?factors=0 turns this off). The export keeps the live traces beside Extract's.";

/** `meta_json.notes` of a recording's factor run (GPU or `?factors=file`): what the settle and Extract read. */
export function fileFactorNotes(
  stages: readonly Pick<StageRun, 'stage' | 'settleSource' | 'source'>[],
): string[] {
  const d = [...stages].reverse().find((r) => r.stage === 'discover');
  const e = [...stages].reverse().find((r) => r.stage === 'extract');
  if (!d?.settleSource && !e?.source) return [];
  const settle =
    d?.settleSource === 'factors'
      ? 'the Final settle read the factors'
      : d?.settleSource === 'file'
        ? 'the Final settle re-read the file'
        : 'there was no Final settle';
  const extract =
    e?.source === 'factors'
      ? 'Extract read the factors'
      : e?.source === 'file'
        ? 'Extract replayed the file'
        : 'Extract did not run';
  const notes = [
    `A recording's factor run: ${settle}; ${extract} (stage records: settle_source, source and their reasons).`,
  ];
  if (e?.source === 'factors')
    notes.push(
      "Extract's traces (traces, traces_signed) are solved on low-rank frames rebuilt from the factors and carry less per-frame noise than traces solved on the file.",
    );
  return notes;
}
