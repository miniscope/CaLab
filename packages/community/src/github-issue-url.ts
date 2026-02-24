/** Builds pre-filled GitHub issue URLs for various issue templates. */

const REPO_BASE = 'https://github.com/miniscope/CaLab/issues/new';

export type AppLabel = 'catune' | 'carank' | 'python';

const FIELD_LABELS: Record<string, string> = {
  indicator: 'Calcium Indicator',
  species: 'Species',
  brain_region: 'Brain Region',
  microscope_type: 'Microscope Type',
  cell_type: 'Cell Type',
};

function joinLabels(base: string, app?: AppLabel): string {
  return app ? `${base},${app}` : base;
}

export function buildFieldOptionRequestUrl(
  fieldName: 'indicator' | 'species' | 'brain_region' | 'microscope_type' | 'cell_type',
  app?: AppLabel,
): string {
  const label = FIELD_LABELS[fieldName];
  const params = new URLSearchParams({
    template: 'field-option-request.yml',
    title: `[Field Option] New ${label}: `,
    labels: joinLabels('field-option-request', app),
  });
  return `${REPO_BASE}?${params.toString()}`;
}

export function buildFeedbackUrl(app?: AppLabel): string {
  const params = new URLSearchParams({
    template: 'feedback.yml',
    title: '[Feedback] ',
    labels: joinLabels('feedback', app),
  });
  return `${REPO_BASE}?${params.toString()}`;
}

export function buildFeatureRequestUrl(app?: AppLabel): string {
  const params = new URLSearchParams({
    template: 'feature-request.yml',
    title: '[Feature] ',
    labels: joinLabels('enhancement', app),
  });
  return `${REPO_BASE}?${params.toString()}`;
}

export function buildBugReportUrl(app?: AppLabel): string {
  const params = new URLSearchParams({
    template: 'bug-report.yml',
    title: '[Bug] ',
    labels: joinLabels('bug', app),
  });
  return `${REPO_BASE}?${params.toString()}`;
}
