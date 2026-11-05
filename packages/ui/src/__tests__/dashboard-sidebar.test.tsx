import { describe, it, expect, afterEach } from 'vitest';
import { render } from 'solid-js/web';
import { createRoot } from 'solid-js';
import { DashboardShell, clampSidebarWidth, SIDEBAR_MIN_PX } from '../DashboardShell.tsx';
import { createDashboardSidebar } from '../sidebar-state.ts';
import { layoutMarkerLabels } from '../dataset/BrushHistogram.tsx';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
});

describe('createDashboardSidebar', () => {
  it('reveal opens on the requested tab', () => {
    createRoot((done) => {
      const s = createDashboardSidebar('community');
      expect(s.open()).toBe(false);
      expect(s.reveal('dataset')).toBe(true);
      expect(s.open()).toBe(true);
      expect(s.tab()).toBe('dataset');
      done();
    });
  });

  it('never reopens after the user closes it', () => {
    createRoot((done) => {
      const s = createDashboardSidebar('dataset');
      s.reveal('dataset');
      s.toggle(); // user closes
      expect(s.open()).toBe(false);
      expect(s.dismissed()).toBe(true);
      expect(s.reveal('dataset')).toBe(false);
      expect(s.open()).toBe(false);
      s.toggle(); // the user can still open it themselves
      expect(s.open()).toBe(true);
      done();
    });
  });

  it('opening by hand is not a dismissal', () => {
    createRoot((done) => {
      const s = createDashboardSidebar('dataset');
      s.toggle();
      expect(s.dismissed()).toBe(false);
      done();
    });
  });
});

describe('DashboardShell sidebar', () => {
  it('clamps dragged widths to [min, 60% of the window]', () => {
    expect(clampSidebarWidth(100, 1440)).toBe(SIDEBAR_MIN_PX);
    expect(clampSidebarWidth(500, 1440)).toBe(500);
    expect(clampSidebarWidth(1200, 1440)).toBe(864);
    expect(clampSidebarWidth(1200, 400)).toBe(SIDEBAR_MIN_PX);
  });

  it('applies the default width and shows the resize handle only when open', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    dispose = render(
      () => (
        <DashboardShell
          header={<span />}
          sidebar={<p>side</p>}
          sidebarOpen
          sidebarWidth="clamp(400px, 30vw, 560px)"
          sidebarResizable
        >
          <span />
        </DashboardShell>
      ),
      root,
    );
    const shell = root.querySelector<HTMLElement>('.dashboard-shell')!;
    expect(shell.classList.contains('dashboard-shell--sidebar-open')).toBe(true);
    expect(shell.style.getPropertyValue('--sidebar-width')).toBe('clamp(400px, 30vw, 560px)');
    expect(root.querySelector('[role="separator"]')).not.toBeNull();
    expect(root.querySelector('.dashboard-shell__sidebar-body')?.textContent).toBe('side');
  });

  it('has no handle when closed or not resizable', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    dispose = render(
      () => (
        <DashboardShell header={<span />} sidebar={<p>side</p>} sidebarResizable>
          <span />
        </DashboardShell>
      ),
      root,
    );
    expect(root.querySelector('[role="separator"]')).toBeNull();
    expect(root.querySelector<HTMLElement>('.dashboard-shell')!.style.cssText).toBe('');
  });
});

describe('DashboardShell collapse button', () => {
  it('calls the toggle, and closing through it suppresses auto-open', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const s = createRoot((d) => {
      dispose = d;
      return createDashboardSidebar('dataset');
    });
    s.reveal('dataset');
    const disposeRender = render(
      () => (
        <DashboardShell
          header={<span />}
          sidebar={<p>side</p>}
          sidebarOpen={s.open()}
          onToggleSidebar={s.toggle}
        >
          <span />
        </DashboardShell>
      ),
      root,
    );
    const prev = dispose;
    dispose = () => {
      disposeRender();
      prev?.();
    };
    const btn = root.querySelector<HTMLButtonElement>('[data-testid="sidebar-collapse"]')!;
    expect(btn.getAttribute('aria-label')).toBe('Collapse sidebar');
    btn.click();
    expect(s.open()).toBe(false);
    expect(s.dismissed()).toBe(true);
    expect(s.reveal('dataset')).toBe(false);
    expect(s.open()).toBe(false);
    expect(root.querySelector('[data-testid="sidebar-collapse"]')).toBeNull();
  });

  it('shows no collapse button without a toggle handler', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    dispose = render(
      () => (
        <DashboardShell header={<span />} sidebar={<p>side</p>} sidebarOpen>
          <span />
        </DashboardShell>
      ),
      root,
    );
    expect(root.querySelector('[data-testid="sidebar-collapse"]')).toBeNull();
  });
});

describe('layoutMarkerLabels', () => {
  it('keeps far-apart labels on one row and stacks close ones', () => {
    const slots = layoutMarkerLabels(
      [
        { px: 100, label: 'median' },
        { px: 300, label: '#3' },
        { px: 105, label: '#23' },
      ],
      400,
    );
    expect(slots[0].row).toBe(0);
    expect(slots[1].row).toBe(0);
    expect(slots[2].row).toBe(1);
  });

  it('flips a label left near the right edge and respects reserved spans', () => {
    const [edge] = layoutMarkerLabels([{ px: 395, label: 'median' }], 400);
    expect(edge.anchor).toBe('end');
    const [blocked] = layoutMarkerLabels([{ px: 10, label: 'x' }], 400, [[0, 60]]);
    expect(blocked.row).toBe(1);
  });
});
