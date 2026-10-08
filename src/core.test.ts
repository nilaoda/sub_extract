import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCues, decodeCTC, restoreVisualSpaces, filterUnsupportedEdgeTokens, formatTime, parseTime, exportSubtitles, importProject, validateCues, mergeTextBoxes, moveRegion, resizeRegion, resizeRegionFromCenter, cropPointerMode, type Observation, type Cue } from './core';

const obs = (time: number, text: string, confidence = 0.96): Observation => ({ time, text, confidence, lines: [] });
const cue: Cue = { id: '1', start: 1230, end: 3560, text: '你 <我> & 他\n第二行', lines: [], confidence: 0.9, needsReview: false, sampleTime: 2000 };

test('midpoint timing, explicit blanks, and recurring identical text remain separate events', () => {
  const cues = buildCues([obs(0, ''), obs(250, '出发'), obs(500, '出发'), obs(750, ''), obs(1000, '出发'), obs(1250, '')], 0, 1500, 250);
  assert.deepEqual(cues.map(c => [c.start, c.end, c.text]), [[125, 625, '出发'], [875, 1125, '出发']]);
});
test('one-character changes in short subtitles are not merged, punctuation uses consensus', () => {
  const cues = buildCues([obs(0, '去北京'), obs(250, '去南京'), obs(500, '去南京。'), obs(750, '去南京')], 0, 1000, 250);
  assert.equal(cues.length, 2); assert.equal(cues[1].text, '去南京'); assert(cues[1].needsReview);
});
test('user regression: short incomplete reads collapse into the sustained complete subtitle', () => {
  const cues = buildCues([
    obs(121788, '他不是一'), obs(121838, '他不是一'),
    obs(121938, '他不是一个'), obs(122188, '他不是一个'), obs(122438, '他不是一个'), obs(122722, '他不是一个'),
    obs(122756, '他不是'), obs(122789, '他不是一个'),
    obs(122823, '一定是那种万人迷的男主'), obs(123073, '一定是那种万人迷的男主'), obs(123323, '一定是那种万人迷的男主'), obs(123573, '一定是那种万人迷的男主'), obs(123823, '一定是那种万人迷的男主'), obs(124073, '一定是那种万人迷的男主'), obs(124323, '一定是那种万人迷的男主'), obs(124573, '一定是那种万人迷的男主'),
  ], 121788, 124741, 250);
  assert.deepEqual(cues.map(c => c.text), ['他不是一个', '一定是那种万人迷的男主']);
  assert.equal(cues[0].start, 121788); assert.equal(cues[0].end, 122806);
  assert.equal(cues[1].start, 122806); assert(cues[0].needsReview);
});
test('dense boundary refinement must not outvote a longer stable reading', () => {
  const dense = Array.from({ length: 100 }, (_, i) => obs(600 + i, '他不是'));
  const cues = buildCues([obs(0, '他不是一个'), obs(250, '他不是一个'), obs(500, '他不是一个'), ...dense, obs(750, '他不是一个'), obs(1000, '他不是一个')], 0, 1250, 250);
  assert.equal(cues.length, 1); assert.equal(cues[0].text, '他不是一个'); assert(cues[0].needsReview);
});
test('a sustained prefix can be a real subtitle; persistent small wording changes stay separate', () => {
  const cues = buildCues([
    obs(0, '他不是'), obs(250, '他不是'), obs(500, '他不是一个'), obs(750, '他不是一个'),
    obs(1000, '一定是那种万人迷的男主'), obs(1250, '一定是那种万人迷的男主'),
    obs(1500, '一定是那种万人迷的女主'), obs(1750, '一定是那种万人迷的女主'),
  ], 0, 2000, 250);
  assert.deepEqual(cues.map(c => c.text), ['他不是', '他不是一个', '一定是那种万人迷的男主', '一定是那种万人迷的女主']);
});
test('short partial reads cannot connect two different complete subtitles through a shared prefix', () => {
  const cues = buildCues([obs(0, '他不是一个'), obs(250, '他不是一个'), obs(500, '他不是一个'), obs(540, '他不是'), obs(580, '他不是别人'), obs(830, '他不是别人')], 0, 1000, 250);
  assert.deepEqual(cues.map(c => c.text), ['他不是一个', '他不是别人']);
});
test('genuine unrelated short subtitles are preserved and flagged; blanks remain gaps', () => {
  const cues = buildCues([obs(0, ''), obs(40, '好'), obs(80, '好'), obs(120, ''), obs(160, '他不是一个'), obs(410, '他不是一个')], 0, 600, 250);
  assert.deepEqual(cues.map(c => c.text), ['好', '他不是一个']); assert(cues[0].needsReview);
  assert(cues[0].end < cues[1].start);
});
test('a brief substitution between matching stable readings is repaired without inventing text', () => {
  const cues = buildCues([obs(0, '他不是一个'), obs(250, '他不是一个'), obs(500, '他不是一个'), obs(540, '他不星一个', 0.8), obs(580, '他不是一个'), obs(830, '他不是一个')], 0, 1000, 250);
  assert.equal(cues.length, 1); assert.equal(cues[0].text, '他不是一个');
});
test('a 380 ms leading dash misread is repaired only between stronger matching readings', () => {
  // Midpoints reproduce the reported 44.700–45.240–45.620–45.960 boundaries.
  const samples = [obs(44700, '一分价钱一分货'), obs(45100, '一分价钱一分货'), obs(45380, '-分价钱一分货'), obs(45600, '-分价钱一分货'), obs(45640, '一分价钱一分货'), obs(45890, '一分价钱一分货')];
  const cues = buildCues(samples, 44700, 45960, 250);
  assert.deepEqual(cues.map(c => [c.start, c.end, c.text]), [[44700, 45960, '一分价钱一分货']]);
  assert(cues[0].needsReview);
  const changed = samples.map(o => ({ ...o, text: o.text === '-分价钱一分货' ? '一分价钱两分货' : o.text }));
  assert.equal(buildCues(changed, 44700, 45960, 250).length, 3);
  assert.equal(buildCues([obs(0, '一分价钱一分货'), obs(500, '-分价钱一分货'), obs(1000, '-分价钱一分货'), obs(1500, '一分价钱一分货')], 0, 2000, 250).length, 3);
  assert.equal(buildCues([obs(0, '一分价钱一分货'), obs(250, ''), obs(500, '-分价钱一分货'), obs(750, '一分价钱一分货')], 0, 1000, 250).length, 3);
});
test('overlapping whole-line and character detections produce one recognition crop', () => {
  const boxes = [{ x: 200, y: 930, width: 230, height: 60 }, { x: 400, y: 935, width: 50, height: 50 }];
  assert.deepEqual(mergeTextBoxes(boxes), [{ x: 200, y: 930, width: 250, height: 60 }]);
  assert.equal(boxes.length, 2);
});
test('nearby components on one line join while separate rows and distant labels stay separate', () => {
  const boxes = [{ x: 200, y: 930, width: 100, height: 60 }, { x: 310, y: 935, width: 100, height: 50 }, { x: 200, y: 1020, width: 200, height: 50 }, { x: 800, y: 930, width: 100, height: 60 }];
  const merged = mergeTextBoxes(boxes);
  assert.equal(merged.length, 3); assert(merged.some(b => b.x === 200 && b.width === 210));
});
test('dragging preserves crop size, clamps to the frame, and snaps each center axis independently', () => {
  const region = { x: 0.1, y: 0.8, width: 0.8, height: 0.15 };
  assert.deepEqual(moveRegion(region, -0.3, 0.3).region, { ...region, x: 0, y: 0.85 });
  const snapped = moveRegion(region, 0.004, -0.371, 0.008, 0.008);
  assert(Math.abs(snapped.region.x - 0.1) < 1e-10); assert.equal(snapped.region.y, 0.425);
  assert(snapped.snappedX && snapped.snappedY);
  const free = moveRegion(region, 0.02, -0.2, 0.008, 0.008);
  assert(!free.snappedX && !free.snappedY); assert.equal(free.region.width, region.width);
});
test('corner resizing keeps the opposite corner fixed and enforces minimum size and frame bounds', () => {
  const region = { x: 0.1, y: 0.8, width: 0.8, height: 0.15 };
  const northwest = resizeRegion(region, 'nw', 1, 1, 0.02, 0.01);
  assert(Math.abs(northwest.width - 0.02) < 1e-10); assert(Math.abs(northwest.height - 0.01) < 1e-10);
  assert(Math.abs(northwest.x + northwest.width - 0.9) < 1e-10);
  assert(Math.abs(northwest.y + northwest.height - 0.95) < 1e-10);
  const southeast = resizeRegion(region, 'se', 1, 1, 0.02, 0.01);
  assert.equal(southeast.x, region.x); assert.equal(southeast.y, region.y);
  assert.equal(southeast.x + southeast.width, 1); assert.equal(southeast.y + southeast.height, 1);
});
test('CTC drops blank/repetition, keeps characters repeated across a blank, and validates dictionary', () => {
  const labels = [0, 1, 1, 0, 1, 2], data = new Float32Array(labels.length * 3);
  labels.forEach((label, t) => { data[t * 3 + label] = 0.95; });
  assert.equal(decodeCTC(data, [1, labels.length, 3], ['', '哈', '！']).text, '哈哈！');
  assert.throws(() => decodeCTC(data, [1, labels.length, 3], ['', '哈']), /字典与模型不匹配/);
});
test('center resizing preserves the anchor while constraining both edges to the frame', () => {
  const region = { x: 0.2, y: 0.8, width: 0.6, height: 0.1 };
  for (const [dx, dy] of [[0.1, 0], [0, 0.05], [-0.1, -0.03], [1, 1], [-1, -1]]) {
    const resized = resizeRegionFromCenter(region, dx, dy, 0.02, 0.01);
    assert(Math.abs(resized.x + resized.width / 2 - 0.5) < 1e-10);
    assert(Math.abs(resized.y + resized.height / 2 - 0.85) < 1e-10);
    assert(resized.x >= 0 && resized.y >= 0 && resized.x + resized.width <= 1 && resized.y + resized.height <= 1);
    assert(resized.width >= 0.02 && resized.height >= 0.01);
  }
});
test('center gestures accept Ctrl, remapped Command, and macOS Ctrl secondary events', () => {
  assert.equal(cropPointerMode({ button: 0, ctrlKey: true, metaKey: false }, false), 'center');
  assert.equal(cropPointerMode({ button: 0, ctrlKey: false, metaKey: true }, false, 'ne'), 'center');
  assert.equal(cropPointerMode({ button: 2, ctrlKey: true, metaKey: false }, false), 'center');
  assert.equal(cropPointerMode({ button: 2, ctrlKey: false, metaKey: false }, false), undefined);
  assert.equal(cropPointerMode({ button: 1, ctrlKey: true, metaKey: false }, false), undefined);
  assert.equal(cropPointerMode({ button: 0, ctrlKey: false, metaKey: false }, false), 'move');
  assert.equal(cropPointerMode({ button: 0, ctrlKey: false, metaKey: false }, false, 'ne'), 'resize');
});
test('visual spacing requires a wide outlined gap, rather than a CTC blank or ordinary glyph spacing', () => {
  const width = 80, height = 32, pixels = new Uint8ClampedArray(width * height * 4);
  for (const [left, right] of [[4, 16], [21, 33], [53, 65]]) for (let y = 5; y < 27; y++) for (let x = left; x < right; x++) {
    const index = (y * width + x) * 4;
    pixels[index] = pixels[index + 1] = pixels[index + 2] = 255; pixels[index + 3] = 255;
  }
  const tokens = [{ text: '你', start: 2, end: 3 }, { text: '好', start: 6, end: 7 }, { text: '呀', start: 14, end: 15 }];
  assert.equal(restoreVisualSpaces('你好呀', tokens, pixels, width, height, 20, width), '你好 呀');
  const ordinary = [{ text: '你', start: 2, end: 3 }, { text: '好', start: 8, end: 9 }, { text: '呀', start: 15, end: 16 }];
  assert.equal(restoreVisualSpaces('你好呀', ordinary, pixels, width, height, 20, width), '你好呀', 'Thin strokes can leave wide blank columns without representing a space');
  assert.equal(restoreVisualSpaces('你好 呀', tokens, pixels, width, height, 20, width), '你好 呀');
  assert.equal(restoreVisualSpaces('你好呀', tokens, new Uint8ClampedArray(pixels.length), width, height, 20, width), '你好呀');
  const labels = [1, 0, 2, 0, 3], data = new Float32Array(labels.length * 4);
  labels.forEach((label, step) => { data[step * 4 + label] = 1; });
  assert.equal(decodeCTC(data, [1, 5, 4], ['', '你', '好', '呀']).text, '你好呀');
  const cues = buildCues([obs(0, '你好 呀'), obs(250, '你好 呀')], 0, 500, 250);
  assert.match(exportSubtitles(cues, 'srt'), /你好 呀/);
  assert.match(exportSubtitles(cues, 'vtt'), /你好 呀/);
});
test('好 算了算了 走吧 restores both gaps despite quantized alignment and a partially recognized space', () => {
  // Alignment from a 25 fps subtitle frame: the first advance is 8 steps,
  // while 1.35 times the normal 6-step advance is 8.1 steps.
  const width = 448, height = 48, steps = 56;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const tokens = [...'好算了算了走吧'].map((text, i) => ({ text, start: [5, 13, 19, 26, 32, 41, 47][i], end: [6, 14, 20, 27, 33, 42, 48][i] }));
  for (const token of tokens) {
    const center = (token.start + token.end) / 2 / steps * width;
    for (let y = 4; y < 44; y++) for (let x = center - 18; x < center + 18; x++) {
      const offset = (y * width + x) * 4;
      pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = pixels[offset + 3] = 255;
    }
  }
  const restore = (input: typeof tokens, image = pixels) => restoreVisualSpaces(input.map(t => t.text).join(''), input, image, width, height, steps, width);
  assert.equal(restore(tokens), '好 算了算了 走吧');
  const partial = [...tokens.slice(0, 5), { text: ' ', start: 37, end: 38 }, ...tokens.slice(5)];
  assert.equal(restore(partial), '好 算了算了 走吧', 'A recognized space must not prevent recovering a different missing space');
  const complete = [tokens[0], { text: ' ', start: 9, end: 10 }, ...partial.slice(1)];
  assert.equal(restore(complete), '好 算了算了 走吧', 'Do not duplicate existing spaces');
  const doubled = [...tokens.slice(0, 5), { text: ' ', start: 36, end: 37 }, { text: ' ', start: 38, end: 39 }, ...tokens.slice(5)];
  assert.equal(restore(doubled), '好 算了算了  走吧', 'Keep literal spaces from the model');
  assert.equal(restore(tokens, new Uint8ClampedArray(pixels.length)), '好算了算了走吧', 'CTC tolerance alone must never create a space');
  assert.equal(restore([{ ...tokens[0], text: 'A' }, ...tokens.slice(1)]), 'A算了算了走吧', 'Keep mixed language text outside Chinese gap inference');
  const text = restore(tokens), observation = obs(22600, text);
  observation.lines = [{ text, confidence: observation.confidence, box: { x: 0, y: 0, width: 1, height: 1 }, spacingInferred: true }];
  const cues = buildCues([observation], 22500, 24100, 250);
  assert(cues[0].needsReview);
  assert.match(exportSubtitles(cues, 'srt'), /好 算了算了 走吧/);
  assert.match(exportSubtitles(cues, 'vtt'), /好 算了算了 走吧/);
});
test('a background stroke at a Chinese subtitle edge is removed; real thin glyphs and other text styles survive', () => {
  const width = 224, height = 32, steps = 112;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const tokens = [...'这本台词都要好一些一'].map((text, i) => ({ text, start: 4 + i * 10, end: 8 + i * 10 }));
  const paint = (index: number, thin: boolean, color: number) => {
    for (let y = thin ? 16 : 5; y < (thin ? 18 : 27); y++) for (let x = 5 + index * 20; x < 19 + index * 20; x++) {
      const offset = (y * width + x) * 4;
      pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = color; pixels[offset + 3] = 255;
    }
  };
  for (let i = 0; i < 9; i++) paint(i, tokens[i].text === '一', 255);
  paint(9, true, 100); // Dark clothing stripe: no matching bright subtitle ink.
  const filtered = filterUnsupportedEdgeTokens(tokens, pixels, width, height, steps, width);
  assert.equal(filtered.map(t => t.text).join(''), '这本台词都要好一些');
  assert(filtered.some(t => t.text === '一'), 'The real thin stroke within 一些 must stay');
  paint(9, true, 255);
  assert.deepEqual(filterUnsupportedEdgeTokens(tokens, pixels, width, height, steps, width), tokens, 'A genuine additional 一 must stay');
  assert.deepEqual(filterUnsupportedEdgeTokens(tokens, new Uint8ClampedArray(pixels.length), width, height, steps, width), tokens, 'No evidence of white outlined text: leave the model result intact');
});
test('corrected 520 ms edge hallucination joins its 560 ms neighbor and keeps review status from weaker samples', () => {
  const box = { x: 0.2, y: 0.8, width: 0.6, height: 0.1 }, text = '这本台词都要好一些';
  const samples = [obs(29100, text, 0.98), obs(29500, text, 0.98), obs(29740, text, 1), obs(29990, text, 1)];
  samples[0].lines = [{ text, confidence: 0.98, box, edgeFiltered: true }];
  const cues = buildCues(samples, 29100, 30180, 250);
  assert.deepEqual(cues.map(c => [c.start, c.end, c.text]), [[29100, 30180, text]]);
  assert.equal(cues[0].sampleTime, 29740, 'The best sample is uncorrected, but the cue must still need review');
  assert(cues[0].needsReview);
  const changed = [obs(29100, text), obs(29350, text), obs(29620, text + '一'), obs(29870, text + '一')];
  assert.equal(buildCues(changed, 29100, 30180, 250).length, 2, 'A visually supported real wording change stays separate');
});
test('SRT / VTT preserve multiline text, correct separators, and literal VTT characters', () => {
  assert.equal(exportSubtitles([cue], 'srt'), '1\n00:00:01,230 --> 00:00:03,560\n你 <我> & 他\n第二行\n');
  assert.equal(exportSubtitles([cue], 'vtt'), 'WEBVTT\n\n1\n00:00:01.230 --> 00:00:03.560\n你 &lt;我&gt; &amp; 他\n第二行\n');
  assert.match(validateCues([cue, { ...cue, id: '2', start: 3500, end: 5000 }]) || '', /重叠/);
  assert.throws(() => exportSubtitles([{ ...cue, end: 0 }], 'srt'));
});
test('time parsing handles hours and fractions and rejects out-of-range values', () => {
  assert.equal(parseTime('01:02:03.4'), 3723400); assert.equal(parseTime('02:03,045'), 123045);
  assert.equal(parseTime('600'), 600000); assert.equal(parseTime('12:65'), null); assert.equal(parseTime('-1'), null);
  assert.equal(formatTime(3723400, ','), '01:02:03,400');
});
test('JSON roundtrip rejects incompatible schemas, missing metadata, and invalid regions', () => {
  const project = { schemaVersion: 1, timeUnit: 'ms', source: { name: 'video.mp4', duration: 10000, width: 1280, height: 720 }, extraction: { region: { x: 0, y: 0.8, width: 1, height: 0.2 }, start: 0, end: 10000, sampleInterval: 250, backend: 'webgpu', model: 'PP-OCRv4', complete: true }, cues: [cue] };
  assert.equal(importProject(JSON.parse(JSON.stringify(project))).cues[0].text, cue.text);
  const filtered = { ...project, extraction: { ...project.extraction, colorFilter: { color: '#FFFFFF', tolerance: 60, outline: false } } };
  assert.equal(importProject(filtered).extraction.colorFilter?.color, '#ffffff');
  assert.equal(importProject({ ...project, extraction: { ...project.extraction, ignoreClippedText: true } }).extraction.ignoreClippedText, true);
  assert.throws(() => importProject({ ...project, extraction: { ...project.extraction, ignoreClippedText: 'true' } }));
  assert.throws(() => importProject({ ...project, extraction: { ...project.extraction, colorFilter: { color: '#fff' } } }));
  assert.throws(() => importProject({ ...project, timeUnit: 's' }));
  assert.throws(() => importProject({ ...project, extraction: { ...project.extraction, region: { x: 0.8, y: 0, width: 1, height: 1 } } }));
});
