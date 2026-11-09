#!/usr/bin/env python3
"""Oracle-relative publication and edit inspection; does not change detection.

Uses unfiltered oracle spatial cosines, distinct from Rust's filtered Hungarian
evaluation. A last published footprint can precede intervening working edits.
"""
import argparse,csv,json,math,re,struct,collections
from pathlib import Path
import numpy as np
import analyze_evolution as af


def sparse_pearson(a,b):
    p,x=a[0],a[2].astype(float);q,y=b[0],b[2].astype(float)
    _,ia,ib=np.intersect1d(p,q,assume_unique=True,return_indices=True);n=len(p)+len(q)-len(ia)
    if n<2:return 0.
    num=x[ia]@y[ib]-x.sum()*y.sum()/n;den=(x@x-x.sum()**2/n)*(y@y-y.sum()**2/n)
    return float(num/np.sqrt(den)) if den>0 else 0.


def filtered_center(fp,w):
    p,_,v=fp;v=np.maximum(v,0);s=max(v.sum(),1e-12)
    return float(v@(p//w)/s),float(v@(p%w)/s)


def oracle(path):
    refs={};meta={}
    with path.open('rb') as f:
        assert f.read(8)==b'CALAORC1';h,w,n,t=struct.unpack('<IIII',f.read(16))
        for _ in range(n):
            i,detectable,focus,cy,cx=struct.unpack('<IBBxxff',f.read(16));fps=[]
            for k in range(2):
                y,x,ph,pw=struct.unpack('<iiII',f.read(16));a=af.take(f,'<f4',ph*pw).reshape(ph,pw)
                yy,xx=np.indices(a.shape);yy+=y;xx+=x;ok=(yy>=0)&(yy<h)&(xx>=0)&(xx<w)&(a>0)
                p=(yy[ok]*w+xx[ok]).astype(np.uint32);vals=a[ok];fps.append((p,vals,vals))
            refs[i]=fps;meta[i]=dict(cy=cy,cx=cx,detectable=detectable,focus=focus)
    return (h,w),refs,meta


def main():
    ap=argparse.ArgumentParser();ap.add_argument('run',type=Path);ap.add_argument('sim',type=Path);args=ap.parse_args();run=args.run;out=run/'analysis';out.mkdir(exist_ok=True)
    dims,obs,first,last=af.load_history(run);_,refs,meta=oracle(args.sim/'oracle.bin');h,w=dims
    log=run.with_suffix('.log');text=log.read_text() if log.exists() else ''
    match=re.search(r'offset \((-?\d+), (-?\d+)\)',text);dy,dx=map(int,match.groups()) if match else (0,0)
    exact=(run/'gt_footprints.bin').exists();gtmapping=af.tsv(run/'gt_units.tsv');slot_to_oracle={int(r['slot']):int(r['oracle_id']) for r in gtmapping}
    if exact:
        _,gtlib=af.read_fp(run/'gt_footprints.bin');refs={i:[fp,fp] for i,fp in gtlib.items()}
        meta={int(r['oracle_id']):dict(cy=float(r['cy']),cx=float(r['cx']),detectable=r['detectable'].lower() in ('true','1'),focus=r['in_focus'].lower() in ('true','1')) for r in gtmapping}
        offset=af.tsv(run/'gt_offset.tsv')
        if offset:dy,dx=int(offset[0]['dy']),int(offset[0]['dx'])
    labels=af.tsv(run/'labels.tsv');final_matches={slot_to_oracle.get(int(l['gt']),int(l['gt'])):int(l['id']) for l in labels if l['class']=='match'}
    def shifted(fp):
        p,a,b=fp;yy=p.astype(np.int64)//w+dy;xx=p.astype(np.int64)%w+dx;ok=(yy>=0)&(yy<h)&(xx>=0)&(xx<w)
        return (yy[ok]*w+xx[ok]).astype(np.uint32),a[ok],b[ok]
    def score(o):
        fp=af.load_snapshot(o);m=af.metrics(fp,w)
        if exact:
            cy,cx=filtered_center(shifted(fp),w);candidates=[i for i in refs if math.hypot(cy-filtered_center(refs[i][0],w)[0],cx-filtered_center(refs[i][0],w)[1])<=15]
        else:candidates=[i for i,u in meta.items() if math.hypot(m['cy']+dy-u['cy'],m['cx']+dx-u['cx'])<=15]
        scored=sorted([((sparse_pearson(shifted(fp),refs[i][0]) if exact else af.cosine(shifted(fp),refs[i][0])),i) for i in candidates],reverse=True)
        if not scored:return dict(gt=-1,cosine=0.,second_cosine=0.,distance=float('nan'),gt_final_matched=False,gt_final_id=-1,gt_detectable=False)
        r,i=scored[0];second=scored[1][0] if len(scored)>1 else 0.
        return dict(gt=i,cosine=r,second_cosine=second,distance=math.hypot(m['cy']+dy-meta[i]['cy'],m['cx']+dx-meta[i]['cx']),gt_final_matched=i in final_matches,gt_final_id=final_matches.get(i,-1),gt_detectable=bool(meta[i]['detectable']))
    rows=[]
    for i,items in obs.items():
        for o in items:rows.append(dict(id=i,frame=o['frame'],version=o['version'],**score(o)))
    af.write_tsv(out/'gt_shape_observations.tsv',rows)
    scored={(r['id'],r['frame']):r for r in rows};events=[]
    for e in af.tsv(run/'edits.tsv'):
        if e['kind'] not in ('merge','split','delete'):continue
        t=af.edit_frame(e);i=int(e['id']);j=int(e['other']);arms=[]
        for who,ident,direction in [('id_before',i,'before'),('other_before',j,'before'),('id_after',i,'after'),('other_after',j,'after')]:
            if ident==0 or (e['kind']=='delete' and who!='id_before'):continue
            available=[o for o in obs.get(ident,[]) if (o['frame']<t if direction=='before' else o['frame']>=t)]
            if not available:continue
            o=available[-1] if direction=='before' else available[0];r=scored[(ident,o['frame'])]
            events.append(dict(event_frame=t,kind=e['kind'],event_id=i,event_other=j,arm=who,snapshot_frame=o['frame'],snapshot_lag_frames=abs(t-o['frame']),**{k:v for k,v in r.items() if k not in ('frame','version')},margin=e['margin']))
    af.write_tsv(out/'gt_structural_events.tsv',events)
    # A good pre-delete shape and absent final GT match is strong retention evidence,
    # but the old publication can lag the deleted working shape.
    lost=[r for r in events if r['kind']=='delete' and r['arm']=='id_before' and r['cosine']>=.8 and r['cosine']-r['second_cosine']>=.1 and not r['gt_final_matched'] and r['gt_detectable']]
    af.write_tsv(out/'gt_delete_retention_candidates.tsv',lost)
    edge=[]
    final_dims,final=af.read_fp(run/'footprints.bin')
    for l in labels:
        i=int(l['id']);m=af.metrics(final[i],w);distance=min(m['cy'],m['cx'],h-1-m['cy'],w-1-m['cx'])
        edge.append(dict(id=i,classification=l['class'],gt=l['gt'],filtered_r=l['r'],edge_distance=distance,within10px=int(distance<=10)))
    af.write_tsv(out/'gt_final_edge_positions.tsv',edge)
    summary=dict(offset=[dy,dx],metric='exact exported filtered sparse-union Pearson' if exact else 'unfiltered full-oracle cosine',exact_gt_export=exact,delete_retention_candidates=lost,final_edge_by_class={c:dict(total=sum(r['classification']==c for r in edge),within10px=sum(r['classification']==c and r['within10px'] for r in edge)) for c in set(r['classification'] for r in edge)},caveat='Per-shape nearest reference comparison, not Hungarian. Exact public shapes may lag working deletions/merges/splits. Missing final matches establish final absence, not deletion causality; inspect raw/movie and traces for mechanism. Without gt_units.tsv final label GT slot may not equal oracle ID; treat fallback results as provisional.')
    (out/'gt_edit_summary.json').write_text(json.dumps(summary,indent=2));print(run.name,json.dumps(summary,indent=2))


if __name__=='__main__':main()
