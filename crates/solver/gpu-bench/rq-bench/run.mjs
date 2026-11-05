// Serve rq-bench/ plus the dumped rows on 127.0.0.1 and drive it in
// Playwright's full Chromium (real Metal adapter). Usage:
//   node run.mjs <rq_rows.bin> [rows=256,1024,2048,4096]
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const here = path.dirname(fileURLToPath(import.meta.url));
const [bin, rows = '256,1024,2048,4096'] = process.argv.slice(2);
const require = createRequire(process.env.PW_FROM ?? import.meta.url);
const { chromium } = require('playwright');
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/rq_rows.bin') return res.end(readFileSync(bin));
  res.setHeader('content-type', 'text/html');
  res.end(readFileSync(path.join(here, 'index.html')));
});
await new Promise((r) => server.listen(4178, '127.0.0.1', r));
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage();
page.on('console', (m) => console.log('[page]', m.text()));
await page.goto(`http://127.0.0.1:4178/?rows=${rows}`);
await page.waitForFunction(() => window.__result, null, { timeout: 15 * 60_000 });
console.log(await page.textContent('#log'));
console.log(JSON.stringify(await page.evaluate(() => window.__result)));
await browser.close();
server.close();
