"""Sim arms of the cala evaluation (PLAN section 3.2). A new arm is a new entry.

Each arm names a minisim spec (relative to `tools/minisim-calibration/`), the
`make_trace_sim.py` flags that distinguish it and whether `qc_eval` needs
`--motion`. An arm whose spec file is missing is listed but reported as
unavailable instead of failing.
"""

from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
SPEC_DIR = REPO / "tools" / "minisim-calibration"

DUR_S = 480.0
NPX = 600
FRAMES = 9600  # 480 s at 20 fps
FPS = 20.0

# spec: file in tools/minisim-calibration; motion: `--motion` for both the
# generator and qc_eval; halo: `--f` of make_trace_sim (0 = the spec's own).
ARMS = {
    "static": {"spec": "ca1_workshop_v2.spec.json", "motion": False, "halo": 0.0},
    "motion": {"spec": "ca1_workshop_v2.spec.json", "motion": True, "halo": 0.0},
    "halo": {"spec": "ca1_workshop_v2_halo.spec.json", "motion": True, "halo": 0.0},
    "oof": {"spec": "ca1_workshop_v2_oof.spec.json", "motion": True, "halo": 0.0},
    "fpn": {"spec": "ca1_workshop_v2_fpn.spec.json", "motion": True, "halo": 0.0},
    # v3: the real recording's cell size (10 px) and edge blur (~1.5 px); size6 and
    # size16 change only the cell size (6 and 16 px). Same 600 px frame, 480 s.
    "v3_static": {"spec": "ca1_workshop_v3.spec.json", "motion": False, "halo": 0.0},
    "v3_motion": {"spec": "ca1_workshop_v3.spec.json", "motion": True, "halo": 0.0},
    "size6_static": {"spec": "ca1_workshop_v3_size6.spec.json", "motion": False, "halo": 0.0},
    "size6_motion": {"spec": "ca1_workshop_v3_size6.spec.json", "motion": True, "halo": 0.0},
    "size16_static": {"spec": "ca1_workshop_v3_size16.spec.json", "motion": False, "halo": 0.0},
    "size16_motion": {"spec": "ca1_workshop_v3_size16.spec.json", "motion": True, "halo": 0.0},
}


# Ground-truth scales of the sim arms (S2.4): `d` = median half-max diameter of the detectable
# GT footprints, `edge` = median ring edge sigma (`gt_scales.py`, minisim 1.1.0 flags, seed 5
# motion arms; v2 from S2.4 section 1). A sim's `given` scales for `qc_eval`.
GT_SCALES = {
    "static": {"d": 14.5, "edge": 4.0},
    "motion": {"d": 14.4, "edge": 4.0},
    "v3_static": {"d": 10.1, "edge": 1.6},
    "v3_motion": {"d": 10.1, "edge": 1.6},
    "size6_static": {"d": 6.0, "edge": 1.5},
    "size6_motion": {"d": 6.0, "edge": 1.5},
    "size16_static": {"d": 15.9, "edge": 1.6},
    "size16_motion": {"d": 15.9, "edge": 1.6},
}

# S2.4 M0 one-at-a-time scale arms: `qc_eval` flags added to a run (section 6.1). The diameter
# arms pin the flatten sigma at today's 20 px so only the detection-side scales move; `tile16`
# also scales the slow loop's tile and margin with the diameter (6.4 d, 2.4 d).
SCALE_ARMS = {
    "base": "",
    "d6": "--cell-diameter 6 --flatten-sigma 20",
    "d14": "--cell-diameter 14 --flatten-sigma 20",
    "d16": "--cell-diameter 16 --flatten-sigma 20",
    "p075": "--psf-sigma 0.75",
    "p3": "--psf-sigma 3",
    "f10": "--flatten-sigma 10",
    "f40": "--flatten-sigma 40",
    "f80": "--flatten-sigma 80",
    "tile16": "--cell-diameter 16 --flatten-sigma 20 --tile-px 102 --margin-px 38",
}


def spec_path(arm: str) -> Path:
    return SPEC_DIR / ARMS[arm]["spec"]


def available(arm: str) -> bool:
    return arm in ARMS and spec_path(arm).exists()


def parse_list(s: str) -> list[str]:
    return [x for x in s.split(",") if x]


def parse_seeds(s: str) -> list[int]:
    out: list[int] = []
    for part in s.split(","):
        if "-" in part:
            a, b = part.split("-")
            out.extend(range(int(a), int(b) + 1))
        elif part:
            out.append(int(part))
    return out


def run_name(arm: str, seed: int) -> str:
    return f"{arm}_s{seed}"
