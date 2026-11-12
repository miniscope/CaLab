/**
 * HistoryPlot: variant A ("overlay") of the cala History chart. Every series of
 * a group is normalised by its own fixed display range and drawn on one canvas;
 * a chip row is the legend, readout and selector at once. No auto-ranging.
 */
import { For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import type { BinValue, BinView, SeriesSpec, StreamHistory } from '@calab/compute';
import { timeTicks, formatElapsed, formatClock } from './time-axis-format.ts';
import {
  binDisplayValue,
  expansionMarks,
  formatTick,
  formatValue,
  normalise,
  rangeText,
} from './history-geometry.ts';
import './history-plot.css';

export interface HistoryEvent {
  t: number;
  /** Span end for 'pause' events (grey shading). */
  t1?: number;
  /** 'scale' | 'ff' | 'warn' | 'range' | 'pause' (others are ignored). */
  kind: string;
  label: string;
}

export interface HistoryPlotProps {
  history: () => StreamHistory | null;
  /** Series of this plot, in chip order (at most 6). */
  keys: readonly string[];
  window: () => { t0: number; t1: number };
  /** Stream seconds: amber dashed line. */
  now: () => number;
  /** File run: recording end; the part after `now` is hatched as unread. */
  runEnd?: () => number | null;
  events?: () => readonly HistoryEvent[];
  /** Changes when data changed; a redraw is scheduled on the next display frame. */
  tick: () => number;
  /** Plot height, CSS px (the event lane and axis add about 26 px). */
  height: number;
  selected?: () => string;
  onSelect?: (key: string) => void;
  inspected?: () => number | null;
  onInspect?: (t: number | null) => void;
  /** Wall ms at stream t (tooltip). */
  clockAt?: (t: number) => number | null;
  onBrush?: (t0: number, t1: number) => void;
  onResetWindow?: () => void;
  /** Dashed grey verticals at 'scale' events (the Scales group). */
  scaleGuides?: boolean;
  testid?: string;
  /** Run panel: no "?" button. */
  compact?: boolean;
  /** Group name for the aria-label. */
  label?: string;
  /** Measures draw cost, ms. */
  onDraw?: (ms: number) => void;
}

const LANE_H = 12;
const AXIS_H = 14;
const AX = 40;
const PAD = 3;

interface Colors {
  ink: string;
  grid: string;
  inset: string;
  accent: string;
  now: string;
  muted: string;
  secondary: string;
  bg: string;
}

function readColors(el: Element): Colors {
  const s = getComputedStyle(el);
  const v = (n: string, d: string) => s.getPropertyValue(n).trim() || d;
  return {
    ink: v('--text-primary', '#1a1a1a'),
    grid: v('--border-subtle', '#e8e8e8'),
    inset: v('--bg-inset', '#fafafa'),
    accent: v('--accent', '#6a3d9a'),
    now: v('--warning', '#e09800'),
    muted: v('--text-tertiary', '#9e9e9e'),
    secondary: v('--text-secondary', '#616161'),
    bg: v('--bg-primary', '#ffffff'),
  };
}

function segments(a: Float32Array, n: number, cb: (s: number, e: number) => void) {
  let s = -1;
  for (let i = 0; i < n; i++) {
    if (a[i] !== a[i]) {
      if (s >= 0) cb(s, i - 1);
      s = -1;
    } else if (s < 0) s = i;
  }
  if (s >= 0) cb(s, n - 1);
}

export function HistoryPlot(props: HistoryPlotProps) {
  const [internalSel, setInternalSel] = createSignal<string | undefined>(undefined);
  const [internalInsp, setInternalInsp] = createSignal<number | null>(null);
  const [frame, setFrame] = createSignal(0);
  const [helpOpen, setHelpOpen] = createSignal(false);

  const selectedKey = () => {
    const k = props.selected?.() ?? internalSel();
    return k !== undefined && props.keys.includes(k) ? k : props.keys[0];
  };
  const inspectedT = () => (props.inspected ? props.inspected() : internalInsp());
  const select = (key: string) => {
    setInternalSel(key);
    props.onSelect?.(key);
  };
  const inspect = (t: number | null) => {
    setInternalInsp(t);
    props.onInspect?.(t);
  };

  let wrapEl!: HTMLDivElement;
  let canvasEl!: HTMLCanvasElement;
  let tipEl!: HTMLDivElement;
  let cssW = 0;
  let colors: Colors | null = null;
  let hatch: CanvasPattern | null = null;
  let raf = 0;
  let hoverT: number | null = null;
  let drag: { x0: number; x1: number } | null = null;
  let binTitle = '';
  const views: (BinView | null)[] = [];
  const laneHits: { x: number; label: string }[] = [];
  const glyphHits: { x: number; y: number; label: string }[] = [];
  const clipTop: number[] = [];
  const clipBot: number[] = [];

  const totalH = () => LANE_H + props.height + AXIS_H;

  // ---------- chips ----------
  function chipValue(key: string): string {
    frame();
    const h = props.history();
    const spec = h?.spec(key);
    if (!h || !spec) return '–';
    const t = inspectedT();
    if (t !== null) {
      const b = h.at(key, t);
      return b ? formatValue(binDisplayValue(spec.kind, b), spec.digits) : '–';
    }
    return formatValue(h.latest(key), spec.digits);
  }

  /**
   * Width reserved for a chip's value, in `ch` of the monospace value font:
   * the series' display range as formatted, with a sign when the range
   * reaches below 0 and one digit of headroom, so a fast-changing value never
   * resizes its chip.
   */
  function chipValueCh(key: string): number {
    const h = props.history();
    const spec = h?.spec(key);
    if (!h || !spec) return 1;
    // One integer digit of headroom over the range, so the early range steps
    // of a fast-rising series (adds per minute at the start) keep the width.
    const r = h.displayRange(key);
    const big = 10 * Math.max(Math.abs(r.lo), Math.abs(r.hi));
    const ends = [big, r.lo < 0 ? -big : 0].map((v) => formatValue(v, spec.digits).length);
    return Math.max(1, ...ends);
  }

  function chipTitle(key: string): string {
    frame();
    const h = props.history();
    const spec = h?.spec(key);
    if (!h || !spec) return key;
    const r = h.displayRange(key);
    const lines = [spec.label, `range ${rangeText(r.lo, r.hi, spec.unit)}`];
    if (spec.unit) lines.push(`unit: ${spec.unit}`);
    if (spec.hint) lines.push(spec.hint);
    for (const m of expansionMarks(r, spec.unit, h.end())) lines.push(m.label);
    if (r.clipped) lines.push('values beyond the fixed range are clipped');
    return lines.join('\n');
  }

  // ---------- drawing ----------
  function draw() {
    raf = 0;
    setFrame((n) => n + 1);
    const cv = canvasEl;
    if (!cv || cssW <= 0) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const t0perf = performance.now();
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!colors) colors = readColors(wrapEl);
    const C = colors;
    const W = cssW;
    const H = totalH();
    const plotTop = LANE_H;
    const plotH = props.height;
    const pw = W - AX;
    const yTop = plotTop + PAD;
    const yH = plotH - 2 * PAD;
    const { t0, t1 } = props.window();
    const span = Math.max(1e-9, t1 - t0);
    const kx = pw / span;
    const X = (t: number) => AX + (t - t0) * kx;
    const now = props.now();
    const runEnd = props.runEnd?.() ?? null;
    const hist = props.history();
    const keys = props.keys;
    const sel = selectedKey();

    ctx.clearRect(0, 0, W, H);
    ctx.font = '10px system-ui, sans-serif';

    // plot background + grid
    ctx.fillStyle = C.inset;
    ctx.fillRect(AX, plotTop, pw, plotH);
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const ticks = timeTicks(t0, t1, pw);
    for (const tk of ticks) {
      const x = Math.round(X(tk.t)) + 0.5;
      ctx.moveTo(x, plotTop);
      ctx.lineTo(x, plotTop + plotH);
    }
    for (const u of [0.25, 0.5, 0.75]) {
      const y = Math.round(yTop + (1 - u) * yH) + 0.5;
      ctx.moveTo(AX, y);
      ctx.lineTo(W, y);
    }
    ctx.stroke();

    // unread part, pauses, scale guides
    const hatchEnd = Math.min(t1, runEnd ?? t1);
    if (now < hatchEnd) {
      const xa = Math.max(AX, X(now));
      const xb = Math.min(W, X(hatchEnd));
      if (xb > xa) {
        if (!hatch) hatch = makeHatch(ctx, C.grid);
        ctx.fillStyle = hatch ?? C.grid;
        ctx.fillRect(xa, plotTop, xb - xa, plotH);
      }
    }
    const events = props.events?.() ?? [];
    for (const e of events) {
      if (e.kind === 'pause' && e.t1 !== undefined) {
        const a = Math.max(AX, X(e.t));
        const b = Math.min(W, Math.max(X(e.t) + 1.5, X(e.t1)));
        if (b > a) {
          ctx.fillStyle = 'rgba(0,0,0,0.05)';
          ctx.fillRect(a, plotTop, b - a, plotH);
        }
      }
    }
    if (props.scaleGuides) {
      ctx.strokeStyle = C.muted;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      for (const e of events) {
        if (e.kind !== 'scale') continue;
        const x = X(e.t);
        if (x < AX || x > W) continue;
        ctx.moveTo(x, plotTop);
        ctx.lineTo(x, plotTop + plotH);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // clip everything below to the plot rectangle
    ctx.save();
    ctx.beginPath();
    ctx.rect(AX, plotTop, pw, plotH);
    ctx.clip();

    glyphHits.length = 0;
    binTitle = '';
    const maxBins = Math.max(8, Math.floor(pw));
    const order: number[] = [];
    for (let i = 0; i < keys.length; i++) {
      views[i] = hist ? hist.view(keys[i], t0, t1, maxBins) : null;
      if (keys[i] !== sel) order.push(i);
    }
    views.length = keys.length;
    const selIdx = keys.indexOf(sel);
    if (selIdx >= 0) order.push(selIdx);

    for (const i of order) {
      const v = views[i];
      const spec = hist?.spec(keys[i]);
      if (!v || !spec || !hist) continue;
      if (!binTitle || i === selIdx) binTitle = `L${v.level}, ${v.levelBinS} s bins`;
      drawSeries(ctx, spec, v, hist.displayRange(keys[i]), i === selIdx, {
        yTop,
        yH,
        plotTop,
        plotH,
        X,
        t0,
        now,
        W,
        kx,
        C,
      });
    }

    // range-step markers of the selected series
    if (hist && selIdx >= 0) {
      const spec = hist.spec(keys[selIdx]);
      const r = hist.displayRange(keys[selIdx]);
      if (spec && r.expansions.length) {
        ctx.strokeStyle = C.now;
        ctx.fillStyle = C.now;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.font = 'bold 11px system-ui, sans-serif';
        ctx.textAlign = 'right';
        for (const m of expansionMarks(r, spec.unit, hist.end())) {
          if (m.u < 0 || m.u > 1) continue;
          const y = Math.round(yTop + (1 - m.u) * yH) + 0.5;
          ctx.beginPath();
          ctx.moveTo(AX, y);
          ctx.lineTo(W, y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillText('⇡', W - 3, y - 3);
          ctx.setLineDash([4, 3]);
          glyphHits.push({ x: W - 8, y, label: m.label });
        }
        ctx.setLineDash([]);
        ctx.textAlign = 'left';
        ctx.font = '10px system-ui, sans-serif';
      }
    }

    // now (amber dashed)
    const xn = X(now);
    if (xn >= AX && xn <= W) {
      ctx.strokeStyle = C.now;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 2]);
      ctx.beginPath();
      ctx.moveTo(xn, plotTop);
      ctx.lineTo(xn, plotTop + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // inspected (violet solid)
    const ins = inspectedT();
    if (ins !== null) {
      const x = X(ins);
      if (x >= AX && x <= W) {
        ctx.strokeStyle = C.accent;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, plotTop);
        ctx.lineTo(x, plotTop + plotH);
        ctx.stroke();
      }
    }
    // hover crosshair + dots
    if (hoverT !== null && hist) {
      const x = X(hoverT);
      ctx.strokeStyle = C.secondary;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, plotTop);
      ctx.lineTo(Math.round(x) + 0.5, plotTop + plotH);
      ctx.stroke();
      for (let i = 0; i < keys.length; i++) {
        const spec = hist.spec(keys[i]);
        const b = hist.at(keys[i], hoverT);
        if (!spec || !b || spec.kind === 'stem') continue;
        const val = binDisplayValue(spec.kind, b);
        if (!Number.isFinite(val)) continue;
        const u = Math.min(1, Math.max(0, normalise(val, hist.displayRange(keys[i]))));
        ctx.fillStyle = spec.color;
        ctx.strokeStyle = C.bg;
        ctx.beginPath();
        ctx.arc(x, yTop + (1 - u) * yH, keys[i] === sel ? 3 : 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    // drag-select
    if (drag) {
      const a = Math.min(drag.x0, drag.x1);
      const b = Math.max(drag.x0, drag.x1);
      ctx.fillStyle = 'rgba(106,61,154,0.12)';
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 1;
      ctx.fillRect(a, plotTop, b - a, plotH);
      ctx.strokeRect(a + 0.5, plotTop + 0.5, b - a, plotH - 1);
    }
    ctx.restore();

    // y axis of the selected series
    if (hist && selIdx >= 0) {
      const spec = hist.spec(keys[selIdx]);
      const r = hist.displayRange(keys[selIdx]);
      if (spec) {
        ctx.fillStyle = C.secondary;
        ctx.textAlign = 'right';
        for (const u of [0, 0.5, 1]) {
          ctx.fillText(formatTick(r.lo + u * (r.hi - r.lo)), AX - 4, yTop + (1 - u) * yH + 3.5);
        }
        if (spec.unit) {
          ctx.fillStyle = spec.color;
          ctx.font = '600 9.5px system-ui, sans-serif';
          ctx.fillText(spec.unit, AX - 4, Math.min(plotTop + plotH - 2, yTop + yH / 2 + 15));
          ctx.font = '10px system-ui, sans-serif';
        }
        ctx.textAlign = 'left';
      }
    }

    // time axis
    ctx.fillStyle = C.muted;
    const axisY = plotTop + plotH + 10;
    for (const tk of ticks) {
      const x = X(tk.t);
      const w = ctx.measureText(tk.label).width;
      ctx.textAlign = x < AX + w / 2 ? 'left' : x > W - w / 2 ? 'right' : 'center';
      ctx.fillText(tk.label, x, axisY);
    }
    ctx.textAlign = 'left';

    drawLane(ctx, events, C, W, X);
    canvasEl.dataset.bins = binTitle;
    props.onDraw?.(performance.now() - t0perf);
  }

  interface DrawEnv {
    yTop: number;
    yH: number;
    plotTop: number;
    plotH: number;
    X: (t: number) => number;
    t0: number;
    now: number;
    W: number;
    kx: number;
    C: Colors;
  }

  function drawSeries(
    ctx: CanvasRenderingContext2D,
    spec: SeriesSpec,
    v: BinView,
    range: { lo: number; hi: number },
    on: boolean,
    env: DrawEnv,
  ) {
    const { yTop, yH, plotTop, plotH, X, now, C } = env;
    const inv = 1 / Math.max(1e-12, range.hi - range.lo);
    const n = v.n;
    const color = spec.color;
    clipTop.length = 0;
    clipBot.length = 0;
    const yOf = (val: number, x: number) => {
      const u = (val - range.lo) * inv;
      if (u > 1) clipTop.push(x);
      else if (u < 0) clipBot.push(x);
      return yTop + (1 - (u < 0 ? 0 : u > 1 ? 1 : u)) * yH;
    };
    const xc = (i: number) => X(v.t0 + (i + 0.5) * v.binS);
    ctx.globalAlpha = on ? 1 : 0.35;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineJoin = 'round';
    ctx.lineWidth = on ? 2 : 1;
    if (!on && spec.dash) ctx.setLineDash(spec.dash);
    const fillEnvelope = (upper: Float32Array, lower: Float32Array, alpha: number) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      segments(upper, n, (s, e) => {
        ctx.moveTo(xc(s), yOf(upper[s], 0));
        for (let i = s + 1; i <= e; i++) ctx.lineTo(xc(i), yOf(upper[i], 0));
        for (let i = e; i >= s; i--) ctx.lineTo(xc(i), yOf(lower[i], 0));
        ctx.closePath();
      });
      ctx.fill();
      ctx.restore();
      clipTop.length = 0;
      clipBot.length = 0;
    };
    // The line bridges empty bins: a series sampled sparser than the bins
    // (QC once per second of stream, 1 s bins) must read as one line. Pauses
    // and gaps are shown in the event lane, not as breaks.
    const line = (arr: Float32Array) => {
      ctx.beginPath();
      let first = -1;
      let count = 0;
      for (let i = 0; i < n; i++) {
        const v = arr[i];
        if (v !== v) continue;
        if (first < 0) {
          first = i;
          ctx.moveTo(xc(i), yOf(v, xc(i)));
        } else ctx.lineTo(xc(i), yOf(v, xc(i)));
        count++;
      }
      if (count === 1) ctx.lineTo(xc(first) + 0.5, yOf(arr[first], 0));
      ctx.stroke();
    };

    if (spec.kind === 'stem') {
      const pxPerBin = v.binS * env.kx;
      ctx.lineWidth = on ? 1.5 : 1;
      const base = plotTop + plotH;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const m = v.max[i];
        if (m !== m) continue;
        const x = Math.round(xc(i)) + 0.5;
        ctx.moveTo(x, base);
        ctx.lineTo(x, yOf(m, x));
      }
      ctx.stroke();
      if (on && pxPerBin >= 4) {
        for (let i = 0; i < n; i++) {
          const m = v.max[i];
          if (m !== m) continue;
          ctx.beginPath();
          ctx.arc(xc(i), yOf(m, 0), 2.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    } else if (spec.kind === 'step') {
      // forward-fill NaN bins up to now
      const limit = Math.min(now, v.t0 + n * v.binS);
      ctx.strokeStyle = on ? C.ink : color;
      ctx.beginPath();
      let held = NaN;
      let prevY = NaN;
      for (let i = 0; i < n; i++) {
        const bs = v.t0 + i * v.binS;
        if (bs > limit) break;
        const val = v.last[i];
        if (val === val) held = val;
        if (held !== held) continue;
        const x0 = Math.max(AX, X(bs));
        const x1 = X(Math.min(limit, bs + v.binS));
        const y = yOf(held, x0);
        if (prevY !== prevY) ctx.moveTo(x0, y);
        else if (y !== prevY) {
          ctx.lineTo(x0, prevY);
          ctx.lineTo(x0, y);
        }
        ctx.lineTo(x1, y);
        prevY = y;
      }
      ctx.stroke();
    } else if (spec.kind === 'band') {
      if (on && v.lo && v.hi) fillEnvelope(v.hi, v.lo, 0.2);
      ctx.lineWidth = on ? 1.5 : 1;
      line(v.last);
    } else {
      if (on) fillEnvelope(v.max, v.min, 0.22);
      line(v.mean);
    }

    // clipped values: amber triangle at the edge (never rescaled)
    if (clipTop.length || clipBot.length) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = C.now;
      ctx.beginPath();
      let last = -99;
      for (const x of clipTop) {
        if (x - last < 6) continue;
        last = x;
        ctx.moveTo(x, plotTop + 1);
        ctx.lineTo(x + 3.5, plotTop + 1);
        ctx.lineTo(x, plotTop + 6);
        ctx.lineTo(x - 3.5, plotTop + 1);
      }
      last = -99;
      for (const x of clipBot) {
        if (x - last < 6) continue;
        last = x;
        ctx.moveTo(x - 3.5, plotTop + plotH - 1);
        ctx.lineTo(x + 3.5, plotTop + plotH - 1);
        ctx.lineTo(x, plotTop + plotH - 6);
      }
      ctx.fill();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  function drawLane(
    ctx: CanvasRenderingContext2D,
    events: readonly HistoryEvent[],
    C: Colors,
    W: number,
    X: (t: number) => number,
  ) {
    laneHits.length = 0;
    ctx.save();
    ctx.beginPath();
    ctx.rect(AX, 0, W - AX, LANE_H);
    ctx.clip();
    // flat-field rug: individual ticks when sparse, a density strip when dense
    let ffCount = 0;
    for (const e of events) if (e.kind === 'ff') ffCount++;
    if (ffCount) {
      ctx.strokeStyle = '#bdbdbd';
      ctx.lineWidth = 1;
      if ((W - AX) / ffCount >= 3) {
        ctx.beginPath();
        for (const e of events) {
          if (e.kind !== 'ff') continue;
          const x = Math.round(X(e.t)) + 0.5;
          ctx.moveTo(x, 6);
          ctx.lineTo(x, 11);
        }
        ctx.stroke();
      } else {
        const per = new Uint16Array(Math.ceil(W) + 1);
        for (const e of events) {
          if (e.kind !== 'ff') continue;
          const px = Math.floor(X(e.t));
          if (px >= 0 && px < per.length) per[px]++;
        }
        ctx.fillStyle = '#bdbdbd';
        for (let x = AX; x < per.length; x++) {
          if (!per[x]) continue;
          ctx.globalAlpha = Math.min(1, per[x] / 6);
          ctx.fillRect(x, 7, 1, 4);
        }
        ctx.globalAlpha = 1;
      }
    }
    for (const e of events) {
      const x = X(e.t);
      if (x < AX - 3 || x > W + 3) continue;
      if (e.kind === 'scale') {
        ctx.fillStyle = C.ink;
        ctx.beginPath();
        ctx.moveTo(x, 1);
        ctx.lineTo(x + 3.5, 4.5);
        ctx.lineTo(x, 8);
        ctx.lineTo(x - 3.5, 4.5);
        ctx.closePath();
        ctx.fill();
      } else if (e.kind === 'warn') {
        ctx.fillStyle = C.now;
        ctx.beginPath();
        ctx.moveTo(x, 0.5);
        ctx.lineTo(x + 4.5, 9);
        ctx.lineTo(x - 4.5, 9);
        ctx.closePath();
        ctx.fill();
      } else if (e.kind === 'range') {
        ctx.fillStyle = C.now;
        ctx.font = 'bold 10px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('⇡', x, 9);
        ctx.textAlign = 'left';
        ctx.font = '10px system-ui, sans-serif';
      } else if (e.kind === 'pause') {
        ctx.fillStyle = C.secondary;
        ctx.fillRect(x - 3, 1, 2, 7);
        ctx.fillRect(x + 1, 1, 2, 7);
      } else continue;
      laneHits.push({ x, label: e.label });
    }
    ctx.restore();
  }

  function schedule() {
    if (raf || typeof requestAnimationFrame === 'undefined') return;
    raf = requestAnimationFrame(draw);
  }

  // ---------- pointer interaction ----------
  const plotRect = () => canvasEl.getBoundingClientRect();
  const tAtX = (clientX: number) => {
    const r = plotRect();
    const { t0, t1 } = props.window();
    return t0 + ((clientX - r.left - AX) / Math.max(1, r.width - AX)) * (t1 - t0);
  };
  const clampT = (t: number) => Math.min(props.now(), Math.max(props.window().t0, t));

  function showTip(clientX: number, clientY: number, text: string) {
    const r = wrapEl.getBoundingClientRect();
    tipEl.textContent = text;
    tipEl.style.display = 'block';
    const w = tipEl.offsetWidth;
    let x = clientX - r.left + 14;
    if (x + w > r.width) x = clientX - r.left - w - 14;
    tipEl.style.left = `${Math.max(0, x)}px`;
    tipEl.style.top = `${Math.max(0, clientY - r.top - 20)}px`;
  }
  function hideTip() {
    tipEl.style.display = 'none';
  }

  function tooltipText(t: number): string {
    const h = props.history();
    if (!h) return '';
    const lines = [formatElapsed(t, h.end())];
    const wall = props.clockAt?.(t);
    if (wall !== null && wall !== undefined) lines[0] += `  ${formatClock(wall)}`;
    for (const k of props.keys) {
      const spec = h.spec(k);
      if (!spec) continue;
      const b: BinValue | null = h.at(k, t);
      const val = b ? formatValue(binDisplayValue(spec.kind, b), spec.digits) : '–';
      lines.push(
        `${(spec.short ?? spec.label).padEnd(10)} ${val.padStart(8)} ${spec.unit}`.trimEnd(),
      );
    }
    return lines.join('\n');
  }

  function onMove(e: MouseEvent) {
    if (drag) return;
    const r = plotRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    canvasEl.title = '';
    if (y < LANE_H) {
      hoverT = null;
      const hit = laneHits.find((l) => Math.abs(l.x - x) <= 5);
      if (hit) showTip(e.clientX, e.clientY, hit.label);
      else hideTip();
      schedule();
      return;
    }
    if (y > LANE_H + props.height) {
      hoverT = null;
      hideTip();
      canvasEl.title = binTitle;
      schedule();
      return;
    }
    if (x < AX) {
      hoverT = null;
      hideTip();
      schedule();
      return;
    }
    const g = glyphHits.find((h) => Math.abs(h.x - x) <= 7 && Math.abs(h.y - y) <= 9);
    if (g) {
      showTip(e.clientX, e.clientY, g.label);
      return;
    }
    const t = tAtX(e.clientX);
    if (t > props.now() || t < props.window().t0) {
      hoverT = null;
      hideTip();
    } else {
      hoverT = t;
      showTip(e.clientX, e.clientY, tooltipText(t));
    }
    schedule();
  }
  function onLeave() {
    if (drag) return;
    hoverT = null;
    hideTip();
    schedule();
  }

  /** Series whose line is within a few px of (x, y), or null. */
  function nearestKey(t: number, y: number): string | null {
    const h = props.history();
    if (!h) return null;
    const yTop = LANE_H + PAD;
    const yH = props.height - 2 * PAD;
    let best: string | null = null;
    let bd = 8;
    for (const k of props.keys) {
      const spec = h.spec(k);
      const b = h.at(k, t);
      if (!spec || !b || spec.kind === 'stem') continue;
      const val = binDisplayValue(spec.kind, b);
      if (!Number.isFinite(val)) continue;
      const u = Math.min(1, Math.max(0, normalise(val, h.displayRange(k))));
      const d = Math.abs(yTop + (1 - u) * yH - y);
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    return best;
  }

  function onDown(e: MouseEvent) {
    if (e.button !== 0) return;
    const r = plotRect();
    const y = e.clientY - r.top;
    if (y < LANE_H || y > LANE_H + props.height || e.clientX - r.left < AX) return;
    const startX = e.clientX - r.left;
    let dragging = false;
    const move = (m: MouseEvent) => {
      const cx = Math.min(r.width, Math.max(AX, m.clientX - r.left));
      if (!dragging && Math.abs(cx - startX) > 4 && props.onBrush) {
        dragging = true;
        hideTip();
        hoverT = null;
      }
      if (dragging) {
        drag = { x0: startX, x1: cx };
        schedule();
      }
    };
    const up = (u: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (dragging && drag) {
        const a = tAtX(r.left + drag.x0);
        const b = tAtX(r.left + drag.x1);
        drag = null;
        schedule();
        if (Math.abs(b - a) > 0) props.onBrush?.(Math.max(0, Math.min(a, b)), Math.max(a, b));
        return;
      }
      drag = null;
      const t = clampT(tAtX(u.clientX));
      const near = nearestKey(t, y);
      if (near && near !== selectedKey()) select(near);
      else inspect(t);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  function onWheel(e: WheelEvent) {
    if (!props.onBrush) return;
    const r = plotRect();
    const y = e.clientY - r.top;
    if (y < LANE_H || y > LANE_H + props.height || e.clientX - r.left < AX) return;
    e.preventDefault();
    const { t0, t1 } = props.window();
    const tc = tAtX(e.clientX);
    const f = e.deltaY < 0 ? 0.8 : 1.25;
    const limit = Math.max(props.runEnd?.() ?? 0, props.now());
    const n0 = Math.max(0, tc - (tc - t0) * f);
    const n1 = Math.min(limit, tc + (t1 - tc) * f);
    if (n1 - n0 < 2) return;
    props.onBrush(n0, n1);
  }

  function cycle(d: number) {
    const keys = props.keys;
    if (!keys.length) return;
    const i = Math.max(0, keys.indexOf(selectedKey()));
    select(keys[(i + d + keys.length) % keys.length]);
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      cycle(1);
      e.preventDefault();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      cycle(-1);
      e.preventDefault();
    } else if (e.key === 'Escape') {
      if (helpOpen()) setHelpOpen(false);
      else if (inspectedT() !== null) inspect(null);
    }
  }

  // ---------- lifecycle ----------
  function resize() {
    cssW = Math.floor(wrapEl.clientWidth);
    const dpr = window.devicePixelRatio || 1;
    canvasEl.width = Math.max(1, Math.round(cssW * dpr));
    canvasEl.height = Math.round(totalH() * dpr);
    canvasEl.style.width = `${cssW}px`;
    canvasEl.style.height = `${totalH()}px`;
    colors = null;
    hatch = null;
    schedule();
  }

  onMount(() => {
    resize();
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        if (Math.floor(wrapEl.clientWidth) !== cssW) resize();
      });
      ro.observe(wrapEl);
    }
    const themeChanged = () => {
      colors = null;
      hatch = null;
      schedule();
    };
    const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
    mq?.addEventListener?.('change', themeChanged);
    const mo =
      typeof MutationObserver !== 'undefined' ? new MutationObserver(themeChanged) : undefined;
    mo?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class'],
    });
    wrapEl.addEventListener('wheel', onWheel, { passive: false });
    onCleanup(() => {
      ro?.disconnect();
      mo?.disconnect();
      mq?.removeEventListener?.('change', themeChanged);
      wrapEl.removeEventListener('wheel', onWheel);
      if (raf) cancelAnimationFrame(raf);
    });
  });

  createEffect(() => {
    props.tick();
    props.window();
    props.now();
    props.runEnd?.();
    props.events?.();
    props.history();
    selectedKey();
    inspectedT();
    schedule();
  });

  const legendRows: [string, string, string][] = [
    ['◆', 'var(--text-primary)', 'scale applied'],
    ['|', 'var(--text-tertiary)', 'flat-field map'],
    ['▲', 'var(--warning)', 'warning or gap'],
    ['⇡', 'var(--warning)', 'range expanded (old limit dashed)'],
    ['▮', 'var(--border-default)', 'pause / warm-up'],
    ['┆', 'var(--warning)', 'now (amber dashed)'],
    ['│', 'var(--accent)', 'inspected time (violet)'],
    ['▒', 'var(--text-tertiary)', 'min–max / 95 % CI'],
  ];

  return (
    <div
      class="history-plot"
      classList={{ 'history-plot--compact': !!props.compact }}
      data-testid={props.testid}
      onKeyDown={onKey}
    >
      <div class="history-chips" role="group" aria-label={`${props.label ?? 'History'} series`}>
        <For each={props.keys}>
          {(key) => (
            <Show when={props.history()?.spec(key)}>
              {(spec) => (
                <button
                  type="button"
                  class="history-chip"
                  classList={{ 'history-chip--on': selectedKey() === key }}
                  aria-pressed={selectedKey() === key}
                  data-key={key}
                  style={{ '--c': spec().color }}
                  title={chipTitle(key)}
                  onClick={() => select(key)}
                >
                  <i class="history-chip__sw" />
                  <span class="history-chip__name">{spec().short ?? spec().label}</span>
                  <b
                    class="history-chip__val"
                    classList={{ 'history-chip__val--insp': inspectedT() !== null }}
                    style={{ 'min-width': `${chipValueCh(key)}ch` }}
                  >
                    {chipValue(key)}
                  </b>
                </button>
              )}
            </Show>
          )}
        </For>
        <Show when={!props.compact}>
          <button
            type="button"
            class="history-help"
            aria-label="Legend"
            aria-expanded={helpOpen()}
            title="what the marks mean"
            onClick={() => setHelpOpen((o) => !o)}
          >
            ?
          </button>
        </Show>
      </div>
      <Show when={helpOpen()}>
        <div class="history-legend" role="dialog" aria-label="History legend">
          <For each={legendRows}>
            {([glyph, color, text]) => (
              <div class="history-legend__row">
                <span class="history-legend__glyph" style={{ color }}>
                  {glyph}
                </span>
                {text}
              </div>
            )}
          </For>
          <div class="history-legend__row history-legend__hint">
            hover a chip: range and unit; hover the axis: bin size
          </div>
        </div>
      </Show>
      <div class="history-wrap" ref={wrapEl} tabindex="0" style={{ height: `${totalH()}px` }}>
        <canvas
          ref={canvasEl}
          class="history-canvas"
          role="img"
          aria-label={`${props.label ?? 'History'} plot: ${props.keys.join(', ')}`}
          onMouseMove={onMove}
          onMouseLeave={onLeave}
          onMouseDown={onDown}
          onDblClick={() => props.onResetWindow?.()}
        />
        <div class="history-tip" ref={tipEl} />
      </div>
    </div>
  );
}

function makeHatch(ctx: CanvasRenderingContext2D, color: string): CanvasPattern | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 6;
  c.height = 6;
  const g = c.getContext('2d');
  if (!g) return null;
  g.strokeStyle = color;
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(-1, 7);
  g.lineTo(7, -1);
  g.stroke();
  return ctx.createPattern(c, 'repeat');
}
