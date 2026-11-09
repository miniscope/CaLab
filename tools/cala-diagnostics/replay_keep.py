#!/usr/bin/env python3
"""Independent frozen-input keep replay: nonnegative cells, free background.

Reads diagnostic-feature keep_* snapshots, never changes CaLa or its state.
SVD projects out the free background; scipy.optimize.nnls solves cell weights.
All alternatives retain the same stored whitened probe pixels. Target-only
footprint replacements retain the snapshot's neighbours/background/noise map.
"""
import argparse
import csv
import json
import struct
from pathlib import Path

import numpy as np
from scipy.optimize import nnls


def tsv(path):
    with path.open() as f:
        return list(csv.DictReader(f, delimiter='\t'))


def meta_load(path):
    rows=tsv(path)
    return {r.get('key',r.get('name')): r.get('value') for r in rows}


def number(m, *names, default=None):
    for n in names:
        if n in m:
            return float(m[n])
    if default is not None:
        return float(default)
    raise KeyError(names)


def array(path, dtype, shape=None):
    a=np.fromfile(path,dtype=dtype)
    return a.reshape(shape) if shape is not None else a


def read_fp(path):
    def take(f,d,n):
        return np.frombuffer(f.read(np.dtype(d).itemsize*n),dtype=d).copy()
    with path.open('rb') as f:
        if f.read(8)!=b'CALAFP01':
            raise ValueError(f'bad footprint magic: {path}')
        h,w,n=struct.unpack('<III',f.read(12)); cells={}
        for _ in range(n):
            ident,k=struct.unpack('<II',f.read(8))
            cells[ident]=(take(f,'<u4',k),take(f,'<f4',k),take(f,'<f4',k))
    return (h,w),cells


def oracle_trace(path,target):
    with path.open('rb') as f:
        if f.read(8)!=b'CALAORC1': raise ValueError('bad oracle magic')
        _,_,n,t=struct.unpack('<4I',f.read(16));ids=[]
        for _ in range(n):
            ident,_,_,_,_=struct.unpack('<IBBxxff',f.read(16));ids.append(ident)
            for _ in range(2):
                _,_,h,w=struct.unpack('<iiII',f.read(16));f.seek(h*w*4,1)
        c=np.frombuffer(f.read(n*t*4),dtype='<f4').reshape(n,t)
    return c[ids.index(target)].copy()


def columns(folder, arm, npix):
    rows=tsv(folder/f'{arm}_columns.tsv')
    pix=array(folder/f'{arm}_pixels.u32','<u4')
    val=array(folder/f'{arm}_values.f32','<f4')
    a=np.zeros((npix,len(rows)),dtype=float)
    ids=[]
    for j,r in enumerate(rows):
        start=int(r['start']); end=start+int(r.get('length',r.get('len')))
        a[pix[start:end],j]=val[start:end]
        ids.append(int(r['id']))
    return np.asarray(ids),a


class FreeBackgroundNNLS:
    """Accurate independent solve of min ||Y - A c - B beta||, c >= 0."""
    def __init__(self,a,b):
        self.a=a; self.b=b
        if b.shape[1]:
            u,s,_=np.linalg.svd(b,full_matrices=False)
            self.u=u[:,s>max(b.shape)*np.finfo(float).eps*s[0]]
        else:
            self.u=np.zeros((a.shape[0],0))
        self.ap=self.project(a)
        self.q=self.ap.T@self.ap

    def project(self,x):
        return x-self.u@(self.u.T@x)

    def solve(self,y):
        yp=self.project(y)
        if self.a.shape[1]:
            c,_=nnls(self.ap,yp,maxiter=max(1000,100*self.a.shape[1]))
        else:
            c=np.empty(0)
        beta=np.linalg.lstsq(self.b,y-self.a@c,rcond=None)[0] if self.b.shape[1] else np.empty(0)
        r=y-self.a@c-self.b@beta
        grad=self.ap.T@(self.ap@c-yp)
        scale=np.maximum(np.sqrt(np.diag(self.q)),1e-15)
        kkt=np.max(np.where(c>1e-10,np.abs(grad),np.maximum(-grad,0))/scale,initial=0.)
        return dict(c=c,beta=beta,chi2=float(r@r),kkt=float(kkt))

    def native_kkt(self,y,c):
        grad=self.ap.T@(self.ap@c-self.project(y))
        scale=np.maximum(np.sqrt(np.diag(self.q)),1e-15)
        return float(np.max(np.where(c>1e-7,np.abs(grad),np.maximum(-grad,0))/scale,initial=0.))


def f32dot(a,b):
    """Rust f32 multiply with f64 accumulation (not a float64 dot)."""
    return np.sum(np.multiply(a,b,dtype=np.float32),dtype=np.float64)


class NativeQuadratic:
    """Reconstruct Rust rounded quadratic and 100-sweep coordinate solver.

    Uses the dumped ridge inverse and dumped projections, then solves that
    same rounded quadratic accurately as a separate tolerance diagnostic.
    """
    def __init__(self,a,b,bg_inv,q=None):
        a=a.astype(np.float32);b=b.astype(np.float32)
        self.a=a;self.bg_inv=bg_inv
        n=a.shape[1];k=b.shape[1]
        gcc=np.array([[f32dot(a[:,i],a[:,j]) for j in range(n)] for i in range(n)])
        self.gbc=np.array([[f32dot(b[:,i],a[:,j]) for j in range(n)] for i in range(k)])
        self.t=self.gbc.T@bg_inv
        rebuilt_q=gcc-self.t@self.gbc
        self.q=rebuilt_q if q is None else q
        self.q_rebuild_max_error=float(np.max(abs(rebuilt_q-self.q),initial=0.))

    def solve(self,y,qb,yy):
        p=np.array([f32dot(col,y) for col in self.a.T])-self.t@qb
        c=np.zeros(len(p));qc=np.zeros(len(p))
        sweeps=0;worst=0.
        for sweeps in range(1,101):
            worst=0.
            for i in range(len(p)):
                d_ii=self.q[i,i]
                if d_ii<=0: continue
                new=max(c[i]+(p[i]-qc[i])/d_ii,0.)
                d=new-c[i]
                if d:
                    c[i]=new;qc+=self.q[i]*d
                    worst=max(worst,abs(d)*np.sqrt(d_ii))
            if worst<1e-2: break
        const=yy-qb@self.bg_inv@qb
        chi=lambda x:float(const-2*p@x+x@self.q@x)
        # G_cc rounding can make Q very slightly asymmetric; symmetrize only
        # for the accurate numerical solver, recording the difference.
        q=(self.q+self.q.T)/2
        if len(p):
            l=np.linalg.cholesky(q)
            exact,_=nnls(l.T,np.linalg.solve(l,p),maxiter=max(1000,100*len(p)))
        else:
            exact=c.copy()
        grad=self.q@c-p
        kkt=np.max(np.where(c>1e-10,abs(grad),np.maximum(-grad,0))/np.sqrt(np.maximum(np.diag(q),1e-15)),initial=0.)
        return dict(chi=chi(c),exact_chi=chi(exact),c=c,exact_c=exact,sweeps=sweeps,worst=worst,kkt=float(kkt))


def crop_column(fp,m,inv_sigma):
    width=int(number(m,'width','dims_width','image_w'))
    y0=int(number(m,'rect_y0','y0')); x0=int(number(m,'rect_x0','x0'))
    h=int(number(m,'rect_height','rect_h','h')); w=int(number(m,'rect_width','rect_w','w'))
    p,_,filt=fp; yy=p.astype(np.int64)//width-y0; xx=p.astype(np.int64)%width-x0
    ok=(yy>=0)&(yy<h)&(xx>=0)&(xx<w)
    a=np.zeros(h*w);a[yy[ok]*w+xx[ok]]=filt[ok]
    return np.multiply(a,inv_sigma,dtype=np.float32).astype(float)


def json_safe(x):
    if isinstance(x,dict): return {str(k):json_safe(v) for k,v in x.items()}
    if isinstance(x,(list,tuple)): return [json_safe(v) for v in x]
    if isinstance(x,np.ndarray): return json_safe(x.tolist())
    if isinstance(x,np.generic): return x.item()
    return x


def replay(folder,replacements=None):
    m=meta_load(folder/'meta.tsv')
    npix=int(number(m,'npix','n_px','rect_len',default=int(number(m,'rect_height','rect_h','h'))*int(number(m,'rect_width','rect_w','w'))))
    nprobe=int(number(m,'nprobe','n_probe'))
    y=array(folder/'y.f32','<f4',(nprobe,npix)).astype(float)
    b=array(folder/'bg_maps.f32','<f4').reshape(-1,npix).T.astype(float)
    ids,a=columns(folder,'full',npix)
    target=int(number(m,'target_id','targetID','id',default=18)); ki=list(ids).index(target)
    rho=number(m,'rho');threshold=number(m,'pass_at')
    keep_z=(threshold/rho-.5)/np.sqrt(1.25)
    dof=number(m,'dof');fov_px=dof+b.shape[1]+len(ids)
    native_full=array(folder/'full_chi2.f64','<f8')
    native_red=array(folder/'red_chi2.f64','<f8')
    native_c=array(folder/'full_c.f32','<f4',(nprobe,len(ids)))
    redids,ared=columns(folder,'red',npix)
    native_rc=array(folder/'red_c.f32','<f4',(nprobe,len(redids)))
    bg_inv=array(folder/'bg_inv.f64','<f8',(b.shape[1],b.shape[1]))
    proj=array(folder/'proj.f64','<f8',(nprobe,b.shape[1]));yy=array(folder/'yy.f64','<f8')
    nqfull=NativeQuadratic(a,b,bg_inv,array(folder/'full_q.f64','<f8',(len(ids),len(ids))))
    nqred=NativeQuadratic(ared,b,bg_inv,array(folder/'red_q.f64','<f8',(len(redids),len(redids))))
    frames=tsv(folder/'probes.tsv')
    variants={'exact_snapshot':(a,b,ids),'no_local_bump':(a,b[:,:-1],ids),'no_neighbours':(a[:,[ki]],b,ids[[ki]])}
    inv_sigma=array(folder/'inv_sigma.f32','<f4').astype(float)
    for label,path in (replacements or {}).items():
        _,fps=read_fp(path)
        if target in fps:
            fp=fps[target]
        elif len(fps)==1:
            fp=next(iter(fps.values()))
        else:
            raise ValueError(f'replacement {path} has no target ID {target} and is not a single-cell library')
        ac=a.copy();ac[:,ki]=crop_column(fp,m,inv_sigma)
        variants[label]=(ac,b,ids)
        variants[label+'_no_local_bump']=(ac,b[:,:-1],ids)
    for name in ['target_working','target_published']:
        path=folder/f'{name}.bin'
        if path.exists():
            _,fps=read_fp(path);ac=a.copy();ac[:,ki]=crop_column(fps[target],m,inv_sigma)
            variants[name]=(ac,b,ids)
    if nprobe==1:
        original_frame=int(frames[0]['probe_original_frame'])
        capture=next((p.parent for p in folder.parent.glob('probe_*/meta.tsv')
                      if int(meta_load(p)['probe_original_frame'])==original_frame),None)
        if capture:
            oldsigma=array(capture/'inv_sigma.f32','<f4').astype(float)
            ratio=np.divide(oldsigma,inv_sigma,out=np.ones_like(oldsigma),where=inv_sigma!=0)
            variants['capture_sigma_all_columns']=(a*ratio[:,None],b,ids)
            ac=a.copy();ac[:,ki]*=ratio
            variants['capture_sigma_target_only']=(ac,b,ids)
    rows=[]; detail={}
    for name,(av,bv,iv) in variants.items():
        kv=list(iv).index(target);keep=iv!=target
        full=FreeBackgroundNNLS(av,bv);red=FreeBackgroundNNLS(av[:,keep],bv)
        share=(av[:,keep].T@av[:,kv])/max(av[:,kv]@av[:,kv],1e-12)
        energy=float(av[:,kv]@av[:,kv]);qii=float(full.q[kv,kv])
        target_projected=full.ap[:,kv]
        if np.any(keep):
            unique=target_projected-full.ap[:,keep]@np.linalg.lstsq(full.ap[:,keep],target_projected,rcond=None)[0]
            cos=(av[:,keep].T@av[:,kv])/np.maximum(np.linalg.norm(av[:,keep],axis=0)*np.sqrt(energy),1e-12)
            nearest=int(iv[keep][np.argmax(cos)]);maxcos=float(np.max(cos))
        else:
            unique=target_projected;nearest=None;maxcos=0.
        unique_energy=float(unique@unique)
        run=[]
        for j,yj in enumerate(y):
            ff=full.solve(yj);rr=red.solve(yj)
            s2=max(ff['chi2']/max(fov_px-bv.shape[1]-len(iv),1),1)
            gain=(rr['chi2']-ff['chi2'])/s2
            took=(rr['c']-ff['c'][keep])*share
            partner=int(iv[keep][np.argmax(took)]) if len(took) and np.max(took)>0.5*ff['c'][kv] and ff['c'][kv]>0 else None
            row=dict(snapshot=folder.name,variant=name,probe_index=j,probe=frames[j],target_id=target,
                     chi_full=ff['chi2'],chi_red=rr['chi2'],raw_gain=rr['chi2']-ff['chi2'],s2=s2,gain=gain,
                     threshold=threshold,rho=rho,keep_z=keep_z,pass_test=bool(gain>threshold),pass_rho1=bool(gain>threshold/rho),
                     verdict='pass' if gain>threshold else ('redundant' if partner else 'fail'),partner=partner,
                     target_c=float(ff['c'][kv]),target_energy=energy,qii=qii,background_retained_energy_fraction=qii/max(energy,1e-12),
                     all_free_neighbours_unique_energy=unique_energy,all_free_neighbours_unique_fraction=unique_energy/max(energy,1e-12),
                     largest_footprint_cosine=maxcos,largest_cosine_neighbour=nearest,
                     coord_noise=np.sqrt(rho/max(qii,1e-12)),full_kkt=ff['kkt'],red_kkt=rr['kkt'])
            if name=='exact_snapshot':
                nf=nqfull.solve(yj,proj[j],yy[j]);nr=nqred.solve(yj,proj[j],yy[j])
                native_s2=max(native_full[j]/dof,1)
                row.update(native_chi_full=float(native_full[j]),native_chi_red=float(native_red[j]),
                           native_gain=float((native_red[j]-native_full[j])/native_s2),
                           native_full_excess=float(native_full[j]-ff['chi2']),native_red_excess=float(native_red[j]-rr['chi2']),
                           native_full_kkt=full.native_kkt(yj,native_c[j]),native_red_kkt=red.native_kkt(yj,native_rc[j]),
                           reconstructed_native_full_chi=nf['chi'],reconstructed_native_red_chi=nr['chi'],
                           reconstructed_native_full_chi_error=nf['chi']-native_full[j],reconstructed_native_red_chi_error=nr['chi']-native_red[j],
                           rounded_q_exact_full_chi=nf['exact_chi'],rounded_q_exact_red_chi=nr['exact_chi'],
                           rounded_q_exact_gain=(nr['exact_chi']-nf['exact_chi'])/max(nf['exact_chi']/dof,1),
                           reconstructed_full_sweeps=nf['sweeps'],reconstructed_red_sweeps=nr['sweeps'],
                           reconstructed_full_kkt=nf['kkt'],reconstructed_red_kkt=nr['kkt'],
                           rebuilt_full_q_max_error=nqfull.q_rebuild_max_error,rebuilt_red_q_max_error=nqred.q_rebuild_max_error,
                           reconstructed_full_c_max_error=float(np.max(abs(nf['c'].astype(np.float32)-native_c[j]),initial=0.)),
                           reconstructed_red_c_max_error=float(np.max(abs(nr['c'].astype(np.float32)-native_rc[j]),initial=0.)))
            rows.append(row)
            run.append(dict(row=row,full_c=ff['c'],red_c=rr['c'],full_beta=ff['beta'],red_beta=rr['beta'],
                            background_change_norm=float(np.linalg.norm(bv@(rr['beta']-ff['beta'])))))
        detail[name]=dict(ids=iv,rows=run)
    return dict(meta=m,rows=rows,detail=detail)


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('trace_dir',type=Path)
    ap.add_argument('--out',type=Path,required=True)
    ap.add_argument('--target',type=int,default=18)
    ap.add_argument('--oracle-id',type=int,help='original oracle ID (defaults to --target)')
    ap.add_argument('--oracle',type=Path,help='simulation oracle.bin; adds true calcium amplitudes')
    ap.add_argument('--slow-start',type=int,default=50,help='zero-based recording frame slow frame 0 maps to')
    ap.add_argument('--fps',type=float,default=20.)
    ap.add_argument('--replace',action='append',default=[],help='LABEL=/path/to/one-cell-CALAFP01.bin')
    args=ap.parse_args();args.out.mkdir(parents=True,exist_ok=True)
    replacements={s.split('=',1)[0]:Path(s.split('=',1)[1]) for s in args.replace}
    truth=oracle_trace(args.oracle,args.oracle_id if args.oracle_id is not None else args.target) if args.oracle else None
    folders=sorted(p.parent for p in args.trace_dir.rglob('meta.tsv') if p.parent.name.startswith('keep_')
                   and int(meta_load(p)['target_id'])==args.target)
    if not folders:
        ap.error(f'no target {args.target} keep snapshots in {args.trace_dir}')
    results=[]
    for folder in folders:
        result=replay(folder,replacements)
        if truth is not None:
            for row in result['rows']:
                p=row['probe'];fi=int(next(p[k] for k in ['probe_original_frame','frame','slow_frame','slow_frame0','probe_frame'] if k in p))+args.slow_start
                horizon=min(len(truth),fi+int(2*args.fps)+1)
                peak=float(np.max(truth[fi:horizon]))
                baseline=float(np.percentile(truth,5))
                row.update(recording_frame0=fi,recording_consumed_frame=fi+1,recording_seconds=fi/args.fps,oracle_c=float(truth[fi]),
                           oracle_next_2s_peak=peak,oracle_probe_fraction_next_2s_peak=float(truth[fi]/max(peak,1e-12)),
                           oracle_global_5pct_baseline=baseline,
                           oracle_probe_above_baseline_fraction_next_2s_peak=float((truth[fi]-baseline)/max(peak-baseline,1e-12)),
                           oracle_probe_fraction_global_peak=float(truth[fi]/max(np.max(truth),1e-12)))
        results.append(result)
        print(folder.name,[(r['variant'],r['probe_index'],round(r['gain'],5),r['verdict']) for r in result['rows']],flush=True)
    (args.out/'replay.json').write_text(json.dumps(json_safe(results),indent=2,allow_nan=False))
    rows=[r for s in results for r in s['rows']]
    if rows:
        keys=list(dict.fromkeys(k for r in rows for k in r))
        with (args.out/'replay.tsv').open('w') as f:
            w=csv.DictWriter(f,fieldnames=keys,delimiter='\t');w.writeheader()
            for r in rows:
                r=dict(r);r['probe']=json.dumps(r['probe'],sort_keys=True);w.writerow(r)
    print(f'{len(results)} frozen snapshots, {len(rows)} comparisons; output {args.out}')


if __name__=='__main__':main()
