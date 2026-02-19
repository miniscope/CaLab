/**
 * Runtime validation schema for the CaTune JSON export format.
 *
 * Uses Valibot (<2KB tree-shaken) to validate external data at the
 * system boundary — when importing a previously exported JSON file.
 */

import * as v from 'valibot';

const ParametersSchema = v.object({
  tau_rise_s: v.number(),
  tau_decay_s: v.number(),
  lambda: v.number(),
  sampling_rate_hz: v.number(),
  filter_enabled: v.boolean(),
});

const AR2Schema = v.object({
  decayRoot: v.number(),
  riseRoot: v.number(),
  g1: v.number(),
  g2: v.number(),
  dt: v.number(),
});

const FormulationSchema = v.object({
  model: v.string(),
  objective: v.string(),
  kernel: v.string(),
  ar2_relation: v.string(),
  lambda_definition: v.string(),
  convergence: v.string(),
});

const MetadataSchema = v.object({
  source_filename: v.optional(v.string()),
  num_cells: v.optional(v.number()),
  num_timepoints: v.optional(v.number()),
});

export const CaTuneExportSchema = v.object({
  schema_version: v.string(),
  catune_version: v.string(),
  export_date: v.string(),
  parameters: ParametersSchema,
  ar2_coefficients: AR2Schema,
  formulation: FormulationSchema,
  metadata: MetadataSchema,
});

export type CaTuneExportData = v.InferOutput<typeof CaTuneExportSchema>;
