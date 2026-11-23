# Public DANDI sharing for donations (Part A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Donors choose "Public on DANDI" or "CaLab only"; public donations
are converted to NWB on the lab server, uploaded to one shared DANDI
collection and listed on a browse page in cala.

**Architecture:** The built pipeline (browser → R2 → admin review → solaris
ingest) stays. Migration 021 adds the sharing choice, the subject fields DANDI
needs, a `published` status and a public view. The `donation` edge function
validates the new fields and gets an `ingest_published` action. A new Python
script on solaris writes NWB, validates it, uploads it with the `dandi` CLI and
marks the row published. cala gets the new form, texts and a browse page that
joins the public view with the DANDI REST API.

**Tech Stack:** SolidJS + Vite (cala, admin), Supabase Postgres + Deno edge
function, Cloudflare R2, Python 3.11+ (`numpy`, `pynwb`, `hdmf`,
`nwbinspector`, `dandi` CLI), vitest, Deno test, pytest, Postgres RLS test
script.

**Spec:** `apps/cala/docs/data-donation.md` (Part A). Part B
(`apps/cala/docs/open-from-dandi.md`) is out of scope here.

## Global Constraints

- Branch: `feature/data-donation` (PR #452). Commit messages: one sentence, no
  body, no Claude/Anthropic attribution or `Co-Authored-By` trailer (user's
  CLAUDE.md overrides any harness default).
- `sharing` values: `public` | `lab`. `license` values: `cc-by-4.0` |
  `lab-use-only`. New rows: `license` is derived (`public` → `cc-by-4.0`,
  `lab` → `lab-use-only`); the client no longer sends `license`.
- `subject_id`: `^[A-Za-z0-9-]{1,64}$`. `subject_sex`: `M` | `F` | `U` | `O`.
  `subject_age`: ISO 8601 duration `^P(?=\d)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?$`, at
  most 16 characters. `session_date`: `YYYY-MM-DD`, not before `1990-01-01`,
  not more than one day after "now" (UTC). `genotype`: optional, ≤ 128.
- `dandi_path`: `^sub-[A-Za-z0-9-]+/[A-Za-z0-9_.+-]+\.nwb$`, ≤ 256.
- NWB file path: `sub-<lab-slug>-<subject_id>/sub-<lab-slug>-<subject_id>_ses-<YYYYMMDD>-<id8>_ophys.nwb`.
- NWB `OnePhotonSeries`: HDF5 chunks of `min(16, n_frames)` whole frames, gzip
  level 4, native `uint8` / `uint16`, `rate` = fps.
- Migrations 020 and 021 go **only** on the donation Supabase project
  (Marcel's `Cala`), never on Daniel's main project. Do **not** add donation
  keys to `schema_fingerprint()` (019) or `apps/admin/src/lib/fingerprint.ts`:
  that panel checks Daniel's project, which has no donation tables.
- CaLab-only data never reaches DANDI: edge function, conversion script and
  public view each check `sharing` independently.
- Python: `uv` venv, type hints, `ruff format` and `ruff check --fix` before
  done. Raw donation folders on solaris are read-only; NWB goes to a separate
  work folder.
- Donor-facing texts (sharing choice), verbatim:
  - Public: "After review, your recording is published in the CaLab donated
    recordings collection on DANDI, where anyone can download it, e.g. to test
    and improve their pipelines. You and your lab are listed as contributors
    on its citable DOI. You can withdraw it until the next version of the
    collection is published; published versions are permanent."
  - CaLab only: "Only the CaLab team uses your recording, to develop and
    benchmark cala. The raw data is never shared; results computed from it may
    appear in papers, which acknowledge your lab. You can have it deleted at
    any time, or ask us to make it public later."

## Review Focus

1. A donor east of UTC picks today's date as the session date: it must be
   accepted (one day of slack). Test in Task 2.
2. A lab name with accents, commas or only punctuation ("Müller Lab, UCLA",
   "!!!") must still give a valid DANDI path. Test in Task 8.
3. A recording with fewer than 16 frames, or a frame count that is not a
   multiple of 16, converts with chunk shape `min(16, n)` and reads back bit
   identical. Test in Task 8.
4. The browse page when DANDI is unreachable or no dandiset is configured:
   rows from the public view still list, without links, with a message. Test
   in Task 7.
5. Re-running the conversion for a donation that is already published must not
   fail or duplicate: an existing verified NWB is reused, and a 409 "already
   published" from `ingest_published` counts as done. Test in Task 8.

---

### Task 0: Bring `main` into the branch

**Files:**

- Modify: `docs/CHANGELOG.md` (the only conflict)

- [ ] **Step 1: Merge**

```bash
git fetch origin
git merge origin/main
```

Expected: `CONFLICT (content): Merge conflict in docs/CHANGELOG.md`; every
other file auto-merges.

- [ ] **Step 2: Resolve the changelog**

Keep both sides: main's new entries and this branch's "Donate data" entry,
under the same `## Unreleased` heading, each once. Remove the conflict markers.

- [ ] **Step 3: Check and commit**

```bash
npm run typecheck
git add docs/CHANGELOG.md
git commit --no-edit
```

Expected: typecheck exits 0. If it does not, fix only what the merge broke.

---

### Task 1: Migration 021 and RLS tests

**Files:**

- Create: `supabase/migrations/021_cala_donations_public.sql`
- Modify: `supabase/tests/rls/test.sql` (append before the final `RAISE NOTICE`)
- Modify: `supabase/README.md` (migration table: add the 021 row under 020)

**Interfaces:**

- Produces: columns `sharing`, `subject_id`, `subject_sex`, `subject_age`,
  `session_date`, `genotype`, `dandi_path`, `published_at` on
  `cala_donations`; status `published`; view `cala_donations_public` (columns
  listed in Step 3).

- [ ] **Step 1: Write the failing RLS tests**

Append to `supabase/tests/rls/test.sql`, before
`DO $$ BEGIN RAISE NOTICE 'ALL RLS ASSERTIONS PASSED'; END $$;`:

```sql
-- ── cala_donations public sharing (021) ──────────────────────────────────
-- Rows from the 020 block default to sharing = 'lab'. A public, published row
-- appears in cala_donations_public (anon may read it); nothing else does.

BEGIN;
SET LOCAL ROLE service_role;
INSERT INTO cala_donations (
  id, user_id, status, indicator, species, brain_region, scope, fps, width, height,
  n_frames, bytes_per_pixel, cala_version, license, rights_attested,
  protocol_attested, contact_ok, declared_bytes, n_chunks, files,
  sharing, subject_id, subject_sex, subject_age, session_date,
  credit_name, credit_lab, dandi_path, published_at
) VALUES
  ('d0000000-0000-0000-0000-00000000000c', '11111111-1111-1111-1111-111111111111',
   'published', 'GCaMP8m', 'mouse', 'M1', 'UCLA v4', 20, 600, 600, 1000, 1, 'test',
   'cc-by-4.0', true, true, true, 1000, 1,
   '[{"name":"frames-0000.calaraw.gz","bytes":1000}]',
   'public', 'm7', 'F', 'P90D', '2026-11-01',
   'A. Donor', 'Some Lab', 'sub-some-lab-m7/sub-some-lab-m7_ses-20261101-d0000000_ophys.nwb',
   '2026-11-20T00:00:00Z'),
  ('d0000000-0000-0000-0000-00000000000d', '11111111-1111-1111-1111-111111111111',
   'ingested', 'GCaMP8m', 'mouse', 'M1', 'UCLA v4', 20, 600, 600, 1000, 1, 'test',
   'lab-use-only', true, true, true, 1000, 1,
   '[{"name":"frames-0000.calaraw.gz","bytes":1000}]',
   'lab', 'm8', 'M', 'P12W', '2026-11-02',
   'A. Donor', 'Some Lab', NULL, NULL);
COMMIT;

BEGIN;
SET LOCAL ROLE anon;
SELECT assert_row_count(
  $sql$SELECT COUNT(*)::int FROM cala_donations_public$sql$, 1,
  'cala_donations_public anon sees exactly the published public row');
SELECT assert_row_count(
  $sql$SELECT COUNT(*)::int FROM cala_donations_public
      WHERE id = 'd0000000-0000-0000-0000-00000000000c' AND credit_lab = 'Some Lab'$sql$, 1,
  'cala_donations_public shows the credit of a public donation');
SELECT assert_row_count(
  $sql$SELECT COUNT(*)::int FROM cala_donations$sql$, 0,
  'cala_donations base table still hidden from anon');
SELECT assert_denied(
  $sql$SELECT user_id FROM cala_donations_public$sql$,
  'cala_donations_public has no user_id column', '42703');
SELECT assert_denied(
  $sql$SELECT notes FROM cala_donations_public$sql$,
  'cala_donations_public has no notes column', '42703');
SELECT assert_denied(
  $sql$DELETE FROM cala_donations_public$sql$,
  'cala_donations_public is read-only for anon');
ROLLBACK;

-- CHECKs of 021 (service role, the only writer).
BEGIN;
SET LOCAL ROLE service_role;
SELECT assert_denied(
  $sql$UPDATE cala_donations SET sharing = 'friends' WHERE id = 'd0000000-0000-0000-0000-00000000000d'$sql$,
  'cala_donations unknown sharing denied', '23514');
SELECT assert_denied(
  $sql$UPDATE cala_donations SET sharing = 'public' WHERE id = 'd0000000-0000-0000-0000-00000000000d'$sql$,
  'cala_donations public sharing with lab-use-only license denied', '23514');
SELECT assert_denied(
  $sql$UPDATE cala_donations SET subject_id = 'mouse 7' WHERE id = 'd0000000-0000-0000-0000-00000000000d'$sql$,
  'cala_donations subject_id with a space denied', '23514');
SELECT assert_denied(
  $sql$UPDATE cala_donations SET subject_sex = 'X' WHERE id = 'd0000000-0000-0000-0000-00000000000d'$sql$,
  'cala_donations subject_sex X denied', '23514');
SELECT assert_denied(
  $sql$UPDATE cala_donations SET subject_age = 'P' WHERE id = 'd0000000-0000-0000-0000-00000000000d'$sql$,
  'cala_donations empty age duration denied', '23514');
SELECT assert_denied(
  $sql$UPDATE cala_donations SET subject_age = '90 days' WHERE id = 'd0000000-0000-0000-0000-00000000000d'$sql$,
  'cala_donations non-ISO age denied', '23514');
SELECT assert_denied(
  $sql$UPDATE cala_donations SET session_date = '1989-12-31' WHERE id = 'd0000000-0000-0000-0000-00000000000d'$sql$,
  'cala_donations session_date before 1990 denied', '23514');
SELECT assert_denied(
  $sql$UPDATE cala_donations SET dandi_path = '../etc/passwd' WHERE id = 'd0000000-0000-0000-0000-00000000000c'$sql$,
  'cala_donations bad dandi_path denied', '23514');
SELECT assert_denied(
  $sql$UPDATE cala_donations SET status = 'published' WHERE id = 'd0000000-0000-0000-0000-00000000000d'$sql$,
  'cala_donations published lab row denied', '23514');
SELECT assert_denied(
  $sql$UPDATE cala_donations SET dandi_path = NULL WHERE id = 'd0000000-0000-0000-0000-00000000000c'$sql$,
  'cala_donations published row without dandi_path denied', '23514');
SELECT assert_allowed(
  $sql$UPDATE cala_donations SET subject_age = 'P1Y2M' WHERE id = 'd0000000-0000-0000-0000-00000000000d'$sql$,
  'cala_donations combined ISO age allowed');
ROLLBACK;
```

- [ ] **Step 2: Run them to see them fail**

Run: `./scripts/test-rls.sh` (needs Docker; CI runs the same script in the
`supabase` job).
Expected: FAIL at the first 021 insert: `column "sharing" of relation
"cala_donations" does not exist`.

- [ ] **Step 3: Write the migration**

`supabase/migrations/021_cala_donations_public.sql`:

```sql
-- Public sharing of donations on DANDI (apps/cala/docs/data-donation.md).
--
-- Donation project only (like 020); never applied to the main project, and not
-- part of schema_fingerprint() (019), which checks the main project.
--
-- Adds the donor's sharing choice (public on DANDI | CaLab only), the subject
-- fields DANDI needs, a `published` status set by the lab, and a PII-free
-- public view of published public donations for cala's browse page.
--
-- Existing rows become sharing = 'lab' with NULL subject fields: they were
-- donated under the lab-only text. The edge function requires the subject
-- fields for every new donation; the table requires them only on a published
-- row (published_complete), so old rows stay valid.
--
-- session_date "not in the future" is checked by the edge function (CHECKs
-- must be immutable); the table bounds it to 1990..2100.

BEGIN;

ALTER TABLE public.cala_donations
  ADD COLUMN IF NOT EXISTS sharing TEXT NOT NULL DEFAULT 'lab',
  ADD COLUMN IF NOT EXISTS subject_id TEXT,
  ADD COLUMN IF NOT EXISTS subject_sex TEXT,
  ADD COLUMN IF NOT EXISTS subject_age TEXT,
  ADD COLUMN IF NOT EXISTS session_date DATE,
  ADD COLUMN IF NOT EXISTS genotype TEXT,
  ADD COLUMN IF NOT EXISTS dandi_path TEXT,
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

ALTER TABLE public.cala_donations DROP CONSTRAINT IF EXISTS valid_status;
ALTER TABLE public.cala_donations ADD CONSTRAINT valid_status CHECK (
  status IN ('uploading', 'uploaded', 'approved', 'rejected', 'ingested', 'withdrawn', 'published')
);

ALTER TABLE public.cala_donations
  DROP CONSTRAINT IF EXISTS valid_sharing,
  DROP CONSTRAINT IF EXISTS valid_sharing_license,
  DROP CONSTRAINT IF EXISTS valid_subject_id,
  DROP CONSTRAINT IF EXISTS valid_subject_sex,
  DROP CONSTRAINT IF EXISTS valid_subject_age,
  DROP CONSTRAINT IF EXISTS valid_session_date,
  DROP CONSTRAINT IF EXISTS valid_genotype_len,
  DROP CONSTRAINT IF EXISTS valid_dandi_path,
  DROP CONSTRAINT IF EXISTS published_complete;

ALTER TABLE public.cala_donations
  ADD CONSTRAINT valid_sharing CHECK (sharing IN ('public', 'lab')),
  -- A public donation is always CC BY 4.0; a lab one may carry either (old rows).
  ADD CONSTRAINT valid_sharing_license CHECK (sharing = 'lab' OR license = 'cc-by-4.0'),
  ADD CONSTRAINT valid_subject_id CHECK (subject_id ~ '^[A-Za-z0-9-]{1,64}$'),
  ADD CONSTRAINT valid_subject_sex CHECK (subject_sex IN ('M', 'F', 'U', 'O')),
  ADD CONSTRAINT valid_subject_age CHECK (
    length(subject_age) <= 16
    AND subject_age ~ '^P[0-9]'
    AND subject_age ~ '^P([0-9]+Y)?([0-9]+M)?([0-9]+W)?([0-9]+D)?$'
  ),
  ADD CONSTRAINT valid_session_date CHECK (
    session_date >= DATE '1990-01-01' AND session_date < DATE '2100-01-01'
  ),
  ADD CONSTRAINT valid_genotype_len CHECK (length(genotype) <= 128),
  ADD CONSTRAINT valid_dandi_path CHECK (
    length(dandi_path) <= 256
    AND dandi_path ~ '^sub-[A-Za-z0-9-]+/[A-Za-z0-9_.+-]+\.nwb$'
  ),
  ADD CONSTRAINT published_complete CHECK (
    status <> 'published' OR (
      sharing = 'public'
      AND subject_id IS NOT NULL AND subject_sex IS NOT NULL
      AND subject_age IS NOT NULL AND session_date IS NOT NULL
      AND dandi_path IS NOT NULL AND published_at IS NOT NULL
    )
  );

-- What cala's browse page shows: published public donations, recording
-- metadata and the donor-chosen credit only (no user id, email, notes, review
-- fields or file list). Runs with the owner's privileges, like the *_public
-- views of 010, so anon sees these rows although the base table is hidden.
CREATE OR REPLACE VIEW public.cala_donations_public
WITH (security_invoker = false) AS
SELECT
  id, published_at, indicator, species, brain_region, expression, preparation,
  behavior, scope, fps, width, height, n_frames, bytes_per_pixel, depth_um,
  subject_sex, subject_age, genotype, credit_name, credit_lab, dandi_path
FROM public.cala_donations
WHERE sharing = 'public' AND status = 'published';

REVOKE ALL ON public.cala_donations_public FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.cala_donations_public TO anon, authenticated;

COMMIT;
```

- [ ] **Step 4: Run the RLS tests**

Run: `./scripts/test-rls.sh`
Expected: ends with `ALL RLS ASSERTIONS PASSED`.

- [ ] **Step 5: README row and commit**

In `supabase/README.md`'s migration table, add under the 020 row:

```markdown
| `021_cala_donations_public.sql` | **Donation project only.** Sharing choice (public on DANDI / CaLab only), subject fields, `published` status, public view `cala_donations_public`. |
```

```bash
git add supabase/migrations/021_cala_donations_public.sql supabase/tests/rls/test.sql supabase/README.md
git commit -m "feat(supabase): sharing choice, subject fields and public view for donations"
```

---

### Task 2: Edge function: sharing, subject fields, `ingest_published`

**Files:**

- Modify: `supabase/functions/donation/index.ts`
- Test: `supabase/functions/donation/index.test.ts`

**Interfaces:**

- Consumes: Task 1 columns.
- Produces: `DonationMeta` (edge) gains `sharing: 'public' | 'lab'`,
  `subject_id: string`, `subject_sex: 'M' | 'F' | 'U' | 'O'`,
  `subject_age: string`, `session_date: string`, `genotype: string | null`;
  `license` is derived, not accepted from the client.
  `DonationRow` gains `dandi_path: string | null`, `published_at: string | null`.
  `DonationStatus` gains `'published'`. New ingest action
  `ingest_published {donation_id, dandi_path}` → `{status: 'published'}`.
  `validateMeta(raw: unknown, nowMs?: number): DonationMeta`.

- [ ] **Step 1: Update the test fixtures and write failing tests**

In `index.test.ts`:

1. In `FakeDb.insert`, add `dandi_path: null, published_at: null,` to the
   stored row.
2. In `META`, delete `license: 'cc-by-4.0',` and add:

```ts
  sharing: 'public',
  subject_id: 'm7',
  subject_sex: 'F',
  subject_age: 'P90D',
  session_date: '2025-12-30',
  genotype: null,
```

3. In `create rejects bad metadata`, replace the case
   `[{ ...META, license: 'mit' }, 'license'],` with these cases:

```ts
    [{ ...META, license: 'cc-by-4.0' }, 'not a known field'],
    [{ ...META, sharing: undefined }, 'sharing'],
    [{ ...META, sharing: 'friends' }, 'sharing'],
    [{ ...META, subject_id: '' }, 'subject_id'],
    [{ ...META, subject_id: 'mouse 7' }, 'subject_id'],
    [{ ...META, subject_id: 'x'.repeat(65) }, 'subject_id'],
    [{ ...META, subject_sex: 'X' }, 'subject_sex'],
    [{ ...META, subject_age: 'P' }, 'subject_age'],
    [{ ...META, subject_age: '90 days' }, 'subject_age'],
    [{ ...META, subject_age: 'P1D'.padEnd(17, '1') }, 'subject_age'],
    [{ ...META, session_date: '2025-13-01' }, 'session_date'],
    [{ ...META, session_date: '2025-02-30' }, 'session_date'],
    [{ ...META, session_date: '1989-12-31' }, 'session_date'],
    [{ ...META, session_date: '2026-01-03' }, 'session_date'],
    [{ ...META, genotype: 'x'.repeat(129) }, 'genotype'],
```

(The handler's clock is `Date.UTC(2026, 0, 1, 1)`, so `2026-01-03` is in the
future.)

4. Add these tests after `create rejects bad metadata`:

```ts
Deno.test('create derives the license from sharing and stores the subject fields', async () => {
  const env = setup();
  const files = [{ name: 'frames-0000.calaraw.gz', bytes: 100 }];
  const pub = await call(env.handler, { action: 'create', meta: META, files }, { as: 'alice' });
  assertEquals(pub.status, 200);
  const row = env.db.rows.get(pub.json.donation_id as string)!;
  assertEquals(row.license, 'cc-by-4.0');
  assertEquals(row.sharing, 'public');
  assertEquals(
    [row.subject_id, row.subject_sex, row.subject_age, row.session_date],
    ['m7', 'F', 'P90D', '2025-12-30'],
  );
  const lab = await call(
    env.handler,
    { action: 'create', meta: { ...META, sharing: 'lab' }, files },
    { as: 'bob' },
  );
  assertEquals(env.db.rows.get(lab.json.donation_id as string)!.license, 'lab-use-only');
});

Deno.test('a session date of today east of UTC is accepted (one day of slack)', async () => {
  const env = setup();
  const files = [{ name: 'frames-0000.calaraw.gz', bytes: 100 }];
  // Clock: 2026-01-01 01:00 UTC; in UTC+14 it is already 2026-01-01 15:00, and
  // someone at UTC+14 just after midnight on Jan 2 would pick 2026-01-02.
  const r = await call(
    env.handler,
    { action: 'create', meta: { ...META, session_date: '2026-01-02' }, files },
    { as: 'alice' },
  );
  assertEquals(r.status, 200, JSON.stringify(r.json));
});
```

5. Add after the `ingest_list, ingest_download_url, ingest_done` test:

```ts
async function ingested(env: ReturnType<typeof setup>, sharing: 'public' | 'lab' = 'public') {
  const { id } = await approved(env);
  if (sharing === 'lab') {
    const row = env.db.rows.get(id)!;
    row.sharing = 'lab';
    row.license = 'lab-use-only';
  }
  const done = await call(
    env.handler,
    { action: 'ingest_done', donation_id: id },
    ingestAs(INGEST_TOKEN),
  );
  assertEquals(done.status, 200);
  return id;
}

const PATH = 'sub-some-lab-m7/sub-some-lab-m7_ses-20251230-00000000_ophys.nwb';

Deno.test('ingest_list returns sharing and the subject fields', async () => {
  const env = setup();
  await approved(env);
  const list = await call(env.handler, { action: 'ingest_list' }, ingestAs(INGEST_TOKEN));
  const row = (list.json.donations as DonationRow[])[0];
  assertEquals(row.sharing, 'public');
  assertEquals(row.subject_id, 'm7');
});

Deno.test('ingest_published marks an ingested public donation published', async () => {
  const env = setup();
  const id = await ingested(env);
  const r = await call(
    env.handler,
    { action: 'ingest_published', donation_id: id, dandi_path: PATH },
    ingestAs(INGEST_TOKEN),
  );
  assertEquals(r.status, 200, JSON.stringify(r.json));
  const row = env.db.rows.get(id)!;
  assertEquals(row.status, 'published');
  assertEquals(row.dandi_path, PATH);
  assertEquals(row.published_at, new Date(Date.UTC(2026, 0, 1, 1)).toISOString());
  // Second call: already published.
  const again = await call(
    env.handler,
    { action: 'ingest_published', donation_id: id, dandi_path: PATH },
    ingestAs(INGEST_TOKEN),
  );
  assertEquals(again.status, 409);
  assertStringIncludes(again.json.error as string, 'published');
});

Deno.test('ingest_published refuses lab donations, wrong status, bad paths, no token', async () => {
  const env = setup();
  const labId = await ingested(env, 'lab');
  const lab = await call(
    env.handler,
    { action: 'ingest_published', donation_id: labId, dandi_path: PATH },
    ingestAs(INGEST_TOKEN),
  );
  assertEquals(lab.status, 409);
  assertStringIncludes(lab.json.error as string, 'CaLab only');
  assertEquals(env.db.rows.get(labId)!.status, 'ingested');

  const { id: approvedId } = await approved(env);
  assertEquals(
    (
      await call(
        env.handler,
        { action: 'ingest_published', donation_id: approvedId, dandi_path: PATH },
        ingestAs(INGEST_TOKEN),
      )
    ).status,
    409,
  );

  const pubId = await ingested(env);
  for (const bad of ['../x.nwb', 'sub-a/x.txt', 'x.nwb', `sub-a/${'x'.repeat(300)}.nwb`, 42]) {
    const r = await call(
      env.handler,
      { action: 'ingest_published', donation_id: pubId, dandi_path: bad },
      ingestAs(INGEST_TOKEN),
    );
    assertEquals(r.status, 400, String(bad));
  }
  assertEquals(
    (
      await call(
        env.handler,
        { action: 'ingest_published', donation_id: pubId, dandi_path: PATH },
        { as: 'admin' },
      )
    ).status,
    401, // an admin session is not the ingest token
  );
});
```

Note: `approved(env)` uses `createAndUpload`, which creates as alice; the
per-user open limit is 2, and `ingested()` moves rows out of the open
statuses, so the test above stays within it. If a call returns 429, call
`setup({ maxOpenPerUser: 10 })` in that test.

6. In `notification config, text and Resend request`, add an assertion that
   the text contains `Sharing:    public on DANDI` for a row with
   `sharing: 'public'`.

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd supabase/functions/donation && deno test --allow-env --allow-net index.test.ts`
Expected: FAIL (`meta.sharing is not a known field`, missing `ingest_published`).

- [ ] **Step 3: Implement**

In `index.ts`:

1. Types:

```ts
export type DonationStatus =
  'uploading' | 'uploaded' | 'approved' | 'rejected' | 'ingested' | 'withdrawn' | 'published';

export type DonationSharing = 'public' | 'lab';
export type SubjectSex = 'M' | 'F' | 'U' | 'O';
```

Add to `DonationMeta`, after `notes`:

```ts
sharing: DonationSharing;
subject_id: string;
subject_sex: SubjectSex;
subject_age: string;
session_date: string;
genotype: string | null;
```

Add to `DonationRow`: `dandi_path: string | null; published_at: string | null;`

Widen the `transition` patch type (interface and `transitionOrConflict`) to
`{ status: DonationStatus; review_note?: string | null; dandi_path?: string; published_at?: string }`.

2. Validation constants and helpers (above `META_KEYS`):

```ts
export const SUBJECT_ID = /^[A-Za-z0-9-]{1,64}$/;
export const SUBJECT_AGE = /^P(?=\d)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?$/;
const SUBJECT_SEXES = new Set(['M', 'F', 'U', 'O']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const MIN_SESSION_DATE = '1990-01-01';
/** Slack for donors in time zones ahead of UTC. */
const SESSION_DATE_SLACK_MS = 86_400_000;
export const DANDI_PATH = /^sub-[A-Za-z0-9-]+\/[A-Za-z0-9_.+-]+\.nwb$/;

function sessionDate(m: Body, nowMs: number): string {
  const v = m.session_date;
  if (typeof v !== 'string' || !ISO_DATE.test(v)) {
    return fail(400, 'meta.session_date must be a date YYYY-MM-DD');
  }
  const t = Date.parse(`${v}T00:00:00Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== v) {
    return fail(400, 'meta.session_date is not a real date');
  }
  if (v < MIN_SESSION_DATE) fail(400, `meta.session_date is before ${MIN_SESSION_DATE}`);
  if (t > nowMs + SESSION_DATE_SLACK_MS) fail(400, 'meta.session_date is in the future');
  return v;
}
```

3. `META_KEYS`: remove `'license'`; add `'sharing'`, `'subject_id'`,
   `'subject_sex'`, `'subject_age'`, `'session_date'`, `'genotype'`.

4. `validateMeta(raw: unknown, nowMs: number = Date.now()): DonationMeta`:
   replace the `m.license` check with:

```ts
if (m.sharing !== 'public' && m.sharing !== 'lab') {
  fail(400, "meta.sharing must be 'public' or 'lab'");
}
if (typeof m.subject_id !== 'string' || !SUBJECT_ID.test(m.subject_id)) {
  fail(400, 'meta.subject_id must be 1-64 letters, digits or dashes');
}
if (typeof m.subject_sex !== 'string' || !SUBJECT_SEXES.has(m.subject_sex)) {
  fail(400, "meta.subject_sex must be 'M', 'F', 'U' or 'O'");
}
if (
  typeof m.subject_age !== 'string' ||
  m.subject_age.length > 16 ||
  !SUBJECT_AGE.test(m.subject_age)
) {
  fail(400, 'meta.subject_age must be an ISO 8601 duration such as P90D or P12W');
}
const sharing = m.sharing as DonationSharing;
```

and in the returned object replace
`license: m.license as DonationMeta['license'],` with
`license: sharing === 'public' ? 'cc-by-4.0' : 'lab-use-only',` and append:

```ts
    sharing,
    subject_id: m.subject_id as string,
    subject_sex: m.subject_sex as SubjectSex,
    subject_age: m.subject_age as string,
    session_date: sessionDate(m, nowMs),
    genotype: optionalText(m, 'genotype', 128),
```

5. In `create`: `const meta = validateMeta(body.meta, now());`

6. `INGEST_ACTIONS` gains `'ingest_published'`. In `ingest()`, before
   `const row = await load(body); requireStatus(row, ['approved']);`, insert:

```ts
if (action === 'ingest_published') {
  const row = await load(body);
  if (row.sharing !== 'public') fail(409, 'donation is CaLab only; it is never published');
  if (row.status === 'published') fail(409, 'donation is already published');
  requireStatus(row, ['ingested']);
  if (!row.subject_id || !row.subject_sex || !row.subject_age || !row.session_date) {
    fail(409, 'donation lacks the subject fields DANDI needs');
  }
  const path = body.dandi_path;
  if (typeof path !== 'string' || path.length > 256 || !DANDI_PATH.test(path)) {
    fail(400, 'dandi_path must look like sub-<subject>/<file>.nwb');
  }
  await transitionOrConflict(row, ['ingested'], {
    status: 'published',
    dandi_path: path as string,
    published_at: new Date(now()).toISOString(),
  });
  return { status: 'published' };
}
```

7. `notificationText`: after the `Credit:` line add

```ts
    `Sharing:    ${row.sharing === 'public' ? 'public on DANDI' : 'CaLab only'}`,
    `Subject:    ${row.subject_id ?? '-'}, ${row.subject_sex ?? '-'}, ${row.subject_age ?? '-'}, session ${row.session_date ?? '-'}`,
```

- [ ] **Step 4: Run the tests**

Run: `cd supabase/functions/donation && deno test --allow-env --allow-net index.test.ts && deno check index.ts`
Expected: all pass (37 old + 6 new), no type errors.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/donation/index.ts supabase/functions/donation/index.test.ts
git commit -m "feat(supabase): donation edge function takes the sharing choice and marks published donations"
```

---

### Task 3: Community package: types, public list, DANDI helpers

**Files:**

- Modify: `packages/community/src/donation-service.ts`
- Create: `packages/community/src/dandi.ts`
- Modify: `packages/community/src/env.d.ts`, `packages/community/src/index.ts`
- Test: `packages/community/src/__tests__/dandi.test.ts`,
  `packages/community/src/__tests__/donation-service.test.ts`

**Interfaces:**

- Consumes: Task 1 view, Task 2 field names.
- Produces (exported from `@calab/community`):
  - types `DonationSharing = 'public' | 'lab'`, `SubjectSex = 'M' | 'F' | 'U' | 'O'`,
    `DonationMeta` (no `license`; adds `sharing`, `subject_id`, `subject_sex`,
    `subject_age`, `session_date`, `genotype?`), `DonationRow` (adds
    `license: DonationLicense`, `dandi_path: string | null`,
    `published_at: string | null`), `DonationStatus` with `'published'`,
    `PublicDonation`.
  - `listPublicDonations(): Promise<PublicDonation[]>`
  - `DandiConfig`, `DandiAsset`, `DandiCollection`, `dandiConfig()`,
    `donationDandi`, `loadDandiCollection()`, `dandiDownloadUrl()`,
    `dandiViewUrl()`, `dandiFolderUrl()`, `acknowledgementText()`.

- [ ] **Step 1: Write the failing tests**

`packages/community/src/__tests__/dandi.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  acknowledgementText,
  dandiConfig,
  dandiDownloadUrl,
  dandiFolderUrl,
  dandiViewUrl,
  loadDandiCollection,
} from '../dandi.ts';

const CFG = dandiConfig('000999', 'sandbox')!;

function fakeFetch(routes: Record<string, unknown>) {
  return vi.fn(async (url: string) => {
    const body = routes[url];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('dandi helpers', () => {
  it('builds a config only for a 6-digit dandiset', () => {
    expect(dandiConfig(undefined, undefined)).toBeNull();
    expect(dandiConfig('12', 'dandi')).toBeNull();
    expect(dandiConfig('000999', undefined)).toEqual({
      dandiset: '000999',
      api: 'https://api.dandiarchive.org/api',
      web: 'https://dandiarchive.org',
    });
    expect(CFG.api).toBe('https://api.sandbox.dandiarchive.org/api');
  });

  it('builds download, view and folder links', () => {
    const a = { asset_id: 'abc', path: 'sub-x/sub-x_ses-1_ophys.nwb', size: 10, version: '0.1' };
    expect(dandiDownloadUrl(CFG, a)).toBe(
      'https://api.sandbox.dandiarchive.org/api/assets/abc/download/',
    );
    const view = new URL(dandiViewUrl(CFG, a));
    expect(view.origin).toBe('https://neurosift.app');
    expect(view.searchParams.get('url')).toBe(dandiDownloadUrl(CFG, a));
    expect(view.searchParams.get('dandisetId')).toBe('000999');
    expect(view.searchParams.get('dandisetVersion')).toBe('0.1');
    expect(dandiFolderUrl(CFG, a.path)).toBe(
      'https://sandbox.dandiarchive.org/dandiset/000999/draft/files?location=sub-x',
    );
  });

  it('loads the published version and adds draft-only assets', async () => {
    const api = CFG.api;
    const f = fakeFetch({
      [`${api}/dandisets/000999/`]: { most_recent_published_version: { version: '0.1' } },
      [`${api}/dandisets/000999/versions/0.1/info/`]: {
        metadata: {
          citation: 'Lab (2026) CaLab donated recordings',
          doi: '10.48324/dandi.000999/0.1',
        },
      },
      [`${api}/dandisets/000999/versions/0.1/assets/?page_size=1000`]: {
        next: null,
        results: [{ asset_id: 'a1', path: 'sub-a/a.nwb', size: 1 }],
      },
      [`${api}/dandisets/000999/versions/draft/assets/?page_size=1000`]: {
        next: null,
        results: [
          { asset_id: 'd1', path: 'sub-a/a.nwb', size: 1 },
          { asset_id: 'd2', path: 'sub-b/b.nwb', size: 2 },
        ],
      },
    });
    const c = await loadDandiCollection(CFG, f);
    expect(c.version).toBe('0.1');
    expect(c.doi).toBe('10.48324/dandi.000999/0.1');
    expect(c.assets.get('sub-a/a.nwb')).toEqual({
      asset_id: 'a1',
      path: 'sub-a/a.nwb',
      size: 1,
      version: '0.1',
    });
    expect(c.assets.get('sub-b/b.nwb')?.version).toBe('draft');
  });

  it('uses the draft when nothing is published yet', async () => {
    const api = CFG.api;
    const f = fakeFetch({
      [`${api}/dandisets/000999/`]: { most_recent_published_version: null },
      [`${api}/dandisets/000999/versions/draft/info/`]: { metadata: { citation: 'draft cite' } },
      [`${api}/dandisets/000999/versions/draft/assets/?page_size=1000`]: {
        next: null,
        results: [{ asset_id: 'd2', path: 'sub-b/b.nwb', size: 2 }],
      },
    });
    const c = await loadDandiCollection(CFG, f);
    expect(c.version).toBe('draft');
    expect(c.doi).toBeNull();
    expect(c.citation).toBe('draft cite');
    expect(c.assets.size).toBe(1);
  });

  it('throws a readable error when DANDI answers with an error', async () => {
    await expect(loadDandiCollection(CFG, fakeFetch({}))).rejects.toThrow(/DANDI/);
  });

  it('writes an acknowledgement naming the donor, lab and collection', () => {
    const text = acknowledgementText(
      { credit_name: 'Jane Doe', credit_lab: 'Doe Lab' },
      CFG,
      '10.48324/dandi.000999/0.1',
    );
    expect(text).toBe(
      'Data were contributed by Jane Doe (Doe Lab) to the CaLab donated recordings collection (DANDI:000999, doi:10.48324/dandi.000999/0.1).',
    );
    expect(acknowledgementText({ credit_name: null, credit_lab: 'Doe Lab' }, CFG, null)).toBe(
      'Data were contributed by Doe Lab to the CaLab donated recordings collection (DANDI:000999).',
    );
  });
});
```

`packages/community/src/__tests__/donation-service.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

const order = vi.fn();
const select = vi.fn(() => ({ order }));
const from = vi.fn(() => ({ select }));
vi.mock('../donation-auth.ts', () => ({
  getDonationSupabase: async () => ({ from }),
}));

import { listPublicDonations } from '../donation-service.ts';

describe('listPublicDonations', () => {
  it('reads the public view, newest first', async () => {
    order.mockResolvedValueOnce({ data: [{ id: 'x', dandi_path: 'sub-a/a.nwb' }], error: null });
    const rows = await listPublicDonations();
    expect(from).toHaveBeenCalledWith('cala_donations_public');
    expect(order).toHaveBeenCalledWith('published_at', { ascending: false });
    expect(rows).toEqual([{ id: 'x', dandi_path: 'sub-a/a.nwb' }]);
  });

  it('turns a database error into a DonationApiError', async () => {
    order.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    await expect(listPublicDonations()).rejects.toThrow('boom');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -w packages/community -- dandi donation-service`
Expected: FAIL (`Cannot find module '../dandi.ts'`, `listPublicDonations` not exported).

- [ ] **Step 3: Implement**

`packages/community/src/env.d.ts`: add

```ts
  readonly VITE_DONATION_DANDISET?: string;
  readonly VITE_DONATION_DANDI_INSTANCE?: string;
```

`packages/community/src/dandi.ts`:

```ts
// DANDI REST API helpers for the public donation collection
// (apps/cala/docs/data-donation.md, "Browse page"). Public endpoints only, no
// key; DANDI's API and S3 answer CORS for any origin.

export interface DandiConfig {
  dandiset: string;
  api: string;
  web: string;
}

export interface DandiAsset {
  asset_id: string;
  path: string;
  size: number;
  /** The version this asset entry is from: a published version or 'draft'. */
  version: string;
}

export interface DandiCollection {
  version: string;
  citation: string | null;
  doi: string | null;
  /** By asset path. */
  assets: Map<string, DandiAsset>;
}

const INSTANCES = {
  dandi: { api: 'https://api.dandiarchive.org/api', web: 'https://dandiarchive.org' },
  sandbox: {
    api: 'https://api.sandbox.dandiarchive.org/api',
    web: 'https://sandbox.dandiarchive.org',
  },
} as const;

const MAX_PAGES = 50;

/** The collection's config, or null when no (valid) dandiset is set. */
export function dandiConfig(
  dandiset: string | undefined,
  instance: string | undefined,
): DandiConfig | null {
  if (!dandiset || !/^\d{6}$/.test(dandiset)) return null;
  return { dandiset, ...(instance === 'sandbox' ? INSTANCES.sandbox : INSTANCES.dandi) };
}

/** From VITE_DONATION_DANDISET / VITE_DONATION_DANDI_INSTANCE (dandi | sandbox). */
export const donationDandi: DandiConfig | null = dandiConfig(
  import.meta.env.VITE_DONATION_DANDISET,
  import.meta.env.VITE_DONATION_DANDI_INSTANCE,
);

async function getJson(fetchFn: typeof fetch, url: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchFn(url);
  } catch (err) {
    throw new Error(`DANDI is not reachable (${err instanceof Error ? err.message : err})`);
  }
  if (!res.ok) throw new Error(`DANDI answered ${res.status} for ${url}`);
  return (await res.json()) as Record<string, unknown>;
}

async function listAssets(
  cfg: DandiConfig,
  version: string,
  fetchFn: typeof fetch,
): Promise<DandiAsset[]> {
  const out: DandiAsset[] = [];
  let url: string | null =
    `${cfg.api}/dandisets/${cfg.dandiset}/versions/${version}/assets/?page_size=1000`;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const body = await getJson(fetchFn, url);
    for (const r of (body.results as Record<string, unknown>[]) ?? []) {
      out.push({
        asset_id: String(r.asset_id),
        path: String(r.path),
        size: Number(r.size),
        version,
      });
    }
    url = typeof body.next === 'string' ? body.next : null;
  }
  return out;
}

/**
 * The collection's most recent published version (else the draft) with its
 * citation and DOI, and every asset by path. Assets that are only in the draft
 * (uploaded after the last published version) are added with version 'draft'.
 */
export async function loadDandiCollection(
  cfg: DandiConfig,
  fetchFn: typeof fetch = fetch,
): Promise<DandiCollection> {
  const ds = await getJson(fetchFn, `${cfg.api}/dandisets/${cfg.dandiset}/`);
  const published = ds.most_recent_published_version as { version?: string } | null;
  const version = published?.version ?? 'draft';
  const info = await getJson(
    fetchFn,
    `${cfg.api}/dandisets/${cfg.dandiset}/versions/${version}/info/`,
  );
  const meta = (info.metadata ?? {}) as { citation?: unknown; doi?: unknown };
  const assets = new Map<string, DandiAsset>();
  for (const a of await listAssets(cfg, version, fetchFn)) assets.set(a.path, a);
  if (version !== 'draft') {
    for (const a of await listAssets(cfg, 'draft', fetchFn)) {
      if (!assets.has(a.path)) assets.set(a.path, a);
    }
  }
  return {
    version,
    citation: typeof meta.citation === 'string' ? meta.citation : null,
    doi: typeof meta.doi === 'string' && version !== 'draft' ? meta.doi : null,
    assets,
  };
}

export function dandiDownloadUrl(cfg: DandiConfig, asset: DandiAsset): string {
  return `${cfg.api}/assets/${asset.asset_id}/download/`;
}

/** Neurosift, the in-browser NWB viewer DANDI links to. */
export function dandiViewUrl(cfg: DandiConfig, asset: DandiAsset): string {
  const q = new URLSearchParams({
    url: dandiDownloadUrl(cfg, asset),
    dandisetId: cfg.dandiset,
    dandisetVersion: asset.version,
  });
  return `https://neurosift.app/nwb?${q}`;
}

/** The asset's folder on the DANDI web page (draft view, which lists every file). */
export function dandiFolderUrl(cfg: DandiConfig, path: string): string {
  const dir = path.slice(0, Math.max(0, path.lastIndexOf('/')));
  return `${cfg.web}/dandiset/${cfg.dandiset}/draft/files?location=${encodeURIComponent(dir)}`;
}

/** The sentence we ask users of a recording to put in their acknowledgements. */
export function acknowledgementText(
  row: { credit_name: string | null; credit_lab: string | null },
  cfg: DandiConfig,
  doi: string | null,
): string {
  const who = row.credit_name
    ? `${row.credit_name}${row.credit_lab ? ` (${row.credit_lab})` : ''}`
    : (row.credit_lab ?? 'the contributing lab');
  const ref = doi ? `DANDI:${cfg.dandiset}, doi:${doi}` : `DANDI:${cfg.dandiset}`;
  return `Data were contributed by ${who} to the CaLab donated recordings collection (${ref}).`;
}
```

`packages/community/src/donation-service.ts`:

1. Status and license types:

```ts
export type DonationStatus =
  'uploading' | 'uploaded' | 'approved' | 'rejected' | 'ingested' | 'withdrawn' | 'published';

export type DonationLicense = 'cc-by-4.0' | 'lab-use-only';
/** Public on DANDI, or CaLab only. */
export type DonationSharing = 'public' | 'lab';
export type SubjectSex = 'M' | 'F' | 'U' | 'O';
```

2. In `DonationMeta`, delete `license: DonationLicense;` and add after
   `notes?`:

```ts
  sharing: DonationSharing;
  /** The donor's own label for the animal: letters, digits, dashes. */
  subject_id: string;
  subject_sex: SubjectSex;
  /** ISO 8601 duration, e.g. P90D. */
  subject_age: string;
  /** YYYY-MM-DD. */
  session_date: string;
  genotype?: string | null;
```

3. In `DonationRow`, add `license: DonationLicense; dandi_path: string | null; published_at: string | null;`

4. After `listDonations`:

```ts
/** A published public donation as the public view shows it (no sign-in needed). */
export interface PublicDonation {
  id: string;
  published_at: string;
  indicator: string;
  species: string;
  brain_region: string;
  expression: string | null;
  preparation: string | null;
  behavior: string | null;
  scope: string;
  fps: number;
  width: number;
  height: number;
  n_frames: number;
  bytes_per_pixel: 1 | 2;
  depth_um: number | null;
  subject_sex: SubjectSex;
  subject_age: string;
  genotype: string | null;
  credit_name: string | null;
  credit_lab: string | null;
  dandi_path: string;
}

/** Published public donations (view cala_donations_public), newest first. */
export async function listPublicDonations(): Promise<PublicDonation[]> {
  const client = await requireClient();
  const { data, error } = await client
    .from('cala_donations_public')
    .select('*')
    .order('published_at', { ascending: false });
  if (error) throw new DonationApiError(error.message);
  return (data as PublicDonation[]) ?? [];
}
```

`packages/community/src/index.ts`: add `listPublicDonations` to the
`donation-service.ts` value exports; add `DonationSharing`, `PublicDonation`,
`SubjectSex` to the type exports; and add:

```ts
export {
  acknowledgementText,
  dandiConfig,
  dandiDownloadUrl,
  dandiFolderUrl,
  dandiViewUrl,
  donationDandi,
  loadDandiCollection,
} from './dandi.ts';
export type { DandiAsset, DandiCollection, DandiConfig } from './dandi.ts';
```

If ESLint complains that `dandi.ts` reads `import.meta.env` outside the
allowed files, add `packages/community/src/dandi.ts` to the same exemption list
in `eslint.config.js` that already names `donation-auth.ts`.

- [ ] **Step 4: Run the tests**

Run: `npm test -w packages/community && npx tsc -p packages/community --noEmit`
Expected: all pass; typecheck fails only in apps that still pass `license`
(fixed in Tasks 5 and 6). `npm run typecheck` repo-wide is checked after Task 6.

- [ ] **Step 5: Commit**

```bash
git add packages/community eslint.config.js
git commit -m "feat(community): donation sharing types, public donation list and DANDI helpers"
```

---

### Task 4: cala form helpers

**Files:**

- Create: `apps/cala/src/lib/donation-form.ts`
- Test: `apps/cala/src/__tests__/donation-form.test.ts`

**Interfaces:**

- Consumes: `DonationSharing`, `SubjectSex` from `@calab/community`.
- Produces:
  - `type AgeUnit = 'D' | 'W' | 'M' | 'Y'`
  - `interface DonationForm` (all form fields as typed; see code)
  - `emptyForm(fps: number | null): DonationForm`
  - `ageToIso(value: string, unit: AgeUnit): string | null`
  - `missingFields(form: DonationForm, today: Date): string[]`
  - `SHARING_TEXT: Record<DonationSharing, { label: string; text: string }>`
  - `todayIso(d: Date): string`

- [ ] **Step 1: Write the failing tests**

`apps/cala/src/__tests__/donation-form.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  ageToIso,
  emptyForm,
  missingFields,
  SHARING_TEXT,
  todayIso,
  type DonationForm,
} from '../lib/donation-form.ts';

const TODAY = new Date('2026-11-23T12:00:00Z');

function filled(over: Partial<DonationForm> = {}): DonationForm {
  return {
    ...emptyForm(20),
    indicator: 'GCaMP8m',
    species: 'mouse',
    brain_region: 'M1',
    scope: 'UCLA v4',
    credit_name: 'Jane Doe',
    credit_lab: 'Doe Lab',
    rights_attested: true,
    protocol_attested: true,
    sharing: 'public',
    subject_id: 'm7',
    subject_sex: 'F',
    age_value: '90',
    age_unit: 'D',
    session_date: '2026-11-20',
    ...over,
  };
}

describe('donation form', () => {
  it('starts with no sharing choice and the known frame rate', () => {
    const f = emptyForm(20);
    expect(f.sharing).toBeNull();
    expect(f.fps).toBe('20');
    expect(emptyForm(null).fps).toBe('');
  });

  it('writes ISO 8601 ages', () => {
    expect(ageToIso('90', 'D')).toBe('P90D');
    expect(ageToIso(' 12 ', 'W')).toBe('P12W');
    expect(ageToIso('3', 'M')).toBe('P3M');
    expect(ageToIso('1', 'Y')).toBe('P1Y');
    for (const bad of ['', '0', '-3', '2.5', 'abc', '100000']) {
      expect(ageToIso(bad, 'D')).toBeNull();
    }
  });

  it('a complete form needs nothing', () => {
    expect(missingFields(filled(), TODAY)).toEqual([]);
  });

  it('needs a sharing choice', () => {
    expect(missingFields(filled({ sharing: null }), TODAY)).toContain(
      'a choice: public on DANDI or CaLab only',
    );
  });

  it('checks the subject fields', () => {
    expect(missingFields(filled({ subject_id: '' }), TODAY)).toContain(
      'animal ID (letters, digits, dashes)',
    );
    expect(missingFields(filled({ subject_id: 'mouse 7' }), TODAY)).toContain(
      'animal ID (letters, digits, dashes)',
    );
    expect(missingFields(filled({ subject_sex: '' }), TODAY)).toContain('sex');
    expect(missingFields(filled({ age_value: '' }), TODAY)).toContain('age');
    expect(missingFields(filled({ session_date: '' }), TODAY)).toContain('recording date');
    expect(missingFields(filled({ session_date: '2026-11-25' }), TODAY)).toContain(
      'recording date',
    );
    expect(missingFields(filled({ session_date: '1989-01-01' }), TODAY)).toContain(
      'recording date',
    );
  });

  it('accepts today as the recording date', () => {
    expect(missingFields(filled({ session_date: todayIso(TODAY) }), TODAY)).toEqual([]);
  });

  it('keeps the existing checks', () => {
    expect(missingFields(filled({ indicator: ' ' }), TODAY)).toContain('indicator');
    expect(missingFields(filled({ fps: '0' }), TODAY)).toContain('frame rate');
    expect(missingFields(filled({ depth_um: '20000' }), TODAY)).toContain(
      'a depth of 0 to 10000 um',
    );
    expect(missingFields(filled({ credit_lab: '' }), TODAY)).toContain('your lab (for credit)');
    expect(missingFields(filled({ protocol_attested: false }), TODAY)).toContain(
      'both confirmations',
    );
  });

  it('has the agreed sharing texts', () => {
    expect(SHARING_TEXT.public.text).toMatch(/^After review, your recording is published/);
    expect(SHARING_TEXT.public.text).toMatch(/published versions are permanent\.$/);
    expect(SHARING_TEXT.lab.text).toMatch(/^Only the CaLab team uses your recording/);
    expect(SHARING_TEXT.lab.text).toMatch(/or ask us to make it public later\.$/);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -w apps/cala -- donation-form`
Expected: FAIL (`Cannot find module '../lib/donation-form.ts'`).

- [ ] **Step 3: Implement**

`apps/cala/src/lib/donation-form.ts`:

```ts
// The Donate form's fields and checks (apps/cala/docs/data-donation.md), kept
// out of the component so they can be tested without a DOM.
import type { DonationSharing, SubjectSex } from '@calab/community';

export type AgeUnit = 'D' | 'W' | 'M' | 'Y';

/** Form fields (strings as typed; converted on submit). */
export interface DonationForm {
  indicator: string;
  species: string;
  brain_region: string;
  scope: string;
  expression: string;
  preparation: string;
  behavior: string;
  depth_um: string;
  led_power: string;
  fps: string;
  /** Null until the donor picks one; nothing is preselected. */
  sharing: DonationSharing | null;
  subject_id: string;
  subject_sex: SubjectSex | '';
  age_value: string;
  age_unit: AgeUnit;
  /** YYYY-MM-DD from <input type="date">. */
  session_date: string;
  genotype: string;
  rights_attested: boolean;
  protocol_attested: boolean;
  contact_ok: boolean;
  credit_name: string;
  credit_lab: string;
  notes: string;
}

export const SHARING_TEXT: Record<DonationSharing, { label: string; text: string }> = {
  public: {
    label: 'Public on DANDI (CC BY 4.0)',
    text: 'After review, your recording is published in the CaLab donated recordings collection on DANDI, where anyone can download it, e.g. to test and improve their pipelines. You and your lab are listed as contributors on its citable DOI. You can withdraw it until the next version of the collection is published; published versions are permanent.',
  },
  lab: {
    label: 'CaLab only',
    text: 'Only the CaLab team uses your recording, to develop and benchmark cala. The raw data is never shared; results computed from it may appear in papers, which acknowledge your lab. You can have it deleted at any time, or ask us to make it public later.',
  },
};

const SUBJECT_ID = /^[A-Za-z0-9-]{1,64}$/;
const MIN_SESSION_DATE = '1990-01-01';
/** Largest age accepted, in the unit typed (100 years in days). */
const MAX_AGE = 36500;

export function emptyForm(fps: number | null): DonationForm {
  return {
    indicator: '',
    species: '',
    brain_region: '',
    scope: '',
    expression: '',
    preparation: '',
    behavior: '',
    depth_um: '',
    led_power: '',
    fps: fps === null ? '' : String(fps),
    sharing: null,
    subject_id: '',
    subject_sex: '',
    age_value: '',
    age_unit: 'D',
    session_date: '',
    genotype: '',
    rights_attested: false,
    protocol_attested: false,
    contact_ok: false,
    credit_name: '',
    credit_lab: '',
    notes: '',
  };
}

/** "90" + days -> "P90D"; null for anything but a whole number from 1 to 36500. */
export function ageToIso(value: string, unit: AgeUnit): string | null {
  const v = value.trim();
  if (!/^\d+$/.test(v)) return null;
  const n = Number(v);
  if (n < 1 || n > MAX_AGE) return null;
  return `P${n}${unit}`;
}

/** The local calendar date as YYYY-MM-DD (what <input type="date"> shows as today). */
export function todayIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function sessionDateOk(v: string, today: Date): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  return v >= MIN_SESSION_DATE && v <= todayIso(today);
}

/** What still blocks the Donate button, as words for "Still needed: ...". */
export function missingFields(form: DonationForm, today: Date): string[] {
  const m: string[] = [];
  const fps = Number(form.fps);
  const depth = Number(form.depth_um);
  if (!form.sharing) m.push('a choice: public on DANDI or CaLab only');
  if (!form.indicator.trim()) m.push('indicator');
  if (!form.species.trim()) m.push('species');
  if (!form.brain_region.trim()) m.push('brain region');
  if (!form.scope.trim()) m.push('scope');
  if (!(Number.isFinite(fps) && fps > 0 && fps <= 1000)) m.push('frame rate');
  if (form.depth_um.trim() !== '' && !(Number.isFinite(depth) && depth >= 0 && depth <= 10000)) {
    m.push('a depth of 0 to 10000 um');
  }
  if (!SUBJECT_ID.test(form.subject_id.trim())) m.push('animal ID (letters, digits, dashes)');
  if (!form.subject_sex) m.push('sex');
  if (ageToIso(form.age_value, form.age_unit) === null) m.push('age');
  if (!sessionDateOk(form.session_date, today)) m.push('recording date');
  if (!form.credit_name.trim()) m.push('your name (for credit)');
  if (!form.credit_lab.trim()) m.push('your lab (for credit)');
  if (!form.rights_attested || !form.protocol_attested) m.push('both confirmations');
  return m;
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -w apps/cala -- donation-form`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cala/src/lib/donation-form.ts apps/cala/src/__tests__/donation-form.test.ts
git commit -m "feat(cala): donation form fields and checks for the sharing choice and subject"
```

---

### Task 5: Donate panel: new texts, sharing choice, subject fields

**Files:**

- Modify: `apps/cala/src/components/DonatePanel.tsx`
- Modify: `apps/cala/src/lib/donation-runner.ts` (`buildMetaJson`)
- Modify: `apps/cala/src/styles/global.css` (radio cards)
- Test: `apps/cala/src/__tests__/donation-encode.test.ts` (meta.json),
  `apps/cala/src/__tests__/donate-panel.test.tsx` (new)

**Interfaces:**

- Consumes: Task 3 types and `donationDandi`, `dandiFolderUrl`; Task 4
  `DonationForm`, `emptyForm`, `ageToIso`, `missingFields`, `SHARING_TEXT`,
  `todayIso`.
- Produces: `buildMetaJson(info, calaVersion, fps, sharing: DonationSharing)`
  writes `"sharing"` at the top level of `meta.json` (read by Task 8).
  `DonationFormView` is exported (for the test).

- [ ] **Step 1: Write the failing tests**

In `donation-encode.test.ts`, change the existing call to
`buildMetaJson(info, '1.2.3', 20, 'public')` and add
`expect(doc.sharing).toBe('public');` next to its other `doc` assertions.

`apps/cala/src/__tests__/donate-panel.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { DonationFormView } from '../components/DonatePanel.tsx';
import type { DonationUiStore } from '../lib/donation-store.ts';
import type { FrameSourceInfo } from '../lib/frame-source.ts';

const info = {
  width: 64,
  height: 48,
  frameCount: 30,
  bitDepth: 8,
  fps: 20,
  fpsSource: 'metadata',
  files: [],
} as unknown as FrameSourceInfo;

const donation = {
  active: () => false,
  start: vi.fn(),
} as unknown as DonationUiStore;

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const dispose = render(
    () => (
      <DonationFormView
        info={info}
        source={{ entries: [] }}
        label="rec"
        version="test"
        donation={donation}
        onClose={() => {}}
      />
    ),
    host,
  );
  return { host, dispose };
}

describe('Donate form', () => {
  it('offers both sharing choices with neither preselected, and blocks submit', () => {
    const { host, dispose } = mount();
    const radios = host.querySelectorAll<HTMLInputElement>('input[name="donate-sharing"]');
    expect([...radios].map((r) => r.value)).toEqual(['public', 'lab']);
    expect([...radios].some((r) => r.checked)).toBe(false);
    const submit = host.querySelector<HTMLButtonElement>('[data-testid="donate-submit"]')!;
    expect(submit.disabled).toBe(true);
    expect(host.textContent).toContain('a choice: public on DANDI or CaLab only');
    dispose();
  });

  it('shows the text of the chosen option', () => {
    const { host, dispose } = mount();
    const lab = host.querySelector<HTMLInputElement>('input[value="lab"]')!;
    lab.click();
    expect(host.querySelector('[data-testid="donate-sharing-text"]')!.textContent).toMatch(
      /^Only the CaLab team uses your recording/,
    );
    dispose();
  });

  it('no longer mentions co-authorship', () => {
    const { host, dispose } = mount();
    expect(host.textContent?.toLowerCase()).not.toContain('co-authorship');
    dispose();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -w apps/cala -- donate-panel donation-encode`
Expected: FAIL (`DonationFormView` not exported; `doc.sharing` undefined).

- [ ] **Step 3: Implement**

`donation-runner.ts`: change the signature to
`buildMetaJson(info: FrameSourceInfo, calaVersion: string, fps: number, sharing: DonationSharing): Uint8Array`
(import `type DonationSharing` from `@calab/community`), and add `sharing,`
right after `cala_version: calaVersion,` in `doc`.

`DonatePanel.tsx`:

1. Imports: drop `type DonationLicense`; add `type DonationSharing`,
   `donationDandi`, `dandiFolderUrl` from `@calab/community`; add
   `import { ageToIso, emptyForm, missingFields, SHARING_TEXT, type AgeUnit, type DonationForm } from '../lib/donation-form.ts';`.
   Delete the local `DonationForm` interface.

2. `STATUS_LABEL`: add `published: 'published on DANDI',` (the type requires
   every status).

3. Replace the `<ul class="cala-donate__why">...</ul>` block with:

```tsx
<ul class="cala-donate__why">
  <li>
    <strong>cala gets better on your kind of data.</strong> Donated recordings go into the benchmark
    set that cala is developed and tuned against.
  </li>
  <li>
    <strong>Share it with everyone, or only with us.</strong> Public recordings are published on{' '}
    <a href="https://dandiarchive.org" target="_blank" rel="noopener noreferrer">
      DANDI
    </a>{' '}
    under{' '}
    <a href={CC_BY_URL} target="_blank" rel="noopener noreferrer">
      CC BY 4.0
    </a>
    , where anyone can use them to test and improve their pipelines. Or keep it CaLab only: then
    only the CaLab team uses it, to improve cala.
  </li>
  <li>
    <strong>Credit.</strong> Public donors and their labs are listed as contributors on the
    collection's citable DOI, and everyone using the data is asked to cite it and acknowledge your
    lab. Our own papers acknowledge every lab whose data they use. Deletion requests:{' '}
    <DeletionContacts />.
  </li>
</ul>
```

4. Replace the expanded intro paragraph (`The raw frames are compressed...`)
   with:

```tsx
<p class="cala-muted">
  The raw frames are compressed without loss in this browser and uploaded with the metadata below.
  File paths are never sent, only file names. The lab reviews each donation first. Withdraw it under
  "My donations" below until the lab has taken it in; after that, email <DeletionContacts />. A
  public recording can be removed until the next version of the DANDI collection is published;
  published versions are permanent.
</p>
```

5. Export the form: `export function DonationFormView(...)`. Inside it,
   replace the `createStore<DonationForm>({...})` initializer with
   `createStore<DonationForm>(emptyForm(fpsKnown))`, delete the local
   `fpsOk`, `depthOk` and `missing` functions, and add
   `const missing = (): string[] => missingFields(form, new Date());`
   (`fps()` stays: `const fps = () => Number(form.fps);`).

6. In `submit`, build `meta` with the new fields (replace the
   `license: form.license,` line):

```ts
      sharing: form.sharing!,
      subject_id: form.subject_id.trim(),
      subject_sex: form.subject_sex as SubjectSex,
      subject_age: ageToIso(form.age_value, form.age_unit)!,
      session_date: form.session_date,
      genotype: optional(form.genotype),
```

(import `type SubjectSex` too) and pass the choice to the meta file:
`metaJson: buildMetaJson(i, props.version, fps(), form.sharing!),`.

7. The `text()` helper's key type: change
   `Exclude<keyof DonationForm, 'license' | 'rights_attested' | 'protocol_attested' | 'contact_ok'>`
   to
   `Exclude<keyof DonationForm, 'sharing' | 'subject_sex' | 'age_unit' | 'rights_attested' | 'protocol_attested' | 'contact_ok'>`.

8. After the `Biology` fieldset, add the `Animal` fieldset:

```tsx
<fieldset class="cala-donate__group">
  <legend>Animal and session (DANDI needs these)</legend>
  {text('subject_id', 'Animal ID', {
    required: true,
    max: 64,
    placeholder: 'your label, e.g. m7 (letters, digits, dashes)',
  })}
  <label class="cala-donate__field">
    <span>Sex *</span>
    <select
      value={form.subject_sex}
      onChange={(e) => setForm('subject_sex', e.currentTarget.value as DonationForm['subject_sex'])}
    >
      <option value="">choose</option>
      <option value="F">female</option>
      <option value="M">male</option>
      <option value="U">unknown</option>
      <option value="O">other</option>
    </select>
  </label>
  <label class="cala-donate__field">
    <span>Age at recording *</span>
    <span class="cala-donate__age">
      <input
        type="number"
        min="1"
        step="1"
        value={form.age_value}
        aria-label="Age"
        onInput={(e) => setForm('age_value', e.currentTarget.value)}
      />
      <select
        value={form.age_unit}
        aria-label="Age unit"
        onChange={(e) => setForm('age_unit', e.currentTarget.value as AgeUnit)}
      >
        <option value="D">days</option>
        <option value="W">weeks</option>
        <option value="M">months</option>
        <option value="Y">years</option>
      </select>
    </span>
  </label>
  <label class="cala-donate__field">
    <span>Recording date *</span>
    <input
      type="date"
      min="1990-01-01"
      value={form.session_date}
      onInput={(e) => setForm('session_date', e.currentTarget.value)}
    />
  </label>
  {text('genotype', 'Strain / genotype', { placeholder: 'C57BL/6J, Thy1-GCaMP6s, ...' })}
</fieldset>
```

9. Replace the `License` fieldset with the sharing choice:

```tsx
<fieldset class="cala-donate__group" data-testid="donate-sharing">
  <legend>Who may use it? *</legend>
  <For each={['public', 'lab'] as DonationSharing[]}>
    {(choice) => (
      <label class="cala-donate__choice">
        <input
          type="radio"
          name="donate-sharing"
          value={choice}
          checked={form.sharing === choice}
          onChange={() => setForm('sharing', choice)}
        />{' '}
        <strong>{SHARING_TEXT[choice].label}</strong>
      </label>
    )}
  </For>
  <Show when={form.sharing}>
    {(s) => (
      <p class="cala-donate__note" data-testid="donate-sharing-text">
        {SHARING_TEXT[s()].text}
      </p>
    )}
  </Show>
</fieldset>
```

10. Consent checkboxes: change the first label to
    `I have the right to share this data under the option chosen above. *`,
    and the contact label to
    `The CaLab team may contact me about this recording.`.

11. Credit legend: `Credit (public for public recordings)`.

12. `DonationProgress` "done" text: replace `before it goes into the benchmark set`
    with `before it is used or published`.

13. `MyDonations` row: after `{statusLabel(row)}` add

```tsx
                  <Show when={row.sharing === 'lab'}>
                    {' '}
                    <span class="cala-donate__badge">CaLab only</span>
                  </Show>
                  <Show
                    when={row.status === 'published' && row.dandi_path && donationDandi ? row.dandi_path : null}
                  >
                    {(path) => (
                      <>
                        {' '}
                        <a href={dandiFolderUrl(donationDandi!, path())} target="_blank" rel="noopener noreferrer">
                          on DANDI
                        </a>
                      </>
                    )}
                  </Show>
```

14. Module doc comment at the top: replace "to the lab's cala benchmark set"
    with "to the CaLab team, public on DANDI or CaLab only".

`global.css`, next to the other `.cala-donate__*` rules:

```css
.cala-donate__choice {
  display: block;
  margin: 0.25rem 0;
}
.cala-donate__age {
  display: flex;
  gap: 0.5rem;
}
.cala-donate__age input {
  width: 6rem;
}
```

- [ ] **Step 4: Run the tests and lint**

Run: `npm test -w apps/cala -- donate-panel donation-encode donation-form donation-runner && npx eslint apps/cala/src/components/DonatePanel.tsx apps/cala/src/lib/donation-form.ts`
Expected: PASS, no lint errors.

- [ ] **Step 5: Commit**

```bash
git add apps/cala/src/components/DonatePanel.tsx apps/cala/src/lib/donation-runner.ts apps/cala/src/styles/global.css apps/cala/src/__tests__/donate-panel.test.tsx apps/cala/src/__tests__/donation-encode.test.ts
git commit -m "feat(cala): donors choose public on DANDI or CaLab only and describe the animal"
```

---

### Task 6: Admin app: sharing, subject and published

**Files:**

- Modify: `apps/admin/src/lib/donations.ts`, `apps/admin/src/components/DonationsView.tsx`,
  `apps/admin/src/components/DonationDrawer.tsx`
- Test: `apps/admin/src/__tests__/donations.test.ts`, `apps/admin/src/__tests__/donations-view.test.tsx`

**Interfaces:**

- Consumes: Task 3 `DonationRow`.
- Produces: `DONATION_STATUSES` includes `'published'` (last);
  `formatSharing(r: Pick<DonationRow, 'sharing'>): string`.

- [ ] **Step 1: Write the failing tests**

In `donations.test.ts`: in the `donation()` factory add
`sharing: 'public', subject_id: 'm7', subject_sex: 'F', subject_age: 'P90D', session_date: '2026-11-20', genotype: null, dandi_path: null, published_at: null,`
(keep `license: 'cc-by-4.0'`). Import `formatSharing` and add:

```ts
describe('sharing', () => {
  it('labels the choice', () => {
    expect(formatSharing(donation({ sharing: 'public' }))).toBe('public (DANDI)');
    expect(formatSharing(donation({ sharing: 'lab' }))).toBe('CaLab only');
  });

  it('counts published donations', () => {
    const counts = countByStatus([donation({ status: 'published' })]);
    expect(counts.published).toBe(1);
  });
});
```

In `donations-view.test.tsx`, update its row fixture the same way and assert
the table header contains `Sharing`.

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -w apps/admin -- donations`
Expected: FAIL (`formatSharing` not exported, no `published` count).

- [ ] **Step 3: Implement**

`donations.ts`: add `'published'` to the end of `DONATION_STATUSES`, and

```ts
export function formatSharing(r: Pick<DonationRow, 'sharing'>): string {
  return r.sharing === 'public' ? 'public (DANDI)' : 'CaLab only';
}
```

`DonationsView.tsx`: replace the `license` column with
`{ key: 'sharing', label: 'Sharing', format: (r) => formatSharing(r as DonationRow) },`
(import `formatSharing`).

`DonationDrawer.tsx`: after `['License', d.license],` add

```ts
    ['Sharing', formatSharing(d)],
    ['Animal', `${orDash(d.subject_id)}, sex ${orDash(d.subject_sex)}, age ${orDash(d.subject_age)}`],
    ['Recording date', orDash(d.session_date)],
    ['Genotype', orDash(d.genotype)],
    ['DANDI path', orDash(d.dandi_path)],
    ['Published', d.published_at ? d.published_at.slice(0, 19).replace('T', ' ') : '-'],
```

- [ ] **Step 4: Run the tests and the repo typecheck**

Run: `npm test -w apps/admin && npm run typecheck`
Expected: PASS; typecheck 0 errors across the repo.

- [ ] **Step 5: Commit**

```bash
git add apps/admin
git commit -m "feat(admin): show sharing choice, animal fields and DANDI publication of donations"
```

---

### Task 7: Browse page in cala

**Files:**

- Create: `apps/cala/src/lib/browse-donations.ts`
- Create: `apps/cala/src/components/BrowseDonations.tsx`
- Modify: `apps/cala/src/App.tsx` (start page, next to `MyDonationsEntry`)
- Modify: `.github/workflows/deploy.yml`, `e2e/build-site.mjs`, `.env.example`
- Modify: `apps/cala/src/styles/global.css`
- Test: `apps/cala/src/__tests__/browse-donations.test.ts`

**Interfaces:**

- Consumes: Task 3 `listPublicDonations`, `PublicDonation`, `donationDandi`,
  `loadDandiCollection`, `DandiCollection`, `dandiDownloadUrl`, `dandiViewUrl`,
  `acknowledgementText`.
- Produces:
  - `interface BrowseFilter { species: string; indicator: string; region: string }`
  - `interface BrowseRow { donation: PublicDonation; asset: DandiAsset | null }`
  - `joinRows(rows: PublicDonation[], coll: DandiCollection | null): BrowseRow[]`
  - `filterRows(rows: BrowseRow[], f: BrowseFilter): BrowseRow[]`
  - `distinct(rows: BrowseRow[], key: 'species' | 'indicator' | 'brain_region'): string[]`
  - component `BrowseDonationsEntry()`.

- [ ] **Step 1: Write the failing tests**

`apps/cala/src/__tests__/browse-donations.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { DandiCollection, PublicDonation } from '@calab/community';
import { distinct, filterRows, joinRows } from '../lib/browse-donations.ts';

function pd(over: Partial<PublicDonation>): PublicDonation {
  return {
    id: 'x',
    published_at: '2026-11-20T00:00:00Z',
    indicator: 'GCaMP8m',
    species: 'mouse',
    brain_region: 'M1',
    expression: null,
    preparation: null,
    behavior: null,
    scope: 'UCLA v4',
    fps: 20,
    width: 600,
    height: 600,
    n_frames: 1000,
    bytes_per_pixel: 1,
    depth_um: null,
    subject_sex: 'F',
    subject_age: 'P90D',
    genotype: null,
    credit_name: 'Jane Doe',
    credit_lab: 'Doe Lab',
    dandi_path: 'sub-a/a.nwb',
    ...over,
  };
}

const COLL: DandiCollection = {
  version: '0.1',
  citation: 'cite',
  doi: '10.48324/dandi.000999/0.1',
  assets: new Map([
    ['sub-a/a.nwb', { asset_id: 'a1', path: 'sub-a/a.nwb', size: 5, version: '0.1' }],
  ]),
};

describe('browse donations', () => {
  it('joins rows with their DANDI asset; unknown paths and no collection give no asset', () => {
    const rows = [pd({ id: '1' }), pd({ id: '2', dandi_path: 'sub-b/b.nwb' })];
    const joined = joinRows(rows, COLL);
    expect(joined[0].asset?.asset_id).toBe('a1');
    expect(joined[1].asset).toBeNull();
    expect(joinRows(rows, null).every((r) => r.asset === null)).toBe(true);
  });

  it('filters by species, indicator and region; empty filter keeps all', () => {
    const joined = joinRows(
      [pd({ id: '1' }), pd({ id: '2', species: 'rat', brain_region: 'CA1' })],
      COLL,
    );
    const all = { species: '', indicator: '', region: '' };
    expect(filterRows(joined, all)).toHaveLength(2);
    expect(filterRows(joined, { ...all, species: 'rat' }).map((r) => r.donation.id)).toEqual(['2']);
    expect(filterRows(joined, { ...all, region: 'M1' }).map((r) => r.donation.id)).toEqual(['1']);
  });

  it('lists distinct sorted values for the filters', () => {
    const joined = joinRows([pd({ species: 'rat' }), pd({ species: 'mouse' }), pd({})], null);
    expect(distinct(joined, 'species')).toEqual(['mouse', 'rat']);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -w apps/cala -- browse-donations`
Expected: FAIL (`Cannot find module '../lib/browse-donations.ts'`).

- [ ] **Step 3: Implement the pure part**

`apps/cala/src/lib/browse-donations.ts`:

```ts
// Rows of the "Browse donated recordings" list: published public donations
// (Supabase view) joined with their DANDI asset. A row without an asset still
// shows (DANDI down, or the file not visible yet), only without links.
import type { DandiAsset, DandiCollection, PublicDonation } from '@calab/community';

export interface BrowseFilter {
  species: string;
  indicator: string;
  region: string;
}

export interface BrowseRow {
  donation: PublicDonation;
  asset: DandiAsset | null;
}

export function joinRows(rows: PublicDonation[], coll: DandiCollection | null): BrowseRow[] {
  return rows.map((donation) => ({
    donation,
    asset: coll?.assets.get(donation.dandi_path) ?? null,
  }));
}

export function filterRows(rows: BrowseRow[], f: BrowseFilter): BrowseRow[] {
  return rows.filter(
    ({ donation: d }) =>
      (!f.species || d.species === f.species) &&
      (!f.indicator || d.indicator === f.indicator) &&
      (!f.region || d.brain_region === f.region),
  );
}

export function distinct(
  rows: BrowseRow[],
  key: 'species' | 'indicator' | 'brain_region',
): string[] {
  return [...new Set(rows.map((r) => r.donation[key]))].sort();
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -w apps/cala -- browse-donations`
Expected: PASS.

- [ ] **Step 5: Add the component and the start-page entry**

`apps/cala/src/components/BrowseDonations.tsx`:

```tsx
/**
 * "Browse donated recordings" on cala's start page: published public donations
 * with Download / View links on DANDI and a ready acknowledgement sentence
 * (apps/cala/docs/data-donation.md, "Browse page"). No sign-in needed.
 */
import { createResource, createSignal, For, Show, type JSX } from 'solid-js';
import {
  acknowledgementText,
  dandiDownloadUrl,
  dandiViewUrl,
  donationDandi,
  listPublicDonations,
  loadDandiCollection,
  type DandiCollection,
} from '@calab/community';
import { distinct, filterRows, joinRows, type BrowseFilter } from '../lib/browse-donations.ts';
import { formatBytes } from '../lib/donation-runner.ts';

async function load() {
  const rows = await listPublicDonations();
  let coll: DandiCollection | null = null;
  let dandiError: string | null = null;
  if (!donationDandi) dandiError = 'The DANDI collection is not set up yet.';
  else {
    try {
      coll = await loadDandiCollection(donationDandi);
    } catch (err) {
      dandiError = err instanceof Error ? err.message : String(err);
    }
  }
  return { rows: joinRows(rows, coll), coll, dandiError };
}

export function BrowseDonationsEntry(): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [data] = createResource(open, (o) => (o ? load() : undefined));
  const [filter, setFilter] = createSignal<BrowseFilter>({
    species: '',
    indicator: '',
    region: '',
  });
  const [copied, setCopied] = createSignal<string | null>(null);

  const shown = () => filterRows(data()?.rows ?? [], filter());
  const doi = () => data()?.coll?.doi ?? null;

  async function copy(id: string, text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
    } catch {
      window.prompt('Copy this acknowledgement:', text);
    }
  }

  const select = (label: string, key: keyof BrowseFilter, values: string[]) => (
    <label class="cala-browse__filter">
      {label}{' '}
      <select
        value={filter()[key]}
        onChange={(e) => setFilter({ ...filter(), [key]: e.currentTarget.value })}
      >
        <option value="">all</option>
        <For each={values}>{(v) => <option value={v}>{v}</option>}</For>
      </select>
    </label>
  );

  return (
    <section class="cala-donate-entry" data-testid="browse-donations">
      <button type="button" class="cala-donate__link" onClick={() => setOpen((v) => !v)}>
        {open() ? 'Hide donated recordings' : 'Browse donated recordings'}
      </button>
      <Show when={open()}>
        <Show when={!data.loading} fallback={<p class="cala-muted">Loading...</p>}>
          <Show
            when={!data.error}
            fallback={
              <div class="error-card" role="alert">
                {String(data.error?.message ?? data.error)}
              </div>
            }
          >
            <div class="cala-browse__cite" data-testid="browse-cite">
              <strong>How to cite.</strong> If you use these recordings, cite the collection
              {doi() ? ` (doi:${doi()})` : ''} and acknowledge the contributing lab ("Copy
              acknowledgement" below). They are shared under CC BY 4.0.
              <Show when={data()?.coll?.citation}>{(c) => <p class="cala-muted">{c()}</p>}</Show>
            </div>
            <Show when={data()?.dandiError}>
              {(m) => <p class="cala-warning">{m()} Recordings are listed without links.</p>}
            </Show>
            <div class="cala-browse__filters">
              {select('Species', 'species', distinct(data()?.rows ?? [], 'species'))}
              {select('Indicator', 'indicator', distinct(data()?.rows ?? [], 'indicator'))}
              {select('Region', 'region', distinct(data()?.rows ?? [], 'brain_region'))}
            </div>
            <Show
              when={shown().length > 0}
              fallback={<p class="cala-muted">No published recordings yet.</p>}
            >
              <ul class="cala-donate__list">
                <For each={shown()}>
                  {(r) => (
                    <li class="cala-donate__item" data-testid="browse-row">
                      <span>
                        {r.donation.indicator}, {r.donation.species}, {r.donation.brain_region},{' '}
                        {r.donation.scope}{' '}
                        <span class="cala-muted">
                          ({r.donation.n_frames.toLocaleString()} frames at {r.donation.fps} Hz
                          {r.asset ? `, ${formatBytes(r.asset.size)}` : ''}) from{' '}
                          {r.donation.credit_lab ?? 'a donor lab'}
                        </span>
                      </span>
                      <span class="cala-donate__status">
                        <Show when={r.asset && donationDandi ? r.asset : null}>
                          {(a) => (
                            <>
                              <a href={dandiDownloadUrl(donationDandi!, a())}>Download</a>{' '}
                              <a
                                href={dandiViewUrl(donationDandi!, a())}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                View
                              </a>{' '}
                            </>
                          )}
                        </Show>
                        <Show when={donationDandi}>
                          {(cfg) => (
                            <button
                              type="button"
                              class="btn-secondary btn-small"
                              onClick={() =>
                                void copy(
                                  r.donation.id,
                                  acknowledgementText(r.donation, cfg(), doi()),
                                )
                              }
                            >
                              {copied() === r.donation.id ? 'Copied' : 'Copy acknowledgement'}
                            </button>
                          )}
                        </Show>
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </Show>
      </Show>
    </section>
  );
}
```

`App.tsx`: import `BrowseDonationsEntry` from `./components/BrowseDonations.tsx`
and, inside the existing `<Show when={donation && screen() === 'open'}>` block
next to `<MyDonationsEntry donation={donation!} />`, add
`<BrowseDonationsEntry />` after it (wrap both in a fragment `<>...</>`).

`global.css`:

```css
.cala-browse__filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin: 0.5rem 0;
}
.cala-browse__cite {
  margin: 0.5rem 0;
  font-size: 0.9em;
}
```

Build config:

- `.env.example`: add `VITE_DONATION_DANDISET=` and
  `VITE_DONATION_DANDI_INSTANCE=` (comment: `dandi` or `sandbox`).
- `e2e/build-site.mjs`: add `VITE_DONATION_DANDISET: ''` and
  `VITE_DONATION_DANDI_INSTANCE: ''` next to the other blanked donation vars.
- `.github/workflows/deploy.yml`, next to `VITE_DONATION_SUPABASE_ANON_KEY`:

```yaml
VITE_DONATION_DANDISET: ${{ vars.DONATION_DANDISET || '' }}
VITE_DONATION_DANDI_INSTANCE: ${{ vars.DONATION_DANDI_INSTANCE || 'dandi' }}
```

(Repository _variables_, not secrets: both values are public. Until the
dandiset exists the browse page says "The DANDI collection is not set up
yet.")

- [ ] **Step 6: Run the cala tests and lint, then commit**

Run: `npm test -w apps/cala && npx eslint apps/cala/src/components/BrowseDonations.tsx apps/cala/src/lib/browse-donations.ts apps/cala/src/App.tsx`
Expected: PASS, no lint errors.

```bash
git add apps/cala .github/workflows/deploy.yml e2e/build-site.mjs .env.example
git commit -m "feat(cala): browse published donated recordings with DANDI links and acknowledgement"
```

---

### Task 8: NWB conversion and DANDI upload script

**Files:**

- Create: `python/scripts/donation_to_nwb.py`
- Test: `python/tests/test_donation_to_nwb.py`
- Modify: `python/pyproject.toml` (`nwb` extra; add to `dev`)
- Modify: `.github/workflows/ci.yml` (python job: `pip install ... pynwb nwbinspector`)

**Interfaces:**

- Consumes: `ingest_donations.IngestApi`, `default_opener` (same folder);
  `_calaraw.iter_calaraw`, `CalarawMeta`; stored donation folder from ingest:
  `<store>/<id>/` with chunk files, `meta.json` (has `"sharing"` from Task 5),
  `donation.json` (the row at ingest, has `sharing` and subject fields from
  Task 2). Edge action `ingest_published`.
- Produces: CLI
  `donation_to_nwb.py <donation_id> --store DIR --work DIR --dandiset NNNNNN --instance {dandi,dandi-sandbox} [--no-upload]`
  and functions `scientific_species(str) -> str`, `lab_slug(str) -> str`,
  `nwb_relpath(row) -> str`, `check_public(row, meta) -> None`,
  `write_nwb(donation_dir, row, out) -> None`, `verify_nwb(donation_dir, out) -> None`,
  `inspect_nwb(out) -> list[str]`, `convert(...)`.

- [ ] **Step 1: Dependencies**

`python/pyproject.toml`: add `nwb = ["pynwb>=2.8", "nwbinspector>=0.6"]` to
`[project.optional-dependencies]` and append `"pynwb>=2.8", "nwbinspector>=0.6"`
to `dev`. `.github/workflows/ci.yml`, python job install line: append
`pynwb nwbinspector`. Locally:

```bash
cd python && uv pip install "pynwb>=2.8" "nwbinspector>=0.6"
```

(The `dandi` CLI is only needed on solaris for upload; tests fake it.)

- [ ] **Step 2: Write the failing tests**

`python/tests/test_donation_to_nwb.py`:

```python
"""Tests for python/scripts/donation_to_nwb.py (data donation, DANDI publishing)."""

from __future__ import annotations

import gzip
import importlib.util
import json
import struct
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pytest

pynwb = pytest.importorskip("pynwb")

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))


def _load(name: str) -> Any:
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


nwb = _load("donation_to_nwb")

DONATION_ID = "abcdef12-1111-4111-8111-111111111111"
HEADER = struct.Struct("<8sIIIIIBBHd")


def write_calaraw(directory: Path, frames: np.ndarray, fps: float, per_chunk: int = 7) -> None:
    """Chunk files with predictor 0 (raw), like the browser writes with predictor 1."""
    n, h, w = frames.shape
    bpp = frames.dtype.itemsize
    for c, start in enumerate(range(0, n, per_chunk)):
        part = frames[start : start + per_chunk]
        header = HEADER.pack(b"CALARAW1", w, h, start, len(part), n, bpp, 0, 0, fps)
        data = header + part.astype(f"<u{bpp}").tobytes()
        (directory / f"frames-{c:04d}.calaraw.gz").write_bytes(gzip.compress(data))


def row(**over: Any) -> dict[str, Any]:
    base = {
        "id": DONATION_ID,
        "status": "approved",
        "sharing": "public",
        "license": "cc-by-4.0",
        "indicator": "GCaMP8m",
        "species": "mouse",
        "brain_region": "M1",
        "scope": "UCLA v4",
        "behavior": "open field",
        "notes": None,
        "fps": 20.0,
        "width": 6,
        "height": 4,
        "n_frames": 0,
        "bytes_per_pixel": 1,
        "subject_id": "m7",
        "subject_sex": "F",
        "subject_age": "P90D",
        "session_date": "2026-11-20",
        "genotype": None,
        "credit_name": "Jane Doe",
        "credit_lab": "Doe Lab, UCLA",
    }
    base.update(over)
    return base


def stored(tmp_path: Path, frames: np.ndarray, **over: Any) -> tuple[Path, dict[str, Any]]:
    d = tmp_path / "store" / DONATION_ID
    d.mkdir(parents=True)
    r = row(n_frames=frames.shape[0], bytes_per_pixel=frames.dtype.itemsize, **over)
    write_calaraw(d, frames, r["fps"])
    (d / "donation.json").write_text(json.dumps(r))
    (d / "meta.json").write_text(json.dumps({"format": "cala-donation-meta", "sharing": r["sharing"]}))
    return d, r


def frames_u8(n: int) -> np.ndarray:
    rng = np.random.default_rng(1)
    return rng.integers(0, 256, size=(n, 4, 6), dtype=np.uint8)


# ---------------------------------------------------------------------------
# Naming
# ---------------------------------------------------------------------------


def test_species_names() -> None:
    assert nwb.scientific_species("mouse") == "Mus musculus"
    assert nwb.scientific_species("Rat") == "Rattus norvegicus"
    assert nwb.scientific_species("zebrafish larva") == "Danio rerio"
    assert nwb.scientific_species("Mus musculus") == "Mus musculus"
    with pytest.raises(nwb.ConversionError, match="species"):
        nwb.scientific_species("songbird")


@pytest.mark.parametrize(
    ("lab", "slug"),
    [
        ("Doe Lab, UCLA", "doe-lab-ucla"),
        ("Müller Lab", "m-ller-lab"),
        ("!!!", "lab"),
        ("A" * 40, "a" * 24),
    ],
)
def test_lab_slug(lab: str, slug: str) -> None:
    assert nwb.lab_slug(lab) == slug


def test_nwb_relpath_is_a_valid_dandi_path() -> None:
    path = nwb.nwb_relpath(row(credit_lab="Müller Lab, Zürich!"))
    assert path == "sub-m-ller-lab-z-rich-m7/sub-m-ller-lab-z-rich-m7_ses-20261120-abcdef12_ophys.nwb"
    assert nwb.DANDI_PATH.fullmatch(path)


# ---------------------------------------------------------------------------
# Safety: CaLab-only never converts
# ---------------------------------------------------------------------------


def test_lab_donations_are_refused(tmp_path: Path) -> None:
    d, r = stored(tmp_path, frames_u8(5), sharing="lab", license="lab-use-only")
    with pytest.raises(nwb.ConversionError, match="CaLab only"):
        nwb.check_public(r, json.loads((d / "meta.json").read_text()))
    # Row says public but meta.json says lab: refused too.
    with pytest.raises(nwb.ConversionError, match="CaLab only"):
        nwb.check_public(row(), {"sharing": "lab"})


def test_missing_subject_fields_are_refused() -> None:
    with pytest.raises(nwb.ConversionError, match="subject_age"):
        nwb.check_public(row(subject_age=None), {"sharing": "public"})


# ---------------------------------------------------------------------------
# Writing and verifying
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("n", [5, 16, 37])
def test_write_and_verify_round_trip(tmp_path: Path, n: int) -> None:
    frames = frames_u8(n)
    d, r = stored(tmp_path, frames)
    out = tmp_path / "out.nwb"
    nwb.write_nwb(d, r, out)
    nwb.verify_nwb(d, out)
    with pynwb.NWBHDF5IO(str(out), "r") as io:
        f = io.read()
        series = f.acquisition["OnePhotonSeries"]
        assert series.rate == 20.0
        np.testing.assert_array_equal(series.data[:], frames)
        assert series.data.chunks == (min(16, n), 4, 6)
        assert series.data.compression == "gzip"
        assert f.subject.species == "Mus musculus"
        assert f.subject.subject_id == "doe-lab-ucla-m7"
        assert f.subject.sex == "F"
        assert f.subject.age == "P90D"
        assert f.identifier == DONATION_ID
        assert f.session_start_time.isoformat() == "2026-11-20T00:00:00+00:00"
        assert f.imaging_planes["ImagingPlane"].location == "M1"


def test_write_uint16(tmp_path: Path) -> None:
    frames = np.arange(3 * 4 * 6, dtype=np.uint16).reshape(3, 4, 6) * 1000
    d, r = stored(tmp_path, frames)
    out = tmp_path / "out.nwb"
    nwb.write_nwb(d, r, out)
    nwb.verify_nwb(d, out)


def test_verify_catches_a_changed_frame(tmp_path: Path) -> None:
    frames = frames_u8(5)
    d, r = stored(tmp_path, frames)
    out = tmp_path / "out.nwb"
    nwb.write_nwb(d, r, out)
    changed = frames.copy()
    changed[2, 0, 0] ^= 1
    for f in d.glob("frames-*.calaraw.gz"):
        f.unlink()
    write_calaraw(d, changed, 20.0)
    with pytest.raises(nwb.ConversionError, match="frame 2"):
        nwb.verify_nwb(d, out)


def test_inspector_finds_no_critical_issue(tmp_path: Path) -> None:
    d, r = stored(tmp_path, frames_u8(5))
    out = tmp_path / "out.nwb"
    nwb.write_nwb(d, r, out)
    assert nwb.inspect_nwb(out) == []


# ---------------------------------------------------------------------------
# Upload and publish
# ---------------------------------------------------------------------------


class FakeApi:
    def __init__(self, answer: Exception | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self.answer = answer

    def call(self, action: str, **body: Any) -> dict[str, Any]:
        self.calls.append({"action": action, **body})
        if self.answer:
            raise self.answer
        return {"status": "published"}


def test_convert_uploads_and_marks_published(tmp_path: Path) -> None:
    d, r = stored(tmp_path, frames_u8(5))
    ran: list[tuple[list[str], Path]] = []
    api = FakeApi()
    path = nwb.convert(
        DONATION_ID,
        store=tmp_path / "store",
        work=tmp_path / "work",
        dandiset="000999",
        instance="dandi-sandbox",
        api=api,
        run=lambda cmd, cwd: ran.append((cmd, cwd)),
    )
    assert path == nwb.nwb_relpath(r)
    dandiset_dir = tmp_path / "work" / "000999"
    assert (dandiset_dir / path).is_file()
    assert ran[0][0][:2] == ["dandi", "download"]
    assert ran[1] == (["dandi", "validate", path], dandiset_dir)
    assert ran[2] == (["dandi", "upload", "-i", "dandi-sandbox", path], dandiset_dir)
    assert api.calls == [{"action": "ingest_published", "donation_id": DONATION_ID, "dandi_path": path}]


def test_convert_again_reuses_the_file_and_accepts_already_published(tmp_path: Path) -> None:
    stored(tmp_path, frames_u8(5))
    kwargs = dict(
        store=tmp_path / "store",
        work=tmp_path / "work",
        dandiset="000999",
        instance="dandi-sandbox",
        run=lambda cmd, cwd: None,
    )
    nwb.convert(DONATION_ID, api=FakeApi(), **kwargs)
    out = next((tmp_path / "work" / "000999").rglob("*.nwb"))
    mtime = out.stat().st_mtime_ns
    already = nwb.ApiError("ingest_published: HTTP 409 donation is already published")
    nwb.convert(DONATION_ID, api=FakeApi(already), **kwargs)
    assert out.stat().st_mtime_ns == mtime


def test_convert_with_no_upload_stops_after_writing(tmp_path: Path) -> None:
    stored(tmp_path, frames_u8(5))
    api = FakeApi()
    ran: list[Any] = []
    nwb.convert(
        DONATION_ID,
        store=tmp_path / "store",
        work=tmp_path / "work",
        dandiset="000999",
        instance="dandi-sandbox",
        api=api,
        run=lambda cmd, cwd: ran.append(cmd),
        upload=False,
    )
    assert api.calls == []
    assert all(cmd[1] != "upload" for cmd in ran)
```

- [ ] **Step 3: Run them to see them fail**

Run: `cd python && .venv/bin/pytest tests/test_donation_to_nwb.py -q`
Expected: FAIL (`No such file ... donation_to_nwb.py`).

- [ ] **Step 4: Implement**

`python/scripts/donation_to_nwb.py`:

```python
#!/usr/bin/env python3
"""Convert one ingested public cala donation to NWB and publish it on DANDI.

See ``apps/cala/docs/data-donation.md`` ("NWB conversion and DANDI upload").
Runs on the lab server after ``ingest_donations.py`` stored the donation:

1. refuses unless both ``donation.json`` and ``meta.json`` say ``public``;
2. writes ``<work>/<dandiset>/sub-.../...ophys.nwb`` (OnePhotonSeries, chunks
   of 16 frames, gzip 4), unless a verified file is already there;
3. checks it: every frame read back equals the CALARAW source, and
   nwbinspector reports nothing critical;
4. ``dandi validate`` and ``dandi upload`` into the dandiset's draft;
5. calls the edge function's ``ingest_published`` with the path.

Environment: SUPABASE_URL, SUPABASE_ANON_KEY, INGEST_TOKEN (as for ingest),
and DANDI_API_KEY for ``dandi upload``. Example::

    set -a; . ~/calab-ingest/ingest.env; set +a
    ~/calab-ingest/.venv/bin/python ~/calab-ingest/donation_to_nwb.py <donation id> \\
        --store /mnt/data_1/mbrosch/calab_donations \\
        --work /mnt/data_1/mbrosch/calab_nwb --dandiset 000999 --instance dandi-sandbox

The stored donation stays read-only; NWB is written under ``--work`` only.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import subprocess
import sys
from collections.abc import Callable, Iterator
from datetime import UTC, date, datetime, time
from pathlib import Path
from typing import Any, Protocol

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ingest_donations import ApiError, IngestApi, _load_calaraw, default_opener  # noqa: E402

__all__ = ["ApiError", "ConversionError", "convert"]

CHUNK_FRAMES = 16
GZIP_LEVEL = 4
DANDI_PATH = re.compile(r"^sub-[A-Za-z0-9-]+/[A-Za-z0-9_.+-]+\.nwb$")
SUBJECT_FIELDS = ("subject_id", "subject_sex", "subject_age", "session_date")

#: Common names in cala's species list -> the scientific names DANDI expects.
#: A species missing here stops the conversion; add it rather than guess.
SPECIES = {
    "mouse": "Mus musculus",
    "rat": "Rattus norvegicus",
    "zebrafish": "Danio rerio",
    "zebrafish larva": "Danio rerio",
    "drosophila": "Drosophila melanogaster",
    "c. elegans": "Caenorhabditis elegans",
    "macaque": "Macaca mulatta",
    "marmoset": "Callithrix jacchus",
    "ferret": "Mustela putorius furo",
    "cat": "Felis catus",
    "guinea pig": "Cavia porcellus",
    "hamster": "Mesocricetus auratus",
    "rabbit": "Oryctolagus cuniculus",
}
BINOMIAL = re.compile(r"^[A-Z][a-z]+ [a-z]+( [a-z]+)?$")


class ConversionError(Exception):
    """The donation cannot be converted or published (message says why)."""


class Api(Protocol):
    def call(self, action: str, **body: Any) -> dict[str, Any]: ...


Runner = Callable[[list[str], Path], None]


# ---------------------------------------------------------------------------
# Naming
# ---------------------------------------------------------------------------


def scientific_species(species: str) -> str:
    name = species.strip()
    if BINOMIAL.match(name):
        return name
    try:
        return SPECIES[name.lower()]
    except KeyError:
        raise ConversionError(
            f"unknown species {species!r}: add its scientific name to SPECIES"
        ) from None


def lab_slug(lab: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", lab.lower()).strip("-")[:24].strip("-")
    return slug or "lab"


def nwb_relpath(row: dict[str, Any]) -> str:
    subject = f"{lab_slug(row.get('credit_lab') or '')}-{row['subject_id']}"
    session = f"{str(row['session_date']).replace('-', '')}-{row['id'][:8]}"
    return f"sub-{subject}/sub-{subject}_ses-{session}_ophys.nwb"


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------


def check_public(row: dict[str, Any], meta: dict[str, Any]) -> None:
    if row.get("sharing") != "public" or meta.get("sharing") != "public":
        raise ConversionError("donation is CaLab only (or unmarked): never published")
    for key in SUBJECT_FIELDS:
        if not row.get(key):
            raise ConversionError(f"donation has no {key}; DANDI needs it")


def load_stored(donation_dir: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    try:
        row = json.loads((donation_dir / "donation.json").read_text())
        meta = json.loads((donation_dir / "meta.json").read_text())
    except (OSError, ValueError) as e:
        raise ConversionError(f"cannot read the stored donation: {e}") from e
    if not isinstance(row, dict) or not isinstance(meta, dict):
        raise ConversionError("donation.json and meta.json must be JSON objects")
    return row, meta


# ---------------------------------------------------------------------------
# NWB
# ---------------------------------------------------------------------------


def _frames(donation_dir: Path) -> Iterator[np.ndarray]:
    for _, chunk in _load_calaraw().iter_calaraw(donation_dir):
        yield from chunk


def write_nwb(donation_dir: Path, row: dict[str, Any], out: Path) -> None:
    from hdmf.backends.hdf5.h5_utils import H5DataIO
    from hdmf.data_utils import DataChunkIterator
    from pynwb import NWBHDF5IO, NWBFile
    from pynwb.file import Subject
    from pynwb.ophys import OnePhotonSeries, OpticalChannel

    n, h, w = int(row["n_frames"]), int(row["height"]), int(row["width"])
    dtype = np.dtype("uint8" if int(row["bytes_per_pixel"]) == 1 else "uint16")
    fps = float(row["fps"])
    subject = f"{lab_slug(row.get('credit_lab') or '')}-{row['subject_id']}"
    start = datetime.combine(date.fromisoformat(str(row["session_date"])), time(0, tzinfo=UTC))

    nwbfile = NWBFile(
        session_description=row.get("behavior") or "calcium imaging recording",
        identifier=row["id"],
        session_start_time=start,
        lab=row.get("credit_lab"),
        experimenter=[row["credit_name"]] if row.get("credit_name") else None,
        experiment_description=(
            "One-photon calcium imaging donated through CaLab (cala). "
            "Raw frames as recorded, lossless."
        ),
        keywords=["calcium imaging", "one-photon", "CaLab donation"],
        notes=row.get("notes"),
    )
    nwbfile.subject = Subject(
        subject_id=subject,
        species=scientific_species(row["species"]),
        sex=row["subject_sex"],
        age=row["subject_age"],
        genotype=row.get("genotype"),
        description=f"donor's label: {row['subject_id']}",
    )
    device = nwbfile.create_device(name="Microscope", description=row["scope"])
    channel = OpticalChannel(
        name="OpticalChannel", description=row["indicator"], emission_lambda=math.nan
    )
    plane = nwbfile.create_imaging_plane(
        name="ImagingPlane",
        optical_channel=channel,
        description=f"{row['indicator']} in {row['brain_region']}",
        device=device,
        excitation_lambda=math.nan,
        imaging_rate=fps,
        indicator=row["indicator"],
        location=row["brain_region"],
    )
    data = H5DataIO(
        DataChunkIterator(
            data=_frames(donation_dir), maxshape=(n, h, w), dtype=dtype, buffer_size=CHUNK_FRAMES
        ),
        chunks=(min(CHUNK_FRAMES, n), h, w),
        compression="gzip",
        compression_opts=GZIP_LEVEL,
    )
    nwbfile.add_acquisition(
        OnePhotonSeries(
            name="OnePhotonSeries",
            data=data,
            imaging_plane=plane,
            unit="n.a.",
            rate=fps,
            starting_time=0.0,
            description="raw frames as recorded",
        )
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".nwb.part")
    with NWBHDF5IO(str(tmp), "w") as io:
        io.write(nwbfile)
    tmp.replace(out)


def verify_nwb(donation_dir: Path, out: Path) -> None:
    """Every frame in the NWB file equals the CALARAW source, and the counts agree."""
    from pynwb import NWBHDF5IO

    with NWBHDF5IO(str(out), "r") as io:
        data = io.read().acquisition["OnePhotonSeries"].data
        i = 0
        # Compare a CALARAW chunk at a time: reading frame by frame would
        # inflate each 16-frame HDF5 chunk 16 times.
        for _, chunk in _load_calaraw().iter_calaraw(donation_dir):
            n = len(chunk)
            if i + n > data.shape[0]:
                raise ConversionError(f"NWB has {data.shape[0]} frames, the donation more")
            diff = (data[i : i + n] != chunk).reshape(n, -1).any(axis=1)
            if diff.any():
                raise ConversionError(
                    f"frame {i + int(np.argmax(diff))} differs between NWB and the donation"
                )
            i += n
        if i != data.shape[0]:
            raise ConversionError(f"NWB has {data.shape[0]} frames, the donation {i}")


def inspect_nwb(out: Path) -> list[str]:
    """nwbinspector messages that block publishing (critical or errors)."""
    from nwbinspector import inspect_nwbfile

    return [
        f"{m.importance.name}: {m.message}"
        for m in inspect_nwbfile(nwbfile_path=str(out))
        if m.importance.name in {"CRITICAL", "ERROR"}
    ]


# ---------------------------------------------------------------------------
# Convert, upload, publish
# ---------------------------------------------------------------------------


def run_command(cmd: list[str], cwd: Path) -> None:
    result = subprocess.run(cmd, cwd=cwd, check=False)
    if result.returncode != 0:
        raise ConversionError(f"{' '.join(cmd)} failed with exit code {result.returncode}")


def dandi_url(dandiset: str, instance: str) -> str:
    host = "sandbox.dandiarchive.org" if instance == "dandi-sandbox" else "dandiarchive.org"
    return f"https://{host}/dandiset/{dandiset}/draft"


def convert(
    donation_id: str,
    *,
    store: Path,
    work: Path,
    dandiset: str,
    instance: str,
    api: Api,
    run: Runner = run_command,
    upload: bool = True,
) -> str:
    """Convert, check, upload and mark one donation published. Returns its DANDI path."""
    donation_dir = store / donation_id
    row, meta = load_stored(donation_dir)
    if row.get("id") != donation_id:
        raise ConversionError("donation.json belongs to another donation")
    check_public(row, meta)
    path = nwb_relpath(row)
    dandiset_dir = work / dandiset
    if not (dandiset_dir / "dandiset.yaml").exists():
        dandiset_dir.parent.mkdir(parents=True, exist_ok=True)
        run(
            ["dandi", "download", "--download", "dandiset.yaml", dandi_url(dandiset, instance)],
            work,
        )
    out = dandiset_dir / path
    if out.exists():
        verify_nwb(donation_dir, out)  # reuse a file from an earlier run
    else:
        write_nwb(donation_dir, row, out)
        verify_nwb(donation_dir, out)
    problems = inspect_nwb(out)
    if problems:
        raise ConversionError("nwbinspector: " + "; ".join(problems))
    run(["dandi", "validate", path], dandiset_dir)
    if not upload:
        return path
    run(["dandi", "upload", "-i", instance, path], dandiset_dir)
    try:
        api.call("ingest_published", donation_id=donation_id, dandi_path=path)
    except ApiError as e:
        if "already published" not in str(e):
            raise
    return path


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("donation_id")
    p.add_argument("--store", type=Path, required=True, help="ingest destination folder")
    p.add_argument("--work", type=Path, required=True, help="folder for NWB files")
    p.add_argument("--dandiset", required=True, help="6-digit dandiset id")
    p.add_argument("--instance", choices=["dandi", "dandi-sandbox"], default="dandi")
    p.add_argument("--no-upload", action="store_true", help="write and check only")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if not re.fullmatch(r"\d{6}", args.dandiset):
        print("--dandiset must be 6 digits", file=sys.stderr)
        return 2
    try:
        api = IngestApi(
            supabase_url=os.environ["SUPABASE_URL"],
            anon_key=os.environ["SUPABASE_ANON_KEY"],
            ingest_token=os.environ["INGEST_TOKEN"],
            opener=default_opener(60.0),
        )
    except KeyError as e:
        print(f"missing environment variable {e}", file=sys.stderr)
        return 2
    try:
        path = convert(
            args.donation_id,
            store=args.store,
            work=args.work,
            dandiset=args.dandiset,
            instance=args.instance,
            api=api,
            upload=not args.no_upload,
        )
    except (ConversionError, ApiError) as e:
        print(f"{args.donation_id}: {e}", file=sys.stderr)
        return 1
    print(f"{args.donation_id}: {'published' if not args.no_upload else 'written'} {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

Notes for the implementer:

- `_load_calaraw` already exists in `ingest_donations.py` (it is a private
  helper; importing it is intended so the lab server needs only the two
  scripts and `_calaraw.py`).
- If `inspect_nwb` reports a critical message on the test file that comes from
  the NaN wavelengths, keep the NaN (the spec says unknown → NaN) and filter
  only that check by name in `inspect_nwb`, with a comment; do not invent
  wavelengths.
- If `datetime.UTC` is missing (Python 3.10), it is not: the project needs
  3.11+.

- [ ] **Step 5: Run the tests, ruff and mypy**

Run:

```bash
cd python
.venv/bin/pytest tests/test_donation_to_nwb.py tests/test_ingest_donations.py -q
.venv/bin/ruff format scripts/donation_to_nwb.py tests/test_donation_to_nwb.py
.venv/bin/ruff check --fix scripts/ tests/
```

Expected: all pass; ruff clean.

- [ ] **Step 6: Commit**

```bash
git add python/scripts/donation_to_nwb.py python/tests/test_donation_to_nwb.py python/pyproject.toml .github/workflows/ci.yml
git commit -m "feat(python): convert public donations to NWB and publish them on DANDI"
```

---

### Task 9: Docs, full checks, push, sandbox run

**Files:**

- Modify: `apps/cala/docs/data-donation.md` (status line; NWB uses `rate`
  only, `timestamps.csv` stays on solaris; fingerprint note)
- Modify: `docs/CHANGELOG.md` (Unreleased/Added: replace the donation entry)
- Modify: `apps/cala/README.md`, `apps/cala/USER_GUIDE.md` (donation
  paragraphs: sharing choice, browse page; no co-authorship)
- Modify: `supabase/README.md` (donation secrets section: mention 021 and
  `ingest_published`)

- [ ] **Step 1: Docs**

1. `data-donation.md`:
   - Status line: "Part A built (date); not yet run against DANDI".
   - In "NWB conversion", step 2: replace "`rate` = fps, or `timestamps`
     when the donation has them" with "`rate` = fps (cala derives it from the
     timestamps when present); `timestamps.csv` stays with the donation on
     solaris".
   - Under "Metadata": "Migrations 020/021 are not in `schema_fingerprint()`
     (019): that panel checks the main project, which has no donation
     tables."
2. `CHANGELOG.md` Unreleased/Added, replace the donation bullet with:
   "**Donate data (cala):** send a recording to the CaLab team from the Run
   tab, either public on DANDI (CC BY 4.0, citable, listed under 'Browse
   donated recordings') or CaLab only."
3. `apps/cala/README.md`, `USER_GUIDE.md`: same content in their style;
   remove any co-authorship sentence (`grep -rn -i "co-author" apps/cala`
   must print nothing outside `docs/` history).

- [ ] **Step 2: Full check suite**

Run (repo root):

```bash
npm run typecheck
npm run lint
npx prettier --check .
npm test
(cd supabase/functions/donation && deno test --allow-env --allow-net index.test.ts)
./scripts/test-rls.sh
(cd python && .venv/bin/pytest -m "not integration" -q && .venv/bin/ruff check src/ tests/ scripts/)
```

Expected: every command exits 0. Fix anything red before going on.

- [ ] **Step 3: Commit and push**

```bash
git add -A apps/cala/docs docs/CHANGELOG.md apps/cala/README.md apps/cala/USER_GUIDE.md supabase/README.md
git commit -m "docs(cala): donation docs for public DANDI sharing"
git push
```

Then check PR #452 is no longer conflicted and its CI goes green.

- [ ] **Step 4: Sandbox end-to-end run (needs Marcel: DANDI accounts, solaris)**

1. Marcel: account on `sandbox.dandiarchive.org`, create a dandiset "CaLab
   donated recordings (test)", CC BY 4.0, with the description stating the
   citation and acknowledgement request (spec, "Citation and
   acknowledgement"); put its API key in `~/calab-ingest/ingest.env` as
   `DANDI_API_KEY=...`. After step 5, add the test donor as a contributor
   (role "Data Collector", included in the citation) on the dandiset page.
2. Apply `021_cala_donations_public.sql` in the donation project's SQL editor
   and redeploy the edge function
   (`supabase functions deploy donation --project-ref wdvqmppmevzqphcwobix`).
3. solaris: copy `donation_to_nwb.py` next to `ingest_donations.py` in
   `~/calab-ingest`; `~/calab-ingest/.venv/bin/pip install pynwb nwbinspector dandi`.
4. Local cala (`cala-donate` launch config, port 5174) with
   `VITE_DONATION_DANDISET=<sandbox id>` and `VITE_DONATION_DANDI_INSTANCE=sandbox`
   in `.env`: donate a short synthetic V4 recording as **public**, approve it
   in admin, wait for (or run) the hourly ingest.
5. solaris: run the script with `--instance dandi-sandbox`. Expected:
   `published sub-.../..._ophys.nwb`.
6. cala start page → "Browse donated recordings": the row shows; Download
   returns the file; View opens it in Neurosift (if Neurosift needs a different
   URL for the sandbox, fix `dandiViewUrl` and its test); "Copy
   acknowledgement" gives the sentence.
7. Donate a second recording as **CaLab only**: it ingests, the script
   refuses it ("CaLab only"), it never appears on the browse page.
8. Record the outcome in `data-donation.md` "To go live" and commit.

```

```
