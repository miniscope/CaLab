// Synthetic dataset for development screenshots. Dev-only: reached through a
// dynamic import guarded by FIXTURE_MODE, so it is not in production bundles.
// SYNTHETIC_FIXTURE_SENTINEL lets a test prove that.

import type { Dataset, PageSource, TableName } from '../analytics-queries.ts';
import type { CadeconSubmissionRow, EventRow, SessionRow, SubmissionRow } from '../types.ts';

export const SYNTHETIC_FIXTURE_SENTINEL = 'calab-admin-synthetic-fixture-v1';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;

interface Geo {
  cc: string;
  regions: string[];
  w: number;
}
const GEOS: Geo[] = [
  { cc: 'US', regions: ['California', 'Massachusetts', 'New York', 'Texas', 'Washington'], w: 34 },
  { cc: 'DE', regions: ['Bavaria', 'Berlin', 'Hesse'], w: 10 },
  { cc: 'GB', regions: ['England', 'Scotland'], w: 9 },
  { cc: 'CN', regions: ['Beijing', 'Shanghai'], w: 8 },
  { cc: 'JP', regions: ['Tokyo', 'Osaka'], w: 6 },
  { cc: 'CA', regions: ['Ontario', 'Quebec'], w: 6 },
  { cc: 'FR', regions: ['Ile-de-France'], w: 5 },
  { cc: 'NL', regions: ['North Holland'], w: 4 },
  { cc: 'BR', regions: ['Sao Paulo'], w: 3 },
  { cc: 'AU', regions: ['Victoria', 'New South Wales'], w: 3 },
  { cc: 'IL', regions: ['Tel Aviv'], w: 2 },
  { cc: 'KR', regions: ['Seoul'], w: 2 },
];

const VENDORS = ['nvidia', 'apple', 'amd', 'intel'];
const ARCH: Record<string, string[]> = {
  nvidia: ['ampere', 'ada-lovelace'],
  apple: ['metal-3'],
  amd: ['rdna-3'],
  intel: ['gen-12'],
};
const GPU_SPEED: Record<string, number> = { nvidia: 1.3, apple: 1, amd: 0.9, intel: 0.4 };
const RELEASES: { from: number; v: string }[] = [
  { from: -400, v: '2.16.0' },
  { from: -100, v: '2.17.0' },
  { from: -60, v: '2.18.0' }, // simulated regression: slow + out-of-memory failures
  { from: -38, v: '2.18.1' },
  { from: -20, v: '2.19.0' },
];

/** Rows inside [fetchStart, fetchEnd), like the real fetch. */
function within(d: Dataset, w: { fetchStart: number; fetchEnd: number }): Dataset {
  const ok = (iso: string) => {
    const t = Date.parse(iso);
    return t >= w.fetchStart && t < w.fetchEnd;
  };
  const sessions = d.sessions.filter((s) => ok(s.created_at));
  const ids = new Set(sessions.map((s) => s.id));
  const events = d.events.filter((e) => ok(e.created_at));
  return {
    ...d,
    sessions,
    events,
    catune: d.catune.filter((r) => ok(r.created_at)),
    cadecon: d.cadecon.filter((r) => ok(r.created_at)),
    orphanEvents: events.filter((e) => !ids.has(e.session_id)).length,
  };
}

export function makeFixture(
  nowMs: number,
  seed = 7,
  window?: { fetchStart: number; fetchEnd: number },
): Dataset {
  const all = generate(nowMs, seed);
  return window ? within(all, window) : all;
}

function generate(nowMs: number, seed: number): Dataset {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join('');
  const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
  const weighted = <T extends { w: number }>(xs: T[]): T => {
    let r = rnd() * xs.reduce((a, b) => a + b.w, 0);
    for (const x of xs) if ((r -= x.w) <= 0) return x;
    return xs[0];
  };
  const today = Math.floor(nowMs / DAY) * DAY;
  const versionOn = (day: number) => {
    let v = RELEASES[0].v;
    for (const r of RELEASES) if (day >= r.from) v = r.v;
    return v;
  };

  const sessions: SessionRow[] = [];
  const events: EventRow[] = [];
  let eventId = 1;
  const ev = (sid: string, at: number, name: string, data: Record<string, unknown> = {}) => {
    events.push({
      id: eventId++,
      created_at: new Date(at).toISOString(),
      session_id: sid,
      event_name: name,
      event_data: data,
    });
  };

  const testers = ['krisha', 'bench-2', 'dan@lab', '<b>bold</b>'];
  const N_USERS = 340;
  for (let u = 0; u < N_USERS; u++) {
    const userId = uuid();
    const geo = weighted(GEOS);
    const region = pick(geo.regions);
    const signedIn = rnd() < 0.06;
    const appPref =
      rnd() < 0.42 ? 'catune' : rnd() < 0.5 ? 'cala' : rnd() < 0.7 ? 'cadecon' : 'cala';
    const ua = rnd() < 0.6 ? 'Chrome' : rnd() < 0.4 ? 'Safari' : rnd() < 0.5 ? 'Firefox' : 'Edge';
    const phone = appPref !== 'cala' && rnd() < 0.12;
    const width = phone ? 390 : pick([1280, 1440, 1536, 1920, 2560]);
    const height = phone ? 844 : pick([720, 900, 864, 1080, 1440]);
    const tester =
      appPref === 'cala' && u % 37 === 0 ? testers[((u / 37) % testers.length) | 0] : null;
    // Browsers keep arriving: more recent first-seen days are likelier.
    const firstDay = -Math.floor(Math.pow(rnd(), 1.6) * 148);
    const retain = rnd() < 0.38 ? 0.5 + rnd() * 0.4 : 0.06;
    const hardware = rnd() < 0.8;
    const vendor = pick(VENDORS);
    const arch = pick(ARCH[vendor]);
    const os = weighted([
      { v: 'windows', w: 50 },
      { v: 'macos', w: 35 },
      { v: 'linux', w: 10 },
      { v: 'chromeos', w: 5 },
    ]).v;
    const cores = pick([4, 6, 8, 8, 10, 12, 16, 24]);
    const memGb = pick([4, 8, 8, 8]);
    const major = pick([128, 129, 130, 130]);
    const maxBuf = vendor === 'intel' ? 256 : vendor === 'apple' ? 4096 : 2048;
    const referrer =
      rnd() < 0.45
        ? null
        : pick(['google.com', 'github.com', 'twitter.com', 'biorxiv.org', 'lab.example.edu']);
    let day = firstDay;
    let first = true;
    while (day <= 0) {
      const nSess = tester ? 1 + Math.floor(rnd() * 3) : 1 + (rnd() < 0.2 ? 1 : 0);
      for (let k = 0; k < nSess; k++) {
        const t0 = today + day * DAY + Math.floor(rnd() * 20 * 3600_000) + 3600_000;
        if (t0 > nowMs) continue;
        const dev = rnd() < 0.04;
        const version = dev ? 'dev' : versionOn(day);
        const app = tester && rnd() < 0.9 ? 'cala' : appPref;
        const dur = (rnd() < 0.05 ? 3600 * 8 : 40 + rnd() * rnd() * 2400) * 1000;
        const sid = uuid();
        const sess: SessionRow = {
          id: sid,
          created_at: new Date(t0).toISOString(),
          anonymous_id: uuid(),
          user_id: userId,
          is_anonymous: !signedIn,
          app_name: app,
          app_version: version,
          country_code: geo.cc,
          region,
          screen_width: width,
          screen_height: height,
          user_agent_family: ua,
          referrer_domain: first ? referrer : rnd() < 0.8 ? null : referrer,
          ended_at: new Date(t0 + dur).toISOString(),
          duration_seconds: rnd() < 0.3 ? Math.min(86400, Math.round(dur / 1000)) : null,
        };
        sessions.push(sess);
        first = false;
        let t = t0 + 4000;
        const step = () => (t += 3000 + Math.floor(rnd() * 90_000));
        if (app === 'cala') {
          if (tester) ev(sid, t0 + 500, 'tester_tag', { tag: tester });
          const cls = hardware ? 'hardware' : rnd() < 0.8 ? 'fallback' : 'none';
          // Hardware events only from 2.19.0 on; older versions send just adapter and vendor.
          const newer = day >= -20 && !dev;
          if (newer)
            ev(sid, t0 + 800, 'device_info', {
              os,
              cores,
              memory_gb: memGb,
              browser_major: major,
              dpr: os === 'macos' ? 2 : 1,
            });
          ev(sid, t0 + 900, 'webgpu_info', {
            adapter: cls,
            vendor: cls === 'hardware' ? vendor : cls === 'fallback' ? 'swiftshader' : '',
            ...(newer && cls === 'hardware'
              ? {
                  architecture: arch,
                  device: 'synthetic',
                  max_buffer_mb: maxBuf,
                  max_storage_mb: maxBuf,
                }
              : {}),
            ...(newer && cls === 'fallback'
              ? { architecture: 'software', max_buffer_mb: 256 }
              : {}),
          });
          if (rnd() < 0.78) {
            ev(sid, step(), 'file_imported', { extension: pick(['avi', 'avi', 'tif', 'mp4']) });
            if (rnd() < 0.82) {
              const regress = version === '2.18.0';
              const frames = Math.round(2000 + rnd() * rnd() * 60000);
              const nSes = rnd() < 0.3 ? 2 + Math.floor(rnd() * 5) : 1;
              const stages = ['discover', 'refine', 'extract'];
              let alive = true;
              for (const stage of stages) {
                if (!alive || (stage !== 'discover' && rnd() < 0.35)) break;
                const mode = nSes > 1 ? pick(['joint', 'separate', 'apply']) : 'single';
                const base = {
                  stage,
                  mode,
                  // Sessions this run processed (Joint: all; Separate and single: one).
                  sessions: mode === 'separate' || mode === 'single' ? 1 : nSes,
                  ...(nSes > 1 ? { plan_sessions: nSes, refine_runs: 1 } : {}),
                  frames,
                  fps: 30,
                  width: 608,
                  height: 608,
                };
                ev(sid, step(), 'run_started', base);
                // 2.18.0 blows the memory budget: the tab dies, so nothing but the
                // start is reported and the heartbeat stops shortly after. Other
                // versions only lose runs the user stops.
                if (rnd() < (regress ? 0.3 : 0.04)) {
                  sess.ended_at = new Date(t + 15_000 + Math.floor(rnd() * 150_000)).toISOString();
                  alive = false;
                  break;
                }
                const failP =
                  cls === 'none'
                    ? 0.9
                    : regress
                      ? 0.35
                      : vendor === 'intel' && frames > 30000
                        ? 0.25
                        : 0.04;
                if (rnd() < failP) {
                  ev(sid, step(), 'run_failed', {
                    stage,
                    error_category:
                      cls === 'none'
                        ? 'webgpu'
                        : regress
                          ? 'out_of_memory'
                          : pick(['decode', 'worker', 'unknown']),
                    error_type:
                      cls === 'none'
                        ? 'GPUValidationError'
                        : regress
                          ? 'RangeError'
                          : pick(['TypeError', 'Error']),
                  });
                  alive = false;
                  break;
                }
                const baseFps =
                  cls === 'hardware'
                    ? (180 + rnd() * 160) * (GPU_SPEED[vendor] ?? 1) * (cores >= 12 ? 1.15 : 0.9)
                    : 8 + rnd() * 10;
                const fps = baseFps * (regress ? 0.45 : 1) * (stage === 'extract' ? 1.6 : 1);
                ev(sid, step(), 'run_finished', {
                  ...base,
                  duration_s: Math.round((frames * nSes) / fps),
                  median_fps: Math.round(fps * 10) / 10,
                  cells: Math.round(20 + rnd() * 160),
                  ...(rnd() < 0.7
                    ? {
                        peak_wasm_mb: Math.round(
                          300 + (frames / 60000) * 3000 * (0.8 + rnd() * 0.4),
                        ),
                      }
                    : {}),
                  ...(day >= -20 && rnd() < 0.8
                    ? { peak_js_mb: Math.round(80 + (frames / 60000) * 400 * (0.8 + rnd() * 0.4)) }
                    : {}),
                });
                if (nSes > 1 && mode === 'joint') {
                  const b = nSes - 1;
                  const bad = rnd() < 0.2 ? 1 : 0;
                  const warn = rnd() < 0.25 ? 1 : 0;
                  ev(sid, step(), 'boundary_summary', {
                    boundaries: b,
                    ok: b - bad - warn,
                    warning: warn,
                    failed: bad,
                  });
                }
              }
              if (alive && rnd() < 0.55)
                ev(sid, step(), 'results_exported', { sessions: nSes, format_version: 2 });
            }
          }
        } else if (app === 'catune' || app === 'cadecon') {
          if (rnd() < 0.8) {
            if (rnd() < 0.55) ev(sid, step(), 'demo_loaded');
            else ev(sid, step(), 'file_imported', { extension: 'csv' });
            if (app === 'catune' && rnd() < 0.6) ev(sid, step(), 'snapshot_pinned');
            if (app === 'cadecon' && rnd() < 0.5) ev(sid, step(), 'ranking_completed');
            if (rnd() < 0.15) ev(sid, step(), 'community_browser_opened');
            if (rnd() < 0.18)
              ev(sid, step(), 'submission_created', { data_source: pick(['user', 'demo']) });
          }
          if (rnd() < 0.2)
            ev(sid, step(), 'tutorial_started', { tutorial_id: pick(['intro', 'tuning']) });
          if (signedIn && rnd() < 0.5) ev(sid, step(), 'auth_signed_in');
        }
      }
      // Next visit: geometric gap, longer when the browser is a one-timer.
      day += 1 + Math.floor(-Math.log(1 - rnd()) / (retain > 0.2 ? 0.35 : 0.01));
      if (rnd() > retain) break;
    }
  }
  // A few small apps so "others discovered from data" has something to show.
  for (let i = 0; i < 14; i++) {
    const t0 = nowMs - Math.floor(rnd() * 40 * DAY);
    sessions.push({
      id: uuid(),
      created_at: new Date(t0).toISOString(),
      anonymous_id: uuid(),
      user_id: uuid(),
      is_anonymous: true,
      app_name: 'carank',
      app_version: '1.2.0',
      country_code: pick(GEOS).cc,
      region: null,
      screen_width: 1440,
      screen_height: 900,
      user_agent_family: 'Chrome',
      referrer_domain: null,
      ended_at: new Date(t0 + 90_000).toISOString(),
      duration_seconds: null,
    });
  }

  const subs = (n: number, app: 'catune' | 'cadecon') =>
    Array.from({ length: n }, () => {
      const t = nowMs - Math.floor(rnd() * 120 * DAY);
      const base = {
        id: uuid(),
        created_at: new Date(t).toISOString(),
        user_id: uuid(),
        indicator: pick(['GCaMP6f', 'GCaMP6s', 'GCaMP7f', 'jGCaMP8f', 'OGB-1']),
        species: pick(['mouse', 'mouse', 'zebrafish', 'rat']),
        brain_region: pick(['CA1', 'V1', 'PFC', 'cerebellum']),
        data_source: pick(['user', 'user', 'demo', 'training']),
        app_version: versionOn(Math.round((t - today) / DAY)),
        tau_rise: 0.02 + rnd() * 0.05 + (rnd() < 0.04 ? 0.6 : 0),
        tau_decay: 0.3 + rnd() * 0.9,
        sampling_rate: pick([10, 20, 30, 30, 60]),
      };
      return app === 'catune'
        ? ({ ...base, lambda: 0.01 + rnd() * 0.05 } as SubmissionRow)
        : ({
            ...base,
            median_alpha: rnd() * 2,
            median_pve: 0.5 + rnd() * 0.4,
            mean_event_rate: rnd() * 2,
            num_iterations: 5 + Math.floor(rnd() * 20),
            converged: rnd() < 0.8,
          } as CadeconSubmissionRow);
    });

  return {
    sessions,
    events,
    catune: subs(80, 'catune') as SubmissionRow[],
    cadecon: subs(36, 'cadecon') as CadeconSubmissionRow[],
    truncated: [],
    orphanEvents: 0,
    fetchedAt: nowMs,
  };
}

export interface FixtureOptions {
  slow: boolean;
  noanon: boolean;
  error: boolean;
}

const cmp = (a: string | number, b: string | number) =>
  typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));

/** Fixture rows served through the same keyset PageSource interface as Supabase. */
export function fixtureSource(
  nowMs: number,
  opts: FixtureOptions = { slow: false, noanon: false, error: false },
): PageSource {
  const d = makeFixture(nowMs);
  const tables: Record<TableName, { id: string | number; created_at: string }[]> = {
    sessions: opts.noanon
      ? d.sessions.map((s) => {
          const { is_anonymous: _drop, ...rest } = s;
          void _drop;
          return rest as SessionRow;
        })
      : d.sessions,
    events: d.events,
    catune: d.catune,
    cadecon: d.cadecon,
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return {
    pageFn(name, range) {
      const rows = tables[name]
        .filter((r) => {
          const t = Date.parse(r.created_at);
          return t >= range.from && t < range.to;
        })
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || cmp(b.id, a.id));
      return async (cursor, signal) => {
        if (opts.error && name === 'sessions') {
          throw new Error('column analytics_sessions.is_anonymous does not exist');
        }
        if (opts.slow && name === 'events') await sleep(1500);
        if (signal.aborted) throw new DOMException('aborted', 'AbortError');
        const after = cursor
          ? rows.filter(
              (r) =>
                r.created_at < cursor.created_at ||
                (r.created_at === cursor.created_at && cmp(r.id, cursor.id) < 0),
            )
          : rows;
        return after.slice(0, 1000) as never[];
      };
    },
  };
}
