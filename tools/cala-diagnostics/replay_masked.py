"""Compare fixed exterior-background arms on captured keep probes.

Input manifest is a JSON list of label, capture, category. Captures may be a
single keep directory or a directory containing keep_* snapshots. Optional
--metrics applies pooled synthetic calibration thresholds descriptively.
"""
import argparse
import json
from pathlib import Path
import numpy as np
from background_models import load_snapshot, compare_snapshot, read_tsv
from background_controls import dump_tsv, json_safe
from masked_background import from_snapshot


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--metrics', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    entries = json.loads(args.manifest.read_text())
    if not entries:
        parser.error('manifest has no captures')
    thresholds = {}
    if args.metrics:
        for row in read_tsv(args.metrics):
            if row['anatomy'] == 'pooled' and row['group'] == 'negative_all':
                thresholds.setdefault(row['model'], {})[row['operating']] = float(row['threshold'])
    rows, diagnostics = [], []
    for entry in entries:
        capture = Path(entry['capture'])
        if not capture.is_absolute():
            capture = args.manifest.parent / capture
        folders = [capture] if (capture/'y.f32').exists() else sorted(capture.glob('keep_*'))
        if not folders:
            parser.error(f'no keep snapshots for {entry["label"]}')
        for folder in folders:
            snapshot = load_snapshot(folder)
            common = dict(case=entry['label'], category=entry['category'], snapshot=folder.name,
                          target_id=int(snapshot.ids[snapshot.target_index]))
            for r in compare_snapshot(folder, variant_names=['original', 'no_bump']):
                nbg = snapshot.b.shape[1] - (r['variant'] == 'no_bump')
                dof = max(int(np.count_nonzero(snapshot.fov))-nbg-snapshot.a.shape[1], 1)
                scale = max(r['raw_full']/dof, 1.)
                rows.append(common | dict(model=r['variant'], probe_index=r['probe_index'],
                    recording_index=r['probe_original_frame'], gain=r['raw_gain']/scale,
                    raw_gain=r['raw_gain'], raw_full=r['raw_full'], s2=scale, dof=dof,
                    target_c=r['target_c']))
            for radius in (0, 3):
                model = f'masked{radius}'
                try:
                    arm = from_snapshot(snapshot, radius)
                except (ValueError, np.linalg.LinAlgError) as exc:
                    diagnostics.append(common | dict(model=model, status='excluded', reason=str(exc)))
                    continue
                diagnostics.append(common | dict(model=model, status='valid', **arm.diagnostics))
                dof = max(int(arm.mask.sum())-snapshot.a.shape[1], 1)
                for i, r in enumerate(arm.solve_many(snapshot.y)):
                    scale = max(r['raw_full']/dof, 1.)
                    rows.append(common | dict(model=model, probe_index=i,
                        recording_index=int(snapshot.probes[i]['probe_original_frame']),
                        gain=r['raw_gain']/scale, raw_gain=r['raw_gain'], raw_full=r['raw_full'],
                        s2=scale, dof=dof, target_c=r['target_c']))
        print(entry['label'], len(folders), 'snapshots', flush=True)
    for row in rows:
        for operating, threshold in thresholds.get(row['model'], {}).items():
            row['threshold_'+operating] = threshold
            row['pass_'+operating] = row['gain'] > threshold
    groups = {}
    for row in rows:
        groups.setdefault((row['case'], row['model']), []).append(row)
    summary = []
    for (case, model), group in groups.items():
        item = dict(case=case, model=model, category=group[0]['category'], probes=len(group),
                    mean_gain=float(np.mean([r['gain'] for r in group])),
                    min_gain=min(r['gain'] for r in group), max_gain=max(r['gain'] for r in group))
        for operating, threshold in thresholds.get(model, {}).items():
            item['threshold_'+operating] = threshold
            item['passes_'+operating] = sum(r['gain'] > threshold for r in group)
        summary.append(item)
    args.out.mkdir(parents=True, exist_ok=True)
    dump_tsv(args.out/'probes.tsv', rows)
    dump_tsv(args.out/'cells.tsv', summary)
    (args.out/'diagnostics.json').write_text(json.dumps(json_safe(diagnostics), indent=2, allow_nan=False)+'\n')
    (args.out/'config.json').write_text(json.dumps(dict(manifest=entries,
        metrics=str(args.metrics) if args.metrics else None,
        scope='selected correlated probe replay, not end-to-end detector evaluation'), indent=2)+'\n')


if __name__ == '__main__':
    main()
