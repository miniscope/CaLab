//! The run parameters of cala ([`CalaParams`]): every value a user, a config
//! file or `qc_eval` may set, with its unit, range, level and description.
//!
//! The structs are the one definition. The JSON Schema
//! (`crates/cala/schema/cala-params.schema.json`) and the TS types
//! (`apps/cala/src/params/cala-params.d.ts`) are generated from them by
//! `npm run gen:params`; the drift tests in `tests.rs` fail when either
//! checked-in file is stale.
//!
//! Conventions:
//!
//! * Durations are seconds (`_s`); [`resolve`] turns them into frames.
//!   Counts of frames are sample sizes or schedules (`_frames`), never
//!   durations.
//! * Cell-scale pixel sizes are multiples of the cell diameter (`_d`,
//!   `_per_d`); absolute pixel sizes end in `_px`.
//! * `null` means "derived" or "off", as the field's description says.
//!   The one number that means off is `settle.background.cap: 0`, a
//!   labelled choice of its enum.
//! * Every block is `#[serde(default)]`: a partial params object (any subset
//!   of keys, at any depth) deserialises to the defaults plus what it sets.
//!   Unknown keys are ignored by serde; the app lists them to the user.
//!
//! The defaults are the app's shipped configuration. [`resolve::resolve`]
//! turns params into [`resolve::EngineView`], the engine-unit view pinned by
//! the golden files in `tests/golden/`, and [`engine::Engine`] builds the
//! engine's config structs from it. The wasm bindings take a resolved
//! handle (`js::ResolvedParams`); `qc_eval`'s flags are turned into params
//! with the help of [`loose`].

pub mod engine;
#[cfg(feature = "jsbindings")]
pub mod js;
pub mod layer;
pub mod loose;
pub mod meta;
pub mod migrate;
pub mod resolve;

#[cfg(test)]
mod tests;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// The version of the [`CalaParams`] layout. A file whose `params_version`
/// is older is migrated by [`migrate::migrate`]; a newer one is refused.
pub const PARAMS_VERSION: u32 = 1;

/// All run parameters of cala.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
#[schemars(title = "cala parameters")]
pub struct CalaParams {
    /// The microscope's optics: they turn sizes at the sample into pixels.
    #[schemars(title = "Optics")]
    pub optics: Optics,
    /// Spatial scales: the expected cell diameter and the sizes that follow it.
    #[schemars(title = "Scales")]
    pub scales: Scales,
    /// The recording's frame rate.
    #[schemars(title = "Time")]
    pub time: Time,
    /// Which part of the frame is processed.
    #[schemars(title = "Input")]
    pub input: Input,
    /// Footprints a run starts from.
    #[schemars(title = "Seed footprints")]
    pub seed: Seed,
    /// Which stages run.
    #[schemars(title = "Stages")]
    pub stages: Stages,
    /// Calibration, flicker, line and background corrections of each frame.
    #[schemars(title = "Preprocessing")]
    pub preprocess: Preprocess,
    /// Motion correction.
    #[schemars(title = "Motion correction")]
    pub motion: Motion,
    /// The sensor flat field estimated from the recording's own motion.
    #[schemars(title = "Flat field")]
    pub flat_field: FlatField,
    /// Cell discovery (the slow loop).
    #[schemars(title = "Discover")]
    pub discover: Discover,
    /// Re-reading past frames for the slow loop during Discover.
    #[schemars(title = "Look-back")]
    pub lookback: Lookback,
    /// Background settle and Final settle.
    #[schemars(title = "Settle")]
    pub settle: Settle,
    /// The per-frame trace solve.
    #[schemars(title = "Traces")]
    pub trace: Trace,
    /// Online quality control of the cells.
    #[schemars(title = "Quality control")]
    pub qc: Qc,
    /// Windowed low-rank factors of the preprocessed frames.
    #[schemars(title = "Factors")]
    pub factors: Factors,
    /// What is written to the export.
    #[schemars(title = "Export")]
    pub export: Export,
    /// How much compute the run uses, and whether its results may depend on
    /// it.
    #[schemars(title = "Compute")]
    pub compute: Compute,
}

// ---- optics ----

/// The microscope's optics. The size of one frame pixel at the sample is
/// `sensor_pixel_um × binning ÷ magnification`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Optics {
    /// Side of one sensor pixel. `null`: not known.
    #[schemars(
        title = "Sensor pixel size",
        range(min = 0.1, max = 100.0),
        extend("x-unit" = "um", "x-level" = "main")
    )]
    pub sensor_pixel_um: Option<f64>,
    /// Magnification from the sample to the sensor. `null`: not known.
    #[schemars(
        title = "Magnification",
        range(min = 0.01, max = 1000.0),
        extend("x-unit" = "ratio", "x-level" = "main")
    )]
    pub magnification: Option<f64>,
    /// Sensor pixels per frame pixel along each side. `null`: the sensor
    /// width over the frame width when the sensor width is known, else 1.
    #[schemars(
        title = "Binning",
        range(min = 1, max = 16),
        extend(
            "x-unit" = "count",
            "x-level" = "main",
            "x-derived" = "optics.sensor_width_px ÷ the frame width"
        )
    )]
    pub binning: Option<u32>,
    /// Width of the full sensor. `null`: not known.
    #[schemars(
        title = "Sensor width",
        range(min = 1, max = 65535),
        extend("x-unit" = "px", "x-level" = "main")
    )]
    pub sensor_width_px: Option<u32>,
}

// ---- scales ----

/// Spatial scales. Every cell-scale pixel size in the engine follows the
/// expected cell diameter.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Scales {
    /// The diameter of the largest cells you expect, at the sample. With the
    /// optics known it gives the diameter in pixels; it is used when
    /// `cell_diameter_px` is `null`. `null`: not given.
    #[schemars(
        title = "Expected cell diameter",
        range(min = 1.0, max = 200.0),
        extend("x-unit" = "um", "x-level" = "main")
    )]
    pub expected_cell_diameter_um: Option<f64>,
    /// The expected cell diameter in pixels, set directly. When set it
    /// overrides the diameter derived from `expected_cell_diameter_um` and
    /// the optics. Flattening, detection and every cell-scale radius follow
    /// the resolved diameter. `null`: derived from the physical diameter.
    #[schemars(
        title = "Expected cell diameter in pixels",
        range(min = 4.0, max = 64.0),
        extend(
            "x-unit" = "px",
            "x-level" = "advanced",
            "x-refined-by" = "data",
            "x-derived" = "scales.expected_cell_diameter_um ÷ optics µm per pixel"
        )
    )]
    pub cell_diameter_px: Option<f64>,
    /// Whether the cell diameter is estimated from the data during the run;
    /// the expected diameter is then its starting value.
    #[schemars(
        title = "Adapt the cell diameter",
        extend("x-unit" = "none", "x-level" = "advanced")
    )]
    pub adapt: ScaleAdapt,
    /// The optics' point-spread σ: light is smoothed at this scale before
    /// a footprint's support is traced.
    #[schemars(
        title = "Point-spread σ",
        range(min = 0.6, max = 8.0),
        extend("x-unit" = "px", "x-level" = "internal")
    )]
    pub psf_sigma_px: f64,
    /// σ of the flattening low-pass, in cell diameters.
    #[schemars(
        title = "Flatten σ per diameter",
        range(min = 0.5, max = 8.0),
        extend("x-unit" = "d", "x-level" = "internal")
    )]
    pub flatten_sigma_per_d: f64,
    /// σ of the flattening low-pass in pixels; overrides the rule above.
    /// `null`: `flatten_sigma_per_d` × the cell diameter.
    #[schemars(
        title = "Flatten σ",
        range(min = 1.0, max = 256.0),
        extend(
            "x-unit" = "px",
            "x-level" = "internal",
            "x-derived" = "scales.flatten_sigma_per_d × scales.cell_diameter_px"
        )
    )]
    pub flatten_sigma_px: Option<f64>,
}

impl Default for Scales {
    fn default() -> Scales {
        Scales {
            expected_cell_diameter_um: None,
            cell_diameter_px: Some(10.0),
            adapt: ScaleAdapt::Off,
            psf_sigma_px: 1.5,
            flatten_sigma_per_d: 2.0,
            flatten_sigma_px: None,
        }
    }
}

/// How the cell diameter follows the data.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ScaleAdapt {
    /// The expected diameter is used as set.
    #[schemars(title = "Off")]
    Off,
    /// One diameter for the field of view, estimated during the run.
    #[schemars(title = "Global")]
    Global,
    /// A diameter per region of the field of view.
    #[schemars(title = "Local")]
    Local,
}

// ---- time ----

/// The recording's frame rate. Every duration of the params is converted
/// to frames at it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Time {
    /// The frame rate to use instead of the one read from the file; for a
    /// file that has none or a wrong one. `null`: the file's frame rate.
    #[schemars(
        title = "Frame rate override",
        range(min = 1.0, max = 1000.0),
        extend("x-unit" = "Hz", "x-level" = "advanced", "x-scope" = "stream")
    )]
    pub fps_override: Option<f64>,
}

// ---- input ----

/// Which part of the frame is processed.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Input {
    /// The rectangle of the motion-corrected frame that is processed.
    /// `null`: the full frame.
    #[schemars(
        title = "Crop",
        extend("x-unit" = "px", "x-level" = "main", "x-widget" = "crop-rect")
    )]
    pub crop: Option<CropRect>,
}

/// A rectangle of the frame, in pixels from the top-left corner.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct CropRect {
    /// Left edge, px.
    pub x: u32,
    /// Top edge, px.
    pub y: u32,
    /// Width, px.
    #[schemars(range(min = 1))]
    pub width: u32,
    /// Height, px.
    #[schemars(range(min = 1))]
    pub height: u32,
}

// ---- seed ----

/// Footprints a run starts from.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Seed {
    /// The past run whose footprints the run starts from. `null`: start from
    /// an empty library.
    #[schemars(
        title = "Start from run",
        extend("x-unit" = "none", "x-level" = "main", "x-widget" = "seed-picker")
    )]
    pub from: Option<String>,
    /// Which of that run's cells are taken.
    #[schemars(
        title = "Cells taken",
        extend("x-unit" = "none", "x-level" = "main")
    )]
    pub select: SeedSelect,
    /// The cell ids taken when `select` is `ids`.
    #[schemars(
        title = "Cell ids",
        extend("x-unit" = "none", "x-level" = "main")
    )]
    pub ids: Vec<u32>,
}

/// Which cells of a seed run are taken.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SeedSelect {
    /// Every cell.
    #[default]
    #[schemars(title = "All")]
    All,
    /// The cells that pass QC.
    #[schemars(title = "Cells that pass QC")]
    QcPass,
    /// The cells listed in `ids`.
    #[schemars(title = "Listed ids")]
    Ids,
}

// ---- stages ----

/// Which stages run.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Stages {
    /// Look for new cells during Discover. Off: only the seed footprints are
    /// refined and traced.
    #[schemars(
        title = "Find new cells",
        extend("x-unit" = "none", "x-level" = "main")
    )]
    pub find_new_cells: bool,
    /// Run Extract after Discover: final traces of every frame with the
    /// footprints frozen.
    #[schemars(
        title = "Extract after Discover",
        extend("x-unit" = "none", "x-level" = "main", "x-when" = "recording")
    )]
    pub extract: bool,
}

impl Default for Stages {
    fn default() -> Stages {
        Stages {
            find_new_cells: true,
            extract: true,
        }
    }
}

// ---- preprocess ----

/// Calibration, flicker, line and background corrections of each frame.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Preprocess {
    /// Time at the start of the recording used for the calibration (field
    /// of view, hot pixels, first noise map).
    #[schemars(
        title = "Calibration time",
        range(min = 0.5, max = 600.0),
        extend("x-unit" = "s", "x-level" = "advanced")
    )]
    pub warmup_s: f64,
    /// Which flicker components are removed from each frame.
    #[schemars(title = "Flicker", extend("x-unit" = "none", "x-level" = "advanced"))]
    pub flicker: Flicker,
    /// Which line artifacts are removed from each frame.
    #[schemars(
        title = "Line artifacts",
        extend("x-unit" = "none", "x-level" = "advanced")
    )]
    pub lines: Lines,
    /// The lens field of view.
    #[schemars(title = "Field of view")]
    pub fov: Fov,
    /// A pixel is hot or cold when it differs from its neighbourhood by this
    /// many noise σ.
    #[schemars(
        title = "Hot-pixel threshold",
        range(min = 1.0, max = 50.0),
        extend("x-unit" = "sigma", "x-level" = "internal")
    )]
    pub hot_pixel_k_sigma: f64,
    /// The background floor subtracted from each pixel.
    #[schemars(title = "Background floor")]
    pub background: Background,
}

impl Default for Preprocess {
    fn default() -> Preprocess {
        Preprocess {
            warmup_s: 10.0,
            flicker: Flicker::Both,
            lines: Lines::Both,
            fov: Fov::default(),
            hot_pixel_k_sigma: 5.0,
            background: Background::default(),
        }
    }
}

/// Which flicker components are removed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Flicker {
    /// None.
    #[schemars(title = "Off")]
    Off,
    /// The per-frame offset.
    #[schemars(title = "Additive")]
    Additive,
    /// The per-frame gain.
    #[schemars(title = "Multiplicative")]
    Multiplicative,
    /// Offset and gain.
    #[schemars(title = "Both")]
    Both,
}

/// Which line artifacts are removed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Lines {
    /// None.
    #[schemars(title = "Off")]
    Off,
    /// Per-frame row noise.
    #[schemars(title = "Rows")]
    Rows,
    /// The static column pattern.
    #[schemars(title = "Columns")]
    Columns,
    /// Rows and columns.
    #[schemars(title = "Both")]
    Both,
}

/// The lens field of view.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Fov {
    /// A pixel is inside the field of view when its mean brightness is at
    /// least this share of the bright end of the frame.
    #[schemars(
        title = "Field-of-view threshold",
        range(min = 0.0, max = 1.0),
        extend("x-unit" = "ratio", "x-level" = "advanced")
    )]
    pub rel_threshold: f64,
    /// Fit a disk to the field of view instead of keeping its traced shape.
    #[schemars(
        title = "Fit a disk",
        extend("x-unit" = "none", "x-level" = "advanced")
    )]
    pub fit_disk: bool,
    /// Pixels removed from the field of view's edge.
    #[schemars(
        title = "Edge margin",
        range(min = 0, max = 256),
        extend("x-unit" = "px", "x-level" = "advanced")
    )]
    pub margin_px: u32,
}

impl Default for Fov {
    fn default() -> Fov {
        Fov {
            rel_threshold: 0.15,
            fit_disk: false,
            margin_px: 0,
        }
    }
}

/// The background floor subtracted from each pixel.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Background {
    /// Length of the running-mean boxcar the floor is tracked on.
    #[schemars(
        title = "Background boxcar",
        range(min = 0.0, max = 10.0),
        extend("x-unit" = "s", "x-level" = "internal")
    )]
    pub boxcar_s: f64,
    /// Time constant of the floor's upward relaxation.
    #[schemars(
        title = "Background relaxation",
        range(min = 1.0, max = 3600.0),
        extend("x-unit" = "s", "x-level" = "internal")
    )]
    pub relax_s: f64,
}

impl Default for Background {
    fn default() -> Background {
        Background {
            boxcar_s: 0.25,
            relax_s: 120.0,
        }
    }
}

// ---- motion ----

/// Motion correction.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Motion {
    /// The largest rigid shift searched.
    #[schemars(
        title = "Largest shift",
        range(min = 1.0, max = 128.0),
        extend("x-unit" = "px", "x-level" = "advanced")
    )]
    pub max_shift_px: f64,
    /// Time constant of the registration template's running average. 0
    /// keeps the warm-up template.
    #[schemars(
        title = "Template time constant",
        range(min = 0.0, max = 3600.0),
        extend("x-unit" = "s", "x-level" = "advanced")
    )]
    pub template_tau_s: f64,
    /// Time between updates of the registration template.
    #[schemars(
        title = "Template refresh",
        range(min = 0.05, max = 600.0),
        extend("x-unit" = "s", "x-level" = "internal")
    )]
    pub template_refresh_s: f64,
    /// Time averaged into the first registration template.
    #[schemars(
        title = "Template warm-up",
        range(min = 0.5, max = 600.0),
        extend("x-unit" = "s", "x-level" = "internal")
    )]
    pub warmup_s: f64,
    /// Piecewise-rigid registration on a grid of patches.
    #[schemars(title = "Non-rigid")]
    pub nonrigid: NonRigid,
    /// At a session boundary of a Joint run, re-register the new session
    /// and carry the preprocessing state into it.
    #[schemars(
        title = "Align sessions",
        extend("x-unit" = "none", "x-level" = "advanced", "x-when" = "joint")
    )]
    pub session_fix: bool,
}

impl Default for Motion {
    fn default() -> Motion {
        Motion {
            max_shift_px: 15.0,
            template_tau_s: 20.0,
            template_refresh_s: 1.0,
            warmup_s: 10.0,
            nonrigid: NonRigid::default(),
            session_fix: true,
        }
    }
}

/// Piecewise-rigid registration on a grid of patches.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct NonRigid {
    /// Refine the rigid shift per patch.
    #[schemars(
        title = "Non-rigid registration",
        extend("x-unit" = "none", "x-level" = "advanced")
    )]
    pub enabled: bool,
    /// Patches per side of the grid.
    #[schemars(
        title = "Patch grid",
        range(min = 2, max = 16),
        extend("x-unit" = "count", "x-level" = "advanced")
    )]
    pub grid: u32,
    /// The largest shift of a patch beyond the rigid shift.
    #[schemars(
        title = "Largest patch shift",
        range(min = 0.0, max = 32.0),
        extend("x-unit" = "px", "x-level" = "advanced")
    )]
    pub max_patch_shift_px: f64,
}

impl Default for NonRigid {
    fn default() -> NonRigid {
        NonRigid {
            enabled: false,
            grid: 4,
            max_patch_shift_px: 3.0,
        }
    }
}

// ---- flat field ----

/// The sensor flat field estimated from the recording's own motion.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct FlatField {
    /// Estimate the sensor's per-pixel gain and divide it out.
    #[schemars(
        title = "Flat field",
        extend("x-unit" = "none", "x-level" = "advanced")
    )]
    pub enabled: bool,
    /// Half-life of the gain estimate's forgetting.
    #[schemars(
        title = "Gain half-life",
        range(min = 1.0, max = 86400.0),
        extend("x-unit" = "s", "x-level" = "internal")
    )]
    pub gain_half_life_s: f64,
    /// Half-life of the offset estimate's forgetting.
    #[schemars(
        title = "Offset half-life",
        range(min = 1.0, max = 86400.0),
        extend("x-unit" = "s", "x-level" = "internal")
    )]
    pub offset_half_life_s: f64,
    /// Recording time before the first gain map.
    #[schemars(
        title = "First map after",
        range(min = 1.0, max = 3600.0),
        extend("x-unit" = "s", "x-level" = "internal")
    )]
    pub first_map_s: f64,
    /// Recording time between later gain maps.
    #[schemars(
        title = "Refit every",
        range(min = 1.0, max = 3600.0),
        extend("x-unit" = "s", "x-level" = "internal")
    )]
    pub refine_every_s: f64,
}

impl Default for FlatField {
    fn default() -> FlatField {
        FlatField {
            enabled: true,
            gain_half_life_s: 7200.0,
            offset_half_life_s: 120.0,
            first_map_s: 150.0,
            refine_every_s: 60.0,
        }
    }
}

// ---- discover ----

/// Cell discovery (the slow loop).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Discover {
    /// A new cell must improve the held-out fit over a noise column by this
    /// many standard deviations of that null.
    #[schemars(
        title = "Add threshold",
        range(min = 0.0, max = 50.0),
        extend("x-unit" = "sigma", "x-level" = "advanced")
    )]
    pub accept_z: f64,
    /// A trace value counts as an event above this many noise σ.
    #[schemars(
        title = "Event threshold",
        range(min = 0.0, max = 50.0),
        extend("x-unit" = "sigma", "x-level" = "advanced")
    )]
    pub event_z: f64,
    /// Held-out events a new cell needs.
    #[schemars(
        title = "Events to add a cell",
        range(min = 0, max = 100),
        extend("x-unit" = "count", "x-level" = "advanced")
    )]
    pub min_events: u32,
    /// Shortest transient that counts as an event; never fewer than 3
    /// frames, whatever the frame rate, since the run length is also what
    /// keeps white noise from making events.
    #[schemars(
        title = "Shortest event",
        range(min = 0.0, max = 10.0),
        extend("x-unit" = "s", "x-level" = "advanced")
    )]
    pub event_s: f64,
    /// A cell with no event in this time after its birth is deleted.
    #[schemars(
        title = "Probation",
        range(min = 1.0, max = 36000.0),
        extend("x-unit" = "s", "x-level" = "advanced")
    )]
    pub probation_s: f64,
    /// Half-life of the running footprint statistics.
    #[schemars(
        title = "Footprint statistics half-life",
        range(min = 1.0, max = 36000.0),
        extend("x-unit" = "s", "x-level" = "advanced")
    )]
    pub stats_half_life_s: f64,
    /// Base cooldown of a spot where a proposed cell was rejected.
    #[schemars(
        title = "Reject cooldown",
        range(min = 0.0, max = 3600.0),
        extend("x-unit" = "s", "x-level" = "internal")
    )]
    pub reject_cooldown_s: f64,
    /// Half-life of an event slot's priority in the reservoir.
    #[schemars(
        title = "Event-slot half-life",
        range(min = 0.05, max = 36000.0),
        extend("x-unit" = "s", "x-level" = "internal")
    )]
    pub event_half_life_s: f64,
    /// Shortest time between two keep-test probes of one cell.
    #[schemars(
        title = "Probe gap",
        range(min = 0.0, max = 3600.0),
        extend("x-unit" = "s", "x-level" = "internal")
    )]
    pub probe_gap_s: f64,
    /// A cell is refined from the reservoir only within this time after its
    /// birth; later, from its running statistics alone.
    #[schemars(
        title = "Reservoir refine window",
        range(min = 0.0, max = 36000.0),
        extend("x-unit" = "s", "x-level" = "internal")
    )]
    pub reservoir_refine_s: f64,
    /// Merge tests.
    #[schemars(title = "Merge")]
    pub merge: Merge,
    /// The joint footprint update of overlapping cells.
    #[schemars(title = "Clusters")]
    pub cluster: Cluster,
    /// The local background ring of each footprint.
    #[schemars(title = "Background ring")]
    pub ring: Ring,
    /// Side of a slow-loop tile.
    #[schemars(
        title = "Tile side",
        range(min = 8, max = 1024),
        extend("x-unit" = "px", "x-level" = "internal")
    )]
    pub tile_px: u32,
    /// Margin stored around each tile. `null`: derived from the cell
    /// diameter.
    #[schemars(
        title = "Tile margin",
        range(min = 0, max = 512),
        extend(
            "x-unit" = "px",
            "x-level" = "internal",
            "x-derived" = "max(24, ceil(2.4 × cell diameter in px))"
        )
    )]
    pub margin_px: Option<u32>,
    /// Frames stored per tile for the add, merge and keep tests.
    #[schemars(
        title = "Frames per tile",
        range(min = 2, max = 4096),
        extend("x-unit" = "frames", "x-level" = "advanced")
    )]
    pub frames_per_tile: u32,
    /// Memory cap of the frame reservoir; fewer frames per tile are kept
    /// when the full count does not fit.
    #[schemars(
        title = "Reservoir memory",
        range(min = 1, max = 65536),
        extend("x-unit" = "MB", "x-level" = "advanced")
    )]
    pub reservoir_max_mb: u32,
    /// How often tiles are visited.
    #[schemars(title = "Visit rate")]
    pub visit: Visit,
    /// Fast-loop work units per frame the slow loop paces itself against.
    #[schemars(
        title = "Work per frame",
        range(min = 1.0, max = 1e12),
        extend("x-unit" = "work_per_frame", "x-level" = "internal")
    )]
    pub budget: f64,
    /// Fewest frames between two published library versions.
    #[schemars(
        title = "Commit interval",
        range(min = 1, max = 100000),
        extend("x-unit" = "frames", "x-level" = "internal")
    )]
    pub commit_interval_frames: u32,
    /// Seed of the held-out split and the reservoir's random sample.
    #[schemars(
        title = "Random seed",
        range(min = 0, max = 4294967295u32),
        extend("x-unit" = "none", "x-level" = "advanced")
    )]
    pub seed: u32,
    /// Family-wise error rate of one support construction: the chance that
    /// it admits at least one pixel without light.
    #[schemars(
        title = "Support error rate",
        range(min = 0.0, max = 1.0),
        extend("x-unit" = "ratio", "x-level" = "internal")
    )]
    pub support_alpha: f64,
    /// Refinements from the running statistics.
    #[schemars(title = "Refine")]
    pub refine: Refine,
    /// The background model of the published libraries.
    #[schemars(
        title = "Background model",
        extend("x-unit" = "none", "x-level" = "internal")
    )]
    pub background: BackgroundModel,
    /// Start each solve in a visit's comparisons at the reference model's
    /// solution.
    #[schemars(
        title = "Warm starts",
        extend("x-unit" = "none", "x-level" = "internal")
    )]
    pub warm_start: bool,
    /// Classification of adds as new, re-added or churned (display only).
    #[schemars(title = "Churn")]
    pub churn: Churn,
}

impl Default for Discover {
    fn default() -> Discover {
        Discover {
            accept_z: 5.0,
            event_z: 4.0,
            min_events: 2,
            event_s: 0.15,
            probation_s: 240.0,
            stats_half_life_s: 300.0,
            reject_cooldown_s: 20.0,
            event_half_life_s: 100.0,
            probe_gap_s: 5.0,
            reservoir_refine_s: 120.0,
            merge: Merge::default(),
            cluster: Cluster::default(),
            ring: Ring::default(),
            tile_px: 64,
            margin_px: None,
            frames_per_tile: 128,
            reservoir_max_mb: 1536,
            visit: Visit::default(),
            budget: 3e7,
            commit_interval_frames: 100,
            seed: 0,
            support_alpha: 0.05,
            refine: Refine::default(),
            background: BackgroundModel::Ring,
            warm_start: true,
            churn: Churn::default(),
        }
    }
}

/// Merge tests.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Merge {
    /// Trace correlation above which a merge of two cells is tested.
    #[schemars(
        title = "Merge correlation",
        range(min = 0.0, max = 1.0),
        extend("x-unit" = "r", "x-level" = "internal")
    )]
    pub corr: f64,
    /// Two cells are kept apart when separating them beats the best single
    /// cell on held-out frames by this many standard deviations.
    #[schemars(
        title = "Keep-apart threshold",
        range(min = 0.0, max = 50.0),
        extend("x-unit" = "sigma", "x-level" = "internal")
    )]
    pub z: f64,
    /// Which merge tests may merge.
    #[schemars(title = "Merge rule", extend("x-unit" = "none", "x-level" = "internal"))]
    pub rule: MergeRule,
    /// Pairs whose centres are at least this many cell diameters apart get
    /// the shape gate whatever their overlap. `null`: off.
    #[schemars(
        title = "Merge guard separation",
        range(min = 0.0, max = 10.0),
        extend("x-unit" = "d", "x-level" = "advanced")
    )]
    pub guard_min_sep_d: Option<f64>,
    /// The neighbour guards of a merge test apply to pairs whose footprints
    /// overlap (cosine) by less than this.
    #[schemars(
        title = "Merge guard overlap",
        range(min = 0.0, max = 2.0),
        extend("x-unit" = "ratio", "x-level" = "internal")
    )]
    pub guard_max_ovl: f64,
    /// The same bound for the refitted-pair baseline alone.
    #[schemars(
        title = "Refit guard overlap",
        range(min = 0.0, max = 2.0),
        extend("x-unit" = "ratio", "x-level" = "internal")
    )]
    pub refit_max_ovl: f64,
}

impl Default for Merge {
    fn default() -> Merge {
        Merge {
            corr: 0.6,
            z: 2.0,
            rule: MergeRule::SplitHalf,
            guard_min_sep_d: Some(0.6),
            guard_max_ovl: 0.5,
            refit_max_ovl: 0.5,
        }
    }
}

/// Which merge tests may merge.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MergeRule {
    /// The held-out test alone.
    #[schemars(title = "Legacy")]
    Legacy,
    /// The held-out test, plus the same measured shape for a pair whose
    /// footprints do not largely coincide.
    #[schemars(title = "Split-half")]
    SplitHalf,
}

/// The joint footprint update of overlapping cells.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Cluster {
    /// Where overlapping cells are refitted jointly from a replay of their
    /// stored history.
    #[schemars(
        title = "Joint update",
        extend("x-unit" = "none", "x-level" = "internal")
    )]
    pub update: ClusterUpdate,
    /// Sign rule of the joint footprint step.
    #[schemars(title = "Sign rule", extend("x-unit" = "none", "x-level" = "internal"))]
    pub sign: ClusterSign,
    /// Cells join a cluster along whitened overlaps of at least this.
    #[schemars(
        title = "Cluster overlap",
        range(min = 0.0, max = 1.0),
        extend("x-unit" = "r", "x-level" = "internal")
    )]
    pub rho_min: f64,
    /// Most cells per cluster.
    #[schemars(
        title = "Cluster size",
        range(min = 2, max = 8),
        extend("x-unit" = "cells", "x-level" = "internal")
    )]
    pub max: u32,
    /// Alternations per replay.
    #[schemars(
        title = "Replay alternations",
        range(min = 1, max = 100),
        extend("x-unit" = "count", "x-level" = "internal")
    )]
    pub iters: u32,
    /// Which members of a replayed cluster are proposed.
    #[schemars(title = "Admission", extend("x-unit" = "none", "x-level" = "internal"))]
    pub admit: ClusterAdmit,
    /// Carry the store's own joint estimate from one replay to the next.
    #[schemars(
        title = "Carry estimate",
        extend("x-unit" = "none", "x-level" = "internal")
    )]
    pub carry: bool,
    /// L1 weight of the replay's trace step, in trace-noise σ.
    #[schemars(
        title = "Replay L1 weight",
        range(min = 0.0, max = 100.0),
        extend("x-unit" = "sigma", "x-level" = "internal")
    )]
    pub l1: f64,
    /// In the add test, also check the candidate's trace against the nearby
    /// cells' traces jointly.
    #[schemars(
        title = "Joint neighbour test",
        extend("x-unit" = "none", "x-level" = "internal")
    )]
    pub neighbours: bool,
}

impl Default for Cluster {
    fn default() -> Cluster {
        Cluster {
            update: ClusterUpdate::All,
            sign: ClusterSign::All,
            rho_min: 0.05,
            max: 6,
            iters: 1,
            admit: ClusterAdmit::Cluster,
            carry: false,
            l1: 0.0,
            neighbours: false,
        }
    }
}

/// Where overlapping cells are refitted jointly.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ClusterUpdate {
    /// Per-cell statistics only.
    #[schemars(title = "Off")]
    Off,
    /// In refinement-only visits (the Final settle).
    #[schemars(title = "Refine")]
    Refine,
    /// In every visit.
    #[schemars(title = "All")]
    All,
}

/// Sign rule of the joint footprint step.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ClusterSign {
    /// A plain joint least-squares fit.
    #[schemars(title = "Off")]
    Off,
    /// Non-negative where the member's current footprint is positive.
    #[schemars(title = "Own")]
    Own,
    /// Non-negative on the member's whole disk.
    #[schemars(title = "All")]
    All,
}

/// Which members of a replayed cluster are proposed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ClusterAdmit {
    /// Every significant member, on the cluster's summed evidence.
    #[schemars(title = "Cluster")]
    Cluster,
    /// Each member on its own evidence.
    #[schemars(title = "Member")]
    Member,
}

/// The local background ring of each footprint.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Ring {
    /// Inner radius of the ring, in cell diameters.
    #[schemars(
        title = "Ring inner radius",
        range(min = 0.1, max = 10.0),
        extend("x-unit" = "d", "x-level" = "internal")
    )]
    pub inner_per_d: f64,
    /// Outer radius of the ring, in cell diameters.
    #[schemars(
        title = "Ring outer radius",
        range(min = 0.2, max = 20.0),
        extend("x-unit" = "d", "x-level" = "internal")
    )]
    pub outer_per_d: f64,
}

impl Default for Ring {
    fn default() -> Ring {
        Ring {
            inner_per_d: 1.2,
            outer_per_d: 2.0,
        }
    }
}

/// How often tiles are visited.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Visit {
    /// Fixed: always the target rate. Auto: lower while visits stop finding
    /// new cells.
    #[schemars(title = "Visit schedule", extend("x-unit" = "none", "x-level" = "advanced"))]
    pub mode: VisitMode,
    /// Tile visits per Discover frame.
    #[schemars(
        title = "Visit rate",
        range(min = 0.01, max = 4.0),
        extend("x-unit" = "visits_per_frame", "x-level" = "advanced")
    )]
    pub target: f64,
}

impl Default for Visit {
    fn default() -> Visit {
        Visit {
            mode: VisitMode::Fixed,
            target: 0.15,
        }
    }
}

/// The Discover visit schedule.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum VisitMode {
    /// Always the target rate.
    #[schemars(title = "Fixed")]
    Fixed,
    /// The target while visits find new cells, lower after.
    #[schemars(title = "Auto")]
    Auto,
}

/// Refinements from the running statistics.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Refine {
    /// When the statistics path proposes a refinement.
    #[schemars(title = "Refine gate", extend("x-unit" = "none", "x-level" = "internal"))]
    pub gate: RefineGate,
    /// A refinement is accepted when its held-out gains have a paired z
    /// above this.
    #[schemars(
        title = "Refine threshold",
        range(min = -10.0, max = 50.0),
        extend("x-unit" = "sigma", "x-level" = "internal")
    )]
    pub z: f64,
}

impl Default for Refine {
    fn default() -> Refine {
        Refine {
            gate: RefineGate::SplitHalf,
            z: 0.0,
        }
    }
}

/// When the statistics path proposes a refinement.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RefineGate {
    /// The estimate disagrees with the footprint beyond its χ² null.
    #[schemars(title = "Legacy")]
    Legacy,
    /// The change exceeds the estimate's own split-half noise.
    #[schemars(title = "Split-half")]
    SplitHalf,
}

/// The background model of the published libraries.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundModel {
    /// No local background.
    #[schemars(title = "None")]
    None,
    /// A ring around each footprint (`discover.ring`).
    #[schemars(title = "Ring")]
    Ring,
}

/// Classification of adds (display only; changes no decision).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Churn {
    /// Removed cells are remembered this long for the re-add test.
    #[schemars(
        title = "Re-add window",
        range(min = 0.0, max = 36000.0),
        extend("x-unit" = "s", "x-level" = "internal")
    )]
    pub readd_window_s: f64,
    /// A cell removed within this time of its add is churn.
    #[schemars(
        title = "Churn window",
        range(min = 0.0, max = 36000.0),
        extend("x-unit" = "s", "x-level" = "internal")
    )]
    pub churn_s: f64,
}

impl Default for Churn {
    fn default() -> Churn {
        Churn {
            readd_window_s: 240.0,
            churn_s: 120.0,
        }
    }
}

// ---- look-back ----

/// Re-reading past frames for the slow loop during Discover.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Lookback {
    /// Re-read earlier frames of the recording for each new cell.
    #[schemars(
        title = "Look-back",
        extend("x-unit" = "none", "x-level" = "main", "x-when" = "recording")
    )]
    pub enabled: bool,
    /// How far before a cell's birth its frames are re-read.
    #[schemars(
        title = "Look-back horizon",
        range(min = 0.0, max = 36000.0),
        extend("x-unit" = "s", "x-level" = "advanced", "x-when" = "lookback")
    )]
    pub horizon_s: f64,
    /// Look-back frames read per Discover frame.
    #[schemars(
        title = "Look-back rate",
        range(min = 0.0, max = 64.0),
        extend("x-unit" = "ratio", "x-level" = "internal", "x-when" = "lookback")
    )]
    pub rate: f64,
}

impl Default for Lookback {
    fn default() -> Lookback {
        Lookback {
            enabled: true,
            horizon_s: 150.0,
            rate: 2.0,
        }
    }
}

// ---- settle ----

/// Background settle and Final settle.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Settle {
    /// Background settle during Discover.
    #[schemars(title = "Background settle")]
    pub background: BackgroundSettle,
    /// The Final settle at the end of Discover.
    #[schemars(title = "Final settle")]
    #[serde(rename = "final")]
    pub final_: FinalSettle,
    /// The slow-loop options of a Final settle on factors.
    #[schemars(title = "Settle on factors")]
    pub on_factors: OnFactors,
}

/// Background settle during Discover.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct BackgroundSettle {
    /// Most frames re-read per live frame to settle footprints. 0: off.
    #[schemars(
        title = "Background settle cap",
        extend(
            "x-unit" = "ratio",
            "x-level" = "main",
            "enum" = [0.0, 0.5, 1.0, 2.0],
            "x-enum-labels" = ["Off", "0.5×", "1×", "2×"]
        )
    )]
    pub cap: f64,
}

impl Default for BackgroundSettle {
    fn default() -> BackgroundSettle {
        BackgroundSettle { cap: 2.0 }
    }
}

/// The Final settle at the end of Discover.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct FinalSettle {
    /// How much of the final settle pass is read.
    #[schemars(
        title = "Final settle",
        extend("x-unit" = "none", "x-level" = "main", "x-when" = "recording")
    )]
    pub level: FinalSettleLevel,
    /// The most recording time the pass reads; a longer recording is
    /// sampled in blocks. `null`: three footprint-statistics half-lives.
    #[schemars(
        title = "Final settle length",
        range(min = 1.0, max = 360000.0),
        extend(
            "x-unit" = "s",
            "x-level" = "internal",
            "x-derived" = "3 × discover.stats_half_life_s"
        )
    )]
    pub max_s: Option<f64>,
}

impl Default for FinalSettle {
    fn default() -> FinalSettle {
        FinalSettle {
            level: FinalSettleLevel::Thorough,
            max_s: None,
        }
    }
}

/// How much of the final settle pass is read.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FinalSettleLevel {
    /// The full pass.
    #[schemars(title = "Thorough")]
    Thorough,
    /// Most of the pass.
    #[schemars(title = "Standard")]
    Standard,
    /// A shorter pass.
    #[schemars(title = "Quick")]
    Quick,
}

/// The slow-loop options of a Final settle on factors.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct OnFactors {
    /// Where overlapping cells are refitted jointly.
    #[schemars(
        title = "Joint update on factors",
        extend("x-unit" = "none", "x-level" = "internal")
    )]
    pub cluster_update: ClusterUpdate,
    /// The merge guard separation on factors. `null`: off.
    #[schemars(
        title = "Merge guard separation on factors",
        range(min = 0.0, max = 10.0),
        extend("x-unit" = "d", "x-level" = "internal")
    )]
    pub guard_min_sep_d: Option<f64>,
}

impl Default for OnFactors {
    fn default() -> OnFactors {
        OnFactors {
            cluster_update: ClusterUpdate::Refine,
            guard_min_sep_d: None,
        }
    }
}

// ---- trace ----

/// The per-frame trace solve.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Trace {
    /// A solve has converged when a sweep moves no trace by more than this
    /// share of its noise σ.
    #[schemars(
        title = "Solve tolerance",
        range(min = 0.0001, max = 1.0),
        extend("x-unit" = "ratio", "x-level" = "internal")
    )]
    pub tol: f64,
    /// Most sweeps per frame.
    #[schemars(
        title = "Most sweeps",
        range(min = 1, max = 100000),
        extend("x-unit" = "count", "x-level" = "internal")
    )]
    pub max_sweeps: u32,
}

impl Default for Trace {
    fn default() -> Trace {
        Trace {
            tol: 0.05,
            max_sweeps: 200,
        }
    }
}

// ---- qc ----

/// Online quality control of the cells.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Qc {
    /// Compute the per-cell QC during the run.
    #[schemars(title = "Quality control", extend("x-unit" = "none", "x-level" = "advanced"))]
    pub enabled: bool,
    /// The per-cell pass rule.
    #[schemars(title = "Pass rule")]
    pub pass: PassRule,
}

impl Default for Qc {
    fn default() -> Qc {
        Qc {
            enabled: true,
            pass: PassRule::default(),
        }
    }
}

/// The per-cell pass rule.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct PassRule {
    /// Smallest peak SNR of a passing cell.
    #[schemars(
        title = "Minimum SNR",
        range(min = 0.0, max = 1000.0),
        extend("x-unit" = "ratio", "x-level" = "advanced")
    )]
    pub min_snr: f64,
    /// Trace correlation above which two overlapping cells are a correlated
    /// pair.
    #[schemars(
        title = "Pair correlation",
        range(min = 0.0, max = 1.0),
        extend("x-unit" = "r", "x-level" = "advanced")
    )]
    pub pair_r: f64,
    /// Share of a trace's variance explained by the frame's shift above
    /// which the cell is flagged as following motion.
    #[schemars(
        title = "Follows-motion flag",
        range(min = 0.0, max = 1.0),
        extend("x-unit" = "ratio", "x-level" = "advanced")
    )]
    pub motion_r2_flag: f64,
}

impl Default for PassRule {
    fn default() -> PassRule {
        PassRule {
            min_snr: 5.0,
            pair_r: 0.8,
            motion_r2_flag: 0.2,
        }
    }
}

// ---- factors ----

/// Windowed low-rank factors of the preprocessed frames.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Factors {
    /// Where factors come from and how they are used.
    #[schemars(title = "Factors", extend("x-unit" = "none", "x-level" = "advanced"))]
    pub mode: FactorsMode,
    /// Length of one factor window.
    #[schemars(
        title = "Factor window",
        range(min = 1.0, max = 3600.0),
        extend("x-unit" = "s", "x-level" = "internal")
    )]
    pub window_s: f64,
}

impl Default for Factors {
    fn default() -> Factors {
        Factors {
            mode: FactorsMode::Auto,
            window_s: 30.0,
        }
    }
}

/// Where factors come from and how they are used.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FactorsMode {
    /// The app's choice: factor files on the GPU for a recording, stream
    /// factors for a live stream.
    #[schemars(title = "Auto")]
    Auto,
    /// No factors.
    #[schemars(title = "Off")]
    Off,
    /// Factors on the CPU, kept in memory.
    #[schemars(title = "Plain")]
    Plain,
    /// Factors on the CPU, kept in files.
    #[schemars(title = "File")]
    File,
    /// Factors on the GPU.
    #[schemars(title = "GPU")]
    Gpu,
}

// ---- export ----

/// What is written to the export.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Export {
    /// Export only the cells that pass QC.
    #[schemars(
        title = "Only cells that pass QC",
        extend("x-unit" = "none", "x-level" = "main", "x-affects" = "output")
    )]
    pub pass_qc_only: bool,
}

impl Default for Export {
    fn default() -> Export {
        Export { pass_qc_only: true }
    }
}

// ---- compute ----

/// How much compute the run uses.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Compute {
    /// The run does the same work at any speed and on any machine, so the
    /// same input and settings give the same result.
    #[schemars(
        title = "Repeatable",
        extend("x-unit" = "none", "x-level" = "main", "x-affects" = "results")
    )]
    pub repeatable: bool,
    /// The target processing speed.
    #[schemars(title = "Speed", extend("x-widget" = "speed"))]
    pub speed: Speed,
    /// Visit workers. `null`: from the machine's core count.
    #[schemars(
        title = "Visit workers",
        range(min = 0, max = 64),
        extend("x-unit" = "count", "x-level" = "internal", "x-affects" = "compute")
    )]
    pub visit_workers: Option<u32>,
    /// Settle look-back workers besides the first. `null`: from the
    /// machine's core count.
    #[schemars(
        title = "Settle pool",
        range(min = 0, max = 4),
        extend("x-unit" = "count", "x-level" = "internal", "x-affects" = "compute")
    )]
    pub settle_pool: Option<u32>,
    /// Frames per processing batch.
    #[schemars(
        title = "Batch size",
        range(min = 1, max = 256),
        extend("x-unit" = "frames", "x-level" = "internal", "x-affects" = "compute")
    )]
    pub batch_frames: u32,
}

impl Default for Compute {
    fn default() -> Compute {
        Compute {
            repeatable: false,
            speed: Speed::default(),
            visit_workers: None,
            settle_pool: None,
            batch_frames: 8,
        }
    }
}

/// The target processing speed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Speed {
    /// Max: as fast as the machine goes. Fixed: a target frame rate. Curve:
    /// a target that follows a preset curve. Auto: a time budget over Max.
    #[schemars(
        title = "Speed mode",
        extend(
            "x-unit" = "none",
            "x-level" = "main",
            "x-affects" = "compute",
            "x-widget" = "speed"
        )
    )]
    pub mode: SpeedMode,
    /// The target in Fixed mode.
    #[schemars(
        title = "Target speed",
        range(min = 1.0, max = 1000.0),
        extend(
            "x-unit" = "Hz",
            "x-level" = "main",
            "x-affects" = "compute",
            "x-widget" = "speed"
        )
    )]
    pub fps: f64,
    /// The preset curve of Curve mode.
    #[schemars(
        title = "Speed curve",
        extend(
            "x-unit" = "none",
            "x-level" = "main",
            "x-affects" = "compute",
            "x-widget" = "speed"
        )
    )]
    pub curve: SpeedCurve,
    /// Auto's time budget: extra time over a Max run, as a share of it.
    #[schemars(
        title = "Auto time budget",
        extend(
            "x-unit" = "ratio",
            "x-level" = "main",
            "x-affects" = "compute",
            "x-widget" = "speed",
            "enum" = [0.5, 1.0, 2.0],
            "x-enum-labels" = ["+50 %", "+100 %", "+200 %"]
        )
    )]
    pub auto_budget: f64,
}

impl Default for Speed {
    fn default() -> Speed {
        Speed {
            mode: SpeedMode::Max,
            fps: 30.0,
            curve: SpeedCurve::FindFast,
            auto_budget: 1.0,
        }
    }
}

/// The speed mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SpeedMode {
    /// As fast as the machine goes.
    #[schemars(title = "Max")]
    Max,
    /// A fixed target frame rate.
    #[schemars(title = "Fixed")]
    Fixed,
    /// A target that follows a preset curve.
    #[schemars(title = "Curve")]
    Curve,
    /// A time budget over a Max run.
    #[schemars(title = "Auto")]
    Auto,
}

/// The preset curves of Curve mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum SpeedCurve {
    /// Max for the first half, while most cells are found, then the floor.
    #[schemars(title = "Find fast, then settle")]
    FindFast,
    /// Max for the first third, every-frame-seen speed to two thirds, then
    /// the floor.
    #[schemars(title = "Step down")]
    StepDown,
}
