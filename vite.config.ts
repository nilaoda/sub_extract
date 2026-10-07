import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';

// The binary is supplied explicitly at init. Suppress ORT's unused URL fallbacks so Vite
// does not inline a second copy into the worker, or leave a runtime network dependency.
const embeddedRuntimeOnly = (): Plugin => ({
  name: 'ort-no-fallback-asset', enforce: 'pre',
  transform(code, id) {
    if (id.includes('ort.webgpu.bundle.min.mjs')) return code
      .replace(/new URL\("ort-wasm-simd-threaded\.asyncify\.wasm",import\.meta\.url\)\.href/g, '"embedded-runtime.wasm"')
      .replaceAll('import.meta.url', 'self.location.href');
  },
});

export default defineConfig({
  plugins: [{
    name: 'embedded-ort-runtime',
    resolveId(id) { if (id === 'virtual:ort-wasm') return '\0ort-wasm'; },
    load(id) {
      if (id === '\0ort-wasm') {
        // Keep the binary outside executable JS: parsing a huge JS literal causes
        // a large memory peak before the user has even loaded a model.
        return `export default () => document.getElementById('ort-wasm-data').textContent;`;
      }
    },
    transformIndexHtml() {
      const bytes = readFileSync(resolve('node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm'));
      return [{ tag: 'script', attrs: { id: 'ort-wasm-data', type: 'application/octet-stream', 'data-compression': 'gzip' }, children: gzipSync(bytes).toString('base64'), injectTo: 'head-prepend' }];
    },
  }, embeddedRuntimeOnly()],
  base: './',
  optimizeDeps: { include: ['onnxruntime-web/webgpu', 'mp4box'] },
  server: { watch: { ignored: ['**/.local-test/**', '**/scripts/**', '**/*.test.ts'] } },
  build: { target: 'es2022', cssCodeSplit: false, assetsInlineLimit: Infinity, reportCompressedSize: false, chunkSizeWarningLimit: 40_000 },
  // Classic Blob workers work from file:// too (module workers fail on opaque file origins).
  worker: { format: 'iife', plugins: () => [embeddedRuntimeOnly()] },
});
