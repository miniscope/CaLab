/**
 * WholeRunStrip: a thin strip that always shows the whole run [0, runEnd]: one
 * series' min/max envelope in grey, the current window as a violet rectangle,
 * the unread part hatched and the now line. Drag to brush, drag the rectangle
 * edges to resize it (or its body to move it), double-click to reset to Run.
 */
import { createEffect, onCleanup, onMount } from 'solid-js';
import type { StreamHistory } from '@calab/compute';
import { normalise } from './history-geometry.ts';
import './history-plot.css';

export interface WholeRunStripProps {
  history: () => StreamHistory | null;
  /** Series whose envelope is drawn. */
  seriesKey: string;
  /** Run length, s (recording end for a file, now for a live run). */
  runEnd: () => number;
  now: () => number;
  window: () => { t0: number; t1: number };
  tick: () => number;
  onBrush?: (t0: number, t1: number) => void;
  onResetWindow?: () => void;
  height?: number;
  testid?: string;
}

const EDGE_PX = 5;
const HINT = 'drag to choose a time window; double-click for the whole run';

export function WholeRunStrip(props: WholeRunStripProps) {
  let wrapEl!: HTMLDivElement;
  let canvasEl!: HTMLCanvasElement;
  let cssW = 0;
  let raf = 0;
  const h = () => props.height ?? 18;

  const span = () => Math.max(1e-6, props.runEnd());
  const xOfT = (t: number) => (t / span()) * cssW;
  const tOfX = (x: number) => Math.min(span(), Math.max(0, (x / Math.max(1, cssW)) * span()));

  function draw() {
    raf = 0;
    const cv = canvasEl;
    if (!cv || cssW <= 0) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const s = getComputedStyle(wrapEl);
    const v = (n: string, d: string) => s.getPropertyValue(n).trim() || d;
    const inset = v('--bg-inset', '#fafafa');
    const grid = v('--border-subtle', '#e8e8e8');
    const grey = v('--border-default', '#d4d4d4');
    const accent = v('--accent', '#6a3d9a');
    const warn = v('--warning', '#e09800');
    const H = h();
    ctx.clearRect(0, 0, cssW, H);
    ctx.fillStyle = inset;
    ctx.fillRect(0, 0, cssW, H);

    // unread part
    const now = props.now();
    const xn = xOfT(Math.min(now, span()));
    if (xn < cssW) {
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = Math.max(0, xn) - H; x < cssW; x += 5) {
        ctx.moveTo(x, H);
        ctx.lineTo(x + H, 0);
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(xn, 0, cssW - xn, H);
      ctx.clip();
      ctx.stroke();
      ctx.restore();
    }

    // envelope of one series, fixed display range
    const hist = props.history();
    const view = hist?.view(props.seriesKey, 0, span(), Math.max(8, Math.floor(cssW)));
    if (hist && view) {
      const r = hist.displayRange(props.seriesKey);
      const y = (val: number) => {
        const u = Math.min(1, Math.max(0, normalise(val, r)));
        return 2 + (1 - u) * (H - 4);
      };
      const xc = (i: number) => xOfT(view.t0 + (i + 0.5) * view.binS);
      ctx.fillStyle = grey;
      ctx.strokeStyle = grey;
      ctx.beginPath();
      let st = -1;
      const flush = (e: number) => {
        ctx.moveTo(xc(st), y(view.max[st]));
        for (let i = st + 1; i <= e; i++) ctx.lineTo(xc(i), y(view.max[i]));
        for (let i = e; i >= st; i--) ctx.lineTo(xc(i), y(view.min[i]));
        ctx.closePath();
      };
      for (let i = 0; i < view.n; i++) {
        const nan = view.max[i] !== view.max[i];
        if (nan && st >= 0) {
          flush(i - 1);
          st = -1;
        } else if (!nan && st < 0) st = i;
      }
      if (st >= 0) flush(view.n - 1);
      ctx.globalAlpha = 0.6;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < view.n; i++) {
        const m = view.mean[i];
        if (m !== m) {
          pen = false;
          continue;
        }
        if (pen) ctx.lineTo(xc(i), y(m));
        else ctx.moveTo(xc(i), y(m));
        pen = true;
      }
      ctx.stroke();
    }

    // now
    if (now <= span()) {
      ctx.strokeStyle = warn;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 2]);
      ctx.beginPath();
      ctx.moveTo(xn, 0);
      ctx.lineTo(xn, H);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // window rectangle
    const w = props.window();
    const xa = xOfT(w.t0);
    const xb = Math.max(xa + 2, xOfT(w.t1));
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.14;
    ctx.fillRect(xa, 0, xb - xa, H);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(xa + 0.75, 0.75, xb - xa - 1.5, H - 1.5);
  }

  function schedule() {
    if (raf || typeof requestAnimationFrame === 'undefined') return;
    raf = requestAnimationFrame(draw);
  }

  function resize() {
    cssW = Math.floor(wrapEl.clientWidth);
    const dpr = window.devicePixelRatio || 1;
    canvasEl.width = Math.max(1, Math.round(cssW * dpr));
    canvasEl.height = Math.round(h() * dpr);
    canvasEl.style.width = `${cssW}px`;
    canvasEl.style.height = `${h()}px`;
    schedule();
  }

  function onDown(e: MouseEvent) {
    if (e.button !== 0 || !props.onBrush) return;
    const rect = canvasEl.getBoundingClientRect();
    const x0 = e.clientX - rect.left;
    const w = props.window();
    const xa = xOfT(w.t0);
    const xb = xOfT(w.t1);
    const full = w.t0 <= 0 && w.t1 >= span() - 1e-6;
    type Mode = 'new' | 'left' | 'right' | 'move';
    let mode: Mode = 'new';
    if (!full) {
      if (Math.abs(x0 - xa) <= EDGE_PX) mode = 'left';
      else if (Math.abs(x0 - xb) <= EDGE_PX) mode = 'right';
      else if (x0 > xa && x0 < xb) mode = 'move';
    }
    const grabT = tOfX(x0);
    let moved = false;
    const move = (m: MouseEvent) => {
      const x = m.clientX - rect.left;
      if (!moved && Math.abs(x - x0) < 3) return;
      moved = true;
      const t = tOfX(x);
      if (mode === 'new') props.onBrush?.(Math.min(grabT, t), Math.max(grabT, t));
      else if (mode === 'left') props.onBrush?.(Math.min(t, w.t1), w.t1);
      else if (mode === 'right') props.onBrush?.(w.t0, Math.max(t, w.t0));
      else {
        const len = w.t1 - w.t0;
        const n0 = Math.min(span() - len, Math.max(0, w.t0 + (t - grabT)));
        props.onBrush?.(n0, n0 + len);
      }
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  function onHover(e: MouseEvent) {
    const w = props.window();
    const x = e.clientX - canvasEl.getBoundingClientRect().left;
    const near = Math.abs(x - xOfT(w.t0)) <= EDGE_PX || Math.abs(x - xOfT(w.t1)) <= EDGE_PX;
    canvasEl.style.cursor = near ? 'ew-resize' : 'crosshair';
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
    onCleanup(() => {
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    });
  });

  createEffect(() => {
    props.tick();
    props.runEnd();
    props.now();
    props.window();
    props.history();
    schedule();
  });

  return (
    <div class="history-strip" ref={wrapEl} data-testid={props.testid} title={HINT}>
      <canvas
        ref={canvasEl}
        class="history-strip__canvas"
        role="img"
        aria-label="Whole run, with the chosen time window"
        onMouseDown={onDown}
        onMouseMove={onHover}
        onDblClick={() => props.onResetWindow?.()}
      />
    </div>
  );
}
