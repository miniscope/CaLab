import { onCleanup, onMount, type JSX } from 'solid-js';
import { delight } from '../lib/delight.ts';

/** Mean seconds between spikes at rest, and with the cursor close by. */
export const REST_ISI_S = 4.5;
export const NEAR_ISI_S = 1.4;
/** The cursor counts as close within this many px of the sketch's centre. */
const NEAR_PX = 220;
/** Largest lean toward the cursor, degrees. */
const LEAN_DEG = 6;

/**
 * Seconds to the next spike: exponential (a Poisson cell) with a mean between `NEAR_ISI_S`
 * (cursor at the centre) and `REST_ISI_S` (cursor `NEAR_PX` away or more). `u` in (0, 1].
 */
export function nextSpikeS(distPx: number, u: number): number {
  const near = Math.max(0, 1 - Math.min(1, distPx / NEAR_PX));
  const mean = REST_ISI_S + (NEAR_ISI_S - REST_ISI_S) * near;
  return -mean * Math.log(Math.max(1e-6, Math.min(1, u)));
}

const AXON = 'M40 42c3 7 4 15 3 24';

/**
 * A small line sketch of a neuron for empty states: a soma, a few dendrites and an axon. With
 * the Fun touches on and motion allowed it is quietly alive: it fires now and then (sparse,
 * random, like a resting cell), the soma glows and a spike runs down the axon; it fires more
 * often with the cursor near and leans a little toward it. Decoration only (hidden from
 * assistive tech and when the switch is off; still with reduced motion). Theme inks.
 */
export function NeuronSketch(props: { size?: number; class?: string }): JSX.Element {
  let svg!: SVGSVGElement;
  let lean!: SVGGElement;
  let glow!: SVGEllipseElement;
  let spike!: SVGCircleElement;
  let motion!: SVGAnimateMotionElement;
  const fun = delight();
  onMount(() => {
    let dist = Infinity;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let raf = 0;
    let at: { x: number; y: number } | null = null;
    const fire = () => {
      if (fun.motion() && svg.isConnected && typeof glow.animate === 'function') {
        glow.animate(
          [
            { opacity: 0.12, transform: 'scale(1)' },
            { opacity: 0.8, transform: 'scale(1.35)', offset: 0.08 },
            { opacity: 0.12, transform: 'scale(1)' },
          ],
          { duration: 1600, easing: 'ease-out' },
        );
        spike.animate([{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 0 }], {
          duration: 900,
          delay: 80,
          easing: 'ease-in',
        });
        try {
          motion.beginElement();
        } catch {
          /* SMIL unavailable (tests): the glow alone */
        }
      }
      schedule();
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(fire, 1000 * nextSpikeS(dist, Math.random()));
    };
    const aim = () => {
      raf = 0;
      if (!at || !fun.motion()) return;
      const r = svg.getBoundingClientRect();
      const dx = at.x - (r.left + r.width / 2);
      const dy = at.y - (r.top + r.height / 2);
      const was = dist;
      dist = Math.hypot(dx, dy);
      const t = Math.max(-1, Math.min(1, dx / 400));
      lean.style.transform = `rotate(${(t * LEAN_DEG).toFixed(2)}deg)`;
      // Coming close makes the next spike sooner (a fresh draw at the higher rate).
      if (was > NEAR_PX && dist <= NEAR_PX) schedule();
    };
    const onMove = (e: PointerEvent) => {
      at = { x: e.clientX, y: e.clientY };
      if (!raf) raf = requestAnimationFrame(aim);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    timer = setTimeout(fire, 900 + 1200 * Math.random());
    onCleanup(() => {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
    });
  });
  return (
    <svg
      ref={svg}
      class={`cala-neuron${props.class ? ' ' + props.class : ''}`}
      width={props.size ?? 72}
      height={props.size ?? 72}
      viewBox="0 0 72 72"
      aria-hidden="true"
    >
      <g ref={lean} class="cala-neuron__lean">
        <g class="cala-neuron__ink" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <path d="M30 31c-5-4-9-10-10-17" />
          <path d="M23 21c-4 0-7-2-10-5" />
          <path d="M41 30c3-6 9-10 16-11" />
          <path d="M49 21c2-4 2-8 1-11" />
          <path d="M29 41c-7 2-13 6-17 12" />
          <path d="M18 47c-4-1-8 0-11 2" />
          <path d={AXON} />
          <path d="M42 56c4 1 7 4 9 8" />
        </g>
        <ellipse ref={glow} class="cala-neuron__glow" cx="35.5" cy="36" rx="9" ry="8" />
        <ellipse class="cala-neuron__soma" cx="35.5" cy="36" rx="7" ry="6.2" />
        <circle class="cala-neuron__nucleus" cx="36.5" cy="35" r="2" />
        <circle ref={spike} class="cala-neuron__spike" r="1.8" cx="0" cy="0">
          <animateMotion
            ref={motion}
            dur="0.9s"
            begin="indefinite"
            fill="freeze"
            path={AXON}
            calcMode="spline"
            keyTimes="0;1"
            keySplines="0.3 0 0.6 1"
          />
        </circle>
      </g>
    </svg>
  );
}
