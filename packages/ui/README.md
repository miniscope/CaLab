# @calab/ui

Shared SolidJS layout components, chart primitives, and CSS design tokens for the CaLab monorepo.

Depends on `@calab/tutorials` (for TutorialPanel and TutorialLauncher components). External dependencies: `solid-js`, `uplot`.

```
@calab/tutorials
  ↑
@calab/ui
  ↑
apps/catune, apps/carank
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

The table above covers the layout components; the barrel (`src/index.ts`) also re-exports the community/auth widgets and the chart utilities below. Consult `src/index.ts` for the authoritative export list.

## Chart utilities (`@calab/ui/chart`)

Shared uPlot primitives so every app charts consistently (also re-exported from the top-level barrel):

| Export                                                                                                                                                                      | Source            | Description                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------- |
| `OKABE_ITO`, `OKABE_ITO_CYCLE`, `NEUTRAL`, `TRACE_COLORS`, `GROUND_TRUTH_COLORS`, `KERNEL_FIT_COLORS`, `METRIC_COLORS`, `DISTRIBUTION_COLORS`, `subsetColor`, `withOpacity` | `series-utils.ts` | Colorblind-safe Okabe-Ito palette and semantic color roles for series |
| `VIRIDIS_LUT`, `viridisRGB`, `viridisCss`                                                                                                                                   | `colormap.ts`     | 256-entry viridis lookup table + RGB/CSS accessors (raster heatmaps)  |
| `niceTicks`                                                                                                                                                                 | `chart-math.ts`   | Human-friendly axis tick values (1/2/5×10ⁿ)                           |
| `chartAxis`, `labeledAxis`, `syncCursor`, `staticCursor`, `safeRange`, `integerTickValues`, `hiddenTickValues`                                                              | `axis-helpers.ts` | uPlot axis/cursor/range builders with shared theming                  |

## CSS

Layout styles are in `styles/layout.css`. Apps define their own design tokens (colors, spacing, shadows) in their `global.css` files, following the dark-theme scientific instrument aesthetic.
