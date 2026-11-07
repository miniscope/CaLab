//! Python bindings stub. Intentionally minimal until the pipeline exists.

use pyo3::prelude::*;

#[pyfunction]
fn cala_version() -> &'static str {
    crate::CALA_VERSION
}

/// The function name must match the leaf of the future module-name ("calab._cala").
#[pymodule]
fn _cala(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(cala_version, m)?)?;
    Ok(())
}
