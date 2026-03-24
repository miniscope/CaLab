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

Each preset returns a `SimulationConfig` with approximate, indicator-appropriate kernel time constants and SNR. These are rough starting points for generating synthetic data, not validated fits to real indicator measurements. All presets accept `**overrides` to customize any field.

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

**NoiseConfig** defaults: `snr=8.0`, `shot_noise_enabled=False`, `shot_noise_fraction=0.3`, `snr_spread=0.0`.

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

**RandomWalkDrift** (default): `step_std_fraction=0.002`, `mean_reversion=0.001`, `step_std_cv=0.0`.

**SinusoidalDrift**: `amplitude_fraction=0.1`, `cycles_min=2.0`, `cycles_max=4.0`, `amplitude_cv=0.0`.

## Ground truth

Each cell's ground truth is a `CellGroundTruth` object with these fields:

```python
gt = result.ground_truth[0]

gt.spikes          # (num_timepoints,) spike counts at imaging rate
gt.clean_calcium   # (num_timepoints,) kernel * spikes, no noise
gt.alpha           # amplitude scaling factor for this cell
gt.snr             # actual SNR for this cell
gt.tau_rise_s      # actual rise time constant (seconds; varies if tau_rise_cv > 0)
gt.tau_decay_s     # actual decay time constant (seconds; varies if tau_decay_cv > 0)
```
