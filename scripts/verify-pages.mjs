import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

assert.deepEqual((await readdir('.pages')).sort(), ['icon-1024.png', 'icon-192.png', 'icon-512.png', 'icon.svg', 'index.html', 'manifest.webmanifest', 'sw.js']);
const html = await readFile('.pages/index.html', 'utf8');
assert(html.includes('<link rel="manifest" href="./manifest.webmanifest">'));
assert(html.includes('id="install-app"'));
assert(!/<script\b[^>]*\bsrc\s*=/.test(html));
const manifest = JSON.parse(await readFile('.pages/manifest.webmanifest', 'utf8'));
assert.equal(manifest.start_url, './'); assert.equal(manifest.scope, './');
for (const icon of manifest.icons) await readFile(`.pages/${icon.src.replace('./', '')}`);
const worker = await readFile('.pages/sw.js', 'utf8');
assert(!worker.includes('__BUILD_VERSION__'));
assert(/const CACHE = `\$\{PREFIX\}[a-f0-9]{16}`/.test(worker));
console.log('Verified: relative Pages paths, install manifest, icons, and versioned offline worker.');
