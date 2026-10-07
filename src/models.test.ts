import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getModelCacheState, MODEL_FILES } from './models';

const legacyDetector = 'c255248806ccdf52d6af1e45e362e6b27dcb770c6e2b92707459ee9a20f54587';

// Only the asynchronous open/count surface is needed for cache discovery.
async function withCache(keys: string[], run: () => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const request = (result: unknown) => {
    const value = { result, onsuccess: undefined as (() => void) | undefined };
    queueMicrotask(() => value.onsuccess?.());
    return value;
  };
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: {
    open: () => request({
      transaction: () => ({ objectStore: () => ({ count: (key: string) => request(keys.includes(key) ? 1 : 0) }) }),
      close() {},
    }),
  } });
  try { await run(); }
  finally {
    if (original) Object.defineProperty(globalThis, 'indexedDB', original);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
  }
}

test('complete mixed-model cache is ready, including with the old detector retained', async () => {
  await withCache([...MODEL_FILES.map(spec => spec.sha), legacyDetector], async () => {
    assert.equal(await getModelCacheState(), 'ready');
  });
});

test('complete v4 cache can upgrade; incomplete caches cannot auto-load', async () => {
  const shared = MODEL_FILES.slice(1).map(spec => spec.sha);
  await withCache([legacyDetector, ...shared], async () => {
    assert.equal(await getModelCacheState(), 'upgrade');
  });
  for (const keys of [[legacyDetector, shared[0]], shared, [MODEL_FILES[0].sha]]) {
    await withCache(keys, async () => assert.equal(await getModelCacheState(), 'empty'));
  }
});

test('unavailable IndexedDB does not prevent startup', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, get() { throw Error('Storage denied'); } });
  try { assert.equal(await getModelCacheState(), 'empty'); }
  finally {
    if (original) Object.defineProperty(globalThis, 'indexedDB', original);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
  }
});
