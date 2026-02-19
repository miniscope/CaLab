/** Builds pre-filled GitHub issue URLs for various issue templates. */

const REPO_BASE = 'https://github.com/miniscope/CaTune/issues/new';

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
  return `${REPO_BASE}?${params.toString()}`;
}

export function buildFeedbackUrl(): string {
  const params = new URLSearchParams({
    template: 'feedback.yml',
    title: '[Feedback] ',
    labels: 'feedback',
  });
  return `${REPO_BASE}?${params.toString()}`;
}

export function buildFeatureRequestUrl(): string {
  const params = new URLSearchParams({
    template: 'feature-request.yml',
    title: '[Feature] ',
    labels: 'enhancement',
  });
  return `${REPO_BASE}?${params.toString()}`;
}

export function buildBugReportUrl(): string {
  const params = new URLSearchParams({
    template: 'bug-report.yml',
    title: '[Bug] ',
    labels: 'bug',
  });
  return `${REPO_BASE}?${params.toString()}`;
}
