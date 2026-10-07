import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const svg = readFileSync('pwa/icon.svg', 'utf8');
// Supersample curved edges, then average pixel coverage. BOX keeps aligned
// straight edges sharp without the halos introduced by sharpening/Lanczos.
// Cap the intermediate image at 4096px to keep memory bounded.
for (const size of [192, 512, 1024]) {
  const scale = Math.min(8, Math.floor(4096 / size));
  const rendered = execFileSync('rsvg-convert', ['-w', String(size * scale), '-h', String(size * scale)], { input: svg });
  execFileSync('python3', ['scripts/downsample-icon.py', String(size), `pwa/icon-${size}.png`], { input: rendered });
  console.log(`Rendered ${size}×${size} from ${scale}× supersampling`);
}
const page = readFileSync('index.html', 'utf8');
writeFileSync('index.html', page.replace(/<link rel="icon" href="data:image\/svg\+xml,[^"]*">/, () => `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(svg)}">`));
