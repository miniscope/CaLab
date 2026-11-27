# @calab/ui

Shared SolidJS layout components, chart primitives, and CSS design tokens for the CaLab monorepo.

Depends on `@calab/tutorials` (for TutorialPanel and TutorialLauncher components), and `@calab/io` for the import flow. External dependencies: `solid-js`, `uplot`.

```
@calab/tutorials
  ↑
@calab/ui
  ↑
apps/catune, apps/cabana
```

## Exports

| Export             | Source                 | Description                                                           |
| ------------------ | ---------------------- | --------------------------------------------------------------------- |
| `DashboardShell`   | `DashboardShell.tsx`   | 3-section CSS grid layout (header / main / sidebar)                   |
| `DashboardPanel`   | `DashboardPanel.tsx`   | Variant-based panel wrapper with `data-panel-id` for layout targeting |
| `VizLayout`        | `VizLayout.tsx`        | Scroll/dashboard mode switcher for visualization content              |
| `CompactHeader`    | `CompactHeader.tsx`    | Shared header component with app title, version, and action buttons   |
| `CardGrid`         | `CardGrid.tsx`         | Responsive grid for multi-cell trace cards                            |
| `TutorialPanel`    | `TutorialPanel.tsx`    | Tutorial selection and progress panel                                 |
| `TutorialLauncher` | `TutorialLauncher.tsx` | Tutorial launch button component                                      |
| `Card`             | `Card.tsx`             | Generic card wrapper component                                        |

### Instruments

Live figures on declared, fixed ranges (`range.ts`: `rangePosition`, `assertRange`). None rescales to its data: a value outside the range is drawn at the nearest end and flagged with `data-clamped`, and a missing value is drawn as "not measured". Styles in `styles/instruments.css`, colours from tokens only.

| Export                             | Description                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| `Meter`, `MeterRow`                | `role="meter"` bar with target tick and band; a row adds the label and the tabular figure        |
| `StageTrack`                       | Run stages as one bar, sized by expected share; waiting, running, done (hue + check), off, error |
| `Sparkline`                        | 1.5 px line on a declared y range with a last-point dot                                          |
| `SegmentedBar`                     | One declared whole split into parts                                                              |
| `RangeBar`                         | A span (e.g. mean to p99) with a mark and a reference line on a declared domain                  |
| `Legend`                           | One-row legend whose swatches are the marks themselves                                           |
| `Badge`                            | 18 px tinted chip; status tones always carry their icon                                          |
| `Icon`                             | 16 px outline set: play, pause, stop, restart, check, cross, info, warning, gpu                  |
| `MetricTile`                       | Title, figure, optional sparkline, status dot and meter slot                                     |
| `OKABE_ITO` (`@calab/ui/palette`)  | The one Okabe-Ito definition; dependency-free for stores and workers                             |
| `STAGE_HUES` (`@calab/ui/palette`) | The `--stage-*` token values for canvas code (a test keeps them equal to `tokens.css`)           |

The table above covers the layout components. Chart utilities, the import flow and the dataset overview (cards plus the `createOverviewStore` factory each app instantiates) have their own entry points (below). Community and auth widgets live in `@calab/community-ui`, so `@calab/ui` never loads Supabase or auth code. Consult `src/index.ts` for the authoritative export list.

## Import flow (`@calab/ui/import`)

The data-import screen shared by the apps. Every component takes the app's `ImportStore` (`createImportStore` in `@calab/io`) as `store`: `ImportOverlay` (the whole flow, `layout: 'stacked' | 'split'`), `FileDropZone`, `NpzArraySelector`, `DimensionConfirmation`, `SamplingRateInput`, `DataValidationReport`, `TracePreview`. A separate entry so apps without an import flow never load `@calab/io`.

## Shared app stylesheets (`@calab/ui/styles/*`)

`base.css` and `tutorial.css` are the design-system base. `app-global.css` (import screen, cards, buttons) and `app-controls.css` (control panels) hold the rules CaTune and CaDecon share; each app imports them just before its own `styles/global.css` / `styles/controls.css`, which keep only app-specific rules.

## Chart utilities (`@calab/ui/chart`)

Shared uPlot primitives so every app charts consistently:

| Export                                                                                                                                                   | Source                   | Description                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------- |
| `OKABE_ITO`, `NEUTRAL`, `TRACE_COLORS`, `GROUND_TRUTH_COLORS`, `KERNEL_FIT_COLORS`, `METRIC_COLORS`, `DISTRIBUTION_COLORS`, `subsetColor`, `withOpacity` | `series-utils.ts`        | Colorblind-safe Okabe-Ito palette and semantic color roles for series |
| `createGroundTruthSpikesSeries`, `createGroundTruthCalciumSeries`, `createGroundTruthKernelSeries`                                                       | `ground-truth-series.ts` | uPlot series for simulated ground-truth overlays                      |
| `VIRIDIS_LUT`, `viridisRGB`, `viridisCss`                                                                                                                | `colormap.ts`            | 256-entry viridis lookup table + RGB/CSS accessors (raster heatmaps)  |
| `niceTicks`                                                                                                                                              | `chart-math.ts`          | Human-friendly axis tick values (1/2/5×10ⁿ)                           |
| `chartAxis`, `labeledAxis`, `syncCursor`, `staticCursor`, `safeRange`, `integerTickValues`                                                               | `axis-helpers.ts`        | uPlot axis/cursor/range builders with shared theming                  |

## CSS

Design tokens are in `styles/tokens.css` (role tokens plus the older names as aliases); layout styles in `styles/layout.css`. Apps override only their accent (and Admin its dark values) in their `global.css`.
