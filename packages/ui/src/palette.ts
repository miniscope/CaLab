/**
 * Okabe-Ito qualitative palette: colorblind-safe under deuteranopia, protanopia and
 * tritanopia. From Okabe & Ito (2008); popularized for scientific figures by Wong, "Points of
 * view: Color blindness", Nature Methods 8:441 (2011). CaLab's one definition of chart series
 * colour: every series and metric colour is drawn from it so no red/green pair ever
 * distinguishes two co-plotted series.
 *
 * Dependency-free (no Solid, no uPlot), so stores and workers import it from
 * `@calab/ui/palette` without pulling in UI code.
 */
export const OKABE_ITO = {
  black: '#000000',
  orange: '#e69f00',
  skyBlue: '#56b4e9',
  bluishGreen: '#009e73',
  yellow: '#f0e442',
  blue: '#0072b2',
  vermillion: '#d55e00',
  reddishPurple: '#cc79a7',
} as const;

/**
 * cala run stage hues and tints, for code that cannot read CSS variables (canvas series). The
 * same values as the `--stage-*` tokens in `styles/tokens.css` (a test keeps them equal).
 */
export const STAGE_HUES = {
  discover: '#1f75d7',
  discoverTint: '#dceafb',
  settle: '#b8407e',
  settleTint: '#f5e1eb',
  extract: '#e0701f',
  extractTint: '#fbe6d8',
} as const;
