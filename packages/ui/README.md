# @calab/ui

Shared SolidJS layout components and CSS design tokens for the CaLab monorepo.

Depends on `@calab/tutorials` (for TutorialPanel and TutorialLauncher components). External dependency: `solid-js`.

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

## CSS

Layout styles are in `styles/layout.css`. Apps define their own design tokens (colors, spacing, shadows) in their `global.css` files, following the dark-theme scientific instrument aesthetic.
