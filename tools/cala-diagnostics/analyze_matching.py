"""Exact final filtered-GT matching sensitivity plus edge reporting.
Requires GT exports from discover_eval; reproduces its union-support Pearson,
positive filtered centroid, 15px gate and Hungarian assignment.
"""
import argparse
import csv,json,struct,sys
from pathlib import Path
import numpy as np
from scipy.optimize import linear_sum_assignment

def table(p):
    with p.open() as f: return list(csv.DictReader(f,delimiter='\t'))

def readfp(p):
    with p.open('rb') as f:
        assert f.read(8)==b'CALAFP01'
        h,w,n=struct.unpack('<III',f.read(12)); out=[]
        for _ in range(n):
            i,k=struct.unpack('<II',f.read(8))
            pix=np.frombuffer(f.read(4*k),dtype='<u4').copy()
            raw=np.frombuffer(f.read(4*k),dtype='<f4').copy()
            val=np.frombuffer(f.read(4*k),dtype='<f4').copy()
            out.append(dict(id=i,pix=pix,raw=raw,val=val))
    return h,w,out

def centroid(a,w):
    v=np.maximum(a['val'].astype(float),0); den=max(v.sum(),1e-12)
    return np.array([(a['pix']//w*v).sum()/den,(a['pix']%w*v).sum()/den])

def corr(a,b):
    _,ia,ib=np.intersect1d(a['pix'],b['pix'],return_indices=True)
    x,y=a['val'].astype(float),b['val'].astype(float)
    n=len(x)+len(y)-len(ia); sx,sy=x.sum(),y.sum()
    xx,yy=np.dot(x,x)-sx*sx/n,np.dot(y,y)-sy*sy/n
    return (np.dot(x[ia],y[ib])-sx*sy/n)/np.sqrt(xx*yy) if xx>0 and yy>0 else 0.

def edge(c,h,w): return np.min(np.c_[c[:,0],c[:,1],h-1-c[:,0],w-1-c[:,1]],axis=1)

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root', type=Path, required=True, help='Benchmark root containing small_runs and optional gt_exports')
parser.add_argument('--json', type=Path, help='Output JSON; default ROOT/small_matching_sensitivity.json')
args = parser.parse_args()
root=args.root.resolve(); results={}
for run in sorted((root/'small_runs').iterdir()):
    if not run.is_dir() or not all((run / name).exists() for name in ['footprints.bin', 'labels.tsv']):continue
    h,w,det=readfp(run/'footprints.bin'); dc=np.array([centroid(a,w) for a in det]); de=edge(dc,h,w)
    labels=table(run/'labels.tsv'); classes=np.array([a['class'] for a in labels]); matched=classes=='match'
    out={'edge_precision_original_r07':{str(g):dict(cells=int((de>=g).sum()),matched=int(((de>=g)&matched).sum()),precision=float(matched[de>=g].mean()) if (de>=g).any() else None,unexplained=int(((de>=g)&(classes=='fp')).sum())) for g in [0,10,16,24]},'unexplained_centroids':[{**labels[i], 'cy':float(dc[i,0]),'cx':float(dc[i,1]),'edge_px':float(de[i])} for i in range(len(det)) if classes[i]=='fp']}
    gtpath=root/'gt_exports'/run.name
    if (gtpath/'gt_footprints.bin').exists():
        gh,gw,gt=readfp(gtpath/'gt_footprints.bin'); assert (gh,gw)==(h,w)
        off=table(gtpath/'gt_offset.tsv')[0]; dy,dx=int(off['dy']),int(off['dx'])
        for a in det:
            ys=a['pix'].astype(np.int64)//w+dy; xs=a['pix'].astype(np.int64)%w+dx
            keep=(ys>=0)&(xs>=0)&(ys<h)&(xs<w)
            a['pix']=(ys[keep]*w+xs[keep]).astype(np.uint32);a['val']=a['val'][keep]
        dcs=np.array([centroid(a,w) for a in det]);gc=np.array([centroid(a,w) for a in gt]); ge=edge(gc,h,w)
        detectable=np.array([r['detectable']=='true' for r in table(gtpath/'gt_units.tsv')])
        rs=np.full((len(det),len(gt)),-1.)
        for i,a in enumerate(det):
            for j,b in enumerate(gt):
                if ((dcs[i]-gc[j])**2).sum()<=225:rs[i,j]=corr(a,b)
        out['threshold_sensitivity']={}
        for thr in [.5,.6,.7,.8]:
            cost=np.where(rs>=thr,1-rs,1000); ii,jj=linear_sum_assignment(cost);ok=cost[ii,jj]<1000;ii,jj=ii[ok],jj[ok]
            dm=np.zeros(len(det),bool);gm=np.zeros(len(gt),bool);dm[ii]=detectable[jj];gm[jj]=True
            out['threshold_sensitivity'][str(thr)]={str(g):dict(cells=int((de>=g).sum()),matched_det=int(dm[de>=g].sum()),precision=float(dm[de>=g].mean()),detectable_gt=int(((ge>=g)&detectable).sum()),matched_gt=int((gm&(ge>=g)&detectable).sum()),recall=float(gm[(ge>=g)&detectable].mean())) for g in [0,10,16,24]}
            if thr==.7:assert int(dm.sum())==int(matched.sum()),(run,dm.sum(),matched.sum())
        out['offset']=[dy,dx]
        out['best_filtered_r']=rs.max(axis=1).tolist()
    results[run.name]=out
(args.json or root/'small_matching_sensitivity.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps({k:{q:v[q] for q in v if q!='unexplained_centroids' and q!='best_filtered_r'} for k,v in results.items()},indent=2))
