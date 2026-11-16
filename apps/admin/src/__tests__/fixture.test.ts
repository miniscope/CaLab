// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { build } from 'vite';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fixtureRequested } from '../lib/fixture/flag.ts';
import { makeFixture, SYNTHETIC_FIXTURE_SENTINEL } from '../lib/fixture/synthetic.ts';
import {
  buildCala,
  versionComparison,
  flagRegressions,
  extractRuns,
  extractFailures,
  pairRuns,
} from '../lib/cala.ts';
import { indexEvents } from '../lib/metrics.ts';

const NOW = Date.UTC(2026, 10, 15, 12);

describe('fixture flag', () => {
  it('is never on outside a dev server, whatever the URL says', () => {
    expect(fixtureRequested(false, '?fixture=1')).toBe(false);
  });
  it('needs the explicit query flag in dev', () => {
    expect(fixtureRequested(true, '')).toBe(false);
    expect(fixtureRequested(true, '?fixture=0')).toBe(false);
    expect(fixtureRequested(true, '?x=1&fixture=1')).toBe(true);
  });
});

describe('synthetic data', () => {
  const d = makeFixture(NOW);

  it('is deterministic for a seed', () => {
    const again = makeFixture(NOW);
    expect(again.sessions.length).toBe(d.sessions.length);
    expect(again.events.length).toBe(d.events.length);
    expect(again.sessions[10].id).toBe(d.sessions[10].id);
  });

  it('covers every app, dev builds, returning users, testers and the injected regressions', () => {
    const apps = new Set(d.sessions.map((s) => s.app_name));
    expect(apps).toEqual(new Set(['catune', 'cadecon', 'cala', 'carank']));
    expect(d.sessions.some((s) => s.app_version === 'dev')).toBe(true);
    const byUser = new Map<string, number>();
    for (const s of d.sessions) byUser.set(s.user_id!, (byUser.get(s.user_id!) ?? 0) + 1);
    expect([...byUser.values()].some((n) => n > 3)).toBe(true);
    const names = new Set(d.events.map((e) => e.event_name));
    for (const n of [
      'run_started',
      'run_finished',
      'run_failed',
      'boundary_summary',
      'results_exported',
      'webgpu_info',
      'device_info',
      'tester_tag',
      'file_imported',
    ] as const) {
      expect(names.has(n)).toBe(true);
    }
    const cala = buildCala(
      d.sessions.filter((s) => s.app_version !== 'dev'),
      d.events,
    );
    const sessions = cala.sessions;
    const ix = indexEvents(sessions, d.events);
    const rows = versionComparison(
      sessions,
      extractRuns(sessions, ix),
      extractFailures(sessions, ix),
      pairRuns(sessions, ix),
    );
    const bad = rows.find((r) => r.version === '2.18.0')!;
    expect(bad.unfinishedRate!).toBeGreaterThan(0.15);
    expect(flagRegressions(rows).some((f) => f.version === '2.18.0')).toBe(true);
  });

  it('keeps events attached to existing sessions', () => {
    const ids = new Set(d.sessions.map((s) => s.id));
    expect(d.events.every((e) => ids.has(e.session_id))).toBe(true);
  });
});

describe('production build', () => {
  it('contains neither the synthetic generator nor the fixture flag logic', async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production'; // vitest sets 'test', which Vite would treat as dev
    const out = mkdtempSync(join(tmpdir(), 'admin-build-'));
    try {
      await build({
        root: resolve(import.meta.dirname, '../..'),
        mode: 'production',
        logLevel: 'silent',
        build: { outDir: out, emptyOutDir: true, write: true },
      });
      const files = readdirSync(join(out, 'assets'), { recursive: true }) as string[];
      let text = '';
      for (const f of files) {
        const p = join(out, 'assets', f);
        if (statSync(p).isFile() && /\.(js|css|html)$/.test(f)) text += readFileSync(p, 'utf8');
      }
      expect(text.length).toBeGreaterThan(1000);
      // toBe(false), not not.toContain: a failure must not print the whole bundle.
      expect(text.includes(SYNTHETIC_FIXTURE_SENTINEL)).toBe(false);
      expect(/get\(["']fixture["']\)/.test(text)).toBe(false);
      expect(text.includes('synthetic')).toBe(false);
    } finally {
      process.env.NODE_ENV = prevEnv;
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});
