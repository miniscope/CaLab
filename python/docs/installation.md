# Installation

## Basic install

```bash
pip install calab
```

This installs the core package with numpy, pydantic, and the compiled Rust solver extension. You get deconvolution, simulation, and the interactive `tune()` bridge out of the box.

Requires **Python 3.10+**.

## Optional dependencies

### Format loaders

If your traces come from CaImAn (HDF5) or Minian (Zarr), install the loader extras to avoid writing manual import code:

```bash
pip install calab[loaders]
```

This adds `h5py` and `zarr`.

### Headless browser

For running CaDecon in CI or scripts without a visible browser window:

```bash
pip install calab[headless]
playwright install chromium
```

This adds `playwright`. The second command downloads the Chromium binary that Playwright needs.

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
