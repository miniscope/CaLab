"""Tests for make_bundle.py and serve.py (pytest tools/cala-label)."""

import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent))
import make_bundle as mb  # noqa: E402
import serve  # noqa: E402


def cell(source, ident, cy, cx, flags=(), seen=None, w=100):
    base = int(cy) * w + int(cx)
    p = np.array([base, base + 1, base + w])
    return dict(source=source, id=ident, p=p, a=np.array([3.0, 2.0, 1.0], np.float32), cy=float(cy), cx=float(cx), flags=list(flags), seen_in=list(seen or [source]))


def pool_of(n_runs=2):
    pool = []
    for i in range(300):
        seen = ["a", "b"][:n_runs] if i % 3 else ["a"]
        flags = ["texture"] if i % 3 == 1 else []
        pool.append(cell("a", i, i % 90, 5 + i // 3, flags, seen))
    return pool


def test_opaque_id_is_stable_and_hides_the_source():
    a, b = mb.opaque_id("r9", 5), mb.opaque_id("r9", 5)
    assert a == b and len(a) == 8
    assert mb.opaque_id("r1", 5) != a
    assert "r9" not in a


def test_strata_quotas_and_caps():
    pool = pool_of()
    minian = [cell("minian", i, 1, i) for i in range(100)]
    got = mb.sample_strata(pool, minian, 300, seed=1)
    names = [s for _, s in got]
    assert len(got) == 300
    assert names.count("flagged") == 80
    assert names.count("run_specific") == 60
    assert names.count("minian_only") == 60
    assert names.count("uniform") == 100
    keys = [(c["source"], c["id"]) for c, _ in got]
    assert len(set(keys)) == 300  # nobody is drawn twice


def test_shortfall_goes_to_uniform():
    pool = pool_of()
    got = mb.sample_strata(pool, [], 300, seed=1)  # no Minian-only cells
    names = [s for _, s in got]
    assert len(got) == 300 and names.count("minian_only") == 0
    assert names.count("uniform") == 160


def test_sampling_is_deterministic_and_shuffled():
    pool = pool_of()
    a = mb.sample_strata(pool, [], 100, seed=3)
    b = mb.sample_strata(pool, [], 100, seed=3)
    c = mb.sample_strata(pool, [], 100, seed=4)
    ids = lambda r: [(x["source"], x["id"]) for x, _ in r]  # noqa: E731
    assert ids(a) == ids(b) and ids(a) != ids(c)
    strata = [s for _, s in a]
    assert strata != sorted(strata)  # not grouped by stratum


def test_pooling_merges_the_same_cell_across_runs():
    one = [cell("a", 1, 10, 10), cell("a", 2, 50, 50)]
    two = [cell("b", 7, 10, 10), cell("b", 8, 80, 80)]
    pool = mb.pool_runs([one, two])
    assert len(pool) == 3
    assert sorted(pool[0]["seen_in"]) == ["a", "b"]


def test_fixed_range_is_one_pair_for_all_and_to_u8_clips():
    arrays = [np.full((10, 10), v, np.float32) for v in (0.0, 5.0, 10.0)]
    lo, hi = mb.fixed_range(arrays, 0, 100)
    assert (lo, hi) == (0.0, 10.0)
    # The same value maps to the same grey in every candidate: no per-image scaling.
    quiet, loud = np.full((2, 2), 4.0), np.full((2, 2), 4.0)
    loud[0, 0] = 1000.0
    assert mb.to_u8(quiet, lo, hi, 256)[1, 1] == mb.to_u8(loud, lo, hi, 256)[1, 1]
    assert mb.to_u8(loud, lo, hi, 256)[0, 0] == 255
    assert mb.to_u8(np.array([-5.0]), lo, hi, 256)[0] == 0


def test_levels_quantise_to_full_range():
    out = mb.to_u8(np.linspace(0, 1, 100), 0.0, 1.0, mb.LEVELS)
    assert out.min() == 0 and out.max() == 255 and len(np.unique(out)) == mb.LEVELS


def test_decimate_keeps_peaks():
    tr = np.zeros(18000)
    tr[12345] = 50.0
    out, k = mb.decimate_max(tr)
    assert len(out) <= mb.TRACE_POINTS and max(out) == 50.0 and k == 9


def test_edge_flag():
    w = h = 100
    assert mb.touches_edge(np.array([3 * w + 50]), h, w)
    assert not mb.touches_edge(np.array([50 * w + 50]), h, w)


def test_footprint_file_roundtrip(tmp_path):
    cells = [(0, np.array([5, 6, 7]), np.array([1, 2, 3], np.float32)), (1, np.array([40]), np.array([9], np.float32))]
    mb.write_fp(tmp_path / "c.bin", 20, 20, cells)
    h, w, back = mb.read_fp(tmp_path / "c.bin")
    assert (h, w, len(back)) == (20, 20, 2)
    assert back[0][1].tolist() == [5, 6, 7] and back[1][2].tolist() == [9.0]


def write_bundle(tmp_path):
    cands = [dict(cid=f"{i:08x}", source="r9", id=i, stratum="uniform") for i in range(3)]
    (tmp_path / "manifest.json").write_text(json.dumps(dict(selection=dict(candidates=cands))))
    (tmp_path / "items.json").write_text(json.dumps(dict(order=[c["cid"] for c in cands])))
    return cands


def test_resolve_joins_labels_with_the_manifest_last_line_wins(tmp_path):
    write_bundle(tmp_path)
    lines = [
        dict(cid="00000000", label="cell", merged=False, edge=False, ms=5),
        dict(cid="00000000", label="not", merged=True, edge=False, ms=7),
        dict(cid="00000001", label="unsure"),
        dict(cid="00000001", label=None),  # undone
    ]
    (tmp_path / "labels.jsonl").write_text("\n".join(json.dumps(x) for x in lines) + '\n{"cid": "0000')
    rows = mb.resolve(tmp_path)
    assert [(r["cid"], r["label"], r["merged"]) for r in rows] == [("00000000", "not", True)]
    assert rows[0]["source"] == "r9"  # provenance appears only in the resolved join


def test_labels_never_carry_provenance(tmp_path):
    cands = write_bundle(tmp_path)
    rec = serve.clean_record(dict(cid=cands[0]["cid"], label="cell", source="r9", stratum="x", score=3), {c["cid"] for c in cands})
    assert set(rec) == {"cid", "label", "merged", "edge", "part", "ms", "ts", "session"}


def test_serve_rejects_unknown_ids_and_labels():
    known = {"0000000a"}
    with pytest.raises(ValueError):
        serve.clean_record(dict(cid="0000000b", label="cell"), known)
    with pytest.raises(ValueError):
        serve.clean_record(dict(cid="0000000a", label="maybe"), known)
    assert serve.clean_record(dict(cid="0000000a", label=None), known)["label"] is None


def test_serve_only_exposes_candidate_files():
    assert serve.SERVED.match("/c/0000000a/snip.png")
    assert not serve.SERVED.match("/manifest.json")
    assert not serve.SERVED.match("/labels.jsonl")
    assert not serve.SERVED.match("/c/../manifest.json")
