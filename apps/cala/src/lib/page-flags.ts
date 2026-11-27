/**
 * The page's URL flags, in one place: what each one does to a run (`parsePageFlags`, read once by
 * `App.tsx`) and how the run record lists them (`urlFlags`, `cala-run-record.json`
 * `url_flags`). Debug-only flags take effect only with `?debug`.
 *
 * `urlFlags` derives each flag's `in_effect` from `parsePageFlags`, so the record says what the
 * run did: a flag is in effect when the app's reading of it differs from the default.
 */
import { parsePoolOverride, type PoolWidth } from './compress-pool.ts';
import { factorsFromPage, type PageFactors } from './factor-run.ts';
import { settleVisitRate } from './settle.ts';
import { visitRateSetting, type VisitRateSetting } from './visit-rate.ts';

// ---- What the flags do (App.tsx) ----

/** `?csettle=yield` or `yieldN`: Background settle feeds each answer N frames at a time. */
const CSETTLE_YIELD = /^yield(\d*)$/;

/** The URL's say on Background settle (null: the URL says nothing; the Speed block's saved cap holds). */
export interface PageCsettle {
  /** On unless `csettle=0`. */
  on: boolean;
  /** `csettle=yield` (1) or `csettle=yieldN` (N); null otherwise. */
  yield: number | null;
  /** `csrate=R`: the cap, re-read frames per live frame; null without `csrate`. */
  ceiling: number | null;
}

/** What the page's flags ask of the app (each as `App.tsx` applies it). */
export interface PageFlags {
  /** `?debug`. */
  debug: boolean;
  /** Not `?gpu=0` (WASM motion correction, to compare with WebGPU). */
  gpu: boolean;
  /** `?visits=N`: that many visit workers (null: absent or empty; NaN for a non-number, as given). */
  visits: number | null;
  /** The factor, compress and review switches (`factorsFromPage`). */
  factors: PageFactors;
  /** `?review=N` as given (`reviewEvery` reads it). */
  review: string | null;
  /** `?debug&lbpool=S`: the settle pool's size (null: from the core count). */
  lbpool: number | null;
  /** `?debug&cpool=D,E[,X]`: the compress pool's widths (null: from the core count). */
  cpool: PoolWidth | null;
  /** `?flatfield=0`: start with the sensor flat field off. */
  flatFieldOff: boolean;
  /** `?noqc`: no online quality control. */
  noqc: boolean;
  /** `?lookback=0`: look-back (and its Final settle) off. */
  lookbackOff: boolean;
  /** `?debug&cbacklog=GB`: the compress backlog cap, GB (NaN: not set; applied only when > 0). */
  cbacklogGb: number;
  /** `?debug&fextract=0`: Extract on factors on rebuilt frames. */
  frameExtract: boolean;
  /** `?debug&lbpoolmax`: the settle pool starts at Max too. */
  poolAtMax: boolean;
  /** `?debug&gpucheck=N`: GPU factors of the first N windows against the CPU's (NaN: not set; applied only when > 0). */
  gpucheck: number;
  /** `?csettle`, `?csrate` (null: neither is present). */
  csettle: PageCsettle | null;
  /** `?debug&needfirst` (not `=0`): need-driven look-back goes first. */
  needFirst: boolean;
  /** `?debug&visitrate=off|auto|...` (null: not set). */
  visitRate: VisitRateSetting | null;
  /** `?debug&settlevisits=R` (null: not set). */
  settleVisits: number | null;
  /** `?debug&pacefps=F` (null: not set). */
  paceFps: number | null;
  /** `?debug&smooth=0`: smooth playback off. */
  smoothOff: boolean;
  /** `?debug&fwait`: a factor run waits for its last window. */
  fwait: boolean;
  /** `?live=URL` (null: absent). */
  live: string | null;
}

/** Read the page's flags (`location.search`). */
export function parsePageFlags(search: string | URLSearchParams): PageFlags {
  const p = typeof search === 'string' ? new URLSearchParams(search) : search;
  const debug = p.has('debug');
  const visits = p.get('visits');
  const cs = p.get('csettle');
  const y = cs !== null && cs !== '0' ? CSETTLE_YIELD.exec(cs) : null;
  return {
    debug,
    gpu: p.get('gpu') !== '0',
    visits: visits !== null && visits !== '' ? Number(visits) : null,
    factors: factorsFromPage(p),
    review: p.get('review'),
    lbpool: debug && p.has('lbpool') ? Number(p.get('lbpool')) || 0 : null,
    cpool: debug ? parsePoolOverride(p.get('cpool')) : null,
    flatFieldOff: p.get('flatfield') === '0',
    noqc: p.has('noqc'),
    lookbackOff: p.get('lookback') === '0',
    cbacklogGb: debug ? Number(p.get('cbacklog')) : NaN,
    frameExtract: debug && p.get('fextract') === '0',
    poolAtMax: debug && p.has('lbpoolmax'),
    gpucheck: debug ? Math.floor(Number(p.get('gpucheck'))) : NaN,
    csettle:
      cs !== null || p.has('csrate')
        ? {
            on: cs !== '0',
            yield: y ? (y[1] ? Number(y[1]) : 1) : null,
            ceiling: p.has('csrate') ? Number(p.get('csrate')) : null,
          }
        : null,
    needFirst: debug && p.has('needfirst') && p.get('needfirst') !== '0',
    visitRate: debug && p.has('visitrate') ? visitRateSetting(p.get('visitrate')) : null,
    settleVisits: debug && p.has('settlevisits') ? settleVisitRate(p.get('settlevisits')) : null,
    paceFps: debug && p.has('pacefps') ? Number(p.get('pacefps')) : null,
    smoothOff: debug && p.get('smooth') === '0',
    fwait: debug && p.has('fwait'),
    live: p.get('live'),
  };
}

// ---- How the run record lists them (run-provenance.ts) ----

/**
 * The URL flags that change how a run is made, with what they mean here. A
 * flag not in this list is recorded by name only (`other_flags`).
 */
export const KNOWN_FLAGS = [
  'debug',
  'lookback',
  'csettle',
  'csrate',
  'pacefps',
  'lbpool',
  'lbpoolmax',
  'settlevisits',
  'cpool',
  'cbacklog',
  'fextract',
  'fwait',
  'gpucheck',
  'needfirst',
  'smooth',
  'gpu',
  'flatfield',
  'noqc',
  'visits',
  'compress',
  'factors',
  'review',
  'pass2',
  'live',
  'visitrate',
] as const;

/** Flags whose value is never written (it can hold a host or address). */
const REDACTED_FLAGS: ReadonlySet<string> = new Set(['live']);

const DEFAULT_FACTORS = JSON.stringify(factorsFromPage(new URLSearchParams()));

/**
 * Whether a flag changes the run, from `parsePageFlags` (the app's own reading): a debug-only flag
 * needs `?debug`, the off switches (`gpu`, `flatfield`, `lookback`) only at `0`, `visitrate` only
 * as `off` or `auto`, `review` needs `compress` and no `factors` other than `factors=0`. Background
 * settle (`csettle`, `csrate`) needs look-back.
 */
function inEffect(name: string, p: URLSearchParams): boolean {
  const f = parsePageFlags(p);
  switch (name) {
    case 'debug':
      return true;
    case 'lookback':
      return f.lookbackOff;
    case 'csettle':
    case 'csrate':
      return !f.lookbackOff && f.csettle !== null;
    case 'pacefps':
      return f.paceFps !== null;
    case 'lbpool':
      return f.lbpool !== null;
    case 'lbpoolmax':
      return f.poolAtMax;
    case 'settlevisits':
      return f.settleVisits !== null;
    case 'cpool':
      return f.cpool !== null;
    case 'cbacklog':
      return f.cbacklogGb > 0;
    case 'fextract':
      return f.frameExtract;
    case 'fwait':
      return f.fwait;
    case 'gpucheck':
      return f.gpucheck > 0;
    case 'needfirst':
      return f.needFirst;
    case 'smooth':
      return f.smoothOff;
    case 'gpu':
      return !f.gpu;
    case 'flatfield':
      return f.flatFieldOff;
    case 'noqc':
      return f.noqc;
    case 'visits':
      return f.visits !== null;
    case 'compress':
      return f.factors.compressAsked;
    case 'factors':
      return JSON.stringify(f.factors) !== DEFAULT_FACTORS;
    case 'review':
      return f.factors.review;
    case 'pass2':
      return p.get('pass2') === 'memory';
    case 'live':
      return f.live !== null;
    case 'visitrate':
      return f.visitRate !== null && f.visitRate !== 'fixed';
    default:
      return false;
  }
}

/** The run record's `url_flags`. */
export interface UrlFlags {
  /** `?debug` is present. */
  debug: boolean;
  /** Each known flag present: its raw value (`''` for a bare flag; `'(redacted)'` for `live`) and whether it is in effect. */
  flags: Record<string, { value: string; in_effect: boolean }>;
  /** Names of other query parameters (values not recorded). */
  other_flags: string[];
}

/** Read the flags in a query string (`location.search`). */
export function urlFlags(search: string): UrlFlags {
  const p = new URLSearchParams(search);
  const debug = p.has('debug');
  const known = new Set<string>(KNOWN_FLAGS);
  const flags: UrlFlags['flags'] = {};
  const other: string[] = [];
  for (const [k, v] of p) {
    if (known.has(k)) {
      flags[k] = {
        value: REDACTED_FLAGS.has(k) ? '(redacted)' : v,
        in_effect: inEffect(k, p),
      };
    } else if (!other.includes(k)) other.push(k);
  }
  return { debug, flags, other_flags: other };
}
