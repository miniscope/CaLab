#!/usr/bin/env python3
"""Read-only diagnostics for discover_eval outputs. Requires only numpy.

CALAFPH1 history stores changed published footprints; library_versions.tsv stores
exact publication membership. Working edit events and published state are reported
separately. Minian is an optional reference, never ground truth.
"""
from __future__ import annotations
import argparse, collections, csv, html, json, math, struct, zlib
from pathlib import Path
import numpy as np


def tsv(path):
    if not path.exists(): return []
    with path.open() as f: return list(csv.DictReader(f, delimiter='\t'))


def write_tsv(path, rows, fields=None):
    rows = list(rows)
    if not fields: fields = list(rows[0]) if rows else []
    with path.open('w') as f:
        w = csv.DictWriter(f, fields, delimiter='\t', extrasaction='ignore')
        w.writeheader(); w.writerows(rows)


def take(f, dtype, n):
    b = f.read(np.dtype(dtype).itemsize*n)
    if len(b) != np.dtype(dtype).itemsize*n: raise ValueError('truncated footprint record')
    return np.frombuffer(b, dtype=dtype).copy()


def read_fp(path):
    with path.open('rb') as f:
        assert f.read(8) == b'CALAFP01'
        h,w,n = struct.unpack('<III',f.read(12)); cells={}
        for _ in range(n):
            i,k=struct.unpack('<II',f.read(8)); cells[i]=(take(f,'<u4',k),take(f,'<f4',k),take(f,'<f4',k))
    return (h,w),cells


def cosine(a,b,which=1):
    p,x=a[0],a[which]; q,y=b[0],b[which]
    _,ia,ib=np.intersect1d(p,q,assume_unique=True,return_indices=True)
    den=np.linalg.norm(x)*np.linalg.norm(y)
    return float(np.dot(x[ia],y[ib])/den) if den else 0.


def metrics(fp,w):
    p,a,_=fp; a=np.maximum(a.astype(float),0); mass=a.sum()
    if mass<=0: return dict(cy=0.,cx=0.,radius=0.,elongation=0.,mass=0.,peak=0.,active_pixels=0)
    yy=p//w; xx=p%w; cy=float(a@yy/mass);cx=float(a@xx/mass)
    dy=yy-cy; dx=xx-cx
    cov=np.array([[a@(dy*dy),a@(dy*dx)],[a@(dy*dx),a@(dx*dx)]])/mass
    eig=np.maximum(np.linalg.eigvalsh(cov),1e-12)
    return dict(cy=cy,cx=cx,radius=float(np.sqrt(eig.sum())),elongation=float(np.sqrt(eig[1]/eig[0])),
                mass=float(mass),peak=float(a.max()),active_pixels=int((a>a.max()*.1).sum()))


def load_history(run):
    path=run/'footprint_history.bin'; obs=collections.defaultdict(list); prev={};first={}; dims=None
    if path.exists():
        with path.open('rb') as f:
            assert f.read(8)==b'CALAFPH1';dims=struct.unpack('<II',f.read(8))
            while True:
                off=f.tell();hdr=f.read(28)
                if not hdr:break
                if len(hdr)!=28: raise ValueError('truncated history header; run may still be writing')
                frame,ver,i,k=struct.unpack('<QQQI',hdr)
                fp=(take(f,'<u4',k),take(f,'<f4',k),take(f,'<f4',k))
                m=metrics(fp,dims[1]); m.update(frame=frame,version=ver,id=i,offset=off,path=str(path),record='history')
                m['cosine_previous']=cosine(fp,prev[i]) if i in prev else 1.
                m['cosine_first']=cosine(fp,first[i]) if i in first else 1.
                m['filtered_cosine_previous']=cosine(fp,prev[i],2) if i in prev else 1.
                m['center_step']=math.hypot(m['cy']-obs[i][-1]['cy'],m['cx']-obs[i][-1]['cx']) if obs[i] else 0.
                obs[i].append(m);prev[i]=fp;first.setdefault(i,fp)
    else:
        for path in sorted(run.glob('fp_*.bin')):
            dims,cells=read_fp(path); frame=int(path.stem.split('_')[-1])
            for i,fp in cells.items():
                if i in prev and np.array_equal(fp[0],prev[i][0]) and np.array_equal(fp[1],prev[i][1]): continue
                m=metrics(fp,dims[1]);m.update(frame=frame,version=0,id=i,offset=0,path=str(path),record='checkpoint')
                m.update(cosine_previous=cosine(fp,prev[i]) if i in prev else 1.,cosine_first=cosine(fp,first[i]) if i in first else 1.,filtered_cosine_previous=cosine(fp,prev[i],2) if i in prev else 1.)
                m['center_step']=math.hypot(m['cy']-obs[i][-1]['cy'],m['cx']-obs[i][-1]['cx']) if obs[i] else 0.
                obs[i].append(m);prev[i]=fp;first.setdefault(i,fp)
    return dims,obs,first,prev


def load_snapshot(o):
    if o['record']=='checkpoint':return read_fp(Path(o['path']))[1][o['id']]
    with open(o['path'],'rb') as f:
        f.seek(o['offset']);_,_,_,k=struct.unpack('<QQQI',f.read(28))
        return take(f,'<u4',k),take(f,'<f4',k),take(f,'<f4',k)


def png(path,array):
    a=np.asarray(array,dtype=np.uint8); h,w=a.shape[:2]; color=2 if a.ndim==3 else 0
    def chunk(k,b):return struct.pack('>I',len(b))+k+b+struct.pack('>I',zlib.crc32(k+b)&0xffffffff)
    raw=b''.join(b'\0'+row.tobytes() for row in a)
    path.write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,color,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b''))


def svg_plot(path,series,title,xlabel='recording minute',ylabel='count',width=1200,height=400):
    colors=['#1166a0','#dc5426','#2f8a4a','#9467bd','#a67a18','#d14888'];left,top,right,bottom=75,55,30,55
    xs=[x for _,v in series for x,y in v];ys=[y for _,v in series for x,y in v]
    xmin,xmax=(min(xs),max(xs)) if xs else (0,1);ymin,ymax=(min(0,min(ys)),max(ys)) if ys else (0,1)
    if xmax==xmin:xmax+=1
    if ymax==ymin:ymax+=1
    def pos(x,y):return left+(x-xmin)/(xmax-xmin)*(width-left-right),height-bottom-(y-ymin)/(ymax-ymin)*(height-top-bottom)
    parts=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}"><rect width="100%" height="100%" fill="white"/><style>text{{font-family:Arial;font-size:13px}}</style>',f'<text x="{left}" y="26" font-size="20">{html.escape(title)}</text>']
    for j in range(6):
        y=ymin+(ymax-ymin)*j/5;x1,y1=pos(xmin,y);x2,_=pos(xmax,y)
        parts.append(f'<path d="M{x1} {y1}H{x2}" stroke="#ddd"/><text x="{left-10}" y="{y1+4}" text-anchor="end">{y:.1f}</text>')
        x=xmin+(xmax-xmin)*j/5;xx,yy=pos(x,ymin)
        parts.append(f'<text x="{xx}" y="{yy+22}" text-anchor="middle">{x:.1f}</text>')
    for j,(name,v) in enumerate(series):
        coords=' '.join(f'{x:.2f},{y:.2f}' for x,y in [pos(x,y) for x,y in v]);c=colors[j%len(colors)]
        parts.append(f'<polyline points="{coords}" fill="none" stroke="{c}" stroke-width="2"/><text x="{left+j*170}" y="43" fill="{c}">{html.escape(name)}</text>')
    parts += [f'<text x="{width/2}" y="{height-8}" text-anchor="middle">{html.escape(xlabel)}</text>',f'<text x="8" y="48">{html.escape(ylabel)}</text>','</svg>']
    path.write_text(''.join(parts))


def png_plots(out, rows, rates, versions, fps):
    """Optional standard publication/export plots when matplotlib is available."""
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    fig,ax=plt.subplots(2,2,figsize=(12,8),constrained_layout=True)
    for k in ['add','merge','delete','split']:
        ax[0,0].plot([r['minute']+.5 for r in rates],[r[k+'_per_min'] for r in rates],label=k)
    ax[0,0].set(xlabel='Recording minute',ylabel='Working events / minute',title='Structural edit rates');ax[0,0].legend()
    ax[0,1].plot([int(v.get('observed_frames',v.get('frame',0)))/fps/60 for v in versions],[int(v['cells']) for v in versions]);ax[0,1].set(xlabel='Recording minute',ylabel='Published cells',title='Published library size')
    valid=[r for r in rows if r['shape_snapshots']>=2]
    ax[1,0].scatter([r['lifetime_s']/60 for r in valid],[r['center_displacement'] for r in valid],s=12,alpha=.6);ax[1,0].set(xlabel='Working lifetime (min)',ylabel='First-to-last center displacement (px)',title='Published footprint motion')
    ax[1,1].hist([r['min_cosine_previous'] for r in valid],bins=np.linspace(-.05,1.01,35));ax[1,1].set(xlabel='Minimum adjacent unfiltered shape cosine',ylabel='IDs with at least 2 changed shapes',title='Published shape stability')
    fig.suptitle('Descriptive footprint diagnostics; screening values do not establish errors',fontsize=13)
    fig.savefig(out/'overview.png',dpi=180);fig.savefig(out/'overview.pdf');plt.close(fig)


def edit_frame(e,start=50):
    # New exporter logs exact consumed recording frames. Legacy edit.frame is slow-loop time.
    if 'recording_frame' in e:return int(e['recording_frame'])+1
    return int(e['frame'])+start


def reference_comparison(minian,dims,first,last,out,maxshift):
    import zarr
    arr=zarr.open(str(minian/'A.zarr'),mode='r')['A']; h,w=dims
    if tuple(arr.shape[1:])!=dims: raise ValueError(f'Minian dims {arr.shape[1:]} differ from {dims}')
    refs={};rm={};summed=np.zeros(dims,dtype=np.float32)
    uidarr=zarr.open(str(minian/'A.zarr'),mode='r')['unit_id'];uids=np.asarray(uidarr)
    for j in range(arr.shape[0]):
        im=np.maximum(np.nan_to_num(np.asarray(arr[j]),nan=0),0).astype(np.float32);peak=im.max()
        if peak<=0:continue
        p=np.flatnonzero(im.ravel()>peak*.01).astype(np.uint32);a=im.ravel()[p];i=int(uids[j]);refs[i]=(p,a,a);rm[i]=metrics(refs[i],w)
        summed.ravel()[p]+=a/peak
    det=np.zeros(dims,dtype=np.float32)
    for p,a,_ in last.values():
        if a.max()>0:det.ravel()[p]+=np.maximum(a,0)/a.max()
    # Linear FFT correlation; no wrapped borders contribute in the searched offsets.
    shape=(2*h,2*w);corr=np.fft.irfftn(np.conj(np.fft.rfftn(det,s=shape,axes=(0,1)))*np.fft.rfftn(summed,s=shape,axes=(0,1)),s=shape,axes=(0,1)).real
    scored=[(float(corr[dy%(2*h),dx%(2*w)]),dy,dx) for dy in range(-maxshift,maxshift+1) for dx in range(-maxshift,maxshift+1)]
    score,dy,dx=max(scored); scores=sorted([s for s,y,x in scored],reverse=True)
    def shifted(fp):
        p,a,b=fp;yy=p.astype(np.int64)//w+dy;xx=p.astype(np.int64)%w+dx;ok=(yy>=0)&(yy<h)&(xx>=0)&(xx<w)
        return ((yy[ok]*w+xx[ok]).astype(np.uint32),a[ok],b[ok])
    def match(fp):
        m=metrics(fp,w);candidates=[j for j in refs if math.hypot(m['cy']+dy-rm[j]['cy'],m['cx']+dx-rm[j]['cx'])<=15]
        ranked=sorted([(cosine(shifted(fp),refs[j]),j) for j in candidates],reverse=True)
        if not ranked:return dict(reference_id=-1,reference_cosine=0.,reference_distance=float('nan'),reference_second_cosine=0.)
        r,j=ranked[0];return dict(reference_id=j,reference_cosine=r,reference_distance=math.hypot(m['cy']+dy-rm[j]['cy'],m['cx']+dx-rm[j]['cx']),reference_second_cosine=ranked[1][0] if len(ranked)>1 else 0.)
    rows=[];matches={}
    for state,items in [('first',first),('last',last)]:
        for i,fp in items.items():
            m=match(fp);matches[(state,i)]=m;rows.append(dict(id=i,state=state,**m))
    write_tsv(out/'minian_reference.tsv',rows)
    detail=dict(components=len(refs),shift_dy=dy,shift_dx=dx,maxshift=maxshift,registration_score=score,
                registration_second_ratio=scores[1]/score if score else 0.,registration_at_search_edge=abs(dy)==maxshift or abs(dx)==maxshift,
                note='Unfiltered nonnegative spatial cosine, Minian values below 1% peak omitted; global shift from summed peak-normalized footprints. Reference agreement is not accuracy or ground truth. Near-identical top shifts are expected for smooth images.')
    (out/'minian_registration.json').write_text(json.dumps(detail,indent=2))
    return matches,detail,match


def main():
    ap=argparse.ArgumentParser();ap.add_argument('run',type=Path);ap.add_argument('--out',type=Path);ap.add_argument('--fps',type=float,default=20.);ap.add_argument('--minian',type=Path);ap.add_argument('--maxshift',type=int,default=16);ap.add_argument('--cases',type=int,default=24);ap.add_argument('--start',type=int,default=50);ap.add_argument('--png-plots',action='store_true');ap.add_argument('--all-cases',action='store_true',help='Render a searchable gallery for every ID with published shapes')
    args=ap.parse_args();run=args.run;out=args.out or run/'analysis';out.mkdir(parents=True,exist_ok=True);(out/'assets').mkdir(exist_ok=True)
    dims,obs,first,last=load_history(run)
    if dims is None:raise ValueError('No footprint history/checkpoints found')
    edits=tsv(run/'edits.tsv');versions=tsv(run/'library_versions.tsv');deleted={int(r['id']):r for r in tsv(run/'deleted.tsv')};ledger={int(r['id']):r for r in tsv(run/'ledger.tsv')}
    final_dims,final=read_fp(run/'footprints.bin')
    validation=dict(final_dimensions_match=tuple(final_dims)==tuple(dims),final_membership_match=True,final_shape_reconstruction_match=True)
    if versions:
        final_ids=set(map(int,filter(None,versions[-1]['ids'].split(','))))
        validation['final_membership_match']=final_ids==set(final)
    for i,fp in final.items():
        if i not in last or any(not np.array_equal(x,y) for x,y in zip(fp,last[i])):validation['final_shape_reconstruction_match']=False
    if not all(validation.values()):raise ValueError(f'Final reconstruction validation failed: {validation}')
    frames=max([int(r.get('observed_frames',r.get('frame',0))) for r in versions]+[o['frame'] for v in obs.values() for o in v]+[0])
    end_events=collections.defaultdict(list);begins=collections.defaultdict(list);lineage=[];event_counts=collections.Counter()
    for e in edits:
        kind=e['kind'];i=int(e['id']);other=int(e.get('other',0));t=edit_frame(e,args.start);e['recording_observed_frames']=t;event_counts[(i,kind)]+=1
        if kind in ('add','split'):
            new=i if kind=='add' else other
            begins[new].append(t)
        if kind=='delete':end_events[i].append((t,kind))
        if kind=='merge':end_events[other].append((t,kind))
        if kind in ('merge','split'):lineage.append(dict(frame=t,kind=kind,parent=other if kind=='merge' else i,child=i if kind=='merge' else other,kept_id=i,other=other,margin=e.get('margin','')))
    intervals=collections.defaultdict(list);live={}
    for v in versions:
        frame=int(v.get('observed_frames',v.get('frame',0)));ids=set(map(int,filter(None,v.get('ids','').split(','))))
        for i in live.keys()-ids:intervals[i].append((live[i],frame));
        live={i:live.get(i,frame) for i in ids}
    for i,t in live.items():intervals[i].append((t,frames))
    all_ids=sorted(set(obs)|set(begins)|set(end_events)|set(ledger)|set(deleted))
    rows=[]
    for i in all_ids:
        v=obs.get(i,[]);a=v[0] if v else {};b=v[-1] if v else {};birth=min(begins[i]) if begins[i] else int(ledger.get(i,deleted.get(i,{})).get('born',0))+args.start
        end=min([t for t,_ in end_events[i]],default=frames);death=end_events[i][0][1] if end_events[i] else ('retained' if i in final else 'unpublished_or_unknown')
        row=dict(id=i,birth_frame=birth,end_frame=end,lifetime_frames=max(0,end-birth),lifetime_s=max(0,end-birth)/args.fps,end_reason=death,delete_reason=deleted.get(i,{}).get('reason',''),final_present=int(i in final),published_intervals=len(intervals[i]),published_frames=sum(b-a for a,b in intervals[i]),shape_snapshots=len(v),first_shape_frame=a.get('frame',''),last_shape_frame=b.get('frame',''),center_displacement=math.hypot(b.get('cy',0)-a.get('cy',0),b.get('cx',0)-a.get('cx',0)) if v else '',center_path=sum(o['center_step'] for o in v),max_center_step=max((o['center_step'] for o in v),default=0),min_cosine_previous=min((o['cosine_previous'] for o in v),default=1),last_cosine_first=b.get('cosine_first',''),first_radius=a.get('radius',''),last_radius=b.get('radius',''),max_elongation=max((o['elongation'] for o in v),default=0),cy=b.get('cy',''),cx=b.get('cx',''),**{k+'_events':event_counts[(i,k)] for k in ['add','refine','absorb','merge','split','delete']})
        rows.append(row)
    write_tsv(out/'all_ids.tsv',rows);write_tsv(out/'shape_observations.tsv',(o for i in sorted(obs) for o in obs[i]));write_tsv(out/'publication_intervals.tsv',(dict(id=i,start_frame=a,end_frame=b,duration_frames=b-a) for i in sorted(intervals) for a,b in intervals[i]),['id','start_frame','end_frame','duration_frames'])
    # Spatial recurrence is deliberately a candidate relation, separate from logged lineage.
    recurrence=[];related={(l['parent'],l['child']) for l in lineage}
    for i in all_ids:
        if not end_events[i] or i not in last:continue
        death=end_events[i][0][0];m=metrics(last[i],dims[1]);candidates=[]
        for j in all_ids:
            if j==i or j not in first or not begins[j] or min(begins[j])<death or (i,j) in related:continue
            fm=metrics(first[j],dims[1]);distance=math.hypot(m['cy']-fm['cy'],m['cx']-fm['cx'])
            if distance<=8:
                r=cosine(last[i],first[j]);gap=min(begins[j])-death
                if r>=.6:candidates.append(dict(old_id=i,new_id=j,removed_frame=death,reborn_frame=min(begins[j]),gap_frames=gap,gap_s=gap/args.fps,distance=distance,cosine=r))
        if candidates:recurrence.append(max(candidates,key=lambda r:r['cosine']))
    write_tsv(out/'recurrence_candidates.tsv',recurrence,['old_id','new_id','removed_frame','reborn_frame','gap_frames','gap_s','distance','cosine'])
    matches={};registration=None;matcher=None
    if args.minian:matches,registration,matcher=reference_comparison(args.minian,dims,first,last,out,args.maxshift)
    for l in lineage:
        if l['kind']=='merge' and matches:
            p=matches.get(('last',l['parent']),{})
            # Both arms are measured at the most recent publication BEFORE the working merge.
            before=[o for o in obs.get(l['child'],[]) if o['frame']<l['frame']]
            c=matcher(load_snapshot(before[-1])) if before else {}
            parent_frame=obs.get(l['parent'],[])[-1]['frame'] if obs.get(l['parent'],[]) else ''
            l.update(parent_reference=p.get('reference_id',''),parent_reference_cosine=p.get('reference_cosine',''),parent_second_cosine=p.get('reference_second_cosine',''),parent_last_snapshot_frame=parent_frame,parent_snapshot_lag_frames=l['frame']-parent_frame if parent_frame!='' else '',kept_before_reference=c.get('reference_id',''),kept_before_reference_cosine=c.get('reference_cosine',''),kept_second_cosine=c.get('reference_second_cosine',''),kept_before_snapshot_frame=before[-1]['frame'] if before else '',kept_snapshot_lag_frames=l['frame']-before[-1]['frame'] if before else '',reference_note='Pre-merge published shapes can lag working edits. Distinct reference matches indicate disagreement to inspect, not a false merge.')
    write_tsv(out/'lineage.tsv',lineage,['frame','kind','parent','child','kept_id','other','margin','parent_reference','parent_reference_cosine','parent_second_cosine','parent_last_snapshot_frame','parent_snapshot_lag_frames','kept_before_reference','kept_before_reference_cosine','kept_second_cosine','kept_before_snapshot_frame','kept_snapshot_lag_frames','reference_note'])
    distinct_reference_merges=[l for l in lineage if l['kind']=='merge' and l.get('parent_reference') not in ('',None,-1) and l.get('kept_before_reference') not in ('',None,-1) and l['parent_reference']!=l['kept_before_reference'] and min(l['parent_reference_cosine'],l['kept_before_reference_cosine'])>=.9 and l['parent_reference_cosine']-l['parent_second_cosine']>=.1 and l['kept_before_reference_cosine']-l['kept_second_cosine']>=.1]
    write_tsv(out/'minian_merge_candidates.tsv',distinct_reference_merges,['frame','parent','child','parent_reference','parent_reference_cosine','kept_before_reference','kept_before_reference_cosine','parent_snapshot_lag_frames','kept_snapshot_lag_frames','reference_note'])
    per_min=[]
    for minute in range(math.ceil(frames/args.fps/60)):
        lo=minute*60*args.fps;hi=min(frames,(minute+1)*60*args.fps);duration=(hi-lo)/args.fps;cnt=collections.Counter(e['kind'] for e in edits if lo<=e['recording_observed_frames']<hi)
        per_min.append(dict(minute=minute,start_frame=int(lo),end_frame=int(hi),duration_s=duration,**{k:cnt[k] for k in ['add','merge','split','delete','refine','absorb']},**{k+'_per_min':cnt[k]*60/max(duration,1e-9) for k in ['add','merge','split','delete','refine','absorb']}))
    write_tsv(out/'rates_per_minute.tsv',per_min)
    if args.png_plots:png_plots(out,rows,per_min,versions,args.fps)
    svg_plot(out/'edit_rates.svg',[(k,[(r['minute']+.5,r[k+'_per_min']) for r in per_min]) for k in ['add','merge','delete','split']], 'Working structural edit rates',ylabel='events / minute')
    svg_plot(out/'refinement_rates.svg',[(k,[(r['minute']+.5,r[k+'_per_min']) for r in per_min]) for k in ['refine','absorb']], 'Working footprint changes',ylabel='events / minute')
    svg_plot(out/'published_cells.svg',[('published cells',[(int(v.get('observed_frames',v.get('frame',0)))/args.fps/60,int(v['cells'])) for v in versions])], 'Published library size')
    bg=np.zeros(dims,dtype=np.float32);bp=run/'maxproj.f32'
    if bp.exists():bg=np.fromfile(bp,dtype='<f4').reshape(dims)
    lo,hi=np.nanpercentile(bg,[5,99.5]);gray=(255*np.clip((bg-lo)/max(hi-lo,1e-9),0,1)).astype(np.uint8);png(out/'assets'/'max_projection.png',gray)
    ranked=[]
    for key,reverse in [('center_displacement',True),('min_cosine_previous',False),('max_elongation',True),('lifetime_frames',False)]:
        ranked += [r['id'] for r in sorted((r for r in rows if r['shape_snapshots']>=2),key=lambda r:float(r[key]),reverse=reverse)[:max(3,args.cases//4)]]
    ranked += [int(r['old_id']) for r in recurrence[:8]]
    chosen=sorted(i for i in obs if obs[i]) if args.all_cases else list(dict.fromkeys(ranked))[:args.cases];byid={r['id']:r for r in rows};caseparts=[]
    for i in chosen:
        v=obs[i];r=byid[i];ix=sorted(set([0,len(v)-1,int(np.argmin([o['cosine_previous'] for o in v]))]+[round(j*(len(v)-1)/4) for j in range(1,4)]))
        picked=[v[j] for j in ix];cy=[o['cy'] for o in picked];cx=[o['cx'] for o in picked];pad=18;y0=max(0,int(min(cy))-pad);y1=min(dims[0],int(max(cy))+pad+1);x0=max(0,int(min(cx))-pad);x1=min(dims[1],int(max(cx))+pad+1)
        ims=[]
        for j,o in enumerate(picked):
            p,a,_=load_snapshot(o);rgb=np.repeat(gray[y0:y1,x0:x1,None],3,axis=2).astype(float);yy=p//dims[1]-y0;xx=p%dims[1]-x0;ok=(yy>=0)&(yy<y1-y0)&(xx>=0)&(xx<x1-x0)
            alpha=.85*np.sqrt(np.maximum(a[ok],0)/max(float(a.max()),1e-12));rgb[yy[ok],xx[ok]]=rgb[yy[ok],xx[ok]]*(1-alpha[:,None])+np.array([255,60,35])*alpha[:,None]
            name=f'case_{i}_{j}.png';png(out/'assets'/name,rgb);ims.append(f'<figure><img loading="lazy" src="assets/{name}"/><figcaption>frame {o["frame"]}, v{o["version"]}<br>r(prev) {o["cosine_previous"]:.3f}; r(first) {o["cosine_first"]:.3f}<br>center {o["cy"]:.1f}, {o["cx"]:.1f}; radius {o["radius"]:.1f}</figcaption></figure>')
        ev='; '.join(f'{e["kind"]}@{e["recording_observed_frames"]}' for e in edits if int(e['id'])==i or (int(e.get('other',0))==i and e['kind'] in ('merge','split')))
        ref=matches.get(('last',i));reftext=f' Last-shape Minian reference agreement: component {ref["reference_id"]}, cosine {ref["reference_cosine"]:.3f}; reference is imperfect, not ground truth.' if ref else ''
        caseparts.append(f'<section data-id="{i}"><h2>ID {i}: {r["end_reason"]}; {r["lifetime_s"]:.1f}s; {len(v)} changed published shapes</h2><p>Center displacement {r["center_displacement"]:.2f}px; path {r["center_path"]:.2f}px; min adjacent cosine {r["min_cosine_previous"]:.3f}. Crop y={y0}:{y1}, x={x0}:{x1}; gray is whole-recording max projection.{reftext}</p><div class="strip">'+''.join(ims)+f'</div><details><summary>Working events</summary><p>{html.escape(ev)}</p></details></section>')
    counts=collections.Counter(e['kind'] for e in edits);tail=[e for e in edits if e['recording_observed_frames']>=frames*.75];tailcount=collections.Counter(e['kind'] for e in tail);taildur=frames*.25/args.fps/60
    summary=dict(frames=frames,fps=args.fps,duration_min=frames/args.fps/60,unique_ids=len(all_ids),published_unique_ids=sum(bool(v) for v in obs.values()),unpublished_ids=len(set(all_ids)-{i for i,v in obs.items() if v}),final_cells=len(final),changed_published_shapes=sum(map(len,obs.values())),publication_count=len(versions),working_edit_counts=dict(counts),tail_quarter_edit_counts=dict(tailcount),tail_quarter_events_per_min={k:n/taildur for k,n in tailcount.items()},recurrence_candidates=len(recurrence),ids_with_displacement_gt4=sum(float(r['center_displacement'] or 0)>4 for r in rows),ids_with_adjacent_cosine_lt_half=sum(r['min_cosine_previous']<.5 for r in rows),same_id_multiple_published_intervals=sum(r['published_intervals']>1 for r in rows),minian_registration=registration,validation=validation)
    summary['minian_distinct_merge_candidates_cos09_margin01']=len(distinct_reference_merges)
    summary['minian_merge_candidate_caveat']='Most recent published shapes before the working merge can be stale by the lags in minian_merge_candidates.tsv. Distinct matches to imperfect Minian components do not establish false merges.'
    (out/'analysis_summary.json').write_text(json.dumps(summary,indent=2))
    report=f'''# Footprint trajectory diagnostics\n\nRun: `{run}`\n\nAnalyzed {frames:,} consumed recording frames ({summary['duration_min']:.2f} min at {args.fps:.8g} fps), {len(all_ids):,} working IDs, {summary['published_unique_ids']:,} IDs with published shape history, {len(final):,} final cells, and {summary['changed_published_shapes']:,} changed published shapes.\n\nContinued new-cell discovery over hours is expected; no count plateau is assumed. Late additions and growth are descriptive, not failure criteria. Retention, footprint quality and identity consistency require separate evidence.\n\nWorking edit counts: {dict(counts)}. Last-quarter rates per minute: {summary['tail_quarter_events_per_min']}.\n\n{summary['ids_with_displacement_gt4']} IDs move more than 4 px first-to-last; {summary['ids_with_adjacent_cosine_lt_half']} have an adjacent published shape cosine below 0.5. These are descriptive screening thresholds, not confirmed errors. {len(recurrence)} removed-to-new-ID spatial recurrence candidates meet distance <=8 px and cosine >=0.6, excluding direct logged lineage. No identity claim follows from spatial agreement alone.\n\nPublication membership and working edits are separate: an edit may change the working set without ever becoming a published footprint. Shape history is available only at publications, so intermediate merge/split shapes can be absent. Exact membership intervals are in publication_intervals.tsv; all_ids.tsv includes even IDs with no published snapshot. Zero publication duration can reflect edits between publications.\n\nMinian comparison: {json.dumps(registration) if registration else 'not requested'}. Reference matches are many-to-one nearest local shape comparisons. Different preprocessing, scatter, motion templates and source extraction can produce disagreement. No precision, recall, or real-data ground-truth claim is made.\n\nArtifacts: all_ids.tsv, shape_observations.tsv, publication_intervals.tsv, lineage.tsv, recurrence_candidates.tsv, rates_per_minute.tsv, analysis_summary.json and case_sheets.html.\n'''
    (out/'report.md').write_text(report)
    selection=f'Every ID with published shapes is shown ({len(chosen)} IDs).' if args.all_cases else 'Cases are selected by large displacement, low adjacent shape cosine, high elongation, short lifetime, then recurrence.'
    header=f'<h1>Footprint trajectory cases</h1><p>{len(all_ids)} IDs, {len(final)} final cells, {frames} frames. {selection} These are inspection candidates, not confirmed failures.</p><p>Shape cosine compares unfiltered sparse columns at their recorded image coordinates. A shift changes cosine even if shape is conserved. Frame labels are consumed recording frames; working events use exporter recording_frame + 1. IDs without published shapes are present in all_ids.tsv.</p><label>Find cell ID: <input id="find" type="search" placeholder="all IDs" /></label>'
    script='<script>document.getElementById("find").addEventListener("input",e=>{document.querySelectorAll("section[data-id]").forEach(s=>s.hidden=e.target.value.trim()!==""&&s.dataset.id!==e.target.value.trim())})</script>'
    (out/'case_sheets.html').write_text('<!doctype html><meta charset="utf-8"><title>Footprint diagnostics</title><style>body{font:15px system-ui;margin:28px;background:#f5f7f9;color:#18222e}section{background:white;padding:16px;margin:20px 0;break-inside:avoid}h2{font-size:19px}.strip{display:flex;gap:12px;flex-wrap:wrap}figure{margin:0}figure img{width:180px;height:180px;object-fit:contain;image-rendering:pixelated;background:#111}figcaption{font:12px monospace;line-height:1.5}details p{overflow-wrap:anywhere}</style>'+header+'<img width="100%" src="published_cells.svg"><img width="100%" src="edit_rates.svg"><img width="100%" src="refinement_rates.svg">'+''.join(caseparts)+script)
    print(json.dumps(summary,indent=2));print(f'Wrote {out}')


if __name__=='__main__':main()
