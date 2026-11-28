//! Migrations of stored params between [`PARAMS_VERSION`]s.
//!
//! A params block is stored with its `params_version`. An older block is
//! brought up to date in memory by the steps of [`MIGRATIONS`], applied in
//! order; each step is a pure JSON → JSON function from version `n` to
//! `n + 1`. A renamed or moved field is a step here, not a serde alias, so
//! the structs only ever describe the current layout. A newer block is
//! refused: this build cannot know what its fields mean.

use serde_json::Value;

use super::PARAMS_VERSION;

/// One migration step: params of version `from` to version `from + 1`.
#[derive(Clone, Copy)]
pub struct Migration {
    /// The version the step reads.
    pub from: u32,
    /// The step. It returns an error message for a block it cannot read.
    pub step: fn(Value) -> Result<Value, String>,
}

/// The migration steps of this build, by ascending `from`. Empty while
/// [`PARAMS_VERSION`] is 1: there is no older layout.
pub const MIGRATIONS: &[Migration] = &[];

/// Why stored params could not be migrated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MigrateError {
    /// The params come from a newer build.
    Newer { found: u32, current: u32 },
    /// No step reads this version.
    Missing { from: u32 },
    /// A step refused the params.
    Step { from: u32, message: String },
}

impl std::fmt::Display for MigrateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MigrateError::Newer { found, current } => write!(
                f,
                "params version {found} is newer than this build's {current}; not read"
            ),
            MigrateError::Missing { from } => {
                write!(f, "no migration from params version {from}")
            }
            MigrateError::Step { from, message } => {
                write!(f, "migration from params version {from} failed: {message}")
            }
        }
    }
}

impl std::error::Error for MigrateError {}

/// `params`, stored at version `from`, at [`PARAMS_VERSION`].
pub fn migrate(params: Value, from: u32) -> Result<Value, MigrateError> {
    migrate_with(params, from, PARAMS_VERSION, MIGRATIONS)
}

/// `params`, stored at version `from`, at version `to`, through `steps`.
/// Same version: unchanged. Each version from `from` to `to - 1` needs one
/// step.
pub fn migrate_with(
    mut params: Value,
    from: u32,
    to: u32,
    steps: &[Migration],
) -> Result<Value, MigrateError> {
    if from > to {
        return Err(MigrateError::Newer {
            found: from,
            current: to,
        });
    }
    for v in from..to {
        let m = steps
            .iter()
            .find(|m| m.from == v)
            .ok_or(MigrateError::Missing { from: v })?;
        params = (m.step)(params).map_err(|message| MigrateError::Step { from: v, message })?;
    }
    Ok(params)
}
