# Synthetic Data Simulation

CaLab can generate realistic synthetic calcium traces with full ground truth, useful for testing and benchmarking deconvolution algorithms.

## Basic usage

```python
import calab

result = calab.simulate()

print(result.traces.shape)              # (10, 9000) — 10 cells, 5 min at 30 Hz
print(len(result.ground_truth))         # 10 — one per cell
print(result.ground_truth[0].spikes)    # spike times (in samples)
```

## Indicator presets

```python
# GCaMP6f (default)
result = calab.simulate(calab.presets.gcamp6f(num_cells=20))

# GCaMP6s (slow kinetics)
result = calab.simulate(calab.presets.gcamp6s())

# jGCaMP8f (fast kinetics)
result = calab.simulate(calab.presets.jgcamp8f(num_cells=50))

# Clean traces (no noise, no drift)
result = calab.simulate(calab.presets.clean())
```

## Custom configuration

The simulation is configured with Pydantic models:

```python
from calab import SimulationConfig, KernelConfig, NoiseConfig, MarkovConfig

config = SimulationConfig(
    num_cells=20,
    duration_s=120.0,
    fs=30.0,
    kernel=KernelConfig(tau_rise=0.02, tau_decay=0.4, tau_decay_cv=0.15),
    spike=MarkovConfig(p_silent_to_active=0.01),
    noise=NoiseConfig(snr=5.0),
)

result = calab.simulate(config)
```

### Spike models

Two spike generators are available:

- **MarkovConfig** — Two-state HMM (silent/active) with bursty firing. Default.
- **PoissonConfig** — Homogeneous Poisson process at a fixed rate.

```python
from calab import SimulationConfig, PoissonConfig

config = SimulationConfig(spike=PoissonConfig(rate_hz=2.0))
result = calab.simulate(config)
```

### Noise and artifacts

```python
from calab import SimulationConfig, NoiseConfig, PhotobleachingConfig, SaturationConfig

config = SimulationConfig(
    noise=NoiseConfig(snr=3.0),
    photobleaching=PhotobleachingConfig(tau_bleach=300.0),
    saturation=SaturationConfig(half_max=5.0),
)
```

### Drift models

```python
from calab import SimulationConfig, SinusoidalDrift, RandomWalkDrift

# Deterministic sinusoidal drift
config = SimulationConfig(drift=SinusoidalDrift(amplitude=0.1, period_s=60.0))

# Stochastic mean-reverting random walk
config = SimulationConfig(drift=RandomWalkDrift(sigma=0.01))
```

## Ground truth

Each cell's ground truth is a `CellGroundTruth` object:

```python
gt = result.ground_truth[0]

gt.spikes        # spike sample indices
gt.calcium       # noiseless calcium trace
gt.true_baseline # baseline value
gt.tau_rise      # actual tau_rise for this cell (may vary if tau_decay_cv > 0)
gt.tau_decay     # actual tau_decay for this cell
```
