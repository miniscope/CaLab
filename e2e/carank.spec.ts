import { test, expect } from './fixtures.ts';

/**
 * CaRank has no built-in demo dataset, so build a tiny 2D float64 .npy
 * (cells x timepoints) in memory and feed it to the import file input.
 */
function makeNpy(rows: number, cols: number): Buffer {
  const header = `{'descr': '<f8', 'fortran_order': False, 'shape': (${rows}, ${cols}), }`;
  // Magic (6) + version (2) + header length (2) + header, padded with spaces
  // and a trailing newline so the data starts on a 64-byte boundary.
  const preamble = 10;
  const total = Math.ceil((preamble + header.length + 1) / 64) * 64;
  const padded = header.padEnd(total - preamble - 1, ' ') + '\n';

  const buf = Buffer.alloc(total + rows * cols * 8);
  buf.write('\x93NUMPY', 0, 'latin1');
  buf.writeUInt8(1, 6);
  buf.writeUInt8(0, 7);
  buf.writeUInt16LE(padded.length, 8);
  buf.write(padded, preamble, 'latin1');
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Sparse transients on noise, with a different rate per cell so the
      // ranking has something to sort.
      const spike = (c + r * 7) % (20 + r * 5) === 0 ? 5 : 0;
      const value = spike + Math.sin(c * 0.37 + r) * 0.2;
      buf.writeDoubleLE(value, total + (r * cols + c) * 8);
    }
  }
  return buf;
}

test('CaRank: an imported .npy mounts the ranking dashboard', async ({ page }) => {
  await page.goto('CaRank/');
  await expect(page.getByRole('heading', { level: 1, name: 'CaRank' })).toBeVisible();
  await expect(page.getByText('Drop a .npy file here')).toBeVisible();

  const cells = 6;
  await page.locator('input[type="file"]').setInputFiles({
    name: 'smoke.npy',
    mimeType: 'application/octet-stream',
    buffer: makeNpy(cells, 600),
  });

  await expect(page.getByRole('heading', { name: 'Cell Quality Ranking' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change Data' })).toBeVisible();
  // One header row plus one row per cell.
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(cells + 1);
});
