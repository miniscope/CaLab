# Installation

## Basic install

```bash
pip install calab
```

This installs the core package with numpy, pydantic, and the compiled Rust solver extension.

Requires **Python 3.10+**.

## Optional dependencies

### Format loaders

To load data from CaImAn (HDF5) or Minian (Zarr) pipelines:

```bash
pip install calab[loaders]
```

This adds `h5py` and `zarr`.

### Headless browser

For automated browser-based deconvolution without a visible window:

```bash
pip install calab[headless]
playwright install chromium
```

### Everything

```bash
pip install calab[all]
```

## Development install

```bash
git clone https://github.com/miniscope/CaLab.git
cd CaLab/python
python -m venv .venv
source .venv/bin/activate
pip install maturin
maturin develop --features pybindings
pip install -e ".[dev]"
```

This requires a **Rust toolchain** (`rustup`) for compiling the native solver extension.
