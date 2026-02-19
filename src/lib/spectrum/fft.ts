// Pure TypeScript radix-2 Cooley-Tukey FFT for spectrum visualization.
// Operates independently of the WASM solver to avoid coupling and extra worker round-trips.

/** Compute one-sided power spectral density (periodogram) of a real signal. */
export function computePeriodogram(
  signal: Float64Array,
  fs: number,
): { freqs: Float64Array; psd: Float64Array } {
  const N = signal.length;
  // Zero-pad to next power of 2
  const nfft = nextPow2(N);
  const halfN = nfft / 2 + 1;

  // Apply Hann window and copy to complex array [re, im, re, im, ...]
  const data = new Float64Array(nfft * 2);
  for (let i = 0; i < N; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
    data[i * 2] = signal[i] * w;
  }

  fft(data, nfft);

  // Compute one-sided PSD in dB: 10 * log10(|X(f)|² / N)
  const psd = new Float64Array(halfN);
  const freqs = new Float64Array(halfN);
  const df = fs / nfft;

  for (let i = 0; i < halfN; i++) {
    const re = data[i * 2];
    const im = data[i * 2 + 1];
    const mag2 = re * re + im * im;
    psd[i] = 10 * Math.log10(mag2 / N + 1e-20);
    freqs[i] = i * df;
  }

  return { freqs, psd };
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** In-place radix-2 Cooley-Tukey FFT on interleaved complex array. */
function fft(data: Float64Array, n: number): void {
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      // Swap complex elements
      let t = data[i * 2];
      data[i * 2] = data[j * 2];
      data[j * 2] = t;
      t = data[i * 2 + 1];
      data[i * 2 + 1] = data[j * 2 + 1];
      data[j * 2 + 1] = t;
    }
  }

  // Butterfly stages
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1,
        curIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const uIdx = (i + j) * 2;
        const vIdx = (i + j + len / 2) * 2;
        const tRe = curRe * data[vIdx] - curIm * data[vIdx + 1];
        const tIm = curRe * data[vIdx + 1] + curIm * data[vIdx];
        data[vIdx] = data[uIdx] - tRe;
        data[vIdx + 1] = data[uIdx + 1] - tIm;
        data[uIdx] += tRe;
        data[uIdx + 1] += tIm;
        const newRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newRe;
      }
    }
  }
}
