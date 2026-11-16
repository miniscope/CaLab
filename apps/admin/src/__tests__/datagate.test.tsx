import { describe, expect, it } from 'vitest';
import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { DataGate, type DataGateProps } from '../components/DataGate.tsx';
import { IDLE, type TableState } from '../lib/loader.ts';
import type { TableName } from '../lib/analytics-queries.ts';

const st = (over: Partial<TableState>): TableState => ({ ...IDLE, ...over });

function mount(tables: Partial<Record<TableName, TableState>>, props: Partial<DataGateProps> = {}) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const [t] = createSignal({
    sessions: IDLE,
    events: IDLE,
    catune: IDLE,
    cadecon: IDLE,
    ...tables,
  });
  const dispose = render(
    () => (
      <DataGate
        tables={t}
        schemaMessages={() => []}
        orphanEvents={() => 0}
        matching={() => 5}
        needsSessions
        needsEvents={false}
        onStop={() => {}}
        onSevenDays={() => {}}
        onReset={() => {}}
        {...props}
      >
        <div>VIEW</div>
      </DataGate>
    ),
    el,
  );
  return { el, dispose };
}

describe('DataGate', () => {
  it('shows the error banner, not "Loading analytics", when sessions failed with no rows', () => {
    const { el, dispose } = mount({
      sessions: st({
        status: 'error',
        error: 'Sessions page 1: column analytics_sessions.is_anonymous does not exist',
      }),
    });
    expect(el.querySelector('[role=alert]')?.textContent).toContain('is_anonymous does not exist');
    expect(el.textContent).not.toContain('Loading analytics');
    expect(el.textContent).not.toContain('VIEW');
    expect(el.textContent).toContain('No session data could be loaded');
    dispose();
  });

  it('shows progress (never a bare Loading) while the first sessions page is pending', () => {
    const { el, dispose } = mount({ sessions: st({ status: 'loading', rows: 0 }) });
    expect(el.textContent).toContain('Loading analytics... Sessions: 0 so far');
    expect(el.textContent).toContain('Stop');
    expect(el.textContent).toContain('Load 7 days instead');
    dispose();
  });

  it('renders the view as soon as sessions are done while events still stream, with a note', () => {
    const { el, dispose } = mount(
      {
        sessions: st({ status: 'done', rows: 100 }),
        events: st({ status: 'loading', rows: 48000 }),
      },
      { needsEvents: true },
    );
    expect(el.textContent).toContain('VIEW');
    expect(el.textContent).toContain('Events are still loading (48,000 so far)');
    expect(el.textContent).toContain('Events: 48,000 so far');
    dispose();
  });

  it('keeps the view and shows the error when events fail midway', () => {
    const { el, dispose } = mount(
      {
        sessions: st({ status: 'done', rows: 100 }),
        events: st({ status: 'error', rows: 3000, error: 'Events page 4: timed out after 30 s' }),
      },
      { needsEvents: true },
    );
    expect(el.textContent).toContain('VIEW');
    expect(el.querySelector('[role=alert]')?.textContent).toContain('timed out after 30 s');
    expect(el.textContent).toContain('Events are incomplete');
    dispose();
  });

  it('shows explicit cap and schema banners, and the empty-filter state', () => {
    const a = mount(
      { sessions: st({ status: 'done', rows: 100, truncated: true }) },
      {
        schemaMessages: () => [
          'analytics_sessions.is_anonymous is missing on this database (migration 008): x',
        ],
      },
    );
    expect(a.el.textContent).toContain('reached the 100-row limit');
    expect(a.el.textContent).toContain('is_anonymous is missing');
    a.dispose();
    const b = mount({ sessions: st({ status: 'done', rows: 100 }) }, { matching: () => 0 });
    expect(b.el.textContent).toContain('No sessions match these filters.');
    b.dispose();
  });
});
