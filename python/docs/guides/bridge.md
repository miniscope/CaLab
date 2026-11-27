# The browser bridge

`calab.tune()` and `calab.decon()` start a small HTTP server on `127.0.0.1`,
open the web app with `?bridge=` pointing at it, and wait for the app to send
its results back. This page covers how apps are registered and how the bridge
checks that the app's results are safe for your installed `calab` to read.

## Version compatibility

The web apps at calab.miniscope.org always run their latest build, while `calab` is
whatever version you installed with pip. Before the bridge accepts results it
compares two versions:

| Check          | App sends                            | Compared against                        | Required |
| -------------- | ------------------------------------ | --------------------------------------- | -------- |
| Result schema  | `schema_version` in the results JSON | the schema this `calab` was written for | yes      |
| Solver version | `solver_version` in the results JSON | `calab._solver.protocol_version()`      | no       |

Both use Cargo's caret rule: versions are compatible when the major matches
(and, while the major is `0`, the minor too).

- **Incompatible** -- the call raises `calab.BridgeVersionError` and the
  app's upload is refused with HTTP 409. The message says which side to
  upgrade: usually `pip install --upgrade calab` when the app is newer, or
  rebuilding/updating the app when you pointed `app_url=` at an older build.
- **Compatible but different** -- the results are accepted and a
  `calab.BridgeVersionWarning` is emitted.
- **Missing `schema_version`** -- rejected, since the payload cannot be
  checked.
- **Missing `solver_version`** -- the solver check is skipped. The deployed
  apps do not send it yet.

To turn the warnings into errors (e.g. in a pipeline):

```python
import warnings
import calab

warnings.simplefilter("error", calab.BridgeVersionWarning)
```

### One solver version

The solver's version is `version` in `crates/solver/Cargo.toml`. It is
exported once (`SOLVER_VERSION` in the crate) and surfaced as
`solver_version()` in the WASM build and as `calab._solver.__version__` /
`calab._solver.protocol_version()` in the Python extension. The `calab`
package version (`py/v*` tags) and the web app release (`v*` tags) are
separate and are not compared.

## App registry

Every app the bridge knows about is one entry in
`calab/_bridge/_registry.py`, keyed by lowercase slug. The URLs below are the
built-in defaults; the deployed site can update them (see "The app manifest"
below):

| Slug      | Deployed at                            | Results schema          |
| --------- | -------------------------------------- | ----------------------- |
| `catune`  | `https://calab.miniscope.org/CaTune/`  | `catune-export` 1.2.0   |
| `cadecon` | `https://calab.miniscope.org/CaDecon/` | `cadecon-results` 2     |
| `cabana`  | `https://calab.miniscope.org/CaBaNA/`  | none (no bridge export) |

An app posts its results to the generic routes:

- `POST /api/v1/results/{slug}/{array}` -- zero or more `.npy` arrays the
  entry declares (CaDecon: `activity`), sent first;
- `POST /api/v1/results/{slug}` -- the JSON results, which completes the call.

`GET /api/v1/status` reports the session's app, these routes, the expected
schema, and the `calab` and solver versions.

The older routes the deployed apps still use (`/api/v1/params` for CaTune,
`/api/v1/results` and `/api/v1/results/activity` for CaDecon) keep working.

`calab._bridge.launch(slug, traces, fs, ...)` runs any registered app;
`tune()` and `decon()` are thin wrappers that add each app's
post-processing. An app with no post-processing hook returns a
`BridgeResult` (`payload`, `arrays`, `warnings`).

## The app manifest

The deployed site publishes the list of its apps at
<https://calab.miniscope.org/apps.json>. The web build writes it
(`scripts/combine-dist.mjs`) from each app's `package.json`, so it is never
edited by hand:

```json
{
  "manifest_version": 1,
  "release": "v2.9.0",
  "commit": "d1d5b3fa7f63642ef2539b51c76165ef61888ca5",
  "generated_at": "2026-10-02T18:00:00.000Z",
  "apps": [
    {
      "id": "catune",
      "displayName": "CaTune",
      "path": "CaTune",
      "description": "Deconvolution parameter tuning",
      "status": "stable"
    }
  ]
}
```

`id` is the registry slug and `path` the URL segment under the site root.
`release` is the `v*` tag the site was built from, or the commit sha for an
untagged build. Hidden apps (the admin dashboard) are not listed.

The first time the bridge needs an app's URL in a Python session it fetches
this file (2 second timeout) and keeps it in memory for the rest of the
session. With it:

- **A listed app the registry knows** opens at the manifest's path, so an
  older `calab` follows a renamed app. Its results schema, arrays and
  post-processing still come from the registry.
- **A listed app the registry does not know** (an app added after your
  `calab` release) has a URL (`calab._bridge.app_url("<slug>")`), but
  `launch()` raises `ValueError` asking you to `pip install --upgrade calab`:
  this version cannot check or read its results.
- **A registered app missing from the manifest** uses its built-in URL.
- **No manifest** (offline, timeout, HTTP error, malformed JSON or an
  unknown `manifest_version`): everything uses the built-in registry, as
  before. The failure is logged at debug level on the
  `calab._bridge._manifest` logger and not retried in that session.

Passing `app_url=` to `tune()`, `decon()` or `launch()` skips the manifest
entirely: the app opens at the URL you gave.

The `CALAB_APPS_MANIFEST` environment variable points the lookup at another
manifest, for example a local `npm run build:pages` (written to
`dist/CaLab/`) served by any static file server at `http://localhost:8000/`:
`CALAB_APPS_MANIFEST=http://localhost:8000/apps.json`. App URLs are then
resolved relative to that address. Set it to `off` to never fetch. The
lab's own server publishes the same site, so
`CALAB_APPS_MANIFEST` can also point at another published copy of the site,
such as the old GitHub Pages one
(`https://miniscope.github.io/CaLab/apps.json`, which still serves the apps
but will later redirect to `calab.miniscope.org`).

### Opening a specific release

`calab.miniscope.org` keeps every release at `/<App>/v<version>/`, with
`/<App>/` always the newest. To open one, pass `version=` to `tune()`,
`decon()` or `launch()`:

```python
calab.decon(traces, fs=30.0, version="2.23.1")  # https://calab.miniscope.org/CaDecon/v2.23.1/
```

The path is built from the app's manifest entry (or the built-in default when
there is no manifest), so it follows the same site root. A leading `v` is
accepted; anything that is not `MAJOR.MINOR.PATCH` (with an optional
pre-release suffix) raises `ValueError`, and so does combining `version=` with
`app_url=`. Releases are published on the lab's server from 2.23.1 on. The
manifest lists only the newest release, so `calab` does not check that the
version exists: an unknown one opens a 404 page and the call waits until it
times out. If the app's results are incompatible with your `calab`, the usual
version handshake raises `BridgeVersionError`.

Result schemas are deliberately not in the manifest. The schema name and
version stay in the registry, where `tests/test_bridge_registry.py` checks
them against the TypeScript that sends them; putting them in the manifest
would mean copying those literals into the build.
