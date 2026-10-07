const PREFIX = `sub-extract:${self.registration.scope}:`;
const CACHE = `${PREFIX}__BUILD_VERSION__`;
const APP = new URL('index.html', self.registration.scope).href;
const ASSETS = ['index.html', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-1024.png'].map(path => new URL(path, self.registration.scope).href);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url), scope = new URL(self.registration.scope);
  if (request.method !== 'GET' || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const isApp = url.pathname === scope.pathname || url.pathname === new URL(APP).pathname;
  if (request.mode === 'navigate' && isApp) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(request);
        if (response.ok) { await cache.put(APP, response.clone()); return response; }
        return await cache.match(APP) || response;
      } catch {
        const cached = await cache.match(APP);
        if (cached) return cached;
        return new Response('离线页面尚未缓存，请联网打开一次。', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
  } else if (ASSETS.includes(url.href)) {
    event.respondWith(caches.open(CACHE).then(async cache => await cache.match(request) || fetch(request)));
  }
});
