#!/usr/bin/env python3
"""Render one detector-ID/oracle-unit retention case using saved diagnostics."""
import argparse,json,struct
from pathlib import Path
import numpy as np
import analyze_evolution as af
from analyze_gt_edits import sparse_pearson,filtered_center


def load_oracle(path):
    units={}
    with path.open('rb') as f:
        assert f.read(8)==b'CALAORC1';h,w,n,t=struct.unpack('<4I',f.read(16));order=[]
        for _ in range(n):
            ident,d,focus,cy,cx=struct.unpack('<IBBxxff',f.read(16));fps=[]
            for _ in range(2):
                y,x,ph,pw=struct.unpack('<iiII',f.read(16));a=af.take(f,'<f4',ph*pw).reshape(ph,pw);yy,xx=np.indices(a.shape);yy+=y;xx+=x;ok=(yy>=0)&(yy<h)&(xx>=0)&(xx<w)&(a>0);p=(yy[ok]*w+xx[ok]).astype(np.uint32);a=a[ok];fps.append((p,a,a))
            units[ident]=dict(full=fps[0],core=fps[1],center=(cy,cx),detectable=d,focus=focus);order.append(ident)
        c=af.take(f,'<f4',n*t).reshape(n,t)
        for j,i in enumerate(order):units[i]['trace']=c[j]
    return (h,w),units


def main():
    ap=argparse.ArgumentParser();ap.add_argument('run',type=Path);ap.add_argument('sim',type=Path);ap.add_argument('--id',type=int,required=True);ap.add_argument('--gt',type=int,required=True);ap.add_argument('--fps',type=float,default=20.);ap.add_argument('--out',type=Path);ap.add_argument('--comparison',type=Path);args=ap.parse_args();run=args.run;out=args.out or run/'analysis';out.mkdir(exist_ok=True)
    dims,obs,first,last=af.load_history(run);_,units=load_oracle(args.sim/'oracle.bin');unit=units[args.gt];events=[e for e in af.tsv(run/'edits.tsv') if int(e['id'])==args.id];death=next(af.edit_frame(e) for e in events if e['kind']=='delete');end=death/args.fps
    _,gtlib=af.read_fp(run/'gt_footprints.bin');gt=gtlib[args.gt];offset=af.tsv(run/'gt_offset.tsv')[0];dy,dx=int(offset['dy']),int(offset['dx']);h,w=dims
    def shifted(fp):
        p,a,b=fp;yy=p.astype(np.int64)//w+dy;xx=p.astype(np.int64)%w+dx;ok=(yy>=0)&(yy<h)&(xx>=0)&(xx<w);return (yy[ok]*w+xx[ok]).astype(np.uint32),a[ok],b[ok]
    v=obs[args.id];scored=[(o,sparse_pearson(shifted(af.load_snapshot(o)),gt)) for o in v]
    _,final=af.read_fp(run/'footprints.bin');final_scores=[]
    for i,fp in final.items():
        sfp=shifted(fp);cy,cx=filtered_center(sfp,w);gy,gx=filtered_center(gt,w)
        if np.hypot(cy-gy,cx-gx)<=15:final_scores.append((sparse_pearson(sfp,gt),i))
    final_scores.sort(reverse=True);pre=[e for e in events if e['kind']=='refine'];deleted=[r for r in af.tsv(run/'deleted.tsv') if int(r['id'])==args.id][0]
    c=unit['trace'];summary=dict(id=args.id,oracle_id=args.gt,deleted_consumed_recording_frame=death,deleted_seconds=end,deleted_ledger=deleted,last_published_frame=v[-1]['frame'],last_published_filtered_gt_r=scored[-1][1],best_final_filtered_gt_r=final_scores[0][0] if final_scores else None,best_final_id=final_scores[0][1] if final_scores else None,final_best_ge07=bool(final_scores and final_scores[0][0]>=.7),final_best_ge05=bool(final_scores and final_scores[0][0]>=.5),oracle_peak_before_delete=float(c[:death].max()),oracle_peak_after_delete=float(c[death:].max()),oracle_post_peak_fraction=float(c[death:].max()/max(c.max(),1e-12)),last_refine_consumed_frame=af.edit_frame(pre[-1]) if pre else None,publication_note='Last accepted working refine immediately before deletion may not have a published footprint. Plot shows saved publication shapes only.')
    comparison=None
    if args.comparison:
        _,comp=af.read_fp(args.comparison/'footprints.bin');comp_scores=sorted([(sparse_pearson(shifted(fp),gt),i) for i,fp in comp.items()],reverse=True);r,j=comp_scores[0];summary['comparison']=dict(run=str(args.comparison),best_id=j,best_filtered_gt_r=r)
        tp=args.comparison/'traces.f32'
        if tp.exists() and tp.stat().st_size:
            tr=np.fromfile(tp,dtype='<f4').reshape(-1,len(comp))[:,list(comp).index(j)];summary['comparison']['trace_r']=float(np.corrcoef(c[:len(tr)],tr)[0,1])
        comparison=(comp[j],j,r)
    (out/f'case_id{args.id}_gt{args.gt}.json').write_text(json.dumps(summary,indent=2))
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    fig=plt.figure(figsize=(14,9),layout='constrained');gs=fig.add_gridspec(3,7 if comparison else 6,height_ratios=[1.5,1,1.7]);ax=fig.add_subplot(gs[0,:]);tt=np.arange(len(c))/args.fps;ax.plot(tt,c,lw=1,color='#285f9e');ax.axvline(end,color='#c13232',ls='--',label=f'working delete {end:.2f}s')
    for e in events:
        if e['kind']=='refine':ax.axvline(af.edit_frame(e)/args.fps,color='#dc9740',alpha=.25,lw=1)
    ax.set(xlabel='Recording second',ylabel='Oracle calcium amplitude',title=f'Detector ID {args.id}, true oracle unit {args.gt}: activity continues after deletion');ax.legend(loc='upper right')
    ax=fig.add_subplot(gs[1,:]);ax.plot([o['frame']/args.fps for o,r in scored],[r for o,r in scored],marker='o');ax.axhline(.7,color='gray',ls=':',label='Rust match threshold 0.7');ax.axvline(end,color='#c13232',ls='--');ax.set(xlabel='Publication second',ylabel='Filtered GT Pearson r',ylim=(-.05,1.05),title='Saved published shapes only; final working refinement was not published');ax.legend()
    chosen=[v[0],v[len(v)//2],v[-1]];items=[('Oracle full',unit['full']),('Oracle core',unit['core'])]+[(f'ID {args.id}, frame {o["frame"]}',shifted(af.load_snapshot(o))) for o in chosen]
    if final_scores:items.append((f'Best final ID {final_scores[0][1]}\nr={final_scores[0][0]:.3f}',shifted(final[final_scores[0][1]])))
    if comparison:items.append((f'No-prune final ID {comparison[1]}\nr={comparison[2]:.3f}',shifted(comparison[0])))
    cy,cx=unit['center'];pad=24;y0=max(0,int(cy)-pad);y1=min(h,int(cy)+pad+1);x0=max(0,int(cx)-pad);x1=min(w,int(cx)+pad+1)
    for j,(title,fp) in enumerate(items):
        ax=fig.add_subplot(gs[2,j]);p,a,_=fp;im=np.zeros(dims);im.ravel()[p]=np.maximum(a,0);im=im[y0:y1,x0:x1];ax.imshow(im/max(im.max(),1e-12),cmap='magma',vmin=0,vmax=1,origin='upper');ax.set_title(title,fontsize=10);ax.set_xticks([]);ax.set_yticks([])
    fig.suptitle(f'Retention case: {deleted["reason"]}; {deleted["passes"]} passes / {deleted["fails"]} failures; default best final r={summary["best_final_filtered_gt_r"]:.3f}'+(f'; no-prune r={comparison[2]:.3f}' if comparison else ''),fontsize=14)
    fig.savefig(out/f'case_id{args.id}_gt{args.gt}.png',dpi=180);fig.savefig(out/f'case_id{args.id}_gt{args.gt}.pdf');plt.close(fig);print(json.dumps(summary,indent=2))


if __name__=='__main__':main()
