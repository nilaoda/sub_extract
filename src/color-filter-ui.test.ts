import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setupColorFilter } from './color-filter-ui';

function pendingSeek() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Exercise the actual UI handlers without decoding video or loading a model. */
function ui(t: TestContext) {
  let reads = 0, previews = 0, seek = Promise.resolve();
  const errors: string[] = [];
  class Element extends EventTarget {
    value = ''; checked = false; hidden = false; disabled = false; open = true;
    textContent = ''; innerHTML = ''; className = ''; tabIndex = 0;
    children: Element[] = [];
    classList = { add() {}, remove() {} };
    onclick?: () => Promise<void> | void;
    onpointerdown?: (event: { button: number; clientX: number; clientY: number; preventDefault(): void }) => Promise<void>;
    constructor(public width = 1, public height = 1) { super(); }
    setAttribute() {} focus() {}
    append(...children: Element[]) { this.children.push(...children); }
    querySelectorAll() { return []; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 50 }; }
    getContext() {
      return {
        drawImage: () => { if (this.width === 1 && this.height === 1) reads++; },
        getImageData: (_x: number, _y: number, w: number, h: number) => { if (w !== 1 || h !== 1) previews++; return { data: w === 1 && h === 1 ? new Uint8ClampedArray([12, 34, 56, 255]) : new Uint8ClampedArray(w * h * 4) }; },
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData() {},
      };
    }
  }
  class Video extends Element {
    videoWidth = 100; videoHeight = 50; readyState = 2; paused = true; seeking = false;
    pause() { this.paused = true; }
  }
  const elements = new Map<string, Element>();
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const globals = {
    document: { getElementById: get, createElement: () => new Element(), body: new Element() },
    localStorage: { getItem: () => null, setItem() {} },
    OffscreenCanvas: Element, HTMLVideoElement: Video,
    createImageBitmap: async () => { throw new Error('Video bitmaps are unavailable before presentation'); },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  };
  for (const [key, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
  }
  const video = new Video(), stage = new Element();
  const filter = setupColorFilter(video as unknown as HTMLVideoElement, stage as unknown as HTMLElement,
    () => ({ x: .1, y: .82, width: .8, height: .15 }), () => seek, () => {}, text => errors.push(text));
  filter.refresh(false, true);
  const layer = stage.children[0];
  return {
    filter, video, layer, errors, get,
    setSeek(value: Promise<void>) { seek = value; },
    reads: () => reads, previews: () => previews,
    start: async () => { await get('pick-subtitle-color').onclick!(); assert.equal(layer.hidden, false); },
    click: () => layer.onpointerdown!({ button: 0, clientX: 50, clientY: 40, preventDefault() {} }),
  };
}

test('actual colour reading waits for the current seek before saving the pixel', async t => {
  const app = ui(t); await app.start();
  const seek = pendingSeek(); app.setSeek(seek.promise);
  const click = app.click(); assert.equal(app.reads(), 0);
  seek.resolve(); await click;
  assert.equal(app.reads(), 1); assert.equal(app.get('subtitle-color').value, '#0c2238');
});

test('a new seek or playback cancels picking and hidden layers cannot read pixels', async t => {
  const app = ui(t); await app.start();
  app.video.seeking = true; app.video.dispatchEvent(new Event('seeking'));
  assert.equal(app.layer.hidden, true); await app.click(); assert.equal(app.reads(), 0);
  app.video.seeking = false; await app.start();
  app.video.paused = false; app.video.dispatchEvent(new Event('play'));
  assert.equal(app.layer.hidden, true); await app.click(); assert.equal(app.reads(), 0);
});

test('changing source cancels an in-flight pixel read and disables picking until ready', async t => {
  const app = ui(t); await app.start();
  const seek = pendingSeek(); app.setSeek(seek.promise); const click = app.click();
  app.filter.sourceChanged(); seek.resolve(); await click;
  assert.equal(app.reads(), 0); assert.equal(app.get('subtitle-color').value, '#ffffff');
  assert.equal(app.get('pick-subtitle-color').disabled, true);
});

test('cancelled pick waits do not show a stale error', async t => {
  const app = ui(t), seek = pendingSeek(); app.setSeek(seek.promise);
  const start = app.get('pick-subtitle-color').onclick!();
  app.filter.stopPicking(); seek.reject(new Error('cancelled seek')); await start;
  assert.deepEqual(app.errors, []); assert.equal(app.layer.hidden, true);
});


test('initial paused video preview uses Canvas without allocating a video bitmap', async t => {
  const app = ui(t); await app.filter.preview();
  assert.equal(app.previews(), 1); assert.equal(app.get('color-mask-preview').hidden, false);
  assert.ok(!app.get('color-filter-status').textContent.includes('unavailable'));
});

test('preview waits for a paused and decoded frame', async t => {
  const app = ui(t); app.video.paused = false; await app.filter.preview();
  assert.equal(app.previews(), 0); assert.equal(app.get('color-mask-preview').hidden, true);
  app.video.paused = true; app.video.readyState = 1; await app.filter.preview();
  assert.equal(app.previews(), 0);
  app.video.readyState = 2; await app.filter.preview(); assert.equal(app.previews(), 1);
});
