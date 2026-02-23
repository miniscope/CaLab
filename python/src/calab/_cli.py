"""CaLab command-line interface.

Usage:
    calab tune <file.npy> --fs 30.0
    calab deconvolve <file.npy> --params params.json -o output.npy
    calab convert <file> --format caiman --fs 30.0 -o output
    calab info <file>
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np


def cmd_tune(args: argparse.Namespace) -> None:
    """Open CaTune with data for interactive tuning."""
    from ._bridge import tune
    from ._io import load_tuning_data

    path = args.file
    ext = Path(path).suffix.lower()

    if ext == ".npy":
        traces = np.load(path)
        if traces.ndim == 1:
            traces = traces.reshape(1, -1)
    else:
        # Try loading as calab format (stem without extension)
        stem = str(Path(path).with_suffix(""))
        traces, meta = load_tuning_data(stem)
        if args.fs is None and "sampling_rate_hz" in meta:
            args.fs = meta["sampling_rate_hz"]

    if args.fs is None:
        print("Error: --fs (sampling rate) is required", file=sys.stderr)
        sys.exit(1)

    params = tune(traces, fs=args.fs, port=args.port, open_browser=not args.no_browser)
    if params is not None:
        print(json.dumps(params, indent=2))
    else:
        print("No parameters received.", file=sys.stderr)
        sys.exit(1)


def _to_serializable(value):
    """Convert numpy arrays/scalars to JSON-serializable Python types."""
    return value.tolist() if hasattr(value, "tolist") else value


def cmd_deconvolve(args: argparse.Namespace) -> None:
    """Batch deconvolution from file."""
    from ._compute import bandpass_filter, run_deconvolution, run_deconvolution_full
    from ._io import load_export_params

    traces = np.load(args.file)
    if traces.ndim == 1:
        traces = traces.reshape(1, -1)

    params = load_export_params(args.params)

    if params["filter_enabled"]:
        traces = traces.copy()
        for i in range(traces.shape[0]):
            traces[i] = bandpass_filter(
                traces[i], params["tau_rise"], params["tau_decay"], params["fs"],
            )

    deconv_kwargs = dict(
        fs=params["fs"],
        tau_r=params["tau_rise"],
        tau_d=params["tau_decay"],
        lam=params["lambda_"],
    )

    if args.full:
        result = run_deconvolution_full(traces, **deconv_kwargs)
        np.save(args.output, result.activity)

        info_path = str(Path(args.output).with_suffix("")) + "_info.json"
        info = {
            "baseline": _to_serializable(result.baseline),
            "iterations": _to_serializable(result.iterations),
            "converged": _to_serializable(result.converged),
        }
        with open(info_path, "w") as f:
            json.dump(info, f, indent=2)
        print(f"Saved activity to {args.output}")
        print(f"Saved info to {info_path}")
    else:
        activity = run_deconvolution(traces, **deconv_kwargs)
        np.save(args.output, activity)
        print(f"Saved activity to {args.output}")


def cmd_convert(args: argparse.Namespace) -> None:
    """Convert from CaImAn/Minian format to CaLab format."""
    from ._io import save_for_tuning
    from ._loaders import load_caiman, load_minian

    fmt = args.format.lower()
    if fmt == "caiman":
        traces, meta = load_caiman(args.file, fs=args.fs)
    elif fmt == "minian":
        traces, meta = load_minian(args.file, fs=args.fs)
    else:
        print(f"Error: unknown format '{fmt}'. Use 'caiman' or 'minian'.", file=sys.stderr)
        sys.exit(1)

    fs = meta.get("sampling_rate_hz") or args.fs
    if fs is None:
        print("Error: --fs is required (not found in source file)", file=sys.stderr)
        sys.exit(1)

    output = args.output or str(Path(args.file).stem)
    save_for_tuning(traces, fs, output, metadata={"source_format": fmt, **meta})
    print(f"Saved {meta['num_cells']} traces ({meta['num_timepoints']} timepoints) to {output}.npy")


def cmd_info(args: argparse.Namespace) -> None:
    """Show file info."""
    path = args.file
    ext = Path(path).suffix.lower()

    if ext == ".npy":
        data = np.load(path)
        print(f"File: {path}")
        print(f"  Shape: {data.shape}")
        print(f"  Dtype: {data.dtype}")
        print(f"  Size: {data.nbytes / 1024:.1f} KB")
        if data.ndim == 2:
            print(f"  Cells: {data.shape[0]}")
            print(f"  Timepoints: {data.shape[1]}")
        # Check for metadata sidecar
        stem = str(Path(path).with_suffix(""))
        meta_path = f"{stem}_metadata.json"
        if Path(meta_path).exists():
            with open(meta_path) as f:
                meta = json.load(f)
            print(f"  Metadata: {meta_path}")
            if "sampling_rate_hz" in meta:
                print(f"  Sampling rate: {meta['sampling_rate_hz']} Hz")
            if "schema_version" in meta:
                print(f"  Schema: v{meta['schema_version']}")

    elif ext == ".json":
        with open(path) as f:
            data = json.load(f)
        print(f"File: {path}")
        if "parameters" in data:
            params = data["parameters"]
            print(f"  Type: CaTune export")
            if "schema_version" in data:
                print(f"  Schema: v{data['schema_version']}")
            for key, val in params.items():
                print(f"  {key}: {val}")
        else:
            print(f"  Keys: {list(data.keys())}")

    else:
        print(f"Unknown file type: {ext}", file=sys.stderr)
        sys.exit(1)


def main() -> None:
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        prog="calab",
        description="CaLab: calcium imaging analysis tools",
    )
    parser.add_argument(
        "--version", action="version", version=f"%(prog)s {_get_version()}",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    # tune
    p_tune = subparsers.add_parser("tune", help="Open CaTune for interactive tuning")
    p_tune.add_argument("file", help="Input .npy file")
    p_tune.add_argument("--fs", type=float, default=None, help="Sampling rate (Hz)")
    p_tune.add_argument("--port", type=int, default=None, help="Server port")
    p_tune.add_argument("--no-browser", action="store_true", help="Don't open browser")
    p_tune.set_defaults(func=cmd_tune)

    # deconvolve
    p_deconv = subparsers.add_parser("deconvolve", help="Batch deconvolution")
    p_deconv.add_argument("file", help="Input .npy file")
    p_deconv.add_argument("--params", "-p", required=True, help="CaTune export JSON")
    p_deconv.add_argument("--output", "-o", default="activity.npy", help="Output file")
    p_deconv.add_argument("--full", action="store_true", help="Save full results")
    p_deconv.set_defaults(func=cmd_deconvolve)

    # convert
    p_conv = subparsers.add_parser("convert", help="Convert to CaLab format")
    p_conv.add_argument("file", help="Input file (HDF5 or Zarr directory)")
    p_conv.add_argument("--format", "-f", required=True, choices=["caiman", "minian"])
    p_conv.add_argument("--fs", type=float, default=None, help="Sampling rate (Hz)")
    p_conv.add_argument("--output", "-o", default=None, help="Output path stem")
    p_conv.set_defaults(func=cmd_convert)

    # info
    p_info = subparsers.add_parser("info", help="Show file info")
    p_info.add_argument("file", help="Input file (.npy or .json)")
    p_info.set_defaults(func=cmd_info)

    args = parser.parse_args()
    args.func(args)


def _get_version() -> str:
    try:
        from . import __version__

        return __version__
    except ImportError:
        return "unknown"


if __name__ == "__main__":
    main()
