---
phase: 03-visualization
plan: 01
subsystem: ui
tags: [uplot, solid-uplot, charting, canvas-2d, downsampling, calcium-kernel, zoom, sync]

# Dependency graph
requires:
  - phase: 01-data-foundation
    provides: "CSS custom properties (global.css), data types (types.ts, solver-types.ts)"
provides:
  - "Min/max per-pixel-bucket downsampling (downsampleMinMax)"
  - "Double-exponential calcium kernel computation (computeKernel)"
  - "Synchronized zoom state manager (createSyncGroup, createZoomSyncPlugin)"
  - "Wheel zoom and drag pan uPlot plugin (wheelZoomPlugin)"
  - "Dark theme CSS overrides for uPlot (chart-theme.css)"
  - "Reusable TracePanel chart component (TracePanel)"
affects: [03-02-visualization, 04-interactivity]

# Tech tracking
tech-stack:
  added: [uplot 1.6.32, "@dschz/solid-uplot 0.5.2"]
  patterns: ["min/max per-pixel downsampling for scientific waveforms", "uPlot.sync() cursor synchronization", "isSyncing guard for zoom propagation loop prevention", "left-click drag pan / wheel zoom oscilloscope model"]

key-files:
  created:
    - src/lib/chart/downsample.ts
    - src/lib/chart/kernel-math.ts
    - src/lib/chart/sync-manager.ts
    - src/lib/chart/wheel-zoom-plugin.ts
    - src/lib/chart/chart-theme.css
    - src/components/traces/TracePanel.tsx
    - src/lib/__tests__/downsample.test.ts
    - src/lib/__tests__/kernel-math.test.ts
  modified:
    - package.json
    - package-lock.json

key-decisions:
  - "Left-click drag for pan, scroll-wheel for zoom (oscilloscope model per research)"
  - "X-axis only zoom with y auto-range (scientific trace viewing standard)"
  - "Disabled uPlot default box-select zoom in favor of drag-to-pan"
  - "autoResize enabled on SolidUplot for responsive width filling"

patterns-established:
  - "TracePanel component pattern: data accessor function, series config, syncKey for multi-panel linking"
  - "Chart plugin composition: wheelZoomPlugin always included, additional plugins passed via props"

# Metrics
duration: 3min
completed: 2026-02-11
---

# Phase 3 Plan 01: Chart Infrastructure Summary

**uPlot charting infrastructure with min/max downsampling, calcium kernel math, synchronized zoom/pan plugins, dark theme, and reusable TracePanel component**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-11T05:14:36Z
- **Completed:** 2026-02-11T05:17:31Z
- **Tasks:** 2
- **Files modified:** 10

## Accomplishments
- Installed uplot and @dschz/solid-uplot charting dependencies
- Created six chart utility modules (downsample, kernel-math, sync-manager, wheel-zoom-plugin, chart-theme.css)
- Built reusable TracePanel component with SolidUplot wrapper, wheel zoom, cursor sync, and dark theme
- Added 15 tests (7 downsample + 8 kernel-math) -- all 67 project tests passing

## Task Commits

Each task was committed atomically:

1. **Task 1: Install charting deps and create chart utility modules** - `33aa839` (feat)
2. **Task 2: Create reusable TracePanel component** - `a25cf14` (feat)

## Files Created/Modified
- `src/lib/chart/downsample.ts` - Min/max per-pixel-bucket downsampling preserving spike peaks and troughs
- `src/lib/chart/kernel-math.ts` - Double-exponential calcium kernel h(t) = exp(-t/tauDecay) - exp(-t/tauRise), normalized to peak=1
- `src/lib/chart/sync-manager.ts` - uPlot.sync() wrapper and zoom propagation plugin with isSyncing guard
- `src/lib/chart/wheel-zoom-plugin.ts` - Scroll-wheel x-zoom and left-click drag pan with data bounds clamping
- `src/lib/chart/chart-theme.css` - Dark theme CSS overrides for uPlot matching CaTune design system
- `src/components/traces/TracePanel.tsx` - Reusable chart panel with SolidUplot, auto-resize, cursor sync
- `src/lib/__tests__/downsample.test.ts` - 7 tests covering reduction, min/max preservation, time ordering, edge cases
- `src/lib/__tests__/kernel-math.test.ts` - 8 tests covering normalization, shape, length, timing
- `package.json` - Added uplot and @dschz/solid-uplot dependencies
- `package-lock.json` - Updated lockfile

## Decisions Made
- Left-click drag for pan, scroll-wheel for zoom (oscilloscope model per research recommendation)
- X-axis only zoom with y auto-range (scientific trace viewing standard)
- Disabled uPlot default box-select zoom in favor of drag-to-pan
- autoResize enabled on SolidUplot for responsive width

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- All six chart utility modules ready for composition in Plan 02 (TracePanelStack)
- TracePanel component exports accept data, series, syncKey, and plugins for multi-panel stacking
- 67/67 tests passing, TypeScript clean, build succeeds

## Self-Check: PASSED

All 9 created files verified present. Both task commits (33aa839, a25cf14) verified in git log. 67/67 tests passing. TypeScript clean. Build succeeds.

---
*Phase: 03-visualization*
*Completed: 2026-02-11*
