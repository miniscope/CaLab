"""Share of static registration power in the dark vessel lines, real vs simulated.

usage: python vessel_share.py REAL_AVI REAL_SHIFTS.npy [SIM_DIR ...]
  REAL_SHIFTS.npy: registering shifts (frame, 2) of the real recording (first 300 used).
  SIM_DIR: contains movie.npy + shifts.npy (true content motion).
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from calibrate_to_real import read_grey_avi, bandpass
from scipy.ndimage import shift as nds, gaussian_filter as gf, binary_dilation
def reg(m,s): return np.mean([nds(f.astype(np.float32),x,order=1,mode='nearest') for f,x in zip(m,s)],0)
def rep(lab, mm):
    h=mm.shape[0]; c=(h-256)//2; b=bandpass(mm)[c:c+256,c:c+256]; b=b-b.mean()
    s=2.0; yy=gf(b,s,order=(2,0)); xx=gf(b,s,order=(0,2)); xy=gf(b,s,order=(1,1))
    tr=(yy+xx)/2; d=np.sqrt(((yy-xx)/2)**2+xy**2); l1=tr+d; l2=tr-d   # l1>=l2
    line=(l1>0)&(np.abs(l2)<0.25*l1)&(b<0)
    thr=np.percentile(l1[line],50) if line.any() else 0
    m=binary_dilation(line&(l1>thr),iterations=1)
    tot=(b**2).sum()
    print(f"{lab}: line-mask area {m.mean():.3f}  static power in dark-line mask {(b[m]**2).sum()/tot:.3f}  mean DoG on mask {b[m].mean():.2f}")
R, RS = sys.argv[1], sys.argv[2]
rep('real', reg(read_grey_avi(R,300), np.load(RS)[:300]))
for d in sys.argv[3:]: rep(d, reg(np.load(d+'/movie.npy'), -np.load(d+'/shifts.npy')))
