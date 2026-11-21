# Data donation (design, not built)

A **Donate data** button in browser cala lets users send a raw recording to the
lab, compressed without loss, with metadata. The goal is more varied datasets
(regions, indicators, scopes, settings) to benchmark and improve cala on.

Status: code for phases 0–5 is written and tested locally (format, edge
function, migration, cala panel, admin view, ingest script). Nothing is
deployed; see "To go live" for what needs accounts and people.

## Why people donate

1. **cala gets better on their kind of data.** Every donation goes into the
   cala benchmark set, and the pipeline is developed and tuned against it. A
   lab with an unusual region, indicator or scope makes sure cala works for that
   setup.
2. **Co-authorship.** If a dataset is used in a benchmark / dataset paper, its
   donors are offered co-authorship. Every use of a donation is verified and
   logged against it (admin `in_benchmark` / `benchmark_note` for now).
3. **Credit and control.** Data stays within the lab under CC BY 4.0 (any use
   credits the donor and their lab); deletion on request at any time.

The panel (bottom of the Run tab, visible without clicking) states all three,
that a single raw recording is enough (no processing), and the 10 GB cap
(after compression, ~40 min of 600x600 V4). Donors see in the app whether their
donation is in the benchmark set ("My donations" in the panel, and on cala's start
page without opening a recording; withdrawn ones are hidden behind a toggle).
Uploads left unfinished for 48 h are withdrawn automatically
(`DONATION_STALE_HOURS`), so they stop holding the donor's slot.

## Goals and non-goals

Goals

- One click from an opened recording to a submitted dataset.
- Raw frames, lossless: noise, motion and artifacts stay as recorded, and any
  pipeline (cala, Minian, CaImAn, future versions) can run on them.
- The lab server is never reachable from the internet.
- Every dataset has the metadata needed to use it and a clear license.
- Cloud cost bounded by design, not by hope.

Non-goals

- Public data browsing or redistribution (maybe later via DANDI, separate
  decision).
- Archival storage in the cloud: the bucket is transit only.

## Raw, not factors

An earlier version of this design uploaded cala's low-rank factors
(`CALAFAC1`). Dropped because:

- the compression keeps only temporally non-white components, so the white
  noise that the in-focus selection and the frame-matched null depend on is
  gone;
- the factors are of preprocessed frames, so motion correction and
  preprocessing could not be developed on donations;
- `CALAFAC1` is a prototype format; donations must stay readable when it
  changes.

## Codec (phase 0, measured 2026-11-19)

Lossless compression of miniscope video is bounded by the sensor noise: every
codec tried lands at 1.4–2.0×. Measured on 300 frames of
`real_v4/v4_dataverse_20min` (UCLA V4, 600×600, 8-bit) and 2000 frames of
`real_wireless/wl24_20251201` (200×200, 8-bit):

| Codec                            | V4    | Wireless |
| -------------------------------- | ----- | -------- |
| gzip                             | 1.44× | 1.72×    |
| **up predictor + gzip** (chosen) | 1.65× | 1.81×    |
| best predictor + zstd -3         | 1.84× | 1.91×    |
| zstd -19 (one 360 MB V4 segment) | 1.7×  |          |
| FFV1 (one 360 MB V4 segment)     | 2.0×  |          |

Chosen: the "up" predictor (each pixel minus the one above) and the browser's
own `CompressionStream('gzip')`. It is within ~10% of zstd, needs no WASM
codec or new dependency (Chrome has no zstd `CompressionStream`), and Chrome's
gzip compresses ~5% smaller than Node's, so the numbers above (Node) are a
lower bound. FFV1 would need ffmpeg.wasm.

At 1.65×: ~260 MB per recorded minute of V4, so a 20-min V4 session is
~5.2 GB; the 33-min wireless session is ~0.9 GB. Encoding runs at ~25–30
MB/s on one thread (Node), far above an upload link (50 Mbit/s ≈ 6 MB/s:
~15 min for 5 GB). Re-run with `apps/cala/scripts/donation-codec-bench.mjs`.

## Builds on

| Piece                         | Where                                                          |
| ----------------------------- | -------------------------------------------------------------- |
| Supabase auth, magic link     | `packages/community/src/auth.ts`                               |
| Non-anonymous insert pattern  | `supabase/migrations/012_block_anonymous_submissions.sql`      |
| Payload CHECKs                | `supabase/migrations/014_validate_submission_payloads.sql`     |
| PII-free public views         | `supabase/migrations/010_restrict_submission_pii.sql`          |
| Admin role and moderation app | `004_admin_role.sql`, `apps/admin`                             |
| Field options (indicator ...) | `packages/community/src/field-options*.ts`                     |
| Dataset fingerprint           | `packages/community/src/dataset-hash.ts`                       |
| Frame decoding (AVI, TIFF)    | cala's file import (`apps/cala/src/components/OpenFolder.tsx`) |

## Data flow

```text
browser cala                Supabase (free plan)            Cloudflare R2           lab server
────────────                ────────────────────            ─────────────           ──────────
metadata form + consent
decode → CALARAW1 → gzip → OPFS (exact sizes known)
        │ create ──────────▶ edge fn `donation`: auth, caps,
        │                    row in cala_donations (uploading)
        │ upload_url ──────▶ presigned PUT per file (1 h)
        │ PUT chunks ────────────────────────────────────────▶ pending/<id>/
        │ finish ──────────▶ edge fn: sizes + magic check
        │                    status=uploaded
                             admin app: preview, approve ──────▶ move to approved/<id>/
                             ingest_list / ingest_download_url ◀── cron pull (outbound only, ingest token)
                                                                            full parse in sandbox
                                                                            data/raw/donations/<id>/
                             ingest_done: delete objects, status=ingested ◀──┘
```

Supabase holds only rows, auth and the edge function. Files never touch
Supabase Storage (free plan: 1 GB, 50 MB per file, 5 GB/month egress, too
small). The lab server only makes outbound requests and holds only the ingest
token (no R2 keys, no Supabase service key); it downloads through presigned
URLs the edge function hands out.

### Edge function API (`supabase/functions/donation`)

POST `{action, ...}`. Client: `packages/community/src/donation-service.ts`.

| Action                | Who                | Does                                                     |
| --------------------- | ------------------ | -------------------------------------------------------- |
| `create`              | signed-in donor    | checks meta, file names, caps; row `uploading`           |
| `upload_url`          | owner, uploading   | presigned PUT for one declared file                      |
| `finish`              | owner, uploading   | exact sizes + every chunk's CALARAW1 header → `uploaded` |
| `withdraw`            | owner, not final   | delete files → `withdrawn`                               |
| `preview_url`         | admin              | presigned GET of one file (first chunk by default)       |
| `review`              | admin, uploaded    | approve (move to `approved/`) or reject (delete)         |
| `ingest_list`         | lab (ingest token) | approved rows                                            |
| `ingest_download_url` | lab                | presigned GET from `approved/`                           |
| `ingest_done`         | lab                | delete files → `ingested`                                |

Errors: 401/403 auth, 404 not found / not owner, 409 wrong status, 413 size
cap, 422 failed check, 429 per-user limit, 507 global cap.

## What a donation contains

All objects go under `pending/<donation_id>/` in the R2 bucket.

| File                                   | Format             | Purpose                                             |
| -------------------------------------- | ------------------ | --------------------------------------------------- |
| `frames-0000.calaraw.gz`, `-0001`, ... | `CALARAW1` + gzip  | Every frame as decoded, native bit depth            |
| `timestamps.csv`                       | CSV, optional      | Frame timestamps if the recording has them          |
| `meta.json`                            | JSON (also in row) | Metadata, cala version, source file list (no paths) |

`CALARAW1` (built, phase 1): each chunk file is a plain gzip of a 40-byte
header (magic, width, height, first frame, frames in chunk, frames in
recording, bytes per pixel, predictor, fps) and ~64 MB of whole frames. The
byte layout is documented in `packages/io/src/calaraw.ts`. One canonical
stream instead of the original AVI/TIFF files means:

- one format to validate, no untrusted AVI/TIFF parsing on the lab side;
- any input cala can open becomes a donation the same way;
- the frames are exactly what cala decoded.

Self-describing chunk files rather than one multipart object: each chunk
uploads, resumes, is checked and can be previewed on its own, with a plain PUT
(no multipart) and a signed content length per file. A 20-min V4 session is
~130 chunks.

Code: writer and decoder `packages/io/src/calaraw.ts` (browser, tests in
`packages/io/src/__tests__/calaraw.test.ts`); lab reader
`calab.read_calaraw` / `calab.iter_calaraw` (`python/src/calab/_calaraw.py`).
`python/tests/test_calaraw.py` decodes fixtures written by the browser encoder
(`packages/io/src/__fixtures__/gen-calaraw-fixtures.ts`). Both decoders reject
bad headers, payloads that are not exactly the declared frames, trailing data
and declared sizes above a cap, and inflate no further than the declared size.

## Metadata (table `cala_donations`)

`supabase/migrations/019_cala_donations.sql`.

- `id`, `user_id`, `created_at`, `updated_at`, `status` (`uploading` →
  `uploaded` → `approved` | `rejected` → `ingested`; `withdrawn` by the donor)
- Biology: `indicator`, `species`, `brain_region`, `expression` (virus /
  transgenic), `preparation` (GRIN / window / ...), `behavior` (short)
- Optics: `scope` (e.g. UCLA v4, Inscopix, own wireless), `fps`, `width`,
  `height`, `n_frames`, `bytes_per_pixel`, `depth_um`, `led_power` (optional)
- Provenance: `cala_version`, `dataset_hash`
- Files: `declared_bytes`, `n_chunks`, `files` (name + exact bytes)
- Consent: `license` (`cc-by-4.0` | `lab-use-only`), `rights_attested`,
  `protocol_attested` (both must be true), `contact_ok` (may we contact them
  about co-authorship)
- Credit: `credit_name`, `credit_lab` (shown in the benchmark list), set by the
  donor
- Benchmark: `in_benchmark` (bool, admin), `benchmark_note` (admin)
- `review_note` (admin), `notes` (length-capped)

RLS: select by owner and admin. No client inserts or deletes; every write goes
through the edge function (service role). Admins may update only
`in_benchmark` / `benchmark_note` (column grant). CHECKs on every column (as
in 014).

## Caps and cost

Initial caps:

- per donation ≤ 10 GB compressed (a ~38 min V4 session),
- per user ≤ 2 donations not yet ingested,
- **global ≤ 200 GB** in the bucket; the edge function refuses new uploads
  above it. This alone bounds the R2 bill.

R2 (checked 2026-11-19): 10 GB-month free, then $0.015 per GB-month; egress
free; 1M writes/month free.

| Scenario                                   | R2 cost        |
| ------------------------------------------ | -------------- |
| 50 donations/month, ~3 days in bucket each | ~$0.25 / month |
| Bucket at the 200 GB global cap all month  | ~$2.85 / month |
| Keep everything in the cloud instead, 1 TB | ~$15 / month   |

Supabase stays on the free plan (rows, auth, edge function calls). The real
long-term cost is lab-server disk: ~3 TB per year at 50 donations/month
(20-min V4 sessions).

Fallbacks: Supabase Pro ($25/month, 100 GB storage, 250 GB egress, then
$0.09/GB) if one vendor matters more than cost; Backblaze B2 ($6.95/TB-month)
is equivalent to R2.

## Security

| Risk                                    | Mitigation                                                                                                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anyone uploads anything                 | Real sign-in required; anonymous sessions rejected (012 pattern).                                                                                              |
| Huge uploads / cost                     | Edge function checks caps before presigning; each presigned PUT carries a signed content length; global bucket cap.                                            |
| Arbitrary files                         | Only the chunk, timestamp and meta names; finish step checks sizes against `declared_bytes` and the gzip + `CALARAW1` magic.                                   |
| Malicious bytes reaching the lab server | Pull only `approved/`; decompress and parse `CALARAW1` (bounds-checked, size must equal header) in a container without network. Nothing else is opened or run. |
| Non-imaging content                     | Admin preview decodes the first chunk and shows the mean image and a few frames before approval.                                                               |
| Lab server exposure                     | Outbound pull only; the lab holds only the ingest token, which can list, download and close approved donations and nothing else.                               |
| Leaked personal info                    | No paths uploaded, only base file names (strippable); email stays in auth, never in public views.                                                              |
| Spam / flooding                         | Per-user limit, global cap, admin can disable the edge function.                                                                                               |
| Leaked R2 key                           | R2 keys live only in edge function secrets; the browser and the lab server only ever see presigned URLs.                                                       |

## Consent and policy

- Checkbox text: the uploader has the right to share the data and agrees to
  CC BY 4.0, and the recordings were made under an approved animal protocol.
- License: always CC BY 4.0 (the UI offers no other choice; the table still
  accepts `lab-use-only`). The data is kept within the lab; attribution is
  the donor's name and lab, both required (form and edge function).
- Co-authorship: offered whenever a donation is used in a benchmark / dataset
  paper; uses are logged per donation.
- Deletion at any time: withdraw in the app until ingested; after that on
  request to the CaLab team, and the lab deletes `data/raw/donations/<id>/`.
  Requests go to the address(es) in `DELETION_CONTACTS` (`DonatePanel.tsx`).
- Before launch: check with UCLA IT / research data policy about holding other
  labs' data on the lab server.

## Phases

0. **Measure.** Done: up predictor + native gzip (see Codec).
1. **Format.** Done: `CALARAW1` writer/decoder (TypeScript) and reader
   (Python), with round-trip and cross-language tests.
2. **Backend.** Code done: migration `019_cala_donations.sql`, edge function
   `supabase/functions/donation` (Deno tests), RLS tests. Not deployed.
3. **UI.** Code done: Donate panel at the bottom of cala's Recording tab
   (`DonatePanel.tsx`, `donation-runner.ts`, `donation-worker.ts`), encode to
   OPFS then upload with retries and resume; "My donations" list.
4. **Moderation.** Code done: Donations view in `apps/admin` with preview,
   approve/reject and benchmark flag.
5. **Ingest.** Code done: `python/scripts/ingest_donations.py` (cron; setup in
   its docstring).
6. **Deploy.** See "To go live".
7. **Pilot** with 2–3 known labs before announcing it.

## To go live (needs people, not code)

Done on the test setup (2026-11-20, Marcel's own Supabase project `Cala` and
R2 bucket `calab-donations`): migration (cala-only), edge function with
secrets, bucket CORS and lifecycle rules, Resend notification email, solaris
ingest (`~/calab-ingest`, hourly systemd user timer with linger, into
`/mnt/data_1/mbrosch/calab_donations`). One donation ran end to end: upload,
preview, approve, ingest; the stored frames are bit-identical to the AVI. R2
verified: a PUT with a different length than signed is refused (403), CORS,
Range GET and copy work.

Still open:

1. **Sign-in email for any donor:** done for now: Supabase sends through
   Gmail SMTP (`marcelbrosch.mb@gmail.com`, app password; ~500 mails/day),
   email rate limit raised. Later: a verified lab domain (Resend) for a more
   official sender; only the SMTP settings change.
2. **Live build:** add repo secrets `DONATION_SUPABASE_URL` and
   `DONATION_SUPABASE_ANON_KEY` (repo admin, i.e. Daniel); `deploy.yml`
   passes them as `VITE_DONATION_SUPABASE_*`. Donations then use Marcel's
   project, everything else stays on Daniel's.
3. **UCLA IT / data policy:** OK to hold other labs' data on the lab server.
4. Decide the open questions below (co-authorship criteria at least).
5. Merge, then tag the release (`v2.21.0`).

## Open questions

- Co-authorship criteria: which papers, what counts as "used", who decides.
- Minimum recording length / quality to accept into the benchmark.
- Publish CC-BY donations on DANDI (free hosting, DOI per dataset) for the
  benchmark release?
- Public listing of donations (metadata and credit only) or private to the lab?
