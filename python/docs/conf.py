"""Sphinx configuration for CaLab Python documentation."""

project = "CaLab"
copyright = "2026, Daniel Aharoni"
author = "Daniel Aharoni"

extensions = [
    "sphinx.ext.napoleon",      # NumPy/Google-style docstrings
    "sphinx.ext.intersphinx",   # Link to numpy/python docs
    "autoapi.extension",        # Auto-generate API docs (no import needed)
    "myst_parser",              # Markdown support
]

# -- sphinx-autoapi (static analysis, no Rust build required) ----------------
autoapi_dirs = ["../src/calab"]
autoapi_type = "python"
autoapi_ignore = ["*/_solver*"]  # Rust extension — not introspectable
autoapi_options = [
    "members",
    "undoc-members",
    "show-inheritance",
    "show-module-summary",
    "imported-members",
]
autoapi_keep_files = False
autoapi_member_order = "groupwise"
autoapi_python_class_content = "both"  # Show both class docstring and __init__
suppress_warnings = [
    "autoapi.python_import_resolution",
    "autoapi.duplicate_object",       # NamedTuple fields appear twice (known issue)
]

# -- MyST (Markdown) ---------------------------------------------------------
myst_enable_extensions = [
    "colon_fence",    # ::: directive syntax
    "fieldlist",      # :param: style fields
]
source_suffix = {
    ".rst": "restructuredtext",
    ".md": "markdown",
}

# -- Intersphinx --------------------------------------------------------------
intersphinx_mapping = {
    "python": ("https://docs.python.org/3", None),
    "numpy": ("https://numpy.org/doc/stable/", None),
    "pydantic": ("https://docs.pydantic.dev/latest/", None),
}

# -- Theme --------------------------------------------------------------------
html_theme = "furo"
html_static_path = ["_static"]
html_title = "CaLab"

# -- General -------------------------------------------------------------------
exclude_patterns = ["_build", "Thumbs.db", ".DS_Store"]
nitpicky = False  # Don't warn on missing references (numpy types, etc.)
