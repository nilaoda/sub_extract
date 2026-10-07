import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameReuse, subtitleSignature, sameSubtitlePixels, FRAME_RECHECK_MS } from './frame-change';
import { buildCues } from './core';
import type { OcrTextResult } from './ocr';

function picture(shift = 0, background = 20, edited = false) {
  const width = 512, height = 64, pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) { pixels[i] = pixels[i + 1] = pixels[i + 2] = background; pixels[i + 3] = 255; }
  const rectangle = (x: number, y: number, w: number, h: number) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x + shift; xx < x + shift + w; xx++) {
      const i = (yy * width + xx) * 4; pixels[i] = pixels[i + 1] = pixels[i + 2] = 230;
    }
  };
  for (let x = 20; x < 470; x += 25) { rectangle(x, 18, 18, 3); rectangle(x + 8, 18, 3, 24); rectangle(x, 36, 18, 3); }
  if (edited) rectangle(227, 25, 6, 3);
  return { pixels, width, height };
}
function signature(shift = 0, background = 20, edited = false) { const image = picture(shift, background, edited); return subtitleSignature(image.pixels, image.width, image.height); }
const value = (text = '测试字幕', confidence = .98): OcrTextResult => ({ text, confidence, lines: text ? [{ text, confidence, box: { x: 15 / 512, y: 12 / 64, width: 470 / 512, height: 36 / 64 } }] : [] });

test('stroke comparison tolerates dark background changes and a one-pixel raster shift', () => {
  const anchor = signature();
  assert.equal(sameSubtitlePixels(anchor, signature(0, 70)), true);
  assert.equal(sameSubtitlePixels(anchor, signature(1)), true);
  assert.equal(sameSubtitlePixels(anchor, signature(3)), false);
});

test('a local glyph edit in a long line cannot hide in the global image average', () => {
  assert.equal(sameSubtitlePixels(signature(), signature(0, 20, true)), false);
});

test('blank regions, different sizes and colour changes do not reuse text', () => {
  const image = picture();
  for (let i = 0; i < image.pixels.length; i += 4) if (image.pixels[i] > 180) image.pixels[i + 1] = image.pixels[i + 2] = 0;
  assert.equal(sameSubtitlePixels(signature(), subtitleSignature(image.pixels, image.width, image.height)), false);
  assert.equal(sameSubtitlePixels(signature(), subtitleSignature(new Uint8ClampedArray(512 * 64 * 4), 512, 64)), false);
  assert.equal(sameSubtitlePixels(signature(), { ...signature(), width: 256 }), false);
});

test('two real reads precede reuse; timestamps and real OCR witnesses survive across windows', async () => {
  const reuse = new FrameReuse(), calls: number[][] = []; reuse.reset('coarse:1');
  const infer = async (indices: number[]) => { calls.push(indices); return indices.map(() => value()); };
  const first = await reuse.recognize([signature(), signature(), signature(), signature()], [0, 250, 500, 750], infer);
  assert.deepEqual(calls, [[0, 1]]); assert.deepEqual(first.reused, [false, false, true, true]);
  assert.deepEqual(first.sourceTimes, [0, 250, 0, 0]);
  const second = await reuse.recognize([signature(), signature()], [1000, 1250], infer);
  assert.deepEqual(second.reused, [true, true]); assert.equal(calls.length, 1);
  const cues = buildCues(second.values.map((result, i) => ({ time: [1000, 1250][i], ocrTime: second.sourceTimes[i], ...result })), 0, 1500, 250);
  assert.equal(cues[0].sampleTime, 0);
});

test('periodic confirmation, phase changes and backward seeks force actual OCR', async () => {
  const reuse = new FrameReuse(); reuse.reset('coarse:1'); let frames = 0;
  const infer = async (indices: number[]) => { frames += indices.length; return indices.map(() => value()); };
  await reuse.recognize([signature(), signature(), signature()], [0, 250, 500], infer);
  assert.equal(frames, 2);
  await reuse.recognize([signature()], [FRAME_RECHECK_MS + 1], infer); assert.equal(frames, 3);
  await reuse.recognize([signature()], [0], infer); assert.equal(frames, 4);
  reuse.reset('refine:1'); await reuse.recognize([signature()], [50], infer); assert.equal(frames, 5);
  reuse.reset('coarse:2'); await reuse.recognize([signature()], [100], infer); assert.equal(frames, 6);
});

test('low confidence, unsupported boxes and inconsistent reads fall back to OCR for every frame', async () => {
  for (const makeValue of [() => value('测试字幕', .8), () => ({ ...value(), lines: [{ ...value().lines[0], box: { x: 0, y: 0, width: 1, height: .1 } }] }), (index: number) => value(index === 0 ? '一分价钱' : '二分价钱')]) {
    const reuse = new FrameReuse(); let frames = 0;
    const result = await reuse.recognize(Array.from({ length: 4 }, () => signature()), [0, 250, 500, 750], async indices => { frames += indices.length; return indices.map(makeValue); });
    assert.equal(frames, 4); assert.equal(result.reusedFrames, 0);
  }
});

test('changed glyphs split groups, preserving order even when representative OCR is batched', async () => {
  const reuse = new FrameReuse();
  const result = await reuse.recognize([signature(), signature(), signature(), signature(0, 20, true), signature(0, 20, true), signature(0, 20, true)], [0, 250, 500, 750, 1000, 1250], async indices => indices.map(index => value(index < 3 ? '第一句' : '第二句')));
  assert.deepEqual(result.values.map(result => result.text), ['第一句', '第一句', '第一句', '第二句', '第二句', '第二句']);
  assert.deepEqual(result.reused, [false, false, true, false, false, true]);
});

test('new text outside detected boxes invalidates reuse, including another row', () => {
  const anchor = signature(), boxes = value().lines.map(line => line.box);
  for (const [x, y] of [[492, 22], [180, 53]]) {
    const added = signature();
    for (let yy = y; yy < y + 3; yy++) for (let xx = x; xx < x + 12; xx++) { added.ink[yy * added.width + xx] = 1; added.count++; }
    assert.equal(sameSubtitlePixels(anchor, added, boxes), false);
  }
});

test('disappearance and reappearance preserve blank gaps and export boundaries', async () => {
  const reuse = new FrameReuse(), blank = subtitleSignature(new Uint8ClampedArray(512 * 64 * 4), 512, 64);
  const times = [0, 250, 500, 750, 1000, 1250, 1500, 1750];
  const result = await reuse.recognize([signature(), signature(), signature(), blank, blank, signature(), signature(), signature()], times,
    async indices => indices.map(i => value(i === 3 || i === 4 ? '' : '测试字幕')));
  assert.equal(result.reusedFrames, 2);
  assert.deepEqual(result.values.map(v => v.text), ['测试字幕', '测试字幕', '测试字幕', '', '', '测试字幕', '测试字幕', '测试字幕']);
  const cues = buildCues(result.values.map((v, i) => ({ ...v, time: times[i], ocrTime: result.sourceTimes[i] })), 0, 2000, 250);
  assert.equal(cues.length, 2); assert.equal(cues[0].end, 625); assert.equal(cues[1].start, 1125);
  assert.ok(cues.every(c => c.sampleTime >= c.start && c.sampleTime < c.end));
});

test('single-frame windows confirm twice and compare against a fixed anchor to catch gradual drift', async () => {
  const reuse = new FrameReuse(); let frames = 0;
  const infer = async (indices: number[]) => { frames += indices.length; return indices.map(() => value()); };
  for (const [i, shift] of [0, 0, 1, 2, 3].entries()) {
    const result = await reuse.recognize([signature(shift)], [i * 250], infer);
    assert.equal(result.reusedFrames, i === 2 ? 1 : 0);
  }
  assert.equal(frames, 4);
});

test('failed inference invalidates cached confirmation', async () => {
  for (const fail of [async () => { throw Error('inference failed'); }, async () => []]) {
    const reuse = new FrameReuse(), infer = async (indices: number[]) => indices.map(() => value());
    await reuse.recognize([signature(), signature()], [0, 250], infer);
    await assert.rejects(reuse.recognize([signature(3)], [500], fail));
    const next = await reuse.recognize([signature(), signature(), signature()], [750, 1000, 1250], infer);
    assert.deepEqual(next.reused, [false, false, true]);
  }
});
