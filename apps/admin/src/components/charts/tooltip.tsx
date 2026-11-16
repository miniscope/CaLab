import { createSignal, For, Show, type JSX } from 'solid-js';

export interface TipRow {
  /** CSS color of a short key stroke; omit for none. */
  color?: string;
  label: string;
  value: string;
}

export interface TipContent {
  title: string;
  rows: TipRow[];
}

interface TipState extends TipContent {
  x: number;
  y: number;
}

const [tip, setTip] = createSignal<TipState | null>(null);

/** Show the tooltip near a pointer event, or beside the focused element. */
export function showTip(e: PointerEvent | FocusEvent, content: TipContent): void {
  if ('clientX' in e) {
    setTip({ ...content, x: e.clientX, y: e.clientY });
  } else {
    const r = (e.currentTarget as Element).getBoundingClientRect();
    setTip({ ...content, x: r.left + r.width / 2, y: r.top });
  }
}

export function hideTip(): void {
  setTip(null);
}

/** One floating tooltip for the whole app. Content is rendered as text nodes only. */
export function TooltipLayer(): JSX.Element {
  return (
    <Show when={tip()}>
      {(t) => (
        <div
          class="tip"
          role="status"
          style={{
            left: `${Math.min(t().x + 12, window.innerWidth - 220)}px`,
            top: `${Math.max(8, t().y - 12)}px`,
          }}
        >
          <div class="tip__title">{t().title}</div>
          <For each={t().rows}>
            {(r) => (
              <div class="tip__row">
                <Show when={r.color}>
                  <span class="tip__key" style={{ background: r.color }} />
                </Show>
                <strong>{r.value}</strong>
                <span>{r.label}</span>
              </div>
            )}
          </For>
        </div>
      )}
    </Show>
  );
}
