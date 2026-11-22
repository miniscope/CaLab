"""Visit refit: per-duty numbers from headed-Chrome runs (memory-measure `<tag>.json`, `<tag>-work.json`, `<tag>-probe.json`).

    visit_refit_chrome_summary.py DIR TAG [TAG ...]

Discover only (work readings with status 'running'). Per run: frames observed and visit jobs in Discover (from the
probe at frames done), and, over the Discover readings, the slow worker's share by duty, ms per observed frame (live),
ms per visit job (visit duty, hand-out + apply), the visit workers' busy time per job, and the batch inbox wait.
Rows by thirds of Discover (by observed frame) show how the costs move as cells accumulate.
"""
import bisect, json, sys
from pathlib import Path


def load(d, tag):
    W = json.load(open(d / f'{tag}-work.json'))
    S = json.load(open(d / f'{tag}.json'))
    P = json.load(open(d / f'{tag}-probe.json'))
    st = [(s['t'] * 1000, s['st']['slow']['observed'], s['st']['slow']['jobs'], s['st'].get('cells') or 0)
          for s in S if s.get('st', {}).get('slow') and s['st'].get('pst') == 'running']
    return W, st, P


def interp(st, t, k):
    ts = [x[0] for x in st]
    i = bisect.bisect_left(ts, t)
    if i == 0:
        return st[0][k]
    if i >= len(st):
        return st[-1][k]
    a, b = st[i - 1], st[i]
    return a[k] + (t - a[0]) / (b[0] - a[0]) * (b[k] - a[k])


def window(run, st):
    span = sum(w['work']['spanMs'] for w in run)
    tot = {}
    vis = 0.0
    wait = 0.0
    for w in run:
        s = w['work']['spanMs']
        for k, v in w['work']['slow'].items():
            tot[k] = tot.get(k, 0) + v * s
        vis += sum(w['work']['visit']) * s
        wait += w['work']['batchWait']['meanMs'] * s
    t0 = run[0]['t'] - run[0]['work']['spanMs']
    t1 = run[-1]['t']
    obs = interp(st, t1, 1) - interp(st, t0, 1)
    jobs = interp(st, t1, 2) - interp(st, t0, 2)
    cells = interp(st, t1, 3)
    return dict(sec=span / 1e3, obs=obs, jobs=jobs, cells=cells, tot=tot, span=span, vis=vis, wait=wait / span)


def show(name, r):
    sh = ', '.join(f"{k} {v / r['span'] * 100:.1f}" for k, v in r['tot'].items())
    o, j = max(r['obs'], 1), max(r['jobs'], 1)
    print(f"  {name}: {r['sec']:.0f} s, obs {r['obs']:.0f} ({r['obs'] / r['sec']:.1f}/s), jobs {r['jobs']:.0f} "
          f"({r['jobs'] / r['sec']:.1f}/s, {r['jobs'] / o:.2f}/frame), cells {r['cells']:.0f}")
    print(f"    slow % [{sh}]")
    print(f"    live ms/frame {r['tot'].get('live', 0) / o:.2f}; visit-duty ms/job {r['tot'].get('visit', 0) / j:.3f}; "
          f"housekeep ms/job {r['tot'].get('housekeep', 0) / j:.3f}; visit-worker ms/job {r['vis'] / j:.1f} "
          f"(busy {r['vis'] / r['span']:.2f} of 4); batch wait mean {r['wait']:.1f} ms")


d = Path(sys.argv[1])
for tag in sys.argv[2:]:
    W, st, P = load(d, tag)
    at = P['probe'].get('atFramesDone', {}).get('slow', {})
    print(f"{tag}: Discover observed {at.get('observed')} jobs {at.get('jobs')} fwd {P['probe'].get('atFramesDone', {}).get('fwd')} "
          f"drop {P['probe'].get('atFramesDone', {}).get('drop')} cells {P['probe'].get('atFramesDone', {}).get('cells')}")
    run = [w for w in W if w['status'] == 'running' and w['work']['spanMs'] > 0]
    show('all', window(run, st))
    n = len(run)
    for i in range(3):
        part = run[i * n // 3:(i + 1) * n // 3]
        if part:
            show(f'third {i + 1}', window(part, st))
