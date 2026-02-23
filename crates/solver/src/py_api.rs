use pyo3::prelude::*;

/// calab-solver: Rust FISTA deconvolution engine for CaLab.
#[pymodule]
fn calab_solver(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add("__version__", env!("CARGO_PKG_VERSION"))?;
    // TODO: Add PySolver wrapper exposing Solver via numpy arrays
    Ok(())
}
