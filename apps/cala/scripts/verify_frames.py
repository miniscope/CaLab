"""Independent reader for apps/cala/scripts/real-data-check.mjs.

Reads frames from uncompressed grayscale AVI files without any of the cala
code: it walks the RIFF chunk tree itself (no idx1, no fixed-stride
assumption), reads pixels with numpy at the offsets it found, and compares
SHA-256 digests with those the frame source produced.

    python -I verify_frames.py samples.json

Rows are compared as stored (top row of the file first), which is what OpenCV
and minian return for these files.
"""

import hashlib
import json
import struct
import sys

import numpy as np


def walk_frames(path):
    """Return (width, height, bit_count, [offset of each frame's pixel data])."""
    offsets = []
    width = height = bit_count = None
    with open(path, "rb") as f:
        riff, _size, form = struct.unpack("<4sI4s", f.read(12))
        assert riff == b"RIFF" and form == b"AVI ", (riff, form)

        def read_chunks(end):
            nonlocal width, height, bit_count
            while f.tell() + 8 <= end:
                start = f.tell()
                tag, size = struct.unpack("<4sI", f.read(8))
                body = f.tell()
                if tag == b"LIST":
                    kind = f.read(4)
                    if kind in (b"hdrl", b"strl"):
                        read_chunks(body + size)
                    elif kind == b"movi":
                        read_movi(body + size)
                elif tag == b"strf" and width is None:
                    _bs, w, h, _pl, bits = struct.unpack("<IiiHH", f.read(16))
                    width, height, bit_count = w, abs(h), bits
                f.seek(body + size + (size & 1))
                assert f.tell() >= start

        def read_movi(end):
            while f.tell() + 8 <= end:
                tag, size = struct.unpack("<4sI", f.read(8))
                body = f.tell()
                if tag[2:] in (b"dc", b"db"):
                    offsets.append((body, size))
                f.seek(body + size + (size & 1))

        f.seek(12)
        read_chunks(8 + _size)
    return width, height, bit_count, offsets


def main():
    spec = json.load(open(sys.argv[1]))
    width, height, bits = spec["width"], spec["height"], spec["bitDepth"]
    starts, total = [], 0
    for entry in spec["files"]:
        starts.append(total)
        total += entry["frames"]

    cache = {}
    bad = 0
    for sample in spec["samples"]:
        g = sample["index"]
        k = max(i for i, s in enumerate(starts) if s <= g)
        name = spec["files"][k]["name"]
        path = f'{spec["dir"]}/{name}'
        if path not in cache:
            w, h, b, offs = walk_frames(path)
            assert (w, h, b) == (width, height, bits), (name, w, h, b)
            cache[path] = offs
        offs = cache[path]
        local = g - starts[k]
        assert local < len(offs), (name, local, len(offs))
        body, size = offs[local]
        stride = ((width * bits + 31) // 32) * 4
        assert size == stride * height, (name, size, stride * height)
        raw = np.fromfile(path, dtype=np.uint8, count=size, offset=body)
        rows = raw.reshape(height, stride)[:, : width * bits // 8]
        digest = hashlib.sha256(np.ascontiguousarray(rows).tobytes()).hexdigest()
        ok = digest == sample["sha256"]
        bad += not ok
        print(f'  frame {g:6d} ({name}[{local}] @ byte {body}): {"OK" if ok else "MISMATCH"}')
    print(f"independent reader: {len(spec['samples']) - bad}/{len(spec['samples'])} frames match")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
