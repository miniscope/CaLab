# CaTune Python Companion

Calcium imaging deconvolution and data preparation -- Python companion package for the [CaTune](https://github.com/daharoni/CaTune) browser tool.

## Installation

```bash
pip install catune
```

## Quick Start

```python
import catune

# Build a calcium kernel
kernel = catune.build_kernel(tau_rise=0.02, tau_decay=0.4, fs=30.0)

# Get AR(2) coefficients
g1, g2, d, r = catune.tau_to_ar2(tau_rise=0.02, tau_decay=0.4, fs=30.0)

# Compute Lipschitz constant for FISTA step size
L = catune.compute_lipschitz(kernel)
```
