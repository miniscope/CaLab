#!/usr/bin/env python3
"""Independent frozen-anatomy synthetic controls (not an end-to-end MiniSim run).

No fitted candidate-background vectors are used to generate diffuse signals.
Seeds and operating points are declared before scoring. The controls keep frozen
A/B/sigma geometry but draw independent quantized unit noise and independent
smooth spatial fields, with real MiniSim GT18 footprint injections for positives.
Rates are probe-level false KEEP under this specified synthetic ensemble. Native
transient selection and sequential ledger history are not simulated; empirical
thresholds from this experiment are not production-ready.
"""
from pathlib import Path
import argparse, csv, json, struct
import numpy as np
from scipy.stats import rankdata
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from background_models import load_snapshot, make_variants, BackgroundNNLS

NEGATIVE_FAMILIES=['quantized_noise','broad_centered','broad_shifted','smooth_curved','broad_halo','signed_filtered','neighbors_only']
SNR=[1.,2.,3.,5.,10.,20.]
FPRS=[.01,.05,.10]
THRESHOLD=.5+2*np.sqrt(1.25)
SEEDS={'calibration':314159,'evaluation':271828}

def read_fp(path):
    """Read the portable CALAFP01 footprint export (raw and filtered values)."""
    def take(f,dtype,n):
        return np.frombuffer(f.read(np.dtype(dtype).itemsize*n),dtype=dtype).copy()
    with Path(path).open('rb') as f:
        if f.read(8)!=b'CALAFP01':raise ValueError(f'Bad footprint magic: {path}')
        h,w,n=struct.unpack('<III',f.read(12));cells={}
        for _ in range(n):
            ident,k=struct.unpack('<II',f.read(8))
            cells[ident]=(take(f,'<u4',k),take(f,'<f4',k),take(f,'<f4',k))
    return (h,w),cells

def crop_column(fp,meta,inv_sigma):
    """Crop a full-frame filtered footprint and apply frozen whitening."""
    width=int(meta['width']);y0=int(meta['rect_y0']);x0=int(meta['rect_x0'])
    h=int(meta['rect_height']);w=int(meta['rect_width'])
    pixels,_,filtered=fp;yy=pixels.astype(np.int64)//width-y0;xx=pixels.astype(np.int64)%width-x0
    valid=(yy>=0)&(yy<h)&(xx>=0)&(xx<w)
    a=np.zeros(h*w);a[yy[valid]*w+xx[valid]]=filtered[valid]
    return np.multiply(a,inv_sigma,dtype=np.float32).astype(float)

def json_safe(value):
    if isinstance(value,dict):return {str(k):json_safe(v) for k,v in value.items()}
    if isinstance(value,(list,tuple)):return [json_safe(v) for v in value]
    if isinstance(value,np.ndarray):return json_safe(value.tolist())
    if isinstance(value,np.generic):return value.item()
    return value

def make_signal(s, family, rng):
    """Whiten raw independent spatial fields with frozen sigma, then set RMS."""
    h,w=s.shape; yy,xx=np.mgrid[:h,:w]
    target=s.a[:,s.target_index]
    mass=np.maximum(target,0).reshape(h,w)
    cy=float((yy*mass).sum()/mass.sum());cx=float((xx*mass).sum()/mass.sum())
    d=18.; x=(xx-cx)/d;y=(yy-cy)/d
    if family=='quantized_noise': return np.zeros(h*w),{}
    pars={}
    if family=='broad_centered':
        sx,sy=rng.uniform(1.2,3.6,2);field=np.exp(-.5*((x/sx)**2+(y/sy)**2));pars={'sx_d':sx,'sy_d':sy}
    elif family=='broad_shifted':
        dx,dy=rng.uniform(-1.1,1.1,2);sx,sy=rng.uniform(.95,3.4,2)
        field=np.exp(-.5*(((x-dx)/sx)**2+((y-dy)/sy)**2));pars={'dx_d':dx,'dy_d':dy,'sx_d':sx,'sy_d':sy}
    elif family=='smooth_curved':
        u=(xx-w/2)/w;v=(yy-h/2)/h;coef=rng.normal(size=7)
        field=coef[0]+coef[1]*u+coef[2]*v+coef[3]*u*v+coef[4]*u*u+coef[5]*v*v+coef[6]*np.sin(rng.uniform(.6,1.8)*np.pi*u+rng.uniform(0,6.28))
        pars={'coefficients':coef.tolist()}
    elif family=='broad_halo':
        dx,dy=rng.uniform(-.6,.6,2);rr=np.sqrt((x-dx)**2+(y-dy)**2);radius=rng.uniform(1,2.7);width=rng.uniform(.35,.85)
        field=np.exp(-.5*((rr-radius)/width)**2);pars={'dx_d':dx,'dy_d':dy,'radius_d':radius,'width_d':width}
    elif family=='signed_filtered':
        dx,dy=rng.uniform(-1,1,2);sx,sy=rng.uniform(.8,2.5,2);ratio=rng.uniform(1.3,2.4)
        inner=np.exp(-.5*(((x-dx)/sx)**2+((y-dy)/sy)**2));outer=np.exp(-.5*(((x-dx)/(sx*ratio))**2+((y-dy)/(sy*ratio))**2))/ratio**2
        field=rng.choice([-1.,1.])*(inner-outer)+.15*np.sin(rng.uniform(.35,.8)*x+rng.uniform(.35,.8)*y+rng.uniform(0,6.28))
        pars={'dx_d':dx,'dy_d':dy,'sx_d':sx,'sy_d':sy,'ratio':ratio}
    elif family=='neighbors_only':
        indices=np.flatnonzero(np.arange(len(s.ids))!=s.target_index)
        cos=(s.a[:,indices].T@target)/np.maximum(np.linalg.norm(s.a[:,indices],axis=0)*np.linalg.norm(target),1e-20)
        # Force the most-overlapping neighbor into every draw, plus another independently drawn one.
        js=list(dict.fromkeys([int(indices[np.argmax(cos)]),int(rng.choice(indices))]))
        signal=np.zeros(h*w); amps=[]
        for j in js:
            amp=rng.uniform(12,65)/max(np.linalg.norm(s.a[:,j]),1e-20);signal+=amp*s.a[:,j];amps.append(amp)
        return signal,{'neighbor_ids':[int(s.ids[j]) for j in js],'coefficients':amps,'target_present':False}
    else: raise ValueError(family)
    field=np.asarray(field).ravel()*s.inv_sigma
    field*=s.fov
    rms=float(rng.choice([.25,.5,1.,2.,4.]))
    field*=rms*np.sqrt(np.count_nonzero(s.fov))/max(np.linalg.norm(field),1e-20)
    pars['whitened_rms']=rms
    return field,pars

def make_cases(s,label,gt,split,nnegative,npositive,gt_id=18):
    split_seed=SEEDS[split]; cases=[];ys=[]
    # Separate sequence identities for anatomy, family, split; every case has a standalone seed.
    anatomy_code=sum((j+1)*ord(x) for j,x in enumerate(label))
    for fi,family in enumerate(NEGATIVE_FAMILIES):
        for j in range(nnegative):
            seed=np.random.SeedSequence([split_seed,anatomy_code,fi,j]).generate_state(1)[0].item();rng=np.random.default_rng(seed)
            signal,pars=make_signal(s,family,rng)
            noise=np.round(rng.normal(size=s.a.shape[0])*32)/32
            y=(signal+noise)*s.fov
            cases.append(dict(case_id=f'{label}_{split}_{family}_{j:04}',anatomy=label,split=split,label=0,family=family,snr=0,seed=seed,parameters=pars))
            ys.append(y)
    # GT18 filtered column comes from MiniSim ground truth, independent of fitted A.
    # SNR refers to its whitened norm after the nine original free grid maps (excluding local bump).
    base=make_variants(s)['original']; q,_=np.linalg.qr(base.b[:,:-1],mode='reduced')
    gp=gt-q@(q.T@gt);g_norm=np.linalg.norm(gp)
    for si,snr in enumerate(SNR):
        for j in range(npositive):
            seed=np.random.SeedSequence([split_seed,anatomy_code,100+si,j]).generate_state(1)[0].item();rng=np.random.default_rng(seed)
            context=['quantized_noise','broad_shifted','neighbors_only'][j%3]
            signal,pars=make_signal(s,context,rng)
            noise=np.round(rng.normal(size=s.a.shape[0])*32)/32
            amp=snr/max(g_norm,1e-20);y=(signal+amp*gt+noise)*s.fov
            cases.append(dict(case_id=f'{label}_{split}_gt{gt_id}_snr{snr:g}_{j:04}',anatomy=label,split=split,label=1,family=f'gt{gt_id}_'+context,snr=snr,seed=seed,parameters=dict(pars,gt_coefficient=amp,projected_gt_norm=g_norm)))
            ys.append(y)
    return np.asarray(ys),cases

def dump_tsv(path,rows):
    if not rows:return
    keys=list(dict.fromkeys(k for r in rows for k in r))
    with path.open('w') as f:
        writer=csv.DictWriter(f,fieldnames=keys,delimiter='\t');writer.writeheader()
        for r in rows:writer.writerow({k:json.dumps(json_safe(v),sort_keys=True) if isinstance(v,(dict,list,np.ndarray)) else v for k,v in r.items()})

def auc(neg,pos):
    if not len(pos) or not len(neg):return None
    ranks=rankdata(np.r_[neg,pos]);n=len(pos)
    return float((ranks[len(neg):].sum()-n*(n+1)/2)/(n*len(neg)))

def wilson(k,n):
    if not n:return (None,None)
    z=1.959963984540054;p=k/n;den=1+z*z/n
    mid=(p+z*z/(2*n))/den;half=z*np.sqrt(p*(1-p)/n+z*z/(4*n*n))/den
    return float(max(0,mid-half)),float(min(1,mid+half))

def summarize(rows,out):
    groups={}
    for row in rows:
        groups.setdefault((row['anatomy'],row['model']),[]).append(row)
        groups.setdefault(('pooled',row['model']),[]).append(row)
    metrics=[];roc=[]
    for (anatomy,model),group in groups.items():
        calibration=np.array([r['gain'] for r in rows if r['model']==model and r['split']=='calibration' and not r['label']])
        evaluation=[r for r in group if r['split']=='evaluation'];neg=np.array([r['gain'] for r in evaluation if not r['label']]);pos=np.array([r['gain'] for r in evaluation if r['label']])
        thresholds={'original_2p736':THRESHOLD}
        for fpr in FPRS: thresholds[f'cal_fpr_{fpr:g}']=float(np.quantile(calibration,1-fpr,method='higher'))
        for operating,threshold in thresholds.items():
            for family in ['all']+NEGATIVE_FAMILIES:
                selected=[r for r in evaluation if not r['label'] and (family=='all' or r['family']==family)]
                metrics.append(dict(anatomy=anatomy,model=model,operating=operating,threshold=threshold,group='negative_'+family,n=len(selected),rate=float(np.mean([r['gain']>threshold for r in selected])),auc=auc(neg,pos)))
            for snr in SNR:
                selected=[r for r in evaluation if r['label'] and r['snr']==snr]
                metrics.append(dict(anatomy=anatomy,model=model,operating=operating,threshold=threshold,group=f'positive_snr{snr:g}',n=len(selected),rate=float(np.mean([r['gain']>threshold for r in selected])),auc=auc(neg,np.array([r['gain'] for r in selected]))))
        for threshold in np.unique(np.r_[0,np.quantile(np.r_[neg,pos],np.linspace(0,1,301))]):
            roc.append(dict(anatomy=anatomy,model=model,threshold=threshold,fpr=float(np.mean(neg>threshold)),tpr=float(np.mean(pos>threshold))))
    for metric in metrics:
        k=round(metric['rate']*metric['n']);lo,hi=wilson(k,metric['n'])
        metric.update(events=k,ci95_low=lo,ci95_high=hi)
    dump_tsv(out/'metrics.tsv',metrics);dump_tsv(out/'roc.tsv',roc)
    models=sorted(set(r['model'] for r in rows));anatomies=sorted(set(r['anatomy'] for r in rows));colors=plt.cm.tab10(np.linspace(0,1,len(models)))
    fig,axes=plt.subplots(2,len(anatomies),figsize=(7*len(anatomies),10),squeeze=False)
    for col,a in enumerate(anatomies):
        for model,color in zip(models,colors):
            rr=[r for r in roc if r['anatomy']==a and r['model']==model]
            axes[0,col].plot([r['fpr'] for r in rr],[r['tpr'] for r in rr],label=model,color=color)
            mm=[r for r in metrics if r['anatomy']==a and r['model']==model and r['operating']=='cal_fpr_0.01' and r['group'].startswith('positive')]
            axes[1,col].plot(SNR,[r['rate'] for r in mm],marker='o',label=model,color=color)
        axes[0,col].set(title=f'{a}: heldout synthetic controls',xlabel='Probe-level false KEEP rate (synthetic)',ylabel='Probe-level true KEEP rate',xlim=(0,.3),ylim=(0,1))
        axes[1,col].set(title='Synthetic-probe calibration: target false KEEP 1%',xlabel='Injected GT projected SNR',ylabel='Probe-level true KEEP rate',ylim=(0,1))
        axes[0,col].grid(alpha=.25);axes[1,col].grid(alpha=.25)
    axes[0,-1].legend(fontsize=7,loc='lower right');fig.tight_layout();fig.savefig(out/'roc_tpr.png',dpi=170);plt.close(fig)
    return metrics

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--gt-footprints',type=Path,required=True,help='CALAFP01 export containing MiniSim GT18');parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--gt-id',type=int,default=18,help='ID in exported GT footprint library (not detector ID)');parser.add_argument('--negative-n',type=int,default=128);parser.add_argument('--positive-n',type=int,default=64)
    parser.add_argument('--snapshots',type=Path,nargs='+',required=True,help='Frozen keep snapshot folders; this fixed experiment uses the early/late ID18 captures');args=parser.parse_args();args.out.mkdir(parents=True,exist_ok=True)
    folders=args.snapshots
    _,fps=read_fp(args.gt_footprints);manifest=[];rows=[];model_configs={}
    for ai,folder in enumerate(folders):
        label=chr(65+ai);s=load_snapshot(folder);gt=crop_column(fps[args.gt_id],s.meta,s.inv_sigma)
        variants=make_variants(s);model_configs[label]={k:v.metadata for k,v in variants.items()}
        for split in SEEDS:
            Y,cases=make_cases(s,label,gt,split,args.negative_n,args.positive_n,args.gt_id);manifest.extend(cases)
            for model,spec in variants.items():
                print(label,split,model,len(cases),flush=True)
                full=BackgroundNNLS(s.a,spec);red=BackgroundNNLS(np.delete(s.a,s.target_index,axis=1),spec)
                ff=full.solve_many(Y);rr=red.solve_many(Y)
                # Fixed original fov count; candidate model changes background degrees only.
                dof=max(np.count_nonzero(s.fov)-spec.b.shape[1]-s.a.shape[1],1)
                for case,f,r in zip(cases,ff,rr):
                    residual=f['raw_residual'];s2=max(residual/dof,1.);gain=(r['objective']-f['objective'])/s2
                    rows.append({k:case[k] for k in ['case_id','anatomy','split','label','family','snr','seed']}|dict(model=model,gain=gain,raw_gain=(r['raw_residual']-residual)/s2,s2=s2,target_c=float(f['c'][s.target_index]),full_kkt=f['kkt'],red_kkt=r['kkt'],pass_at_original=bool(gain>THRESHOLD)))
        print('finished',label,flush=True)
    config=dict(description=__doc__,negative_families=NEGATIVE_FAMILIES,positive_snr=SNR,predeclared_fpr=FPRS,seeds=SEEDS,negative_n_per_family_split_anatomy=args.negative_n,positive_n_per_snr_split_anatomy=args.positive_n,noise_quantum_whitened=1/32,gt_footprints=str(args.gt_footprints.resolve()),gt_id=args.gt_id,diameter_px=18,rate_scope='probe-level false KEEP under specified synthetic ensemble',native_probe_selection_simulated=False,sequential_ledger_simulated=False,snapshots=[str(p) for p in folders],models=model_configs,score='nested penalized objective gain / max(full raw residual / dof, 1)',original_threshold=THRESHOLD,notes=['Synthetic frozen-anatomy probe controls, not an end-to-end MiniSim evaluation or false-cell production rate.','Draws are unconditional single-Y observations. Native ledger transient selection (event z, event frames, gaps, publication version) and sequential ledger history are not modeled. Empirical thresholds are not production-ready.','A/B are temporal captures of the same physical tile unless explicit snapshots supplied.','Positives use actual independently generated MiniSim GT18 filtered footprint; GT18 is developmental same-anatomy geometry, not spatially heldout.','All positive SNR levels use the same base nine-grid residualization, excluding the local bump; no candidate-dependent amplitudes.','Negative family profiles never use exact candidate background vectors.','Original threshold is descriptive; model-specific empirical null calibration uses calibration seeds only.','Calibration and evaluation seeds are disjoint. Models are fixed before heldout scoring.','One threshold per candidate is calibrated from pooled A/B negative cases and used for all heldout anatomy/family strata; no geometry-specific tuning.','Pooled negative families are equally weighted; operating-point results depend on this mixture.'])
    (args.out/'config.json').write_text(json.dumps(json_safe(config),indent=2));dump_tsv(args.out/'cases.tsv',manifest);dump_tsv(args.out/'scores.tsv',rows)
    metrics=summarize(rows,args.out)
    (args.out/'summary.json').write_text(json.dumps(json_safe(dict(config=config,metrics=metrics)),indent=2))
    print('done',len(manifest),'independent cases',len(rows),'model scores',flush=True)
if __name__=='__main__':main()
