# Phase 7: Community Database - Context

**Gathered:** 2026-02-11
**Status:** Ready for planning

<domain>
## Phase Boundary

Opt-in parameter sharing and cross-lab distribution browsing. Users can submit their tuned parameters with experimental metadata to a community database, browse and filter community parameter distributions, and compare their own parameters against the community. Authentication prevents spam. Trace data never leaves the browser.

</domain>

<decisions>
## Implementation Decisions

### Submission flow
- Single unified action point (not separate export + submit) — one button for "save & share" that offers export locally, submit to community, or both
- Rich required metadata: animal, brain region, virus/transgenic, calcium indicator, time since injection (for virus)
- Auto-included from session: parameter values (tau_rise, tau_decay, lambda), AR2 coefficients, sampling rate
- Dataset metadata tracked: number of cells, recording length, FPS
- Quality metrics included with submission
- Dataset hash to detect duplicate submissions from the same recording
- One parameter set per submission (single set across all cells)
- Summary card confirmation showing what was submitted

### Browsing & filtering
- Scatter plot: tau_rise vs tau_decay with lambda as color dimension, marginal histograms on axes — three parameters in one view
- Flat multi-filter: indicator, species, brain region, method all at same level
- Indicator field encodes delivery context (e.g., "GCaMP7f (AAV)" vs "GCaMP7f (transgenic)" vs "OGB-1 (dye)") to avoid conditional filter cascading
- "Compare my params" toggle overlays user's current values on community distribution
- Built as modular, collapsible component — layout integration deferred to future rework

### Privacy & trust model
- Authentication required via Supabase Auth (GitHub or Google providers) to prevent spam
- Submissions anonymous by default, optional attribution (lab name, ORCID)
- Inline privacy message at submission: "Only parameters and metadata are shared — your traces never leave your browser"
- Expandable "Learn more" section with detailed data flow explanation
- Automated quality checks only (parameter range sanity) — no human moderation
- Users can delete their own submissions but not edit (submit fresh if params change)

### Backend & storage
- Supabase for auth, database, and API (existing project)
- Environment variables: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
- GitHub and Google OAuth providers via Supabase Auth

### Claude's Discretion
- Caching strategy for community data (live vs cached locally)
- Database schema design and RLS policies
- Exact scatter plot library/implementation
- Quality metric calculations
- Dataset hash algorithm
- Automated sanity check thresholds for parameter ranges
- Exact filter UI component design

</decisions>

<specifics>
## Specific Ideas

- Color-coded scatter plot: tau_rise (x) vs tau_decay (y) vs lambda (color) to show all three parameters in one visualization
- Indicator naming should encode delivery method context to keep filters flat while capturing important distinctions
- Dataset hash enables detecting when the same recording generates multiple parameter submissions
- Summary card after submission gives users confidence about exactly what was shared

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 07-community-database*
*Context gathered: 2026-02-11*
