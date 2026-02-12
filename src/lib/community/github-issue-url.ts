/** Builds a pre-filled GitHub issue URL for requesting a new field option. */

const FIELD_LABELS: Record<string, string> = {
  indicator: 'Calcium Indicator',
  species: 'Species',
  brain_region: 'Brain Region',
  microscope_type: 'Microscope Type',
  cell_type: 'Cell Type',
};

export function buildFieldOptionRequestUrl(
  fieldName: 'indicator' | 'species' | 'brain_region' | 'microscope_type' | 'cell_type',
): string {
  const label = FIELD_LABELS[fieldName];
  const params = new URLSearchParams({
    template: 'field-option-request.yml',
    title: `[Field Option] New ${label}: `,
    labels: 'field-option-request',
  });
  return `https://github.com/miniscope/CaTune/issues/new?${params.toString()}`;
}
