# Synthetic Data Simulation

## Why simulate?

Simulated traces with known ground truth let you:

- **Benchmark deconvolution** — measure spike detection accuracy against known spike trains.
- **Test edge cases** — vary SNR, kernel shape, drift, and saturation to see where algorithms break.
- **Test pipelines** — confirm that your analysis code handles common artifacts before running it on real data.

CaLab's simulation runs the heavy work in Rust for performance and exposes Pydantic configuration models in Python for full control.

## Basic usage

```python
import calab

result = calab.simulate()

print(result.traces.shape)              # (100, 27000) — 100 cells, 15 min at 30 Hz
print(len(result.ground_truth))         # 100 — one CellGroundTruth per cell
print(result.ground_truth[0].spikes)    # (27000,) spike counts at imaging rate
```

`simulate()` accepts an optional `SimulationConfig` and/or keyword overrides:

```python
# Override individual fields on the default config
result = calab.simulate(num_cells=50, seed=123)

# Pass a full config object
config = calab.SimulationConfig(num_cells=20)
result = calab.simulate(config)

# Combine a config with keyword overrides
result = calab.simulate(config, seed=99)
```

## Indicator presets

Each preset returns a `SimulationConfig` with approximate, indicator-appropriate kernel time constants and a measured SNR typical of real recordings (the value each preset measures at under default firing at 30 Hz with CASCADE's typical noise level ν ≈ 4 %/√Hz). These are rough starting points for generating synthetic data, not validated fits to real indicator measurements. All presets accept `**overrides` to customize any field.

Available presets: `gcamp6f`, `gcamp6s`, `gcamp6m`, `jgcamp8f`, `ogb1`, and `clean` (minimal noise, for debugging).

```python
result = calab.simulate(calab.presets.gcamp6f(num_cells=20))
result = calab.simulate(calab.presets.jgcamp8f(num_cells=50))
result = calab.simulate(calab.presets.clean())
```

## Custom configuration

The simulation is configured with Pydantic models. Every field has a sensible default.

```python
from calab import SimulationConfig, KernelConfig, NoiseConfig, MarkovConfig

config = SimulationConfig(
    num_cells=20,
    num_timepoints=9000,       # 9000 samples = 5 min at 30 Hz
    fs_hz=30.0,
    kernel=KernelConfig(tau_rise_s=0.02, tau_decay_s=0.4, tau_decay_cv=0.15),
    spike_model=MarkovConfig(p_silent_to_active=0.01),
    noise=NoiseConfig(snr=5.0),
)

result = calab.simulate(config)
```

### SimulationConfig defaults

| Field            | Default                  | Description                                   |
| ---------------- | ------------------------ | --------------------------------------------- |
| `fs_hz`          | 30.0                     | Sampling rate (Hz)                            |
| `num_timepoints` | 27000                    | Number of timepoints (27000 / 30 Hz = 15 min) |
| `num_cells`      | 100                      | Number of cells                               |
| `kernel`         | `KernelConfig()`         | Double-exponential kernel                     |
| `spike_model`    | `MarkovConfig()`         | Spike generator                               |
| `noise`          | `NoiseConfig()`          | Noise model                                   |
| `drift`          | `RandomWalkDrift()`      | Baseline drift model                          |
| `photobleaching` | `PhotobleachingConfig()` | Photobleaching (disabled by default)          |
| `saturation`     | `SaturationConfig()`     | Indicator saturation (disabled by default)    |
| `alpha_mean`     | 1.0                      | Mean per-cell amplitude scaling factor        |
| `alpha_cv`       | 0.3                      | Per-cell log-normal CV on alpha               |
| `seed`           | 42                       | RNG seed (u32)                                |
| `spike_sim_hz`   | 300.0                    | Internal spike simulation rate (Hz)           |

### Spike models

Two spike generators are available:

- **MarkovConfig** — Two-state model (silent/active) with bursty firing. Default.
- **PoissonConfig** — Poisson process at a fixed rate (`rate_hz`, default 1.0).

```python
from calab import SimulationConfig, PoissonConfig

config = SimulationConfig(spike_model=PoissonConfig(rate_hz=2.0))
result = calab.simulate(config)
```

### Kernel

`KernelConfig` defines the double-exponential calcium response (rise and decay time constants).

| Field          | Default | Description                         |
| -------------- | ------- | ----------------------------------- |
| `tau_rise_s`   | 0.1     | Rise time constant (seconds)        |
| `tau_decay_s`  | 0.6     | Decay time constant (seconds)       |
| `tau_rise_cv`  | 0.0     | Per-cell log-normal CV on tau_rise  |
| `tau_decay_cv` | 0.0     | Per-cell log-normal CV on tau_decay |

### Noise and artifacts

```python
from calab import SimulationConfig, NoiseConfig, PhotobleachingConfig, SaturationConfig

config = SimulationConfig(
    noise=NoiseConfig(snr=3.0, shot_noise_enabled=True),
    photobleaching=PhotobleachingConfig(enabled=True, decay_time_constant_s=300.0),
    saturation=SaturationConfig(enabled=True, k_d=5.0),
)
```

**NoiseConfig** defaults: `snr=8.0`, `reference="measured_snr"`, `shot_noise_enabled=False`, `shot_noise_fraction=0.3`, `snr_spread=0.0`.

### What `snr` means

By default (`reference="measured_snr"`) each simulated trace measures at `snr` with `calab.measured_snr`, the same function you run on your own recordings: the mean of the trace's top 1 % of samples minus its median (both read after subtracting a slow baseline, a rolling 20th percentile over 60 s, so photobleaching and other slow drift do not inflate it), over the noise σ from the MAD of frame-to-frame differences (Krisha Aghi's estimator). The metric is burst-based, because on real data a single action potential usually sits inside the noise. It compares cells that share a burst-size distribution, as cells of one simulated dataset do; at the same per-spike noise a burstier cell measures higher and a sparser cell lower. Pure noise measures about 2.7 (2.5–2.9 for 1–30 minute traces), with or without slow drift, so targets below that are unreachable and clamp to it, and values near it mean "indistinguishable from noise".

`reference="peak"` reproduces the pre-change convention (`noise σ = max(clean) / snr`), and `reference="single_spike"` sets the noise against one spike's response. Every cell also reports `noise_sigma` and the simulation-only diagnostic `snr_1ap` (single-spike response over `noise_sigma`).

```python
trace = result.traces[0]
calab.measured_snr(trace, fs=30.0)   # ~= config.noise.snr (fs sets the 60 s drift window)
calab.noise_sigma_mad_diff(trace)    # robust noise std
calab.noise_level_nu(trace_dff_percent, fs=30.0)  # CASCADE noise level

# Is there anything there? Events and the silent flag (separation ~ decay time in samples)
sep = round(0.4 * 30.0)
report = calab.measured_snr_report(trace, fs=30.0, min_separation_samples=sep)
report.snr, report.is_silent         # top-slice SNR; True if no event clears the noise floor
events = calab.detect_events(trace, min_separation_samples=sep)  # [Event(time_index, height, baseline)]
```

`measured_snr` is always the top-slice number. A trace with no activity measures about 2.7, so use `is_silent` (no event above a floor chosen so pure noise gives about 0.1 false events per trace) rather than a threshold on the SNR to decide whether a cell is active.

**PhotobleachingConfig** (disabled by default): `decay_time_constant_s=600.0`, `amplitude_fraction=0.15`, `amplitude_cv=0.0`.

**SaturationConfig** (disabled by default): `hill_coefficient=1.0`, `k_d=5.0`, `k_d_cv=0.0`.

### Drift models

```python
from calab import SimulationConfig, SinusoidalDrift, RandomWalkDrift

# Deterministic sinusoidal drift
config = SimulationConfig(drift=SinusoidalDrift(amplitude_fraction=0.1, cycles_min=2.0))

# Stochastic mean-reverting random walk (default)
config = SimulationConfig(drift=RandomWalkDrift(step_std_fraction=0.01))
```

Drift amplitudes are fractions of the same robust signal the SNR uses (mean of the clean trace's top 1 % of samples minus its median), so drift relative to the noise is `fraction × SNR` in every firing regime. `NoiseConfig(reference="peak")` keeps the old `max(clean)` scaling.

**RandomWalkDrift** (default): `step_std_fraction=0.002`, `mean_reversion=0.001`, `step_std_cv=0.0`.

**SinusoidalDrift**: `amplitude_fraction=0.1`, `cycles_min=2.0`, `cycles_max=4.0`, `amplitude_cv=0.0`.

## Ground truth

Each cell's ground truth is a `CellGroundTruth` object with these fields:

```python
gt = result.ground_truth[0]

gt.spikes          # (num_timepoints,) spike counts at imaging rate
gt.clean_calcium   # (num_timepoints,) kernel * spikes, no noise
gt.alpha           # amplitude scaling factor for this cell
gt.snr             # this cell's target SNR (units of NoiseConfig.reference)
gt.noise_sigma     # std of the noise actually added
gt.snr_1ap         # simulation-only: single-spike response / noise_sigma
gt.tau_rise_s      # actual rise time constant (seconds; varies if tau_rise_cv > 0)
gt.tau_decay_s     # actual decay time constant (seconds; varies if tau_decay_cv > 0)
```
