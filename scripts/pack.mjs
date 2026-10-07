import { readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
let html = await readFile('dist/index.html', 'utf8');
for (const match of [...html.matchAll(/<script\b[^>]*src="([^"]+)"[^>]*><\/script>/g)]) {
  const code = await readFile(resolve('dist', match[1]), 'utf8');
  // A callback keeps "$&", "$`", and "$'" in bundled code literal.
  html = html.replace(match[0], () => `<script type="module">${code.replace(/<\/script/gi, '<\\/script')}</script>`);
}
for (const match of [...html.matchAll(/<link\b[^>]*href="([^"]+\.css)"[^>]*>/g)]) {
  const css = await readFile(resolve('dist', match[1]), 'utf8');
  html = html.replace(match[0], () => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`);
}
await writeFile('dist/sub-extract.html', html);
for (const path of await readdir('dist')) if (path !== 'sub-extract.html') await rm(resolve('dist', path), { recursive: true });
console.log(`Single HTML: ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(1)} MiB`);
