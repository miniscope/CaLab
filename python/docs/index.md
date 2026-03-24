# CaLab

**Calcium imaging analysis tools — deconvolution and data preparation.**

Calcium imaging captures neural activity as fluorescence traces, but the
raw signal is a blurred, noisy proxy for the underlying spiking activity.
_Deconvolution_ recovers a sharp estimate of that activity from the slow
calcium indicator dynamics. CaLab makes this step fast and tunable: a
compiled Rust FISTA solver runs the math, an interactive browser UI lets
you dial in the parameters on real data, and Python utilities handle the
rest — loading traces from CaImAn or Minian, batch processing, and
exporting results.

```bash
pip install calab
```

## Getting Started

```{toctree}
:maxdepth: 2

installation
quickstart
```

## User Guide

```{toctree}
:maxdepth: 2

guides/bridge
guides/loaders
guides/simulation
guides/batch-deconvolution
cli
```

## API Reference

```{toctree}
:maxdepth: 3

autoapi/index
```

## Project

```{toctree}
:maxdepth: 1

changelog
```
