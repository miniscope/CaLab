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
from ingest_donations import DONATION_ID, ApiError, IngestApi, _load_calaraw, default_opener  # noqa: E402

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
#: nwbinspector checks not applied. check_data_orientation guesses that time is
#: the longest axis; write_nwb always puts time first by construction, and the
#: guess is wrong for recordings with fewer frames than pixels in a row (tiny
#: test files, very short clips).
IGNORED_CHECKS = {"check_data_orientation"}
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
    tmp = out.with_name(out.stem + ".part.nwb")
    try:
        with NWBHDF5IO(str(tmp), "w") as io:
            io.write(nwbfile)
        # Verify before the file gets its final name: a bad file must never sit at `out`.
        verify_nwb(donation_dir, tmp, n)
        tmp.replace(out)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def verify_nwb(donation_dir: Path, out: Path, n_frames: int | None = None) -> None:
    """Every frame in the NWB file equals the CALARAW source, and the counts agree."""
    from pynwb import NWBHDF5IO

    with NWBHDF5IO(str(out), "r") as io:
        data = io.read().acquisition["OnePhotonSeries"].data
        if n_frames is not None and data.shape[0] != n_frames:
            raise ConversionError(f"NWB has {data.shape[0]} frames, donation.json says {n_frames}")
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
        and m.check_function_name not in IGNORED_CHECKS
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
    if not DONATION_ID.fullmatch(donation_id):
        raise ConversionError(f"not a donation id: {donation_id!r}")
    donation_dir = store / donation_id
    row, meta = load_stored(donation_dir)
    if row.get("id") != donation_id:
        raise ConversionError("donation.json belongs to another donation")
    check_public(row, meta)
    try:
        n_frames = int(row["n_frames"])
    except (KeyError, TypeError, ValueError):
        raise ConversionError(
            f"donation.json has no integer n_frames: {row.get('n_frames')!r}"
        ) from None
    if n_frames < 1:
        raise ConversionError(f"donation.json n_frames is {n_frames}")
    path = nwb_relpath(row)
    if not DANDI_PATH.fullmatch(path):
        raise ConversionError(
            f"not a valid DANDI path {path!r}: the animal ID may contain only letters, "
            "digits and dashes (the lab name and date are fixed up automatically)"
        )
    dandiset_dir = work / dandiset
    if not (dandiset_dir / "dandiset.yaml").exists():
        dandiset_dir.parent.mkdir(parents=True, exist_ok=True)
        run(
            ["dandi", "download", "--download", "dandiset.yaml", dandi_url(dandiset, instance)],
            work,
        )
    out = dandiset_dir / path
    if out.exists():
        verify_nwb(donation_dir, out, n_frames)  # reuse a file from an earlier run
    else:
        write_nwb(donation_dir, row, out)  # verified before it is renamed to `out`
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
