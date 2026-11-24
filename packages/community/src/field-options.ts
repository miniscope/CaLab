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

/** Specific microscopes (models), shown before the generic types. */
export const SCOPE_MODEL_OPTIONS = [
  'UCLA Miniscope v4',
  'UCLA Miniscope V4.4',
  'UCLA Miniscope v3',
  'UCLA Miniscope wire-free',
  'own wireless miniscope',
  'Inscopix nVista',
  'Inscopix nVoke',
  'Doric miniscope',
  'NINscope',
  'Bruker 2-photon',
  'Thorlabs 2-photon',
  'Neurolabware 2-photon',
];

/** How the indicator is expressed (virus or transgenic line). */
export const EXPRESSION_OPTIONS = [
  'AAV1-Syn-GCaMP6f',
  'AAV1-Syn-GCaMP6s',
  'AAV9-Syn-GCaMP7f',
  'AAV9-Syn-jGCaMP8m',
  'AAV9-Syn-jGCaMP8s',
  'AAV1-CaMKII-GCaMP6f',
  'AAV9-CaMKII-GCaMP7f',
  'AAV-Flex-GCaMP6f (Cre-dependent)',
  'AAV-Flex-jGCaMP8m (Cre-dependent)',
  'Thy1-GCaMP6s (GP4.3)',
  'Thy1-GCaMP6f (GP5.17)',
  'Ai148 (TIGRE-GCaMP6f) x Cre',
  'Ai162 (TIGRE-GCaMP6s) x Cre',
  'Ai95 (RCL-GCaMP6f) x Cre',
  'Snap25-GCaMP6s',
];

/** Surgical / optical preparation. */
export const PREPARATION_OPTIONS = [
  'GRIN lens',
  'GRIN lens + prism',
  'cranial window',
  'cranial window + baseplate',
  'thinned skull',
  'optical fiber',
  'acute slice',
];

/** What the animal was doing during the recording. */
export const BEHAVIOR_OPTIONS = [
  'open field',
  'linear track',
  'home cage',
  'sleep',
  'head-fixed, at rest',
  'head-fixed, running wheel',
  'head-fixed, task',
  'freely moving, task',
  'fear conditioning',
  'social interaction',
  'anesthetized',
];

/** Strain or genotype of the animal. */
export const GENOTYPE_OPTIONS = [
  'C57BL/6J',
  'C57BL/6N',
  'Thy1-GCaMP6s (GP4.3)',
  'Thy1-GCaMP6f (GP5.17)',
  'Ai148 x Cre',
  'Ai162 x Cre',
  'PV-Cre',
  'SST-Cre',
  'VIP-Cre',
  'CaMKIIa-Cre',
  'Drd1-Cre',
  'A2a-Cre',
  'Long-Evans',
  'Sprague-Dawley',
];
