import { readFile, writeFile, mkdir, rm, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const html = await readFile('dist/sub-extract.html', 'utf8');
const manifest = await readFile('pwa/manifest.webmanifest', 'utf8');
const worker = await readFile('pwa/sw.js', 'utf8');
const hash = createHash('sha256').update(html).update(manifest).update(worker);
const icons = ['icon.svg', ...[192, 512, 1024].map(size => `icon-${size}.png`)];
for (const name of icons) hash.update(await readFile(`pwa/${name}`));
const version = hash.digest('hex').slice(0, 16);
await rm('.pages', { recursive: true, force: true });
await mkdir('.pages', { recursive: true });
const tags = '<link rel="manifest" href="./manifest.webmanifest">\n<meta name="theme-color" content="#111516">\n<link rel="icon" href="./icon.svg" type="image/svg+xml" sizes="any">\n<link rel="apple-touch-icon" href="./icon-512.png">\n';
await writeFile('.pages/index.html', html.replace('</head>', () => `${tags}</head>`));
await writeFile('.pages/sw.js', worker.replace('__BUILD_VERSION__', version));
await copyFile('pwa/manifest.webmanifest', '.pages/manifest.webmanifest');
for (const name of icons) await copyFile(`pwa/${name}`, `.pages/${name}`);
console.log(`Pages + PWA ready: .pages/ (${version})`);
