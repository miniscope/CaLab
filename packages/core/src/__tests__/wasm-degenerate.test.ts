/**
 * Degenerate inputs through the real WASM build (`jsbindings`).
 *
 * The Rust tests cover the shared validation and the core functions natively,
 * but the wasm-bindgen wrappers (JsError conversion, JS number -> usize/u32
 * coercion, serde-wasm-bindgen) only exist in the compiled module. This suite
 * calls every export with degenerate input and asserts the contract the
 * workers rely on: a bad input throws an ordinary `Error` (never a WASM trap,
 * which surfaces as a `RuntimeError` and leaves the module unusable), and
 * degenerate-but-legal input returns finite output of the right length.
 *
 * Loading mirrors wasm-parity.test.ts (stubbed fetch for the .wasm file).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SnrReport } from '../metrics/snr-events.ts';
import {
  Solver,
  get_simulation_presets,
  indeca_estimate_kernel,
  indeca_fit_biexponential,
  indeca_solve_trace,
  initWasm,
  seed_trace,
  simulate_traces,
  snr_default_top_fraction,
  snr_detect_events,
  snr_measured,
  snr_measured_report,
  snr_noise_level_nu,
  snr_noise_sigma_mad_diff,
  snr_peak,
} from '../wasm-adapter.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const PKG_WASM = `${REPO_ROOT}crates/solver/pkg/calab_solver_bg.wasm`;
const pkgPresent = existsSync(PKG_WASM);
if (!pkgPresent && process.env.CI) {
  throw new Error(`WASM pkg missing at ${PKG_WASM}. Run \`npm run ensure-wasm\` first.`);
}

const TAU_R = 0.02;
const TAU_D = 0.4;
const LAM = 0.01;
const FS = 30;
const MAX_KERNEL_LEN = 2 ** 20;
const KERNEL_TAIL = -Math.log(1e-6);

const BAD_PARAMS: [string, number, number, number, number][] = [
  ['reversed taus', 0.4, 0.02, LAM, FS],
  ['equal taus', 0.4, 0.4, LAM, FS],
  ['tau_rise = 0', 0, TAU_D, LAM, FS],
  ['tau_decay < 0', TAU_R, -0.4, LAM, FS],
  ['tau NaN', NaN, TAU_D, LAM, FS],
  ['fs = 0', TAU_R, TAU_D, LAM, 0],
  ['fs < 0', TAU_R, TAU_D, LAM, -FS],
  ['fs Infinity', TAU_R, TAU_D, LAM, Infinity],
  ['lambda < 0', TAU_R, TAU_D, -1e-9, FS],
  ['lambda NaN', TAU_R, TAU_D, NaN, FS],
  ['kernel over cap', 20, 400, LAM, 30_000],
];

function spiky(n = 200): Float32Array {
  const t = new Float32Array(n).fill(0.2);
  for (const onset of [Math.floor(n / 5), Math.floor(n / 2), Math.floor((4 * n) / 5)]) {
    for (let j = onset; j < n; j++) {
      const dt = (j - onset) / FS;
      t[j] += Math.exp(-dt / TAU_D) - Math.exp(-dt / TAU_R);
    }
  }
  return t;
}

const finite = (v: ArrayLike<number>) => Array.from(v).every(Number.isFinite);

/** Throws a plain validation Error (not a trap), with the given text. */
function expectRejected(fn: () => unknown, text: string | RegExp): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err, 'expected a thrown Error').toBeInstanceOf(Error);
  expect((err as Error).name, `trap instead of error: ${String(err)}`).not.toBe('RuntimeError');
  expect((err as Error).message).toMatch(text);
}

function solve(s: Solver): void {
  for (let i = 0; i < 50; i++) if (s.step_batch(20)) break;
}

describe.skipIf(!pkgPresent)('WASM exports reject degenerate input without trapping', () => {
  beforeAll(async () => {
    vi.stubGlobal('fetch', async (input: URL | string) => {
      const url = input instanceof URL ? input : new URL(input);
      if (url.protocol !== 'file:') throw new Error(`unexpected fetch in test: ${url}`);
      return new Response(readFileSync(fileURLToPath(url)), {
        headers: { 'Content-Type': 'application/wasm' },
      });
    });
    await initWasm();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  describe('Solver', () => {
    it.each(BAD_PARAMS)(
      'set_params rejects %s and leaves the solver usable',
      (_l, tr, td, lam, fs) => {
        const s = new Solver();
        try {
          s.set_params(TAU_R, TAU_D, LAM, FS);
          s.set_trace(spiky());
          const kernel = s.get_kernel();
          expectRejected(() => s.set_params(tr, td, lam, fs), 'invalid parameter');
          expect(s.get_kernel()).toEqual(kernel);
          solve(s);
          expect(finite(s.get_solution())).toBe(true);
        } finally {
          s.free();
        }
      },
    );

    it.each([
      ['all NaN', new Float32Array(20).fill(NaN), 0],
      ['single NaN', Float32Array.of(NaN), 0],
      ['NaN mid', Float32Array.of(1, 1, NaN, 1), 2],
      ['+Infinity last', Float32Array.of(1, 1, Infinity), 2],
      ['-Infinity first', Float32Array.of(-Infinity, 1), 0],
    ])('set_trace rejects %s', (_l, trace, idx) => {
      const s = new Solver();
      try {
        s.set_trace(spiky(50));
        expectRejected(() => s.set_trace(trace), `index ${idx}`);
        expect(s.get_trace()).toEqual(spiky(50)); // untouched
      } finally {
        s.free();
      }
    });

    it('handles empty / single-sample traces and getters before any solve', () => {
      const s = new Solver();
      try {
        expect(s.get_solution().length).toBe(0);
        expect(s.get_reconvolution_with_baseline().length).toBe(0);
        expect(s.get_baseline()).toBe(0);
        expect(s.iteration_count()).toBe(0);
        expect(s.step_batch(5)).toBe(true);
        for (const n of [0, 1, 2, 7]) {
          s.set_filter_enabled(n % 2 === 1);
          s.set_trace(new Float32Array(n).fill(2));
          s.apply_filter();
          s.subtract_baseline();
          solve(s);
          expect(s.get_solution().length).toBe(n);
          expect(finite(s.get_solution())).toBe(true);
          expect(finite(s.get_reconvolution_with_baseline())).toBe(true);
          expect(Number.isFinite(s.get_baseline())).toBe(true);
        }
        s.load_state(new Uint8Array(13)); // malformed: ignored
      } finally {
        s.free();
      }
    });

    it('spectrum frequency axis always matches the power spectrum length', () => {
      const s = new Solver();
      try {
        // No trace loaded: both empty (the axis used to be [NaN]).
        expect(s.get_spectrum_frequencies().length).toBe(0);
        expect(s.get_power_spectrum().length).toBe(0);
        for (const n of [1, 2, 7, 8, 9, 64]) {
          s.set_trace(new Float32Array(n).fill(1));
          const freqs = s.get_spectrum_frequencies();
          expect(freqs.length, `n=${n}`).toBe(s.get_power_spectrum().length);
          expect(freqs.length, `n=${n}`).toBe(n < 8 ? 0 : Math.floor(n / 2) + 1);
          expect(finite(freqs), `n=${n}`).toBe(true);
        }
      } finally {
        s.free();
      }
    });

    it('display getters are idempotent and do not change the solve (bug 1.2)', () => {
      const polled = new Solver();
      const quiet = new Solver();
      try {
        const trace = spiky(300).map((v) => v + 3);
        for (const s of [polled, quiet]) {
          s.set_params(TAU_R, TAU_D, LAM, FS);
          s.set_trace(trace);
        }
        for (let i = 0; i < 40; i++) {
          const a = [polled.get_solution(), polled.get_reconvolution(), polled.get_baseline()];
          const b = [polled.get_solution(), polled.get_reconvolution(), polled.get_baseline()];
          expect(b).toEqual(a);
          const done = polled.step_batch(5);
          expect(quiet.step_batch(5)).toBe(done);
          if (done) break;
        }
        expect(polled.export_state()).toEqual(quiet.export_state());
        expect(polled.get_solution()).toEqual(quiet.get_solution());
      } finally {
        polled.free();
        quiet.free();
      }
    });

    it('kernel length: exactly at the cap is accepted, just over is rejected', () => {
      const s = new Solver();
      try {
        s.set_params(1, (MAX_KERNEL_LEN - 0.5) / KERNEL_TAIL, LAM, 1);
        expect(s.get_kernel().length).toBe(MAX_KERNEL_LEN);
        expectRejected(
          () => s.set_params(1, (MAX_KERNEL_LEN + 0.5) / KERNEL_TAIL, LAM, 1),
          'kernel',
        );
      } finally {
        s.free();
      }
    });
  });

  describe('indeca_solve_trace', () => {
    const call = (
      trace: Float32Array,
      {
        tr = TAU_R,
        td = TAU_D,
        fs = FS,
        mfr = FS,
        tol = 1e-4,
        warm = new Float32Array(0),
        lam = 0,
      } = {},
    ) => indeca_solve_trace(trace, tr, td, fs, mfr, 50, tol, false, false, warm, lam);

    it.each(BAD_PARAMS)('rejects %s', (_l, tr, td, lam, fs) => {
      expectRejected(
        () => call(spiky(), { tr, td, fs, lam }),
        /^indeca_solve_trace: invalid parameter/,
      );
    });

    it.each([
      ['max_firing_rate 0', { mfr: 0 }, 'max_firing_rate'],
      ['max_firing_rate NaN', { mfr: NaN }, 'max_firing_rate'],
      ['max_firing_rate -1', { mfr: -1 }, 'max_firing_rate'],
      ['max_firing_rate over 10000', { mfr: 10001 }, 'max_firing_rate'],
      ['tol < 0', { tol: -1 }, 'tol'],
    ])('rejects %s', (_l, opts, text) => {
      expectRejected(() => call(spiky(), opts), text);
    });

    it('rejects non-finite trace and warm counts', () => {
      expectRejected(() => call(Float32Array.of(1, NaN)), 'non-finite');
      expectRejected(() => call(spiky(10), { warm: Float32Array.of(Infinity) }), 'warm_counts');
    });

    it.each([0, 1, 2, 200])('accepts a %i-sample trace', (n) => {
      const r = call(new Float32Array(n).fill(1)) as {
        s_counts: number[];
        alpha: number;
        pve: number;
      };
      expect(r.s_counts.length).toBe(n);
      expect(finite(r.s_counts) && Number.isFinite(r.alpha) && Number.isFinite(r.pve)).toBe(true);
    });
  });

  describe('indeca_estimate_kernel', () => {
    const t20 = new Float32Array(20).fill(0.5);
    const call = (
      lengths: number[],
      { alphas = [1, 1], baselines = [0, 0], k = 5, traces = t20, spikes = t20, sl = 0 } = {},
    ) =>
      indeca_estimate_kernel(
        traces,
        spikes,
        Uint32Array.from(lengths),
        Float64Array.from(alphas),
        Float64Array.from(baselines),
        k,
        20,
        1e-4,
        new Float32Array(0),
        sl,
      );

    it.each([
      ['lengths do not sum to the data', [10, 9], {}, 'sum\\(trace_lengths\\)'],
      ['alphas short', [10, 10], { alphas: [1] }, 'one entry per trace'],
      ['alpha NaN', [10, 10], { alphas: [1, NaN] }, 'alphas'],
      ['kernel_length 0', [10, 10], { k: 0 }, 'kernel_length'],
      ['kernel_length over cap', [10, 10], { k: MAX_KERNEL_LEN + 1 }, 'kernel_length'],
      ['kernel_length -1 (coerced to 2^32-1)', [10, 10], { k: -1 }, 'kernel_length'],
      ['u32 lengths overflowing usize on wasm32', [2 ** 32 - 1, 21], {}, 'overflow'],
      ['smooth_lambda < 0', [10, 10], { sl: -1 }, 'smooth_lambda'],
    ])('rejects %s', (_l, lengths, opts, text) => {
      expectRejected(() => call(lengths, opts), new RegExp(text));
    });

    it('accepts no traces, empty traces and traces shorter than the kernel', () => {
      const empty = new Float32Array(0);
      expect(finite(call([], { alphas: [], baselines: [], traces: empty, spikes: empty }))).toBe(
        true,
      );
      expect(call([0], { alphas: [1], baselines: [0], traces: empty, spikes: empty }).length).toBe(
        5,
      );
      const three = new Float32Array(3).fill(1);
      expect(
        finite(call([3], { alphas: [1], baselines: [0], traces: three, spikes: three, k: 10 })),
      ).toBe(true);
    });
  });

  describe('indeca_fit_biexponential', () => {
    const call = (h: Float32Array, fs = FS, warm = false, wTauRise = TAU_R, residual = Infinity) =>
      indeca_fit_biexponential(h, fs, true, 0, wTauRise, TAU_D, 0, 0, 1, 0, residual, warm) as {
        tau_rise: number;
        tau_decay: number;
        fit_mode: string;
      };

    it.each([0, -1, NaN, Infinity])('rejects fs = %d', (fs) => {
      expectRejected(() => call(new Float32Array(10).fill(1), fs), 'fs');
    });

    it('rejects non-finite kernels and warm fields', () => {
      expectRejected(() => call(Float32Array.of(0, NaN)), 'h_free');
      expectRejected(() => call(new Float32Array(10).fill(1), FS, true, NaN), 'warm_tau_rise');
      expectRejected(
        () => call(new Float32Array(10).fill(1), FS, true, TAU_R, NaN),
        'warm_residual',
      );
    });

    it.each([-1, 0, TAU_D, 1])('rejects non-physical warm tau_rise = %d', (tr) => {
      expectRejected(() => call(new Float32Array(10).fill(1), FS, true, tr), 'warm_tau_rise');
    });

    it.each([0, 1, 2, 50])('accepts a %i-sample kernel', (n) => {
      const r = call(new Float32Array(n).fill(1));
      expect(Number.isFinite(r.tau_rise) && Number.isFinite(r.tau_decay)).toBe(true);
    });
  });

  describe('seed_trace', () => {
    it('seed_trace rejects bad fs / non-finite traces and accepts tiny traces', () => {
      expectRejected(() => seed_trace(spiky(), 0), 'fs');
      expectRejected(() => seed_trace(Float32Array.of(NaN), FS), 'non-finite');
      for (const n of [0, 1, 2]) {
        const r = seed_trace(new Float32Array(n).fill(1), FS) as { s_counts: number[] };
        expect(r.s_counts.length).toBe(n);
      }
    });
  });

  describe('simulate_traces', () => {
    const preset = () => {
      const [, cfg] = (get_simulation_presets() as [string, Record<string, unknown>][])[0];
      return { ...cfg, num_cells: 2, num_timepoints: 100 };
    };

    it('rejects configs that do not deserialize', () => {
      expectRejected(() => simulate_traces('not a config'), 'invalid SimulationConfig');
      expectRejected(
        () => simulate_traces({ ...preset(), fs_hz: 'fast' }),
        'invalid SimulationConfig',
      );
    });

    it.each([
      [0, 100],
      [2, 0],
      [2, 1],
    ])('handles %i cells x %i timepoints', (cells, tp) => {
      const r = simulate_traces({ ...preset(), num_cells: cells, num_timepoints: tp }) as {
        traces: number[];
      };
      expect(r.traces.length).toBe(cells * tp);
    });

    // Regression: simulate_traces ran no validation, so fs_hz = 0 or a
    // tau_decay_s in the wrong units trapped the module (overflow / OOM abort)
    // and tau_rise_s = 0 returned NaN traces. Now a plain Error, and the module
    // keeps working afterwards.
    it.each([
      ['fs_hz = 0', { fs_hz: 0 }, 'fs'],
      ['spike_sim_hz = 0', { spike_sim_hz: 0 }, 'spike_sim_hz'],
      ['cells x timepoints over cap', { num_cells: 2 ** 14, num_timepoints: 2 ** 13 }, 'num_cells'],
      ['tau_decay_s = 1e12', { kernel: { tau_decay_s: 1e12 } }, 'kernel'],
      ['tau_rise_s = 0', { kernel: { tau_rise_s: 0 } }, 'tau_rise'],
      ['reversed taus', { kernel: { tau_rise_s: 1, tau_decay_s: 0.1 } }, 'tau_rise'],
    ])('rejects %s without trapping', (_l, overrides, text) => {
      const base = preset() as Record<string, unknown>;
      const { kernel, ...rest } = overrides as { kernel?: Record<string, number> };
      const cfg = {
        ...base,
        ...rest,
        kernel: { ...(base.kernel as Record<string, number>), ...kernel },
      };
      expectRejected(() => simulate_traces(cfg), `simulate_traces: invalid parameter`);
      expectRejected(() => simulate_traces(cfg), text);
      // Still usable.
      expect((simulate_traces(preset()) as { traces: number[] }).traces.length).toBe(200);
    });
  });

  describe('snr metrics', () => {
    it('return finite, non-negative numbers on empty, tiny, constant and NaN traces', () => {
      const traces = [
        new Float32Array(0),
        new Float32Array([1]),
        new Float32Array([0, 1]),
        new Float32Array(200).fill(2.5),
        new Float32Array([0, NaN, 1, 2, Infinity, 0.5]),
      ];
      for (const t of traces) {
        for (const v of [
          snr_noise_sigma_mad_diff(t),
          snr_noise_level_nu(t, FS),
          snr_peak(t, 1, 0.01, FS),
          snr_measured(t, FS),
          // An invalid frame rate skips the drift removal instead of failing.
          snr_measured(t, 0),
          snr_measured(t, NaN),
        ]) {
          expect(Number.isFinite(v) && v >= 0, String(v)).toBe(true);
        }
      }
      for (const t of traces) {
        for (const sep of [0, 1, 12]) {
          expect(Array.isArray(snr_detect_events(t, snr_noise_sigma_mad_diff(t), sep))).toBe(true);
          const r = snr_measured_report(t, FS, sep) as SnrReport;
          expect(Number.isFinite(r.sigma) && r.sigma >= 0).toBe(true);
          expect(typeof r.is_silent).toBe('boolean');
        }
      }
      expect(snr_noise_level_nu(spiky(), 0)).toBe(0);
      expect(snr_noise_level_nu(spiky(), NaN)).toBe(0);
      expect(snr_default_top_fraction()).toBe(0.01);
    });
  });
});
