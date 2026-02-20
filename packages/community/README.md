# @calab/community

Supabase data access layer for community parameter sharing in CaLab.

This package is **optional** — the app works fully offline without it. When Supabase credentials are configured, users can submit and browse deconvolution parameters shared by others.

Depends on `@calab/core`. External dependency: `@supabase/supabase-js`.

```
@calab/core
  ↑
@calab/community
  ↑
apps/catune
```

## Boundary Rule

Only `supabase.ts` may import `@supabase/supabase-js` (~45 KB). The SDK is lazy-loaded on first use via dynamic import. The `supabaseEnabled` boolean is re-exported through the barrel so the app can conditionally render community UI. This boundary is enforced by ESLint `no-restricted-imports`.

## Exports

| Export                                                                                                         | Source                 | Description                                           |
| -------------------------------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------- |
| `getSupabase`, `supabaseEnabled`                                                                               | `supabase.ts`          | Lazy Supabase client singleton and availability flag  |
| `submitParameters`, `fetchSubmissions`, `fetchFieldOptions`, `deleteSubmission`                                | `community-service.ts` | CRUD operations for community submissions             |
| `INDICATOR_OPTIONS`, `SPECIES_OPTIONS`, `MICROSCOPE_TYPE_OPTIONS`, `CELL_TYPE_OPTIONS`, `BRAIN_REGION_OPTIONS` | `field-options.ts`     | Hardcoded option arrays for submission form dropdowns |
| `buildFieldOptionRequestUrl`, `buildFeedbackUrl`, `buildFeatureRequestUrl`, `buildBugReportUrl`                | `github-issue-url.ts`  | GitHub issue URL builders for community feedback      |
| `validateSubmission`                                                                                           | `quality-checks.ts`    | Submission quality validation                         |
| `submitToSupabase`                                                                                             | `submit-action.ts`     | Form → payload → Supabase submission pipeline         |
| `DataSource`, `CommunitySubmission`, `SubmissionPayload`, `FilterState`, ...                                   | `types.ts`             | Community data types                                  |
