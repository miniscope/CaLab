//! Writes the params schema (`schema/cala-params.schema.json`) and the
//! default-params golden files (`tests/golden/engine-view-fps{20,30}.json`).
//!
//! Run from the repo root as `npm run gen:params`, which also regenerates the
//! TS types from the schema. The cargo tests fail when a checked-in file
//! differs from what this writes.

use std::path::Path;

use calab_cala::params::{meta, resolve};

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = vec![(meta::SCHEMA_PATH.to_string(), meta::params_schema_text())];
    for fps in resolve::GOLDEN_FPS {
        files.push((resolve::golden_path(fps), resolve::golden_text(fps)));
    }
    for (rel, text) in files {
        let path = root.join(&rel);
        std::fs::create_dir_all(path.parent().expect("a file path has a parent"))
            .expect("create the output folder");
        std::fs::write(&path, text).expect("write the output file");
        println!("wrote {}", path.display());
    }
}
