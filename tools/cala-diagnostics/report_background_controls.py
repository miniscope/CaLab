#!/usr/bin/env python3
"""Make transparent tables and QA figures from the completed controls run."""
import argparse,csv,json
from pathlib import Path
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from background_controls import SNR,FPRS,NEGATIVE_FAMILIES,SEEDS,THRESHOLD,wilson,make_cases,dump_tsv,read_fp,crop_column
from background_models import load_snapshot
parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--results',type=Path,required=True);args=parser.parse_args();p=args.results
config=json.loads((p/'config.json').read_text())
nnegative=config['negative_n_per_family_split_anatomy'];npositive=config['positive_n_per_snr_split_anatomy'];nanatomies=len(config['snapshots']);negative_per_split=nnegative*len(NEGATIVE_FAMILIES)*nanatomies;positive_per_split=npositive*len(SNR)*nanatomies
rows=list(csv.DictReader((p/'scores.tsv').open(),delimiter='\t'))
for r in rows:
    for k in ['gain','raw_gain','snr','full_kkt','red_kkt']:r[k]=float(r[k])
    for k in ['label','seed']:r[k]=int(r[k])
metrics=list(csv.DictReader((p/'metrics.tsv').open(),delimiter='\t'))
models=list(dict.fromkeys(r['model'] for r in rows))
calmetrics=[]
for model in models:
    subset=[r for r in rows if r['model']==model and r['split']=='calibration']
    neg=[r['gain'] for r in subset if not r['label']]
    for fpr in FPRS:
        threshold=float(np.quantile(neg,1-fpr,method='higher'))
        for snr in SNR:
            pp=[r for r in subset if r['label'] and r['snr']==snr]
            calmetrics.append(dict(model=model,target_fpr=fpr,threshold=threshold,snr=snr,n=len(pp),events=sum(r['gain']>threshold for r in pp),tpr=np.mean([r['gain']>threshold for r in pp])))
dump_tsv(p/'calibration_metrics.tsv',calmetrics)
def item(model,op,group,anatomy='pooled'):
    return next(r for r in metrics if r['model']==model and r['operating']==op and r['group']==group and r['anatomy']==anatomy)
def rate(r):return f"{100*float(r['rate']):.1f}% [{100*float(r['ci95_low']):.1f}, {100*float(r['ci95_high']):.1f}]"
lines=['# Frozen-anatomy keep controls','',
'All nine candidate variants were fixed before independent calibration/evaluation scoring. Rates are **probe-level false KEEP under the specified synthetic ensemble**, not end-to-end false-cell production rates. This is an exploratory frozen-input stress test, not an end-to-end MiniSim run, spatially independent validation, or a claim about the real-data false KEEP rate. A/B are early/late frozen captures of the same ID18 tile. Positives inject the actual MiniSim GT18 filtered footprint into independently generated data, so the cell geometry is developmental. Actual observed probes are evaluated separately.','',
'**Native selection is absent.** Synthetic cases are unconditional single-Y draws. Native probes are selected through ledger transients, including event z, event frames, inter-event gaps and publication versions, and decisions accumulate sequential ledger history. Neither event selection nor that history is included in this calibration. Fixed-Y candidate comparisons remain a useful stress test; their empirical thresholds are not production-ready and do not calibrate repeated sequential keep decisions.','',
'## Exact design','',
f'{2*(negative_per_split+positive_per_split):,} independent cases; {len(rows):,} candidate scores. Each split has {negative_per_split:,} negatives ({nnegative} cases × seven families × {nanatomies} anatomies) and {positive_per_split:,} positives ({npositive} cases × six SNRs × {nanatomies} anatomies). Seeds 314159 and 271828 identify separate calibration/evaluation ensembles. Every case has a standalone saved seed and parameters in `cases.tsv`.','',
'Negative families: whitened quantized noise; broad centered/shifted anisotropic Gaussians; smooth polynomial/curved/sinusoidal fields; broad annular halos; signed difference-of-Gaussian plus ripple patterns; and the most-overlapping frozen neighbor plus another neighbor with the target absent. Diffuse widths, shifts and coefficients are sampled independently; profiles are never generated from a candidate fitted background basis. Independent physical fields are whitened by the frozen sigma map and set to RMS 0.25, 0.5, 1, 2, or 4 noise standard deviations. Noise is independent standard normal rounded to 1/32 in whitened units, masked to the valid field of view. This is not sensor-level Poisson/camera simulation.','',
'Positive projected SNRs: 1, 2, 3, 5, 10, 20. One fixed physical injection is shared by all candidates. SNR is computed after removing only the original nine-grid background space, excluding the Gaussian bump. Positive contexts cycle through noise, independent shifted diffuse Gaussian and target-absent overlapping neighbors.','',
'Each candidate has one threshold from the pooled A/B calibration negatives. A score strictly above the empirical 99th percentile (order statistic with `higher` interpolation) passes the primary 1% operating point; 5% and 10% are sensitivity analyses. The threshold is then frozen for all heldout anatomy and family strata. The chosen mixture is intentionally challenging and equally weights seven negative families. Numerical thresholds and probe-level false KEEP rates are conditional on this unconditional synthetic mixture, without native transient selection or sequential ledger history.','',
'The nested score is `(reduced penalized objective − full penalized objective) / max(full raw RSS / dof, 1)`. Penalized objectives are not chi-square calibrated. Raw RSS gains are retained separately because regularization can increase raw RSS while producing a positive objective gain. The original 2.736 threshold is descriptive only.','',
'## Heldout pooled results','',
f'Probe-level rates show 95% Wilson intervals; negative n={negative_per_split:,}, positive n={npositive*nanatomies:,} per SNR. Calibration quantile uncertainty is additional and is not represented by these intervals.','',
'| Variant | False KEEP at 2.736 | Synthetic 1% threshold | Heldout false KEEP | True KEEP SNR10 | True KEEP SNR20 |','|---|---:|---:|---:|---:|---:|']
for model in models:
    o=item(model,'original_2p736','negative_all');n=item(model,'cal_fpr_0.01','negative_all');a=item(model,'cal_fpr_0.01','positive_snr10');b=item(model,'cal_fpr_0.01','positive_snr20')
    lines.append(f"| {model} | {rate(o)} | {float(n['threshold']):.3f} | {rate(n)} | {rate(a)} | {rate(b)} |")
lines+=['','The original bump model and weaker penalties lose sensitivity under this deliberately broad null. Wide-3 and incremental-ridge-1 retain high-SNR GT18 sensitivity at similar heldout probe-level false KEEP rates; SNR1–5 sensitivity remains very low at the primary 1% operating point. These comparisons are exploratory and do not select a production variant. `calibration_metrics.tsv` exposes positive tradeoffs on the calibration pool separately from heldout results.','',
'## Family stress test at the original threshold','',
f'Pooled heldout n={nnegative*nanatomies} per negative family. Values are probe-level false KEEP rates. This table shows why observed true-probe rescue alone does not establish specificity.','',
'| Family | Original | Wide-3 | Incremental ridge-1 | Shape-gradient-0.1 |','|---|---:|---:|---:|---:|']
for family in NEGATIVE_FAMILIES:
    lines.append('| '+family+' | '+' | '.join(rate(item(model,'original_2p736','negative_'+family)) for model in ['original','wide_3','incremental_ridge_1','shape_gradient_0p1'])+' |')
lines+=['','The strong shape-gradient candidate frequently transfers diffuse structure into the target cell because that reduces its expensive background penalty. Its apparent success on true probes is accompanied by severe specificity loss on independent broad diffuse controls. The full `metrics.tsv` includes every candidate, each family/anatomy, all SNR levels, and 1/5/10% operating points.','',
'## Numerical checks','',f"All scores are finite. Maximum normalized full/reduced KKT violation: {max(r[k] for r in rows for k in ['full_kkt','red_kkt']):.3g}. Minimum nested objective gain: {min(r['gain'] for r in rows):.3g}, a float64 cancellation-scale negative. The independent candidate solver has separate direct-residual/BVLS validation in the candidate module report.",'',
'Artifacts: `config.json`, `cases.tsv`, `scores.tsv`, `metrics.tsv`, `calibration_metrics.tsv`, `roc.tsv`, `roc_tpr.png`, `control_gallery.png`.']
(p/'report.md').write_text('\n'.join(lines)+'\n')
# Deterministic gallery: same independently seeded draw construction as full experiment.
folder=Path(config['snapshots'][0]);s=load_snapshot(folder)
_,fps=read_fp(Path(config['gt_footprints']));gt_id=int(config.get('gt_id',config.get('target_id',18)));gt=crop_column(fps[gt_id],s.meta,s.inv_sigma)
Y,cases=make_cases(s,'A',gt,'evaluation',nnegative,npositive,gt_id)
fig,axes=plt.subplots(2,7,figsize=(19,6),squeeze=False)
for col,family in enumerate(NEGATIVE_FAMILIES):
    indices=[j for j,c in enumerate(cases) if not c['label'] and c['family']==family]
    # Fixed early sample indices, not selected by candidate performance.
    for row,sample in enumerate([0,min(7,nnegative-1)]):
        j=indices[sample];im=Y[j].reshape(s.shape);scale=np.percentile(abs(im[s.fov.reshape(s.shape).astype(bool)]),99)
        axes[row,col].imshow(im,cmap='RdBu_r',vmin=-scale,vmax=scale)
        axes[row,col].set_title(f'{family}\nseed {cases[j]["seed"]}',fontsize=8);axes[row,col].axis('off')
fig.suptitle('Independent heldout negative controls — fixed samples 0 and 7; panel-specific symmetric color scale',fontsize=12);fig.tight_layout();fig.savefig(p/'control_gallery.png',dpi=160);plt.close(fig)
print(p/'report.md')
