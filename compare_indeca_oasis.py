# compare indeca and oasis using calab.simulate. adapts some of the og 
# indeca plotting code as well. Plots the results. need to add comparison
# with cascade!

import json, time, argparse
import numpy as np
import calab
from calab import SimulationConfig, KernelConfig, NoiseConfig, PoissonConfig, RandomWalkDrift, simulate


def match(s1, s2, tol=3):
    t_idx = np.where(s1 > 0)[0]
    i_idx = np.where(s2 > 0)[0]
    used = set()
    pairs = []
    for i in sorted(i_idx):
        bd = tol + 1
        bt = None
        for t in t_idx:
            if t in used: continue
            d = abs(int(i) - int(t))
            if d <= tol and d < bd: bd = d; bt = t
        if bt is not None: pairs.append((int(bt), int(i))); used.add(bt)
    tp = len(pairs)
    fp = len(i_idx) - tp
    fn = len(t_idx) - tp
    nt = len(t_idx)
    p = tp / max(tp+fp, 1)
    sens = tp / max(tp+fn, 1)
    f1 = 2*p*sens / max(p+sens, 1e-10)
    err = (fp+fn) / nt if nt > 0 else np.nan
    bias = (fp-fn) / nt if nt > 0 else np.nan
    return {"tp":tp,"fp":fp,"fn":fn,"n_true":nt,"n_inf":len(i_idx),
            "precision":p,"sensitivity":sens,"f1":f1,"error":err,"bias":bias}


def make_data(nc=10, nt=9000, fs=30.0, tr=0.1, td=0.6, snr=8.0, sr=1.0, seed=42):
    cfg = SimulationConfig(fs_hz=fs, num_timepoints=nt, num_cells=nc,
        kernel=KernelConfig(tau_rise_s=tr, tau_decay_s=td),
        spike_model=PoissonConfig(rate_hz=sr),
        noise=NoiseConfig(snr=snr),
        drift=RandomWalkDrift(step_std_fraction=0.002),
        alpha_mean=1.0, alpha_cv=0.0, seed=seed)
    r = simulate(cfg)
    spk = np.stack([g.spikes for g in r.ground_truth])
    return {"traces":r.traces.astype(np.float64), "spikes":spk.astype(np.float64),
            "n_cells":nc, "n_tp":nt, "fs":fs, "tau_rise":tr, "tau_decay":td}


def do_indeca(gt, lam=0.0):
    from calab._compute import solve_trace
    act = np.zeros_like(gt["traces"])
    t0 = time.perf_counter()
    for i in range(gt["n_cells"]):
        r = solve_trace(gt["traces"][i], tau_rise=gt["tau_rise"], tau_decay=gt["tau_decay"], fs=gt["fs"], lambda_=lam)
        act[i] = r.s_counts
    return act, time.perf_counter()-t0


def get_sn(trace):
    from scipy.signal import welch
    ff, psd = welch(trace, nperseg=min(256, len(trace)))
    return max(np.sqrt(np.median(psd[len(psd)//2:]) * (ff[-1]-ff[0])), 1e-8)


def do_oasis1(gt):
    from oasis.oasis_methods import constrained_oasisAR1
    g = float(np.exp(-1.0/(gt["tau_decay"]*gt["fs"])))
    act = np.zeros_like(gt["traces"])
    t0 = time.perf_counter()
    for i in range(gt["n_cells"]):
        tr = gt["traces"][i].ravel().copy()
        c,s,b,go,l = constrained_oasisAR1(tr, g, get_sn(tr), optimize_b=True, b_nonneg=True, optimize_g=0)
        act[i] = s
    return act, time.perf_counter()-t0


def do_oasis2(gt):
    from oasis.oasis_methods import constrained_oasisAR2
    fs = gt["fs"]
    d = float(np.exp(-1.0/(gt["tau_decay"]*fs)))
    r = float(np.exp(-1.0/(gt["tau_rise"]*fs)))
    act = np.zeros_like(gt["traces"])
    t0 = time.perf_counter()
    for i in range(gt["n_cells"]):
        tr = gt["traces"][i].ravel().copy()
        c,s,b,go,l = constrained_oasisAR2(tr, d+r, -d*r, get_sn(tr), optimize_b=True, b_nonneg=True, optimize_g=0)
        act[i] = s
    return act, time.perf_counter()-t0


def eval_method(gt, act, tol=3):
    keys = ["precision","sensitivity","f1","error","bias"]
    ms = [match(gt["spikes"][i], act[i], tol) for i in range(gt["n_cells"])]
    out = {}
    for k in keys:
        v = [m[k] for m in ms if not np.isnan(m[k])]
        out[k+"_mean"] = float(np.mean(v)) if v else np.nan
        out[k+"_std"] = float(np.std(v)) if v else np.nan
    out["n_true_total"] = sum(m["n_true"] for m in ms)
    out["n_inf_total"] = sum(m["n_inf"] for m in ms)
    return out


def run_sweep(snrs, tr, td, fs, nc, nt, sr, tol, seed, lam, trace_save=None):
    results = []
    for si,snr in enumerate(snrs):
        gt = make_data(nc=nc, nt=nt, fs=fs, tr=tr, td=td, snr=snr, sr=sr, seed=seed)
        i_act,i_t = do_indeca(gt, lam=lam)
        o1_act,o1_t = do_oasis1(gt)
        o2_act,o2_t = do_oasis2(gt)
        meths = [("InDeCa",i_act,i_t),("OASIS AR(1)",o1_act,o1_t),("OASIS AR(2)",o2_act,o2_t)]
        print(f"\nSNR={snr:.1f}")
        for nm,act,el in meths:
            a = eval_method(gt, act, tol)
            a["method"]=nm; a["snr"]=snr; a["time_per_cell_ms"]=el/nc*1000
            results.append(a)
            print(f"  {nm:>12s}: F1={a['f1_mean']:.3f}  P={a['precision_mean']:.3f}  S={a['sensitivity_mean']:.3f}  err={a['error_mean']:.3f}  bias={a['bias_mean']:+.3f}  spks={a['n_inf_total']}  time={a['time_per_cell_ms']:.1f}ms")
        if trace_save and si in (0, len(snrs)//2, len(snrs)-1):
            stem = trace_save.replace(".png","")
            draw_traces(gt, {"InDeCa":i_act,"OASIS AR(1)":o1_act,"OASIS AR(2)":o2_act}, title=f"SNR={snr:.1f}", save=f"{stem}_snr{snr:.1f}.png")
    return results


def draw_metrics(results, title="", save=None):
    import matplotlib.pyplot as plt
    meths = ["InDeCa","OASIS AR(1)","OASIS AR(2)"]
    cols = {"InDeCa":"#E24B4A","OASIS AR(1)":"#378ADD","OASIS AR(2)":"#6BA3D6"}
    mrks = {"InDeCa":"o","OASIS AR(1)":"s","OASIS AR(2)":"D"}
    panels = [("f1","F1 score",(0,0),(0,1.05)),("error","Error (FP+FN)/N",(0,1),None),
              ("bias","Bias (FP-FN)/N",(0,2),None),("precision","Precision",(1,0),(0,1.05)),
              ("sensitivity","Sensitivity",(1,1),(0,1.05)),("time_per_cell","Time per cell (ms)",(1,2),None)]
    fig, ax = plt.subplots(2,3,figsize=(15,9))
    for m in meths:
        d = [r for r in results if r["method"]==m]
        if not d: continue
        snrs = [r["snr"] for r in d]
        for k,lbl,(r,c),yl in panels:
            if k == "time_per_cell":
                ax[r,c].plot(snrs,[r2["time_per_cell_ms"] for r2 in d],f"{mrks[m]}-",color=cols[m],ms=5,label=m)
            else:
                ax[r,c].errorbar(snrs,[r2[k+"_mean"] for r2 in d],yerr=[r2[k+"_std"] for r2 in d],
                                 fmt=f"{mrks[m]}-",color=cols[m],ms=5,capsize=3,label=m)
    for k,lbl,(r,c),yl in panels:
        ax[r,c].set_title(lbl,fontsize=11); ax[r,c].set_xlabel("SNR"); ax[r,c].set_xscale("log"); ax[r,c].legend(fontsize=7)
        if yl: ax[r,c].set_ylim(yl)
        if k=="bias": ax[r,c].axhline(0,color="gray",lw=0.5,ls="--")
        if k in ("f1","precision","sensitivity"): ax[r,c].axhline(1,color="gray",lw=0.5,ls="--")
        if k=="error": ax[r,c].axhline(0,color="gray",lw=0.5)
        if k=="time_per_cell": ax[r,c].set_ylabel("ms")
    fig.suptitle(f"InDeCa vs OASIS — {title}" if title else "InDeCa vs OASIS",fontsize=13,y=1.01)
    plt.tight_layout()
    if save: plt.savefig(save,dpi=150,bbox_inches="tight"); print(f"Saved: {save}")
    else: plt.show()
    plt.close()


def draw_traces(gt, mdict, nc=10, ntp=600, title="", save=None):
    import matplotlib.pyplot as plt
    from matplotlib.lines import Line2D
    nc = min(nc, gt["n_cells"]); ntp = min(ntp, gt["n_tp"])
    t = np.arange(ntp)/gt["fs"]
    mnames = list(mdict.keys())
    cols = {"Ground Truth":"#2ECC71","InDeCa":"#E24B4A","OASIS AR(1)":"#378ADD","OASIS AR(2)":"#6BA3D6"}
    fig,axes = plt.subplots(nc,1,figsize=(18,3.5*nc),sharex=True)
    if nc==1: axes=[axes]
    for ci,ax in enumerate(axes):
        tr = gt["traces"][ci,:ntp]
        ax.plot(t,tr,color="#AAAAAA",lw=0.7,alpha=0.6)
        tmin,tmax = tr.min(),tr.max()
        trng = max(tmax-tmin, 1e-6)
        gi = np.where(gt["spikes"][ci,:ntp]>0)[0]
        yl,yh = tmin-0.18*trng, tmin-0.03*trng
        if len(gi)>0: ax.vlines(gi/gt["fs"],yl,yh,color=cols["Ground Truth"],lw=1.5,alpha=0.9)
        for mi,nm in enumerate(mnames):
            ii = np.where(mdict[nm][ci,:ntp]>0)[0]
            y1 = tmax+(0.05+mi*0.13)*trng; y2 = y1+0.09*trng
            if len(ii)>0: ax.vlines(ii/gt["fs"],y1,y2,color=cols.get(nm,"#999"),lw=1.2,alpha=0.8)
            ax.text(t[-1]*1.01,(y1+y2)/2,nm,color=cols.get(nm,"#999"),fontsize=8,va="center",clip_on=False)
        ax.text(t[-1]*1.01,(yl+yh)/2,"Ground Truth",color=cols["Ground Truth"],fontsize=8,va="center",clip_on=False)
        ax.set_ylabel(f"Cell {ci}",fontsize=10)
        ax.spines["top"].set_visible(False); ax.spines["right"].set_visible(False)
        ax.set_ylim(yl-0.05*trng, tmax+(0.05+len(mnames)*0.13+0.12)*trng)
    axes[-1].set_xlabel("Time (s)",fontsize=11)
    leg = [Line2D([0],[0],color="#AAAAAA",lw=1.5,label="Fluorescence"),
           Line2D([0],[0],color=cols["Ground Truth"],lw=2,label="Ground Truth")]
    for nm in mnames: leg.append(Line2D([0],[0],color=cols.get(nm,"#999"),lw=2,label=nm))
    axes[0].legend(handles=leg,loc="upper left",fontsize=8,ncol=len(leg),framealpha=0.8)
    fig.suptitle(f"Trace + Spike Comparison — {title}" if title else "Trace + Spike Comparison",fontsize=13,y=1.01)
    plt.tight_layout()
    if save: plt.savefig(save,dpi=150,bbox_inches="tight"); print(f"Saved trace plot: {save}")
    else: plt.show()
    plt.close()


PRESETS = {"gcamp6f":{"tau_rise":0.1,"tau_decay":0.6},"gcamp6s":{"tau_rise":0.4,"tau_decay":1.8},
           "gcamp6m":{"tau_rise":0.15,"tau_decay":0.9},"jgcamp8f":{"tau_rise":0.05,"tau_decay":0.3},
           "ogb1":{"tau_rise":0.05,"tau_decay":1.5}}

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--preset",type=str,default=None,choices=list(PRESETS.keys()))
    p.add_argument("--tau_r",type=float,default=0.1)
    p.add_argument("--tau_d",type=float,default=0.6)
    p.add_argument("--fs",type=float,default=30.0)
    p.add_argument("--n_cells",type=int,default=10)
    p.add_argument("--n_tp",type=int,default=9000)
    p.add_argument("--spike_rate",type=float,default=1.0)
    p.add_argument("--lam",type=float,default=0.0)
    p.add_argument("--tolerance",type=int,default=3)
    p.add_argument("--snr_min",type=float,default=2.0)
    p.add_argument("--snr_max",type=float,default=200.0)
    p.add_argument("--snr_steps",type=int,default=8)
    p.add_argument("--seed",type=int,default=42)
    p.add_argument("--save_json",type=str,default=None)
    p.add_argument("--save_plot",type=str,default=None)
    p.add_argument("--all_presets",action="store_true")
    args = p.parse_args()

    if args.all_presets: runs = list(PRESETS.items())
    elif args.preset:
        pr = PRESETS[args.preset]; args.tau_r=pr["tau_rise"]; args.tau_d=pr["tau_decay"]
        runs = [(args.preset,pr)]
    else:
        runs = [(f"tau_r={args.tau_r*1000:.0f}ms_tau_d={args.tau_d*1000:.0f}ms",{"tau_rise":args.tau_r,"tau_decay":args.tau_d})]

    snrs = np.geomspace(args.snr_min, args.snr_max, args.snr_steps).tolist()

    for label,params in runs:
        print(f"\n{'='*80}\n{label} (tau_r={params['tau_rise']*1000:.0f}ms, tau_d={params['tau_decay']*1000:.0f}ms)")
        print(f"SNR: {[f'{s:.1f}' for s in snrs]}\ntolerance={args.tolerance} frames, lam={args.lam}\n{'='*80}")
        tp = None
        if args.save_plot:
            stem = args.save_plot.replace(".png","")
            tp = f"{stem}_{label}_traces.png" if args.all_presets else f"{stem}_traces.png"
        results = run_sweep(snrs, params["tau_rise"], params["tau_decay"], args.fs, args.n_cells, args.n_tp,
                            args.spike_rate, args.tolerance, args.seed, args.lam, trace_save=tp)
        if args.save_json:
            stem = args.save_json.replace(".json","")
            path = f"{stem}_{label}.json" if args.all_presets else args.save_json
            with open(path,"w") as f: json.dump(results,f,indent=2)
            print(f"\nSaved: {path}")
        sp = None
        if args.save_plot:
            stem = args.save_plot.replace(".png","")
            sp = f"{stem}_{label}.png" if args.all_presets else args.save_plot
        draw_metrics(results, title=label, save=sp)