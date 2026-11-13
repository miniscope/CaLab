"""Recompute minisim's `detectable` flag for a cala-eval sim dir, in place (metadata only).

usage: $MINISIM_PY recompute_detectable.py SIM_DIR [--dry-run]

For recordings made with minisim <= 1.0.3 (peak-SNR flag) and moved to 1.1.0's
matched-filter SNR (`minisim.matched_filter_snr >= DETECT_SNR_THRESHOLD`). The video
does not depend on the flag for these specs (the focal depth is fixed), so only the
ground truth changes; regenerating with 1.1.0 gives the same flags.
Patches daq/ground_truth/ground_truth.zarr `ground_truth/detectable` and the per-unit
detectable byte of oracle.bin. oracle.bin keeps any depth window it was written with
(a unit minisim flagged detectable but oracle.bin did not stays non-detectable).
Prints: name, units, old minisim, new minisim, old oracle, new oracle.
"""
import struct
import sys
from importlib.metadata import version
from pathlib import Path

import numpy as np
import zarr
from minisim import DETECT_SNR_THRESHOLD, Spec, load_ground_truth, matched_filter_snr

sim = Path(sys.argv[1])
dry = "--dry-run" in sys.argv
assert tuple(int(v) for v in version("minisim").split(".")[:2]) >= (1, 1), version("minisim")
spec = Spec.model_validate_json((sim / "spec.json").read_text())
zpath = sim / "daq/ground_truth/ground_truth.zarr"
gt, _ = load_ground_truth(zpath)
snr = matched_filter_snr(gt, spec)
new = (snr >= DETECT_SNR_THRESHOLD) & np.asarray(gt.C).any(axis=1)
old = np.asarray(gt.detectable, bool)

ob = sim / "oracle.bin"
b = bytearray(ob.read_bytes())
H, W, n, T = struct.unpack("<4I", b[8:24]); off = 24
assert n == gt.n_units, (n, gt.n_units)
det_offsets, old_or = [], []
for _ in range(n):
    det_offsets.append(off + 4); old_or.append(b[off + 4]); off += 16
    for _f in range(2):
        y0, x0, ph, pw = struct.unpack("<iiII", b[off:off + 16]); off += 16 + 4 * ph * pw
old_or = np.array(old_or, bool)
# oracle.bin may have been written with --target-depth-um (oof arms: only the target
# layer counts). Recover that window as the place_neurons population whose depth range
# holds every unit oracle.bin flagged, and apply it to the new flag too.
window = old & ~old_or
new_or = new.copy()
if window.any():
    z = np.asarray(gt.centers_um)[:, 0]
    place = next(st for st in spec.steps if st.kind == "place_neurons")
    zf = z[old_or]
    lo, hi = next(pp.depth_range_um for pp in place.populations
                  if pp.depth_range_um[0] <= zf.min() and zf.max() <= pp.depth_range_um[1])
    new_or &= (z >= lo) & (z <= hi)
    print(f"  depth window {lo}-{hi} um applied to oracle.bin", file=sys.stderr)
if not dry:
    for o, d in zip(det_offsets, new_or):
        b[o] = int(d)
    ob.write_bytes(bytes(b))
    root = zarr.open_group(str(zpath), mode="r+")
    root["ground_truth"]["detectable"][:] = new
    gt2, _ = load_ground_truth(zpath)
    assert (np.asarray(gt2.detectable) == new).all()
print(f"{sim.name}\t{n}\t{old.sum()}\t{new.sum()}\t{old_or.sum()}\t{new_or.sum()}\twindow={window.sum()}")
