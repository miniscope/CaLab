# Data donation

A **Donate data** button in browser cala lets users send a raw recording to the
CaLab team, compressed without loss, with metadata. The donor chooses one of
two ways to share it:

- **Public**: after lab review the recording is converted to NWB and published
  on [DANDI](https://dandiarchive.org) under CC BY 4.0, in one shared
  collection anyone can browse, stream and download, e.g. to test and improve
  their own pipelines. cala uses it too.
- **CaLab only**: the recording stays on the lab server and is used only by
  the CaLab team to develop and benchmark cala. The raw data is never shared.

The collection is named for CaLab, not cala, so CaDecon, CaTune and CaBaNA can
add their own collections (traces rather than raw videos) later. Only cala
donations are in scope now.

Status (2026-11-23): Part A built (2026-11-23); not yet run against DANDI. Part A is the
public-sharing redesign described below (branch `feature/data-donation`, PR #452).
Opening a DANDI recording directly in cala is the separate "Part B":
[open-from-dandi.md](open-from-dandi.md).

## Why people donate

1. **cala gets better on their kind of data.** Every donation (public or
   CaLab only) can go into the cala benchmark set, and the pipeline is
   developed and tuned against it. A lab with an unusual region, indicator or
   scope makes sure cala works for that setup.
2. **Public donations help everyone.** Other developers can test their
   pipelines on the recording, and anyone can look at how other labs' data
   looks.
3. **Credit.**
   - Public donors and their labs are listed as contributors on the DANDI
     collection, which has a citable DOI per published version, and users of
     the data are asked to cite it and acknowledge the contributing lab (see
     "Citation and acknowledgement").
   - The CaLab team acknowledges every donor lab, public or CaLab only, in
     any paper that uses their data.

The panel (bottom of the Run tab, visible without clicking) states these, that
a single raw recording is enough (no processing), and the 10 GB cap (after
compression, ~40 min of 600x600 V4). "My donations" (in the panel and on cala's
start page) shows each donation's state, and for a published one its DANDI
link. Uploads left unfinished for 48 h are withdrawn automatically
(`DONATION_STALE_HOURS`).

## Goals and non-goals

Goals

- One click from an opened recording to a submitted dataset.
- Raw frames, lossless: noise, motion and artifacts stay as recorded, and any
  pipeline (cala, Minian, CaImAn, suite2p, future versions) can run on them.
- An explicit, recorded choice between public and CaLab only, with nothing
  preselected.
- Public donations end up as valid NWB on DANDI with the metadata DANDI needs,
  one row per recording on a browse page in cala, each with its own download
  and view link.
- The lab server is never reachable from the internet, and a CaLab-only
  donation can never reach DANDI by mistake.
- Cloud cost bounded by design: R2 is transit only and stays in the free tier
  in normal use.

Non-goals (now)

- Opening a DANDI recording in cala: Part B, its own spec and branch.
- CaDecon / CaTune / CaBaNA donations.
- Automatic DANDI publishing: the lab runs the conversion and upload, and
  publishes versions by hand.
- Switching a donation between public and CaLab only in the app: by email to
  the CaLab team.

## Data flow

```text
browser cala            Supabase (donation project)     Cloudflare R2     lab server (solaris)             DANDI
────────────            ───────────────────────────     ─────────────     ────────────────────             ─────
form + sharing choice
decode → CALARAW1 → gzip → OPFS
   │ create ──────────▶ edge fn `donation`: auth, caps,
   │                    row (uploading)
   │ PUT chunks ─────────────────────────────────────▶ pending/<id>/
   │ finish ──────────▶ sizes + magic → uploaded
                        admin: preview, approve ──────▶ approved/<id>/
                        ingest_list / download_url ◀───────────────────── hourly pull (outbound only)
                                                                          strict parse, read-only store
                        ingest_done → ingested ◀───────────────────────── R2 copy deleted
                                                                          ── public only ──
                                                                          donation_to_nwb.py → NWB
                                                                          nwbinspector, dandi validate
                                                                          dandi upload ──────────────────▶ draft
                        ingest_published → published ◀─────────────────── (asset path)
                                                                          lab publishes a version ──────▶ DOI
browse page ◀── public view (published rows) ─┘                                        ◀── asset links ──┘
```

Steps up to `ingested` are built and unchanged, apart from the new fields.
New in Part A:

1. **Sharing choice and DANDI fields** in the form, the row and the edge
   function.
2. **`python/scripts/donation_to_nwb.py`** on solaris: converts one ingested
   public donation to NWB and uploads it to the collection's draft.
3. **`ingest_published`** edge action: the lab marks the row `published` with
   its DANDI asset path.
4. **Browse page** in cala, fed by a public view of published rows.
5. **Text**: panel, consent, deletion, citation.

Supabase holds only rows, auth and the edge function; files never touch
Supabase Storage. The lab server only makes outbound requests and holds only
the ingest token and the DANDI API key (no R2 keys, no Supabase service key).

## The sharing choice

A required radio group, nothing preselected; the Donate button stays disabled
until one is picked.

- **Public on DANDI (CC BY 4.0).** "After review, your recording is published
  in the CaLab donated recordings collection on DANDI, where anyone can
  download it, e.g. to test and improve their pipelines. You and your lab are
  listed as contributors on its citable DOI. You can withdraw it until the
  next version of the collection is published; published versions are
  permanent."
- **CaLab only.** "Only the CaLab team uses your recording, to develop and
  benchmark cala. The raw data is never shared; results computed from it may
  appear in papers, which acknowledge your lab. You can have it deleted at any
  time, or ask us to make it public later."

Stored as `sharing` (`public` | `lab`) with `license` derived from it
(`cc-by-4.0` | `lab-use-only`) and a CHECK that the two agree. The license
value `lab-use-only` already exists in migration 020.

Safety: a CaLab-only row never gets past `ingested`. The edge function refuses
`ingest_published` for it, the conversion script refuses a donation whose
`meta.json` or row says `lab`, and the browse view selects only
`sharing = 'public' AND status = 'published'`.

## Metadata (table `cala_donations`)

Built (migration `020_cala_donations.sql`):

- `id`, `user_id`, `created_at`, `updated_at`, `status`
- Biology: `indicator`, `species`, `brain_region`, `expression`,
  `preparation`, `behavior`
- Optics: `scope`, `fps`, `width`, `height`, `n_frames`, `bytes_per_pixel`,
  `depth_um`, `led_power`
- Provenance: `cala_version`, `dataset_hash`
- Files: `declared_bytes`, `n_chunks`, `files`
- Consent: `license`, `rights_attested`, `protocol_attested`, `contact_ok`
- Credit: `credit_name`, `credit_lab` (both required by form and edge
  function)
- Benchmark and review: `in_benchmark`, `benchmark_note`, `review_note`,
  `notes`

New (migration `021_cala_donations_public.sql`; a new migration rather than an
edit of 020, because 020 is already applied on the test project):

| Column         | Type / check                                                      | Why                                    |
| -------------- | ----------------------------------------------------------------- | -------------------------------------- |
| `sharing`      | `public` \| `lab`, NOT NULL; agrees with `license`                | the donor's choice                     |
| `subject_id`   | text 1–64, `[A-Za-z0-9-]` only                                    | NWB / DANDI subject; donor's own label |
| `subject_sex`  | `M` \| `F` \| `U` \| `O`                                          | required by DANDI                      |
| `subject_age`  | ISO 8601 duration, e.g. `P90D`, `P12W`, `P3M` (≤ 16 chars)        | required by DANDI (age or birth date)  |
| `session_date` | date, not in the future, not before 1990                          | NWB `session_start_time`               |
| `genotype`     | text ≤ 128, optional                                              | strain / genotype for NWB `Subject`    |
| `dandi_path`   | text ≤ 256, `^sub-[A-Za-z0-9-]+/[^/]+\.nwb$`, set by the lab only | where the published file is            |
| `published_at` | timestamptz, set with `dandi_path`                                | shown to the donor                     |

`subject_id`, `subject_sex`, `subject_age` and `session_date` are required for
both choices: the benchmark needs them too, and a CaLab-only donation can
then become public later without asking again. The edge function requires
them on `create`; in the table they stay nullable, so the existing test rows
migrate as `sharing = 'lab'` with NULL subject fields, and a CHECK requires all
four (and `dandi_path`, `published_at`) on any `published` row.

Status machine gains `published`:

```text
uploading → uploaded → approved → ingested → published   (public only)
                     ↘ rejected
uploading | uploaded | approved → withdrawn               (by the donor)
```

The form offers age as a number and a unit (days, weeks, months, years) and
writes the ISO duration. Species stays the existing free-text field with the
`SPECIES_OPTIONS` list; the conversion script maps it to the scientific name
DANDI expects (mouse → _Mus musculus_, rat → _Rattus norvegicus_, macaque →
_Macaca mulatta_, marmoset → _Callithrix jacchus_, zebrafish → _Danio rerio_,
...) and stops with a clear message for a species it does not know, so the lab
adds it to the table rather than guessing.

### Public view

`cala_donations_public` (security definer, like the `*_public` views in 010),
granted to `anon`:

```text
id, published_at, indicator, species, brain_region, expression, preparation,
behavior, scope, fps, width, height, n_frames, bytes_per_pixel, depth_um,
subject_sex, subject_age, genotype, credit_name, credit_lab, dandi_path
WHERE sharing = 'public' AND status = 'published'
```

No `user_id`, email, notes, review fields or file list. The donor's name and
lab are public for public donations; the form says so next to the choice.

Migrations 020/021 are not in `schema_fingerprint()` (019): that panel checks
the main project, which has no donation tables.

## Edge function changes (`supabase/functions/donation`)

| Action             | Change                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `create`           | requires and validates `sharing` and the four subject fields (same rules as the CHECKs); derives `license`                  |
| `ingest_published` | **new**, lab (ingest token): `{donation_id, dandi_path}` for an `ingested`, `public` row → `published`, sets `published_at` |
| `ingest_list`      | also returns `sharing` and the subject fields, so the lab side never has to infer them                                      |
| `withdraw`         | unchanged (until ingested); later requests go to the CaLab team                                                             |

The new-upload notification email names the sharing choice.

## NWB conversion and DANDI upload (`python/scripts/donation_to_nwb.py`)

Runs on solaris, by hand at first (`run.sh nwb <donation_id>`), in the
`~/calab-ingest` venv plus `pynwb`, `hdmf`, `nwbinspector` and `dandi`.

1. Read the stored donation (`/mnt/data_1/mbrosch/calab_donations/<id>/`):
   CALARAW chunks through `calab._calaraw`, `meta.json`, optional
   `timestamps.csv`. Refuse unless the row and `meta.json` both say `public`.
2. Write `sub-<subject>/sub-<subject>_ses-<date>-<id8>_ophys.nwb`, where
   `<subject>` is `<lab-slug>-<subject_id>` (unique across labs) and `<id8>`
   is the first 8 characters of the donation id:
   - `NWBFile`: `identifier` = donation id, `session_start_time` =
     `session_date` at 00:00 UTC (the form asks for no time), `lab` =
     `credit_lab`, `experimenter` = `credit_name`, `session_description` from
     behavior (donor notes stay private).
   - `Subject`: id, scientific species, sex, age, genotype.
   - `Device` (scope), `OpticalChannel`, `ImagingPlane` (indicator, location
     = brain region, imaging rate = fps; excitation/emission unknown → NaN).
   - `OnePhotonSeries` in `acquisition`: frames streamed with a
     `DataChunkIterator` (a 10 GB donation never sits in memory), native
     `uint8` / `uint16`, HDF5 chunks of 16 whole frames (~6 MB for 600x600
     8-bit), gzip level 4, `rate` = fps;
     `timestamps.csv` stays with the donation on solaris. This chunk shape is what Part B streams.
3. Check: read every frame back and compare with the CALARAW source (bit
   identical), then `nwbinspector` (no critical issues) and `dandi validate`.
4. Right before uploading, ask the edge function (`ingest_published` with
   `dry_run`) to re-check the live row, so a donation switched to CaLab only
   after ingest is never uploaded. Then `dandi upload` into the collection's
   draft (the API key in `ingest.env`: `DANDI_API_KEY` for the archive,
   `DANDI_SANDBOX_API_KEY` for the sandbox) and call `ingest_published` with the path.

Known limit: `dandi validate` may reject recordings with fewer frames than the
frame width (nwbinspector's data-orientation heuristic; the script ignores that
one check because frames are always written time-first), so very short
recordings (under ~30 s at 20 fps for 600 px frames) may need a manual look.

Size: plain gzip in HDF5 compresses ~1.44x on V4 (no up predictor; see
"Codec"), so a NWB file is ~15% larger than its CALARAW chunks. DANDI has no
per-file limit that matters here.

The lab publishes a version of the collection from the DANDI web page when
enough new recordings are in the draft (e.g. monthly). Each published version
gets a DOI. The pilot adds each new donor and lab to the collection's
contributors by hand on the DANDI page (role "Data Collector", included in the
citation); automating that is later work.

## Browse page in cala

"Browse donated recordings" link on cala's start page, next to "My
donations", opens a list, no sign-in needed:

- Reads `cala_donations_public` with the donation project's anon key.
- Resolves each `dandi_path` to its asset in the collection's most recent
  published version (DANDI REST API, public, CORS open), falling back to the
  draft for files not yet in a version.
- One row per recording: indicator, species, region, scope, size, frames and
  fps, contributing lab. Filters by species, indicator and region.
- Per row: **Download** (DANDI asset download URL), **View** (Neurosift in a
  new tab), **Copy acknowledgement** (below). Part B adds **Open in cala**.
- A "How to cite" box with the collection's citation and DOI, taken from the
  DANDI version metadata.

## Citation and acknowledgement

- The DANDI collection description and the browse page state: anyone who uses
  the data cites the collection (DOI of the version used) and acknowledges the
  contributing labs.
- **Copy acknowledgement** gives a ready sentence per recording, e.g. "Data
  were contributed by Jane Doe (Doe Lab) to the CaLab donated recordings
  collection (DANDI:00XXXX, doi:10.48324/dandi.00XXXX/…)."
- CC BY 4.0 makes attribution a licence condition; the acknowledgement
  sentence is the norm we ask for on top, as other open datasets do.
- Our own papers acknowledge every donor lab whose data they use, public or
  CaLab only, logged per donation (`in_benchmark` / `benchmark_note`).
- No separate contact opt-in: signing in with an email already lets the team
  reach the sharer. The form always sends `contact_ok: true` (column kept for
  old rows). At ingest the edge function adds the sharer's sign-in email
  (`contact_email`, Auth admin API) to `ingest_list`, and the lab server keeps
  it in `contact.json` (mode 0400) next to the recording, never in
  `donation.json`, the NWB file or the notification email.

## Consent, deletion and policy

- Checkboxes (both required, unchanged): the donor has the right to share the
  data, and it was recorded under an approved animal protocol.
- The sharing choice (above), with its text, right next to the Donate button.
- Deletion:
  - Withdraw in the app until ingested.
  - After that, people contact the CaLab team (plain text in the panel, no
    link, no personal email in the app): a
    CaLab-only donation is deleted from the lab server; a public one is
    removed from the DANDI draft and the lab server, which takes it out of
    every later version.
  - A published DANDI version cannot be changed; the panel says so.
- UCLA IT / data policy: holding other labs' data on solaris still needs an OK
  (now mostly for CaLab-only donations; public ones also live on DANDI).

## What a donation contains (unchanged)

All objects go under `pending/<donation_id>/` in the R2 bucket.

| File                                   | Format             | Purpose                                             |
| -------------------------------------- | ------------------ | --------------------------------------------------- |
| `frames-0000.calaraw.gz`, `-0001`, ... | `CALARAW1` + gzip  | Every frame as decoded, native bit depth            |
| `timestamps.csv`                       | CSV, optional      | Frame timestamps if the recording has them          |
| `meta.json`                            | JSON (also in row) | Metadata, cala version, source file list (no paths) |

`CALARAW1`: each chunk file is a plain gzip of a 40-byte header (magic, width,
height, first frame, frames in chunk, frames in recording, bytes per pixel,
predictor, fps) and ~64 MB of whole frames; byte layout in
`packages/io/src/calaraw.ts`, Python reader `python/src/calab/_calaraw.py`,
cross-language fixtures in `packages/io/src/__fixtures__/`. One canonical
stream means one format to validate, no untrusted AVI/TIFF parsing on the lab
side, and frames exactly as cala decoded them. NWB is written on the lab side,
from verified CALARAW, never in the browser.

## Codec (measured 2026-11-19, unchanged)

| Codec                            | V4    | Wireless |
| -------------------------------- | ----- | -------- |
| gzip                             | 1.44× | 1.72×    |
| **up predictor + gzip** (chosen) | 1.65× | 1.81×    |
| best predictor + zstd -3         | 1.84× | 1.91×    |
| FFV1 (one 360 MB V4 segment)     | 2.0×  |          |

Up predictor plus the browser's `CompressionStream('gzip')`: within ~10% of
zstd, no WASM codec. ~260 MB per recorded minute of V4. Re-run with
`apps/cala/scripts/donation-codec-bench.mjs`.

## Caps and cost

- Per donation ≤ 10 GB compressed, per user ≤ 2 donations not yet ingested,
  global cap on bytes in the bucket (`DONATION_GLOBAL_CAP_BYTES`).
- R2 is transit only (deleted after ingest), so it stays within the 10 GB-month
  free tier in normal use; egress is free.
- DANDI hosting is free (AWS Open Data). Its guaranteed retention is tied to
  its NIH award (currently to 2029); the solaris copy is our backup.
- Real long-term cost: solaris disk, ~3 TB per year at 50 donations/month
  (20-min V4 sessions), plus the NWB copies while they are being made.

## Security

| Risk                                 | Mitigation                                                                                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anyone uploads anything              | Real sign-in required; anonymous sessions rejected.                                                                                                         |
| Huge uploads / cost                  | Caps checked before presigning; signed content length per PUT; global bucket cap.                                                                           |
| Arbitrary files                      | Only chunk, timestamp and meta names; finish checks sizes and the gzip + `CALARAW1` magic.                                                                  |
| Malicious bytes on the lab server    | Pull only `approved/`; strict CALARAW and sidecar parsing; read-only storage; `.rejected/` quarantine.                                                      |
| Non-imaging content                  | Admin preview (mean image, frames) before approval.                                                                                                         |
| CaLab-only data published by mistake | `sharing` checked by the edge function, the conversion script and the public view; the script also asks the edge function (dry run) right before uploading. |
| Personal data in public metadata     | Public view lists only recording metadata and the donor-chosen credit; no email, user id, notes or file names.                                              |
| Lab server exposure                  | Outbound only; holds the ingest token and the DANDI key, nothing else.                                                                                      |
| Leaked keys                          | R2 keys only in edge function secrets; DANDI key only in `ingest.env` (chmod 600) on solaris.                                                               |

## Testing

- Edge function (Deno): `create` with and without each new field and invalid
  values; `sharing`/`license` agreement; `ingest_published` refuses `lab`,
  wrong status, bad paths, and needs the ingest token.
- RLS (PGlite): anon sees only published public rows and only the view's
  columns; the base table stays owner/admin only; existing rows migrate.
- cala: the Donate button stays disabled without a sharing choice; age writes
  an ISO duration; "My donations" shows the DANDI link; browse page against a
  mocked view and mocked DANDI API.
- Python: `donation_to_nwb.py` on the CALARAW fixtures writes NWB whose frames
  read back bit identical, with the expected chunks and metadata, passing
  `nwbinspector`; refuses a `lab` donation and an unknown species.
- End to end: a synthetic V4 recording donated as public, through ingest and
  conversion, uploaded to the DANDI **sandbox** (`sandbox.dandiarchive.org`),
  visible on the browse page with working Download and View links.

## Phases

1. **Done (before public sharing):** format, edge function, migration 020, panel, admin
   view, solaris ingest, end-to-end run.
2. **Part A** (this spec): sharing choice, new fields, migration 021, edge
   function, panel and admin text, conversion script, browse page, tests,
   sandbox run.
3. **Release:** merge PR #452, tag.
4. **Pilot** with 2–3 known labs before announcing it.
5. **Part B:** open DANDI recordings in cala.

## To go live (needs people, not code)

Done on the test setup (2026-11-20): Supabase project `Cala` (donations
only), R2 bucket `calab-donations` with CORS and lifecycle rules, Gmail SMTP
for sign-in, Resend notification email, solaris ingest (`~/calab-ingest`,
hourly systemd user timer into `/mnt/data_1/mbrosch/calab_donations`), live
build defaults in `deploy.yml`.

Done 2026-11-24: sandbox end-to-end run (dandiset 219290; public recording
published, CaLab-only one refused); real dandiset **002097** "CaLab shared
recordings" (CC BY 4.0); `DANDI_API_KEY` and `DANDI_SANDBOX_API_KEY` in
`~/calab-ingest/ingest.env`; repository variables `DONATION_DANDISET=002097`
and `DONATION_DANDI_INSTANCE=dandi` (live since the v2.22.2 deploy).

Sandbox tests share the live donation database: a recording published to the
sandbox shows on the live browse page (without links). Afterwards, set it to
`withdrawn` in the SQL editor (`update public.cala_donations set status =
'withdrawn', review_note = 'sandbox test' where id = '<id>';`).

Still open:

1. **UCLA IT / data policy:** OK to hold other labs' data on solaris.
2. **Pilot** with 2–3 known labs before announcing it.

## Open questions

- Minimum recording length / quality to accept.
- How often to publish a DANDI version (monthly, or per N recordings).
- Whether CaDecon / CaTune donations go into one collection per app or one
  per data type.
