# Open a DANDI recording in cala ("Part B")

Spec, not built. Follows [data-donation.md](data-donation.md) (Part A), which
publishes donated recordings on DANDI as NWB; its own branch and PR.

cala gets an **Open in cala** button on the browse page, and an "Open from
DANDI" field on the start page that takes a DANDI asset link. cala then
streams the imaging data straight from DANDI's storage with byte-range
requests: a 10 GB recording is never downloaded as a whole before cala can
show and process it.

## Goals and non-goals

Goals

- Open any recording in the CaLab donation collection and run cala on it
  exactly as on a local Miniscope folder.
- Best effort for other DANDI dandisets: any NWB file with a raw
  `OnePhotonSeries` / `TwoPhotonSeries` holding a 3-D `uint8` / `uint16`
  array.
- A recording opened from DANDI behaves like a local one everywhere in cala
  (viewer, Run, look-back, exports), except Donate, which is hidden (the data
  is already public).

Non-goals

- Writing results back to DANDI.
- NWB-Zarr assets, `external_file` series (video files next to the NWB),
  segmentation or trace data.
- Opening local NWB files from disk (would be easy afterwards: same reader
  over a `File` instead of HTTP).

## What was checked (2026-11-23)

On dandiset 000718 (miniscope, Cai lab), asset
`sub-Ca-EEG2-1_ses-FC_image+ophys.nwb`, 2.16 GB:

- DANDI's S3 bucket answers range requests (`206`, `Accept-Ranges: bytes`)
  with `Access-Control-Allow-Origin: *`, and its CORS preflight allows the
  `range` header, so a browser can read any byte range of any public asset.
  The API's download endpoint redirects (302) to a presigned S3 URL valid for
  6 h; the asset metadata's `contentUrl` also gives the plain, unsigned S3
  URL, which does not expire.
- Layout: `acquisition/OnePhotonSeries/data`, shape (8161, 608, 608),
  `uint8`, HDF5 chunks of 27 whole frames, gzip level 4. A second series in
  the same file (`ImageSeries` pointing at an external `.wmv`) has an empty
  data array and must be skipped.
- From Python (`h5py` over `remfile`), opening the file and reading one frame
  took ~5 s (mostly HDF5 metadata); 100 more frames took ~6 s, about 6 MB/s
  of compressed data from a home connection.

Our own NWB files (Part A) are written with 16-frame chunks and gzip 4, the
same kind of layout.

## Design

### Reading NWB in the browser

**h5wasm** (HDF5 compiled to WebAssembly, the reader the Neurosift viewer
builds on) in a worker, over a lazy file whose reads become HTTP range
requests:

- The file is exposed to h5wasm's virtual file system as a lazily loaded
  file: each read of HDF5 metadata or a data chunk turns into a synchronous
  range request (allowed in a worker), fetched in aligned blocks (e.g. 4 MB)
  and kept in an LRU block cache.
- Opening reads only the HDF5 metadata needed to find the series: a few MB.
- Frame reads ask h5wasm for a hyperslab `[start, start + count)`; HDF5 reads
  and inflates just the chunks it needs.

Alternatives looked at: `jsfive` (pure JS, but needs the whole file in
memory); writing our own HDF5 chunk-index reader (far more code, all of HDF5's
B-tree variants); NWB-Zarr (simple to read over HTTP, but other people's files
are HDF5, and so is most pipeline tooling).

**First task of the plan is a spike:** h5wasm with a lazy HTTP file in a
worker, reading the 000718 asset and a Part A NWB made from synthetic V4. Pass
if opening takes under 10 s and sequential reading sustains at least the
Python figure above. If h5wasm's lazy file cannot do it, fall back to h5wasm
for metadata only plus our own fetch-and-inflate of whole chunks, found with
HDF5's chunk index (`H5Dget_chunk_info`), if the h5wasm build exposes it. The
spec gets updated with the result before anything else is built.

### Finding the series

Open the file, walk `/acquisition`, and keep series whose `neurodata_type` is
`OnePhotonSeries` or `TwoPhotonSeries` (then any `ImageSeries`) with a 3-D
`data` array that has frames and a supported dtype. One candidate: use it.
Several: the user picks (name, shape, dtype). None: a clear message ("no raw
imaging series in this file").

- fps: `starting_time.rate`, or from `timestamps` (median frame interval),
  same rule as cala's `timeStamps.csv` handling (`fpsFromTimeStamps`).
- Timestamps become cala's frame times when present.
- `int16`: refuse at first, with a message (could map to `uint16` later).
  Float data: refuse.

### Fitting into cala

cala's `FrameSource` (`apps/cala/src/lib/frame-source.ts`) is the AVI-folder
source that `frame-worker`, `lookback-worker` and `donation-worker` open with
`FrameSource.open` / `openSessions`, and the pipeline reads through
`info` and `readFrames(start, count, out)`.

- Extract the part the workers use into a `RecordingSource` interface
  (`info`, `readFrames`, `readFrame`, `close`), implemented by `FrameSource`
  and a new `NwbFrameSource`.
- The source descriptor the workers receive gains a third kind next to
  folder entries and sessions: `{ kind: 'nwb-url', url, seriesPath }`. A
  small `openRecordingSource(descriptor)` picks the class; the three worker
  call sites use it.
- `NwbFrameSource.readFrames` aligns its reads to the HDF5 chunk size and
  keeps one chunk-span of read-ahead, like `FrameSource`'s `READ_AHEAD_SPANS`.
- The recording's name in the UI is the DANDI path; the project / session
  store keys it by dandiset, version and path.

### Several passes over the data

A cala run reads the recording more than once (Discover, look-back, exports).
Streaming every pass again from DANDI would multiply the download, so the
block cache spills to OPFS:

- Fetched blocks are written to an OPFS file per asset, keyed by the asset's
  ETag; later reads come from OPFS.
- Capped at what the browser grants (`navigator.storage.estimate()`), least
  recently used assets evicted first; a "Clear downloaded recordings" button
  in settings.
- The first pass therefore costs one download of the frames it touches;
  later passes are local.

### Entry points

- Browse page (Part A): **Open in cala** per row opens
  `/cala/?dandi=<dandiset>/<version>/<asset path>`.
- Start page: "Open from DANDI" field that accepts a DANDI asset URL, an
  `api.dandiarchive.org/api/assets/<id>/` link or the `?dandi=` form above;
  cala resolves it through the DANDI API to the unsigned S3 URL.
- The URL is shareable: anyone opening it gets the same recording.

### Errors

- Network failure during a read: retry with backoff (3 tries), then pause the
  run with "Connection to DANDI lost", resumable.
- Expired presigned URL (403): re-resolve through the API once.
- Asset changed (ETag differs from the cached one): drop the cache for it and
  tell the user.

## Testing

- Unit: series discovery and fps/timestamp rules on small NWB fixtures
  written by Part A's `donation_to_nwb.py` from the CALARAW fixtures (plus one
  hand-made file with an empty external-file series and one `int16` series).
- Reader: `NwbFrameSource` over a local static server with range support,
  frames compared with the CALARAW source (bit identical), read-ahead and
  chunk alignment, OPFS cache hit on the second pass.
- e2e: open a synthetic V4 NWB through `?dandi=`-style URL against the local
  server, run cala, results equal to running on the same frames from an AVI.
- Manual spot check: dandiset 000718 asset from the live DANDI.

## Open questions

- Whether h5wasm's lazy file meets the spike's numbers (decides the reader).
- OPFS cache cap default and whether to ask before caching a large file.
