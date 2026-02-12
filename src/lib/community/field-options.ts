/**
 * Autocomplete suggestion lists for community submission form fields.
 *
 * Edit these arrays to add/remove options shown in the datalist dropdowns.
 * These are suggestions only — users can still type free-form values.
 */

/** Calcium indicator suggestions grouped by family, then sorted alphabetically. */
export const INDICATOR_OPTIONS = [
  // GCaMP6 family
  'GCaMP6f (AAV)',
  'GCaMP6f (transgenic)',
  'GCaMP6m (AAV)',
  'GCaMP6m (transgenic)',
  'GCaMP6s (AAV)',
  'GCaMP6s (transgenic)',

  // GCaMP7 family
  'GCaMP7f (AAV)',
  'GCaMP7f (transgenic)',
  'GCaMP7s (AAV)',

  // GCaMP8 / jGCaMP8 family
  'jGCaMP8f (AAV)',
  'jGCaMP8m (AAV)',
  'jGCaMP8s (AAV)',
  'GCaMP8f (AAV)',
  'GCaMP8m (AAV)',
  'GCaMP8s (AAV)',

  // Other genetically-encoded indicators
  'RCaMP1h (AAV)',
  'RCaMP2 (AAV)',
  'jRGECO1a (AAV)',
  'jRGECO1b (AAV)',
  'XCaMP-G (AAV)',
  'XCaMP-R (AAV)',
  'GCaMP-X (AAV)',
  'CaMPARI2 (AAV)',
  'NIR-GECO1 (AAV)',

  // Synthetic / chemical dyes
  'OGB-1 (dye)',
  'OGB-2 (dye)',
  'Cal-520 (dye)',
  'Cal-590 (dye)',
  'Fluo-4 (dye)',
  'Fluo-8 (dye)',
  'Fura-2 (dye)',
  'Rhod-2 (dye)',
  'X-Rhod-1 (dye)',
];

/** Species suggestions. */
export const SPECIES_OPTIONS = [
  'mouse',
  'rat',
  'zebrafish',
  'zebrafish larva',
  'drosophila',
  'C. elegans',
  'macaque',
  'marmoset',
  'ferret',
  'cat',
  'human (slice)',
  'human (organoid)',
  'guinea pig',
  'hamster',
  'rabbit',
  'songbird',
  'xenopus',
  'lamprey',
  'planarian',
];

/** Microscope type suggestions. */
export const MICROSCOPE_TYPE_OPTIONS = [
  '1-photon widefield',
  '1-photon miniscope',
  '2-photon',
  '3-photon',
  'confocal',
  'spinning disk confocal',
  'light-sheet',
  'fiber photometry',
];

/** Cell type suggestions. */
export const CELL_TYPE_OPTIONS = [
  'excitatory neuron',
  'inhibitory neuron',
  'pyramidal cell',
  'interneuron — PV+',
  'interneuron — SST+',
  'interneuron — VIP+',
  'medium spiny neuron (MSN)',
  'D1 MSN',
  'D2 MSN',
  'dopaminergic neuron',
  'serotonergic neuron',
  'cholinergic neuron',
  'Purkinje cell',
  'granule cell',
  'astrocyte',
  'microglia',
  'oligodendrocyte',
];

/** Brain region suggestions, including sub-regions. */
export const BRAIN_REGION_OPTIONS = [
  // Cortex
  'cortex',
  'cortex — prefrontal (PFC)',
  'cortex — motor (M1)',
  'cortex — premotor (M2)',
  'cortex — somatosensory (S1)',
  'cortex — barrel cortex (S1BF)',
  'cortex — visual (V1)',
  'cortex — auditory (A1)',
  'cortex — retrosplenial (RSC)',
  'cortex — entorhinal (EC)',
  'cortex — piriform',
  'cortex — insular',
  'cortex — cingulate (ACC)',
  'cortex — orbitofrontal (OFC)',
  'cortex — parietal',

  // Hippocampus
  'hippocampus',
  'hippocampus — CA1',
  'hippocampus — CA2',
  'hippocampus — CA3',
  'hippocampus — dentate gyrus (DG)',
  'hippocampus — subiculum',

  // Basal ganglia
  'striatum',
  'striatum — dorsal (dSTR)',
  'striatum — dorsomedial (DMS)',
  'striatum — dorsolateral (DLS)',
  'striatum — ventral / NAc',
  'NAc — core',
  'NAc — shell',
  'globus pallidus',

  // Thalamus
  'thalamus',
  'thalamus — lateral geniculate (LGN)',
  'thalamus — medial geniculate (MGN)',
  'thalamus — ventral posteromedial (VPM)',
  'thalamus — mediodorsal (MD)',
  'thalamus — reticular (TRN)',

  // Midbrain
  'VTA',
  'substantia nigra (SNc)',
  'substantia nigra (SNr)',
  'superior colliculus',
  'inferior colliculus',
  'periaqueductal gray (PAG)',

  // Cerebellum
  'cerebellum',
  'cerebellum — Purkinje cells',
  'cerebellum — granule cells',
  'cerebellum — deep cerebellar nuclei',

  // Hypothalamus
  'hypothalamus',
  'hypothalamus — arcuate (ARC)',
  'hypothalamus — lateral (LH)',
  'hypothalamus — paraventricular (PVN)',
  'hypothalamus — ventromedial (VMH)',
  'hypothalamus — suprachiasmatic (SCN)',

  // Amygdala
  'amygdala',
  'amygdala — basolateral (BLA)',
  'amygdala — central (CeA)',
  'amygdala — medial (MeA)',

  // Brainstem
  'brainstem',
  'locus coeruleus (LC)',
  'dorsal raphe (DRN)',
  'parabrachial nucleus',
  'nucleus tractus solitarius (NTS)',

  // Other
  'olfactory bulb',
  'bed nucleus of stria terminalis (BNST)',
  'spinal cord',
  'retina',
  'habenula',
  'septum',
  'claustrum',
];
