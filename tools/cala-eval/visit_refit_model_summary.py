"""Visit refit: the model's (qc_eval `--offered-fps`) numbers next to Chrome's, one row per run directory.

    visit_refit_model_summary.py RUN_DIR [RUN_DIR ...]

Reads `<dir>.log` (the `timed:` lines) and, with `--visit-diag`, `<dir>/visit_diag.txt`: missed share, visit jobs,
need-driven frames, background-settle frames per forwarded frame, visit workers' busy share and ms per job, the
owner's ms per batch / per observed frame, mean inbox wait of batches and of visit results, cells at the end.
"""
import re, sys
from pathlib import Path

for d in map(Path, sys.argv[1:]):
    log = Path(str(d) + '.log').read_text()
    m = re.search(r'forwarded (\d+) frames, dropped (\d+), observed (\d+); visits \d+ \((\d+) jobs\); owner busy (\d+)% '
                  r', visit workers busy (\d+)%.*?(\d+) observed frames/s', log)
    fwd, drop, obs, jobs, own, vb, ofps = (int(x) for x in m.groups())
    need = re.search(r'look-back gate: (\d+) need-driven', log)
    cs = re.search(r'timed settle jobs: (\d+) frames re-read', log)
    cells = re.search(r'pass 1 done: (\d+) cells', log)
    wall = re.search(r'offered ([\d.]+) fps over ([\d.]+) s', log)
    row = (f"{d.name}: missed {100 * drop / (fwd + drop):.1f}%, jobs {jobs}, need {need.group(1) if need else '-'}, "
           f"settle/fwd {int(cs.group(1)) / fwd:.3f}, cells {cells.group(1) if cells else '-'}, obs/s {ofps}, owner {own}%, "
           f"visit busy {vb}%")
    f = d / 'visit_diag.txt'
    if f.exists():
        v = dict(l.split('\t') for l in f.read_text().split('\n') if '\t' in l)
        g = lambda k: float(v[k])
        row += (f"; ms/job {g('worker_busy_ms') / max(g('jobs'), 1):.1f}, batch {g('owner_batch_ms') / max(g('owner_batch_msgs'), 1):.1f} ms "
                f"({g('owner_batch_ms') / max(obs, 1):.2f}/frame), wait batch {g('queue_batch_ms_mean'):.1f} result "
                f"{g('queue_result_ms_mean'):.1f} ms, slots/handout {g('slots_at_handout_mean'):.0f}")
    print(row)
