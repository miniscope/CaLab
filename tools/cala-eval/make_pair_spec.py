"""Derive a pairs-only spec from ca1_workshop_v2: isolated cell pairs at controlled centre distance.

usage: make_pair_spec.py OUT.spec.json   (needs numpy; the minisim venv python has it)
then, per seed s (the `pairs` sims of demix_suite.py, `<pairs dir>/pairs_s<s>`):
  $MINISIM_PY tools/minisim-calibration/make_trace_sim.py <pairs dir>/pairs_s<s> --dur 480 --npx 600 --seed <s> --spec OUT.spec.json
54 pairs at 4, 6, 8, 10, 12, 14, 17, 20, 24 px (soma diameter ~14.5 px), 6 each, in random orientation.
"""
import json, math, sys
from pathlib import Path
import numpy as np
base = json.load(open(Path(__file__).resolve().parent.parent / 'minisim-calibration' / 'ca1_workshop_v2.spec.json'))
PX_UM = 4.8/2.9
H = 600
rng = np.random.default_rng(1)
seps = [4, 6, 8, 10, 12, 14, 17, 20, 24]   # px (soma diameter ~14.5 px)
reps = 6
sites = []
step_px = 52
c = H/2
for gy in range(-6, 7):
    for gx in range(-6, 7):
        y, x = c+gy*step_px, c+gx*step_px
        if math.hypot(y-c, x-c) < 270: sites.append((y, x))
rng.shuffle(sites)
jobs = [s for s in seps for _ in range(reps)]
assert len(sites) >= len(jobs), (len(sites), len(jobs))
pos = []
for (y, x), s in zip(sites, jobs):
    th = rng.uniform(0, math.pi)
    dy, dx = s/2*math.sin(th), s/2*math.cos(th)
    for sg in (-1, 1):
        pos.append([150.0, (y+sg*dy-c)*PX_UM, (x+sg*dx-c)*PX_UM])
for st in base['steps']:
    if st['kind'] == 'place_neurons':
        st['populations'] = [dict(density_per_mm3=1.0, soma_radius_um=5.0, irregularity=0.3, morphology='cytosolic',
                                  dendrite_length_um=24.0, dendrite_width_um=3.0, depth_range_um=[140.0, 160.0],
                                  min_distance_um=0.0, positions_um=pos)]
        for k in ['density_per_mm3','soma_radius_um','irregularity','morphology','dendrite_length_um','dendrite_width_um','depth_range_um','min_distance_um','positions_um']:
            st.pop(k, None)
json.dump(base, open(sys.argv[1], 'w'), indent=1)
print(len(pos), 'cells,', len(jobs), 'pairs')
