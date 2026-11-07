/** Natural ordering of file names: `2.avi` < `10.avi`, digit runs compare as numbers. */
export function naturalCompare(a: string, b: string): number {
  const ax = a.match(/\d+|\D+/g) ?? [];
  const bx = b.match(/\d+|\D+/g) ?? [];
  const n = Math.min(ax.length, bx.length);
  for (let i = 0; i < n; i++) {
    const x = ax[i];
    const y = bx[i];
    if (x === y) continue;
    const xd = /^\d/.test(x);
    const yd = /^\d/.test(y);
    if (xd && yd) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
      // Same value, different zero padding: shorter first, for a stable order.
      if (x.length !== y.length) return x.length - y.length;
    } else {
      return x < y ? -1 : 1;
    }
  }
  return ax.length - bx.length;
}
