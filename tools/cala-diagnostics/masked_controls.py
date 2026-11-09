#!/usr/bin/env python3
"""Frozen synthetic controls for original/no_bump and masked radii 0/3.

Manifest: JSON list (or {geometries: [...]}) with label, snapshot,
gt_footprints, gt_id, optional gt_offset [dy,dx], splits and spatial_split.
Evaluator offset maps working -> GT; GT injections therefore shift by -offset.
Uses existing independent field generator with explicit 1/32 noise quantization.
"""
import os
for _key in ('OPENBLAS_NUM_THREADS','OMP_NUM_THREADS','MKL_NUM_THREADS','VECLIB_MAXIMUM_THREADS'):
    os.environ[_key] = '1'
import argparse, csv, hashlib, json, sys
from pathlib import Path
import numpy as np

import background_controls as controls
from background_models import load_snapshot, make_variants, BackgroundNNLS
from masked_background import from_snapshot

SEEDS = {'calibration':2026110901, 'evaluation':2026110902}
MODELS = ('original','no_bump','masked0','masked3')

def save_json(path, value):
    path.write_text(json.dumps(controls.json_safe(value), indent=2, allow_nan=False)+'\n')

def ground_truth(entry, snapshot):
    shape, fps = controls.read_fp(entry['gt_footprints'])
    fp = fps[int(entry['gt_id'])]
    h,w = shape
    pixels, raw, filtered = fp
    dy,dx = entry.get('gt_offset',[0,0])
    yy = pixels.astype(np.int64)//w-int(dy)
    xx = pixels.astype(np.int64)%w-int(dx)
    valid = (yy>=0)&(yy<h)&(xx>=0)&(xx<w)
    shifted = ((yy[valid]*w+xx[valid]).astype(np.uint32),raw[valid],filtered[valid])
    gt = controls.crop_column(shifted,snapshot.meta,snapshot.inv_sigma)
    if not np.all(np.isfinite(gt)) or np.linalg.norm(gt)<1e-10:
        raise ValueError('GT injection has zero/nonfinite norm after crop and alignment')
    grid = snapshot.b[:,:9]
    q,_ = np.linalg.qr(grid,mode='reduced')
    norm = float(np.linalg.norm(gt-q@(q.T@gt)))
    if norm < 1e-8:
        raise ValueError('GT nine-grid projected norm too small')
    return gt, norm

def summarize_metrics(rows,out):
    groups={}
    for row in rows:
        groups.setdefault((row['anatomy'],row['model']),[]).append(row)
        groups.setdefault(('pooled',row['model']),[]).append(row)
    metrics=[];roc=[]
    for (anatomy,model),group in groups.items():
        calibration=np.array([r['gain'] for r in rows if r['model']==model and r['split']=='calibration' and not r['label']])
        evaluation=[r for r in group if r['split']=='evaluation']
        if not evaluation:continue
        neg=np.array([r['gain'] for r in evaluation if not r['label']]);pos=np.array([r['gain'] for r in evaluation if r['label']])
        thresholds={'original_2p736':controls.THRESHOLD}
        for fpr in controls.FPRS: thresholds[f'cal_fpr_{fpr:g}']=float(np.quantile(calibration,1-fpr,method='higher'))
        for operating,threshold in thresholds.items():
            for family in ['all']+controls.NEGATIVE_FAMILIES:
                selected=[r for r in evaluation if not r['label'] and (family=='all' or r['family']==family)]
                metrics.append(dict(anatomy=anatomy,model=model,operating=operating,threshold=threshold,group='negative_'+family,n=len(selected),rate=float(np.mean([r['gain']>threshold for r in selected])),auc=controls.auc(neg,pos)))
            for snr in controls.SNR:
                selected=[r for r in evaluation if r['label'] and r['snr']==snr]
                metrics.append(dict(anatomy=anatomy,model=model,operating=operating,threshold=threshold,group=f'positive_snr{snr:g}',n=len(selected),rate=float(np.mean([r['gain']>threshold for r in selected])),auc=controls.auc(neg,np.array([r['gain'] for r in selected]))))
        for threshold in np.unique(np.r_[0,np.quantile(np.r_[neg,pos],np.linspace(0,1,301))]):
            roc.append(dict(anatomy=anatomy,model=model,threshold=threshold,fpr=float(np.mean(neg>threshold)),tpr=float(np.mean(pos>threshold))))
    for metric in metrics:
        k=round(metric['rate']*metric['n']);lo,hi=controls.wilson(k,metric['n'])
        metric.update(events=k,ci95_low=lo,ci95_high=hi)
    controls.dump_tsv(out/'metrics.tsv',metrics);controls.dump_tsv(out/'roc.tsv',roc)
    return metrics

def external_calibration(directory, config, entries):
    if any('calibration' in e['splits'] for e in entries):
        raise ValueError('External calibration requires an evaluation-only manifest')
    path=directory/'config.json'
    previous=json.loads(path.read_text())
    keys=('seeds','models','noise_quantum_whitened','negative_families','positive_snr',
          'amplitudes','masked_score','baseline_score','gt_alignment',
          'solver_source_sha256','background_models_source_sha256','controls_source_sha256')
    for key in keys:
        if previous.get(key)!=config[key]:raise ValueError(f'Calibration protocol mismatch: {key}')
    geometries={e['label'] for e in previous['manifest'] if 'calibration' in e['splits']}
    if not geometries:raise ValueError('External configuration has no calibration geometries')
    if geometries & {e['label'] for e in entries}:raise ValueError('Evaluation labels overlap external calibration labels')
    rows=[]
    with (directory/'scores.tsv').open() as f:
        for row in csv.DictReader(f,delimiter='\t'):
            if row['split'] not in SEEDS:raise ValueError('Unknown split in external scores')
            if row['model'] not in MODELS:raise ValueError('Unknown model in external scores')
            if row['split']!='calibration':continue
            if row['anatomy'] not in geometries:raise ValueError('Undeclared external calibration geometry')
            if row['summary_eligible']!='True':raise ValueError('Incomplete external calibration model')
            row.update(label=int(row['label']),snr=float(row['snr']),gain=float(row['gain']))
            if row['label'] not in (0,1) or not np.isfinite(row['gain']):raise ValueError('Invalid external calibration value')
            rows.append(row)
    expected={(g,m) for g in geometries for m in MODELS}
    if {(r['anatomy'],r['model']) for r in rows}!=expected:raise ValueError('External calibration model/geometry set incomplete')
    n=previous['negative_n_per_family_split_geometry']
    for g,m in expected:
        for family in controls.NEGATIVE_FAMILIES:
            group=[r for r in rows if r['anatomy']==g and r['model']==m and not r['label'] and r['family']==family]
            if len(group)!=n or len({r['case_id'] for r in group})!=n:raise ValueError('External negative calibration stratum incomplete/duplicated')
    config['external_calibration']=dict(directory=str(directory.resolve()),config_sha256=hashlib.sha256(path.read_bytes()).hexdigest(),scores_sha256=hashlib.sha256((directory/'scores.tsv').read_bytes()).hexdigest(),calibration_rows=len(rows),geometries=sorted(geometries))
    return rows

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest',type=Path,required=True)
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--calibration-results',type=Path,help='Prior compatible results directory; reuse calibration rows only')
    parser.add_argument('--negative-n',type=int,default=128)
    parser.add_argument('--positive-n',type=int,default=64)
    args=parser.parse_args()
    if min(args.negative_n,args.positive_n)<1:parser.error('sample counts must be positive')
    source=json.loads(args.manifest.read_text())
    entries=source['geometries'] if isinstance(source,dict) else source
    if len({e['label'] for e in entries})!=len(entries):raise ValueError('geometry labels must be unique')
    for e in entries:
        for key in ('snapshot','gt_footprints'):
            p=Path(e[key]);e[key]=str((args.manifest.parent/p).resolve() if not p.is_absolute() else p)
        e.setdefault('splits',['calibration','evaluation'])
        e.setdefault('spatial_split',e.get('spatial_role','unspecified'))
        if not e['splits'] or set(e['splits'])-set(SEEDS):raise ValueError('unknown/empty splits')
    args.out.mkdir(parents=True,exist_ok=True)
    controls.SEEDS=SEEDS.copy()  # Explicit protocol override; generator otherwise unchanged.
    config=dict(description=__doc__,manifest=entries,seeds=SEEDS,models=list(MODELS),
        negative_n_per_family_split_geometry=args.negative_n,positive_n_per_snr_split_geometry=args.positive_n,
        noise_quantum_whitened=1/32,negative_families=controls.NEGATIVE_FAMILIES,positive_snr=controls.SNR,
        controls_source=str(Path(controls.__file__).resolve()),
        solver_source_sha256=hashlib.sha256(Path(sys.modules[from_snapshot.__module__].__file__).read_bytes()).hexdigest(),
        background_models_source_sha256=hashlib.sha256(Path(sys.modules[BackgroundNNLS.__module__].__file__).read_bytes()).hexdigest(),
        controls_source_sha256=hashlib.sha256(Path(controls.__file__).read_bytes()).hexdigest(),
        calibration='one threshold per model pooled over manifest calibration geometries only; evaluation labels do not tune thresholds',
        amplitudes='one shared GT amplitude per SNR from original nine-grid projected GT norm; excludes local bump',
        masked_score='mask RSS gain / max(full mask RSS / max(mask_pixels - full_cell_columns,1),1)',
        baseline_score='full-region RSS gain / max(full RSS / max(fov_pixels - background_columns - full_cell_columns,1),1)',
        gt_alignment='gt_offset is evaluator working->GT shift; inject GT shifted by negative offset',
        native_transient_selection_simulated=False,sequential_ledger_simulated=False,
        rate_scope='probe-level synthetic controls, not production false-cell rates',
        missing_geometry_policy='invalid geometry/model has no score rows; if any calibration geometry invalid for a model, exclude that model from all summaries; evaluation omissions explicitly recorded')
    calibration_rows=external_calibration(args.calibration_results,config,entries) if args.calibration_results else []
    if not calibration_rows and not any('calibration' in e['splits'] for e in entries):raise ValueError('Evaluation-only manifest requires --calibration-results')
    # Freeze candidates, protocol, seeds and spatial split before numerical scoring.
    save_json(args.out/'config.json',config)
    diagnostics={};prepared={};bad_cal=set()
    for e in entries:
        label=e['label'];s=load_snapshot(e['snapshot'])
        if s.a.shape[1]<2:raise ValueError(f'{label}: controls require a non-target neighbor')
        gt,norm=ground_truth(e,s)
        variants=make_variants(s);arms={};status={}
        for model in MODELS:
            try:
                if model.startswith('masked'):
                    arm=from_snapshot(s,int(model[-1]));details=dict(arm.diagnostics, gt_outside_mask_energy_fraction=float(np.sum(gt[arm.outside]**2)/np.sum(gt**2)), gt_inside_mask_energy_fraction=float(np.sum(gt[arm.mask]**2)/np.sum(gt**2)))
                else:
                    spec=variants[model]
                    arm=(BackgroundNNLS(s.a,spec),BackgroundNNLS(np.delete(s.a,s.target_index,axis=1),spec),spec)
                    details={'background_columns':spec.b.shape[1]}
                arms[model]=arm;status[model]=dict(status='valid',**details)
            except (ValueError,np.linalg.LinAlgError) as exc:
                status[model]=dict(status='excluded',reason=str(exc))
                if 'calibration' in e['splits']:bad_cal.add(model)
        diagnostics[label]=dict(gt_projected_norm=norm,gt_id=e['gt_id'],spatial_split=e.get('spatial_split'),models=status)
        prepared[label]=(s,gt,arms)
    save_json(args.out/'solver_diagnostics.json',diagnostics)
    all_cases=[];scores=[]
    for e in entries:
        label=e['label'];s,gt,arms=prepared[label]
        for split in e['splits']:
            Y,cases=controls.make_cases(s,label,gt,split,args.negative_n,args.positive_n,gt_id=e['gt_id'])
            for c in cases:c['spatial_split']=e.get('spatial_split','unspecified');c['gt_id']=e['gt_id']
            all_cases.extend(cases)
            for model,arm in arms.items():
                print(label,split,model,len(cases),flush=True)
                if model.startswith('masked'):
                    fits=arm.solve_many(Y)
                    dof=max(int(arm.mask.sum())-s.a.shape[1],1)
                    results=[(f['raw_full'],f['raw_gain'],f['target_c'],f.get('outside_kkt',0),0) for f in fits]
                else:
                    full,red,spec=arm
                    dof=max(int(np.count_nonzero(s.fov))-spec.b.shape[1]-s.a.shape[1],1)
                    results=[(f['raw_residual'],r['raw_residual']-f['raw_residual'],float(f['c'][s.target_index]),f['kkt'],r['kkt']) for f,r in zip(full.solve_many(Y),red.solve_many(Y))]
                for case,(rss,gain,coefficient,fk,rk) in zip(cases,results):
                    scale=max(rss/dof,1.)
                    scores.append({k:case[k] for k in ('case_id','anatomy','split','label','family','snr','seed','spatial_split','gt_id')} | dict(model=model,gain=gain/scale,raw_gain=gain,s2=scale,dof=dof,target_c=coefficient,full_kkt=None if model.startswith('masked') else fk,red_kkt=None if model.startswith('masked') else rk,outside_kkt=fk if model.startswith('masked') else None,summary_eligible=model not in bad_cal))
            controls.dump_tsv(args.out/'cases.tsv',all_cases)
            controls.dump_tsv(args.out/'scores.tsv',scores)
    eligible=[r for r in scores if r['summary_eligible']]
    save_json(args.out/'summary_exclusions.json',dict(models_with_incomplete_calibration=sorted(bad_cal)))
    metrics=summarize_metrics(calibration_rows+eligible,args.out) if eligible else []
    save_json(args.out/'summary.json',dict(cases=len(all_cases),scores=len(scores),metrics=metrics))
    print('done',len(all_cases),'cases',len(scores),'scores',flush=True)

if __name__=='__main__':main()
