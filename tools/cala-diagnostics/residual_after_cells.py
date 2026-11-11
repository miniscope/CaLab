"""Residual after cells, measured the same way on real and simulated data.

  residual_after_cells.py real  AVI_DIR MINIAN_OUT [--lib RUN_DIR]  --start S --frames N   (Minian A; or a cala library)
  residual_after_cells.py sim   SIM_DIR [--lib RUN_DIR]  --start S --frames N   (GT units; or a cala library)

Frames -> rigid motion correction (phase correlation, sub-px, real/motion only)
-> high-pass (normalised-convolution Gaussian, sigma 20, FOV mask) -> per frame
least squares on the high-passed footprints (with their moats) -> residual.
Residual and data are averaged to 0.5 s bins (10 frames). Reports:
 * noise sigma per pixel (MAD of frame differences / sqrt 2)
 * residual fluctuation power by spatial band (Gaussian DoG bands), in noise units
 * radial autocorrelation of the residual fluctuation after the global mode: 1/e, half
 * population coupling: corr of the residual blurred at cell scale (sigma 4 px) and at a
   diffuse scale (sigma 10 px) with the population drive P(t) (mean z-scored trace),
   per 32 px block, after removing the global mode
 * the share of pixel-bins where the sigma-8 blurred residual exceeds 5 noise units
 * the share of 1.5-20 px residual power a per-pixel loading on P(t) explains
Results and context: LEFTOVER_LIGHT.md. RAM: frames streamed, residual bins kept;
about 3-5 GB peak for 1800 frames at 600 x 600 (use fewer frames to stay lower).
"""
import os, re, sys, struct
import numpy as np
from scipy.ndimage import gaussian_filter
import cv2


def read_fp(path):
    b = open(path, "rb").read()
    assert b[:8] == b"CALAFP01"
    H, W, n = struct.unpack_from("<3I", b, 8)
    o = 20
    out = {}
    for _ in range(n):
        cid, m = struct.unpack_from("<2I", b, o); o += 8
        p = np.frombuffer(b, "<u4", m, o); o += 4 * m
        a = np.frombuffer(b, "<f4", m, o); o += 4 * m
        h = np.frombuffer(b, "<f4", m, o); o += 4 * m
        out[cid] = (p.copy(), a.copy(), h.copy())
    return H, W, out


def read_oracle(path):
    b = open(path, "rb").read()
    assert b[:8] == b"CALAORC1"
    H, W, n, T = struct.unpack_from("<4I", b, 8)
    o = 24
    units = []
    for _ in range(n):
        i, det, inf, cy, cx = struct.unpack_from("<IBBxxff", b, o); o += 16
        fp = []
        for _k in range(2):
            y0, x0, ph, pw = struct.unpack_from("<iiII", b, o); o += 16
            v = np.frombuffer(b, "<f4", ph * pw, o).reshape(ph, pw); o += 4 * ph * pw
            fp.append((y0, x0, v))
        units.append(dict(det=det, inf=inf, cy=cy, cx=cx, full=fp[0], core=fp[1]))
    C = np.frombuffer(b, "<f4", n * T, o).reshape(n, T)
    return units, C


args = sys.argv[1:]
def opt(name, default):
    if name in args:
        i = args.index(name); v = args[i + 1]; del args[i:i + 2]; return v
    return default
start = int(opt("--start", 0)); nfr = int(opt("--frames", 2400)); libdir = opt("--lib", None)
BIN = 10
mode = args[0]
if mode == "real":
    avidir, mout = args[1], args[2]
    avis = sorted([f for f in os.listdir(avidir) if re.fullmatch(r"\d+\.avi", f)], key=lambda f: int(f[:-4]))
    avis = [os.path.join(avidir, f) for f in avis]
else:
    sim = args[1]
    d = sim + "/daq/Miniscope"
    avis = sorted([f for f in os.listdir(d) if f.endswith(".avi")], key=lambda f: int(re.sub(r"\D", "", f) or 0))
    avis = [os.path.join(d, f) for f in avis]

def frames():
    pos = 0
    for f in avis:
        cap = cv2.VideoCapture(f)
        n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        if pos + n <= start:
            pos += n; continue
        if start > pos:
            cap.set(cv2.CAP_PROP_POS_FRAMES, start - pos); pos = start
        while pos < start + nfr:
            ok, fr = cap.read()
            if not ok:
                break
            yield fr[..., 0].astype(np.float32)
            pos += 1
        if pos >= start + nfr:
            return

it = frames()
first = [next(it) for _ in range(200)]
H, W = first[0].shape
mean0 = np.mean(first, 0)
fov = mean0 > 0.25 * np.percentile(mean0, 99)
fovf = fov.astype(np.float32)
SIG = 20.0
den = gaussian_filter(fovf, SIG)
def hp(x):
    return (x - gaussian_filter(x * fovf, SIG) / np.maximum(den, 1e-3)) * fovf
def hpcanvas(x):
    return hp(x)
# motion template
do_motion = True
if mode == "sim" and os.path.exists(sim + "/spec.json"):
    do_motion = '"brain_motion"' in open(sim + "/spec.json").read()
win = np.outer(np.hanning(H), np.hanning(W)).astype(np.float32)
def band(x):
    return gaussian_filter(x, 1.5) - gaussian_filter(x, 8)
tmpl = band(np.mean(first[:100], 0)) * win
Ft = np.conj(np.fft.rfft2(tmpl))
def shift_of(fr):
    c = np.fft.irfft2(np.fft.rfft2(band(fr) * win) * Ft, (H, W))
    i, j = np.unravel_index(np.argmax(c), c.shape)
    def sub(a, b, cc):
        d = a - 2 * cc + b
        return 0.0 if d == 0 else 0.5 * (a - b) / d
    dy = sub(c[(i - 1) % H, j], c[(i + 1) % H, j], c[i, j]) + i
    dx = sub(c[i, (j - 1) % W], c[i, (j + 1) % W], c[i, j]) + j
    dy = dy - H if dy > H / 2 else dy
    dx = dx - W if dx > W / 2 else dx
    return dy, dx
ky = np.fft.fftfreq(H)[:, None]; kx = np.fft.rfftfreq(W)[None, :]
def apply_shift(fr, dy, dx):
    return np.fft.irfft2(np.fft.rfft2(fr) * np.exp(-2j * np.pi * (ky * (-dy) + kx * (-dx))), (H, W)).astype(np.float32)

# ---- footprints (unfiltered, frame coords) ----
foot = []  # (y0, x0, sub)
def compact(a):
    ys, xs = np.nonzero(a > 0)
    if len(ys) == 0:
        return None
    return (ys.min(), xs.min(), a[ys.min():ys.max() + 1, xs.min():xs.max() + 1].copy())
if mode == "real" and libdir:
    _, _, fps = read_fp(libdir + "/footprints.bin")
    for cid, (p, a, h) in fps.items():
        z = np.zeros(H * W, np.float32); z[p] = a; c_ = compact(z.reshape(H, W))
        if c_ is not None: foot.append(c_)
    Ctr = None
elif mode == "real":
    import zarr
    A = zarr.open(mout + "/A.zarr", mode="r")["A"]
    for u in range(A.shape[0]):
        a = np.nan_to_num(np.asarray(A[u], dtype=np.float32))
        c_ = compact(a)
        if c_ is not None: foot.append(c_)
    # Minian offset vs our template: xcorr of high-passed max projections (sign as real_del.py)
    Ctr = np.asarray(zarr.open(mout + "/C.zarr", mode="r")["C"][:, start:start + nfr], dtype=np.float32)
else:
    units, Cg = read_oracle(sim + "/oracle.bin")
    if libdir:
        _, _, fps = read_fp(libdir + "/footprints.bin")
        for cid, (p, a, h) in fps.items():
            z = np.zeros(H * W, np.float32); z[p] = a; c_ = compact(z.reshape(H, W))
            if c_ is not None: foot.append(c_)
        Ctr = None
    else:
        for u in units:
            y0, x0, v = u["full"]; z = np.zeros((H, W), np.float32); z[y0:y0 + v.shape[0], x0:x0 + v.shape[1]] = v
            c_ = compact(z)
            if c_ is not None: foot.append(c_)
        Ctr = Cg[:, start:start + nfr]
# integer offset: footprint-sum image vs our (corrected) max of first frames
fs = np.zeros((H, W), np.float32)
for (y0_, x0_, sb_) in foot:
    fs[y0_:y0_ + sb_.shape[0], x0_:x0_ + sb_.shape[1]] += sb_
mx = np.max([apply_shift(f, *shift_of(f)) if do_motion else f for f in first[:100]], 0)
def hpi(x):
    x = np.nan_to_num(x - np.median(x)); return x - gaussian_filter(x, 10)
Xc = np.fft.ifft2(np.fft.fft2(hpi(mx)) * np.conj(np.fft.fft2(hpi(fs)))).real
oy, ox = np.unravel_index(np.argmax(Xc), Xc.shape)
oy = oy - H if oy > H // 2 else oy; ox = ox - W if ox > W // 2 else ox
print("footprint offset", oy, ox)
if (oy, ox) != (0, 0):
    nf = []
    for (y0_, x0_, sb_) in foot:
        y0_, x0_ = y0_ + oy, x0_ + ox
        cy0, cx0 = max(-y0_, 0), max(-x0_, 0)
        sb_ = sb_[cy0:H - y0_, cx0:W - x0_]
        if sb_.size and sb_.max() > 0:
            nf.append((y0_ + cy0, x0_ + cx0, sb_))
    foot = nf
# filtered footprints, sparse (with moats)
import scipy.sparse as sp
rows, cols, vals = [], [], []
for k, (fy0, fx0, fsub) in enumerate(foot):
    y0, y1 = max(fy0 - 60, 0), min(fy0 + fsub.shape[0] + 60, H); x0, x1 = max(fx0 - 60, 0), min(fx0 + fsub.shape[1] + 60, W)
    sub = np.zeros((y1 - y0, x1 - x0), np.float32)
    sub[fy0 - y0:fy0 - y0 + fsub.shape[0], fx0 - x0:fx0 - x0 + fsub.shape[1]] = fsub; m = fovf[y0:y1, x0:x1]; dn = np.maximum(den[y0:y1, x0:x1], 1e-3)
    f = (sub - gaussian_filter(sub * m, SIG, mode="constant") / dn) * m
    keep = np.abs(f) > 1e-3 * np.abs(f).max()
    yy, xx = np.nonzero(keep)
    rows.append((yy + y0) * W + xx + x0); cols.append(np.full(len(yy), k)); vals.append(f[keep])
F = sp.csc_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(H * W, len(foot)))
G = (F.T @ F).toarray() + 1e-6 * np.eye(len(foot))
Gi = np.linalg.inv(G)
print(f"{mode}: {len(foot)} footprints, motion {do_motion}, frames {start}..{start + nfr}", flush=True)

nb = nfr // BIN
Rb = np.zeros((nb, H, W), np.float32); Cb = np.zeros((nb, len(foot)), np.float32)
dsum = np.zeros((H, W)); dn_ = 0; prev = None
acc_r = np.zeros((H, W), np.float32); acc_c = np.zeros(len(foot), np.float32)
allfr = first + []
t = 0
shifts = []
def frames_all():
    for f in first:
        yield f
    yield from it
for fr in frames_all():
    if t >= nb * BIN:
        break
    if do_motion:
        dy, dx = shift_of(fr); shifts.append((dy, dx)); fr = apply_shift(fr, dy, dx)
    y = hp(fr)
    if prev is not None:
        dsum += np.abs(y - prev); dn_ += 1  # mean abs diff
    prev = y
    c = Gi @ (F.T @ y.ravel())
    r = y - (F @ c).reshape(H, W)
    acc_r += r; acc_c += c
    t += 1
    if t % BIN == 0:
        Rb[t // BIN - 1] = acc_r / BIN; Cb[t // BIN - 1] = acc_c / BIN
        acc_r[:] = 0; acc_c[:] = 0
sigma = (dsum / max(dn_, 1)) / np.sqrt(2) * np.sqrt(np.pi / 2)  # mean|diff| -> sigma
sigma = np.where(fov, np.maximum(sigma, 1e-3), np.nan)
sb = np.nanmedian(sigma) / np.sqrt(BIN)  # noise of a bin mean (white)
if shifts:
    s = np.array(shifts); print("motion std px %.2f %.2f" % tuple(s.std(0)))
print("noise sigma median %.2f grey" % np.nanmedian(sigma))
# fluctuation about per-pixel mean
Rf = Rb - Rb.mean(0, keepdims=True)
Rf *= fov
# global mode
er = gaussian_filter(fovf, 3) > 0.999  # interior
inner = (gaussian_filter(fovf, 25) > 0.999)
g = Rf[:, inner].mean(1)
beta = np.tensordot(g, Rf, axes=(0, 0)) / max(g @ g, 1e-12)
fit = g[:, None, None] * beta[None]
tot = np.sum(Rf[:, inner] ** 2); gs = np.sum(fit[:, inner] ** 2)
Rl = (Rf - fit) * inner
print("global-mode share of residual fluctuation %.3f (incl. noise)" % (gs / tot))
# band powers, noise units per pixel (white noise of a bin: sb^2)
def blur(x, s):
    return gaussian_filter(x, (0, s, s)) if s > 0 else x
levels = [0, 1.5, 4, 10, 20]
print("band power (residual minus global mode, inner FOV), / white-noise power of the same band:")
noise_sim = np.random.default_rng(0).standard_normal((8, H, W)).astype(np.float32) * sb
prevB, prevN = Rl, noise_sim
B1 = None
for a in range(1, len(levels)):
    cur = blur(Rl, levels[a]); curN = blur(noise_sim, levels[a])
    pw = np.mean((prevB - cur)[:, inner] ** 2); pn = np.mean((prevN - curN)[:, inner] ** 2)
    print(f"  {levels[a-1]:>4}-{levels[a]:<4} px: {pw / pn:7.2f}")
    if a == 1:
        B1 = cur
    prevB, prevN = cur, curN
Blast = prevB
pw = np.mean(Blast[:, inner] ** 2); pn = np.mean(prevN[:, inner] ** 2)
print(f"  >{levels[-1]} px: {pw / pn:7.2f}")
del fit, Rf, Rb
# radial autocorrelation of the band-limited (>1.5 px) residual
X = B1
acc = np.zeros((2 * H, 2 * W))
fm = np.fft.rfft2(inner.astype(float), (2 * H, 2 * W)); norm = np.fft.irfft2(fm * np.conj(fm), (2 * H, 2 * W))
for k in range(0, nb, max(nb // 60, 1)):
    fr_ = np.fft.rfft2(X[k], (2 * H, 2 * W)); acc += np.fft.irfft2(fr_ * np.conj(fr_), (2 * H, 2 * W))
ac = np.fft.fftshift(acc / np.maximum(norm, 1))
yy, xx = np.mgrid[:2 * H, :2 * W]; rr = np.rint(np.hypot(yy - H, xx - W)).astype(int)
m = rr <= 80
prof = np.bincount(rr[m], ac[m]) / np.bincount(rr[m]); prof /= prof[0]
def cross(p, v):
    i = np.argmax(p < v); return i
print("residual(>1.5px blur) autocorr: 1/e %d px, half %d px; r(10)=%.2f r(20)=%.2f r(40)=%.2f" % (cross(prof, np.exp(-1)), cross(prof, .5), prof[10], prof[20], prof[40]))
# population coupling
if Ctr is not None or True:
    Cz = (Cb - Cb.mean(0)) / (Cb.std(0) + 1e-9)
    P = Cz.mean(1); P = (P - P.mean()) / P.std()
    for s in (4, 10):
        X = blur(Rl, s)
        bs = 32
        rs = []
        for by in range(0, H - bs + 1, bs):
            for bx in range(0, W - bs + 1, bs):
                if not inner[by:by + bs, bx:bx + bs].all():
                    continue
                tsr = X[:, by + bs // 2, bx + bs // 2]
                if tsr.std() == 0:
                    continue
                rs.append(np.corrcoef(tsr, P)[0, 1])
        rs = np.array(rs)
        print(f"  coupling to population P, blur {s} px: median r {np.median(rs):+.3f}, |r| median {np.median(np.abs(rs)):.3f}, share r>0.3 {np.mean(rs > 0.3):.3f}, n {len(rs)}")
    # excursions: sigma-8 blur, per-block max, in units of the bin-noise of that blur
    X = blur(Rl, 8); 
    nz = blur(noise_sim, 8)[:, inner].std()
    ev = (X[:, inner] > 5 * nz).mean()
    print(f"  sigma-8 blurred residual > 5 noise: {ev * 100:.3f} % of px-bins (white noise: 3e-5 %)")
    # how much residual fluctuation power (>1.5 px band) is explained by P (linear, per pixel)
    Xb = B1 - Blast
    bp = np.tensordot(P, Xb, axes=(0, 0)) / (P @ P)
    expl = np.sum((P[:, None, None] * bp[None])[:, inner] ** 2) / np.sum(Xb[:, inner] ** 2)
    print(f"  share of 1.5-20 px residual power explained by P (per-pixel loading): {expl:.3f}")
