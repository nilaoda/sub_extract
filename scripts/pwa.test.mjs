import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../pwa/sw.js', import.meta.url), 'utf8');
async function runtime() {
  const scope = 'https://example.github.io/sub_extract/';
  const stores = new Map(), events = new Map(), requests = [];
  let offline = false, status = 200, claimed = false;
  const key = request => typeof request === 'string' ? request : request.url;
  const fetch = async request => {
    requests.push(key(request));
    if (offline) throw new TypeError('offline');
    return new Response('cached app', { status });
  };
  const caches = {
    keys: async () => [...stores.keys()],
    delete: async name => stores.delete(name),
    open: async name => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        addAll: async urls => { for (const url of urls) store.set(url, await fetch(url)); },
        put: async (url, response) => store.set(key(url), response),
        match: async url => store.get(key(url))?.clone(),
      };
    },
  };
  vm.runInNewContext(source.replace('__BUILD_VERSION__', 'new'), {
    self: { registration: { scope }, clients: { claim: async () => { claimed = true; } }, addEventListener: (type, callback) => events.set(type, callback) },
    caches, fetch, URL, Response,
  });
  const lifecycle = async type => { let task; events.get(type)({ waitUntil: promise => { task = promise; } }); await task; };
  const request = async (url, mode = 'navigate') => {
    let task;
    events.get('fetch')({ request: { url, method: 'GET', mode }, respondWith: promise => { task = promise; } });
    return task;
  };
  return { scope, stores, requests, lifecycle, request, setOffline: value => { offline = value; }, setStatus: value => { status = value; }, claimed: () => claimed };
}
test('PWA precaches the app and returns it offline for both project root and index URL', async () => {
  const sw = await runtime(); await sw.lifecycle('install');
  assert.equal(sw.requests.length, 6);
  sw.setOffline(true);
  for (const url of [sw.scope, `${sw.scope}index.html?test=1`]) assert.equal(await (await sw.request(url)).text(), 'cached app');
  assert.equal(await (await sw.request(`${sw.scope}icon-192.png`, 'cors')).text(), 'cached app');
});
test('PWA leaves other origins and unrelated routes alone and only removes its own obsolete caches', async () => {
  const sw = await runtime();
  const old = `sub-extract:${sw.scope}:old`, other = 'sub-extract:https://example.github.io/other/:old';
  sw.stores.set(old, new Map()); sw.stores.set(other, new Map());
  await sw.lifecycle('install'); await sw.lifecycle('activate');
  assert(!sw.stores.has(old)); assert(sw.stores.has(other)); assert(sw.claimed());
  assert.equal(await sw.request('https://huggingface.co/model.onnx', 'cors'), undefined);
  assert.equal(await sw.request('https://example.github.io/other/', 'navigate'), undefined);
  assert.equal(await sw.request(`${sw.scope}unrelated.json`, 'cors'), undefined);
});
test('PWA keeps cached navigation available on server errors, and explains a missing offline cache', async () => {
  const sw = await runtime(); await sw.lifecycle('install'); sw.setStatus(503);
  assert.equal((await sw.request(sw.scope)).status, 200);
  const empty = await runtime(); empty.setOffline(true);
  assert.equal((await empty.request(empty.scope)).status, 503);
});
test('PWA manifest uses relative project paths and includes valid installation icons', async () => {
  const manifest = JSON.parse(await readFile(new URL('../pwa/manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.start_url, './'); assert.equal(manifest.scope, './'); assert.equal(manifest.display, 'standalone');
  assert(manifest.icons.some(icon => icon.sizes === 'any' && icon.type === 'image/svg+xml'));
  for (const size of [192, 512, 1024]) {
    assert(manifest.icons.some(icon => icon.sizes === `${size}x${size}`));
    const icon = await readFile(new URL(`../pwa/icon-${size}.png`, import.meta.url));
    assert.equal(icon.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(icon.readUInt32BE(16), size); assert.equal(icon.readUInt32BE(20), size);
  }
});
