import { describe, it, expect } from 'vitest';
import {
  buildFieldOptionRequestUrl,
  buildFeedbackUrl,
  buildFeatureRequestUrl,
  buildBugReportUrl,
} from '../github-issue-url.ts';

const BASE = 'https://github.com/miniscope/CaLab/issues/new?';

describe('GitHub issue URL builders', () => {
  it('all produce URLs starting with the correct base', () => {
    expect(buildFieldOptionRequestUrl('indicator')).toContain(BASE);
    expect(buildFeedbackUrl()).toContain(BASE);
    expect(buildFeatureRequestUrl()).toContain(BASE);
    expect(buildBugReportUrl()).toContain(BASE);
  });

  it('buildFieldOptionRequestUrl includes correct template and label', () => {
    const url = buildFieldOptionRequestUrl('indicator');
    expect(url).toContain('template=field-option-request.yml');
    expect(url).toContain('labels=field-option-request');
    expect(url).toContain('Calcium+Indicator');
  });

  it('buildFeedbackUrl has template=feedback.yml and labels=feedback', () => {
    const url = buildFeedbackUrl();
    expect(url).toContain('template=feedback.yml');
    expect(url).toContain('labels=feedback');
  });

  it('buildFeatureRequestUrl has labels=enhancement', () => {
    const url = buildFeatureRequestUrl();
    expect(url).toContain('template=feature-request.yml');
    expect(url).toContain('labels=enhancement');
  });

  it('buildBugReportUrl has labels=bug', () => {
    const url = buildBugReportUrl();
    expect(url).toContain('template=bug-report.yml');
    expect(url).toContain('labels=bug');
  });
});
