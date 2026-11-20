# Data donation (design, not built)

A **Donate data** button in browser cala lets users send a raw recording to the
lab, compressed without loss, with metadata. The goal is more varied datasets
(regions, indicators, scopes, settings) to benchmark and improve cala on.

Status: proposal. Nothing below exists yet except what the "Builds on" list
names.

## Why people donate

1. **cala gets better on their kind of data.** Every donation goes into the
   cala benchmark set, and the pipeline is developed and tuned against it. A
   lab with an unusual region, indicator or scope makes sure cala works for that
   setup.
2. **Co-authorship.** If a dataset is used in a benchmark / dataset paper, its
   donors are offered co-authorship.

The donate panel states both, and donors can see in the app whether their
donation is in the benchmark set.

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

Measured on `real_v4/v4_dataverse_20min` (UCLA V4, 600×600, 8-bit), one
360 MB AVI segment:

| Encoding      | Size   | Ratio |
| ------------- | ------ | ----- |
| raw AVI       | 360 MB | 1.0×  |
| zstd -19      | 215 MB | 1.7×  |
| FFV1 (ffmpeg) | 184 MB | 2.0×  |

So about 0.2 GB per minute of V4 recording: a 20-min V4 session is ~4.3 GB,
the 200×200 wireless session (40k frames) ~0.8 GB. Upload of 4 GB at 50 Mbit/s
is ~11 min. The browser uses zstd (WASM, streaming); FFV1 would need
ffmpeg.wasm and is too slow. The ratio at the zstd level the browser can afford
is still to be measured (phase 0).

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
        │ insert row ──────▶ cala_donations (pending)
        │ request upload ──▶ edge fn donation-upload
        │                    checks auth, quotas, caps
        │ ◀── presigned multipart URLs ──────────────────────
decode → CALARAW1 → zstd
        │ PUT parts ─────────────────────────────────────────▶ pending/<id>/
        │ finish ──────────▶ edge fn: sizes + magic check
        │                    status=uploaded
                             admin app: preview, approve ──────▶ move to approved/<id>/
                                                                        ◀── cron pull (outbound only)
                                                                            full parse in sandbox
                                                                            data/raw/donations/<id>/
                             status=ingested ◀──────────────── delete objects ◀──┘
```

Supabase holds only rows, auth and the edge function. Files never touch
Supabase Storage (free plan: 1 GB, 50 MB per file, 5 GB/month egress, too
small). The lab server only makes outbound requests; no credential that can
write to it exists outside it.

## What a donation contains

All objects go under `pending/<donation_id>/` in the R2 bucket.

| File             | Format             | Purpose                                             |
| ---------------- | ------------------ | --------------------------------------------------- |
| `frames.raw.zst` | `CALARAW1` + zstd  | Every frame as decoded, native bit depth            |
| `timestamps.csv` | CSV, optional      | Frame timestamps if the recording has them          |
| `meta.json`      | JSON (also in row) | Metadata, cala version, source file list (no paths) |

`CALARAW1` (new, deliberately trivial): magic, u32 width, height, frames, u8
bytes per pixel, f64 fps, then frames row-major little-endian. One canonical
stream instead of the original AVI/TIFF files means:

- one format to validate, no untrusted AVI/TIFF parsing on the lab side;
- any input cala can open becomes a donation the same way;
- the frames are exactly what cala decoded, so a decoding bug shows up as a
  mismatch with the source file list rather than silently.

zstd runs in independent frames of ~64 MB so that upload parts, resume and
the admin preview do not need the whole file.

## Metadata (table `cala_donations`)

New migration (next free number, `019_...`), following the base template.

- `id`, `user_id`, `created_at`, `status`
  (`pending` → `uploaded` → `approved` | `rejected` → `ingested`)
- Biology: `indicator`, `species`, `brain_region`, `expression` (virus /
  transgenic), `preparation` (GRIN / window / ...), `behavior` (short)
- Optics: `scope` (e.g. UCLA v4, Inscopix, own wireless), `fps`, `width`,
  `height`, `n_frames`, `bytes_per_pixel`, `depth_um`, `led_power` (optional)
- Provenance: `cala_version`, `dataset_hash`
- Files: `declared_bytes`, `n_parts`
- Consent: `license` (`cc-by-4.0` | `lab-use-only`), `rights_attested`,
  `protocol_attested` (both must be true), `contact_ok` (may we contact them
  about co-authorship)
- Credit: `credit_name`, `credit_lab` (shown in the benchmark list), set by the
  donor
- Benchmark: `in_benchmark` (bool, admin), `benchmark_note` (admin)
- `notes` (length-capped)

RLS: insert only by non-anonymous users for their own `user_id` (as in 012);
select by owner and admin; status and benchmark fields by admin and the edge
function only. CHECKs on every column (as in 014).

## Caps and cost

Initial caps:

- per donation ≤ 10 GB compressed (a ~45 min V4 session),
- per user ≤ 2 donations not yet ingested,
- **global ≤ 200 GB** in the bucket; the edge function refuses new uploads
  above it. This alone bounds the R2 bill.

R2 (checked 2026-11-19): 10 GB-month free, then $0.015 per GB-month; egress
free; 1M writes/month free.

| Scenario                                   | R2 cost        |
| ------------------------------------------ | -------------- |
| 50 donations/month, ~3 days in bucket each | ~$0.20 / month |
| Bucket at the 200 GB global cap all month  | ~$2.85 / month |
| Keep everything in the cloud instead, 1 TB | ~$15 / month   |

Supabase stays on the free plan (rows, auth, edge function calls). The real
long-term cost is lab-server disk: ~2.5 TB per year at 50 donations/month.

Fallbacks: Supabase Pro ($25/month, 100 GB storage, 250 GB egress, then
$0.09/GB) if one vendor matters more than cost; Backblaze B2 ($6.95/TB-month)
is equivalent to R2.

## Security

| Risk                                    | Mitigation                                                                                                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anyone uploads anything                 | Real sign-in required; anonymous sessions rejected (012 pattern).                                                                                              |
| Huge uploads / cost                     | Edge function checks caps before presigning; presigned parts carry a signed content length; global bucket cap.                                                 |
| Arbitrary files                         | Only the three object names; finish step checks sizes against `declared_bytes` and the zstd + `CALARAW1` magic.                                                |
| Malicious bytes reaching the lab server | Pull only `approved/`; decompress and parse `CALARAW1` (bounds-checked, size must equal header) in a container without network. Nothing else is opened or run. |
| Non-imaging content                     | Admin preview decodes the first zstd frame and shows the mean image and a few frames before approval.                                                          |
| Lab server exposure                     | Outbound pull only; the ingest key can read and delete `approved/` and nothing else.                                                                           |
| Leaked personal info                    | No paths uploaded, only base file names (strippable); email stays in auth, never in public views.                                                              |
| Spam / flooding                         | Per-user limit, global cap, admin can disable the edge function.                                                                                               |
| Leaked R2 key                           | R2 keys live only in edge function secrets and on the lab server; the browser only ever sees presigned URLs.                                                   |

## Consent and policy

- Checkbox text: the uploader has the right to share the data, the recordings
  were made under an approved animal protocol, and they accept the chosen
  license.
- Panel text states what happens: the data goes into the cala benchmark set;
  if it is used in a benchmark / dataset paper, donors who ticked `contact_ok`
  are offered co-authorship.
- Default license CC-BY 4.0; `lab-use-only` for people who will not share
  publicly (usable for development, not for a public benchmark release).
- Withdrawal: delete in the app until ingested; after that by email, and the
  lab deletes `data/raw/donations/<id>/`.
- Before launch: check with UCLA IT / research data policy about holding other
  labs' data on the lab server.

## Phases

0. **Measure.** zstd WASM in the browser on the V4 and wireless sessions:
   ratio and MB/s per level; pick the level.
1. **Format.** `CALARAW1` writer (browser) and reader (Rust, used by ingest),
   with round-trip tests.
2. **Backend.** R2 bucket, migration `019_cala_donations.sql`, edge function
   `donation-upload` (caps, presign multipart, finish check), RLS tests in
   `supabase/tests/rls`.
3. **UI.** Donate panel in cala: why-donate text, metadata form (field
   options), consent, resumable upload with progress; "my donations" list with
   status and `in_benchmark`.
4. **Moderation.** Donations view in `apps/admin`: preview, approve/reject,
   benchmark flag.
5. **Ingest.** Lab-server cron: pull approved, verify in sandbox, write
   `data/raw/donations/<id>/` read-only, mark `ingested`, delete objects.
6. **Pilot** with 2–3 known labs before announcing it.

## Open questions

- Co-authorship criteria: which papers, what counts as "used", who decides.
- Minimum recording length / quality to accept into the benchmark.
- Publish CC-BY donations on DANDI (free hosting, DOI per dataset) for the
  benchmark release?
- Public listing of donations (metadata and credit only) or private to the lab?
