import { For, onMount, type JSX } from 'solid-js';

import { renderOverlay, type CellGeometry, type Rgb } from '../lib/cell-overlay.ts';
import { portraitLines, type PortraitStats } from '../lib/soul.ts';

/** Width of the saved PNG, px. */
const PNG_W = 1200;

/** The footprints on black, every cell filled in its scheme colour with its outline. */
function drawFootprints(
  g: CellGeometry,
  color: (id: number) => Rgb,
  glow: boolean,
): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = g.width;
  c.height = g.height;
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  const rgba = renderOverlay(g, { mode: 'both', selected: null, glow, color, fill: () => 0.25 });
  ctx.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, g.width, g.height), 0, 0);
  return c;
}

/**
 * The session portrait at the end of a run: the field of view's footprints in the chosen colour
 * scheme, with a few true figures of the run, and Save PNG. A keepsake: decoration only (shown
 * with the Fun touches switch on), it reads the final library and never changes anything.
 */
export function SessionPortrait(props: {
  geometry: CellGeometry;
  color: (id: number) => Rgb;
  glow: boolean;
  /** The scheme the cells are coloured by (its label). */
  scheme: string;
  stats: PortraitStats;
  /** The recording's name, for the PNG and its file name. */
  name: string;
  onClose: () => void;
}): JSX.Element {
  let view!: HTMLCanvasElement;
  let closeBtn!: HTMLButtonElement;
  // The geometry is the final library's: drawn once.
  // eslint-disable-next-line solid/reactivity
  const art = drawFootprints(props.geometry, props.color, props.glow);
  onMount(() => {
    view.width = art.width;
    view.height = art.height;
    const ctx = view.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, view.width, view.height);
      ctx.drawImage(art, 0, 0);
    }
    closeBtn.focus({ preventScroll: true });
  });

  const save = () => {
    const lines = portraitLines(props.stats);
    const scale = PNG_W / art.width;
    const imgH = Math.round(art.height * scale);
    const foot = 132;
    const c = document.createElement('canvas');
    c.width = PNG_W;
    c.height = imgH + foot;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(art, 0, 0, PNG_W, imgH);
    ctx.fillStyle = '#121418';
    ctx.fillRect(0, imgH, PNG_W, foot);
    const font = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';
    ctx.fillStyle = '#f2f2f2';
    ctx.font = `600 30px ${font}`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(props.name, 32, imgH + 50);
    ctx.fillStyle = '#9aa0a8';
    ctx.font = `400 18px ${font}`;
    ctx.fillText(
      `Cala · ${new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })} · coloured by ${props.scheme}`,
      32,
      imgH + 82,
    );
    let x = 32;
    for (const l of lines) {
      ctx.fillStyle = '#9aa0a8';
      ctx.font = `400 15px ${font}`;
      ctx.fillText(l.label, x, imgH + 108);
      ctx.fillStyle = '#f2f2f2';
      ctx.font = `600 17px ${font}`;
      const vx = x + ctx.measureText(l.label).width + 8;
      ctx.fillText(l.value, vx, imgH + 108);
      x = vx + ctx.measureText(l.value).width + 28;
    }
    const file = `${props.name.replace(/[^\w.-]+/g, '_') || 'cala'}-portrait.png`;
    c.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = file;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, 'image/png');
  };

  return (
    <div
      class="cala-portrait"
      role="dialog"
      aria-label="Session portrait"
      data-testid="session-portrait"
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.key === 'Escape' && props.onClose()}
    >
      <canvas ref={view} class="cala-portrait__art" aria-label="The footprints of this run" />
      <div class="cala-portrait__body">
        <p class="cala-portrait__name">{props.name}</p>
        <dl class="cala-portrait__stats">
          <For each={portraitLines(props.stats)}>
            {(l) => (
              <div>
                <dt>{l.label}</dt>
                <dd class="num">{l.value}</dd>
              </div>
            )}
          </For>
        </dl>
        <div class="cala-portrait__actions">
          <button
            type="button"
            class="btn-primary btn-small"
            data-testid="portrait-save"
            onClick={save}
          >
            Save PNG
          </button>
          <button
            ref={closeBtn}
            type="button"
            class="btn-secondary btn-small"
            data-testid="portrait-close"
            onClick={() => props.onClose()}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
