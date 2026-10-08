import test from 'node:test';
import assert from 'node:assert/strict';
import { detectTextBoxes } from './text-detection';

function map(rects: [number, number, number, number][], width = 160, height = 64) {
  const pixels = new Float32Array(width * height);
  for (const [x, y, w, h] of rects) for (let row = y; row < y + h; row++) pixels.fill(.9, row * width + x, row * width + x + w);
  return (filter: boolean) => detectTextBoxes(pixels, width, height, width, height, filter);
}

test('filter is opt-in and rejects contours clipped by either vertical edge', () => {
  const detect = map([[10, 0, 35, 12], [85, 52, 35, 12]]);
  assert.equal(detect(false).boxes.length, 2);
  assert.deepEqual(detect(true), { boxes: [], ignoredTextBoxes: 2 });
});

test('expanded padding touching an edge does not reject an intact line', () => {
  const detect = map([[10, 5, 110, 12]]);
  assert.equal(detect(false).boxes[0].y, 0);
  assert.deepEqual(detect(true), detect(false));
});

test('clipped fragments are removed with their merged line, while another row stays', () => {
  const detect = map([[10, 0, 25, 10], [39, 3, 25, 7], [15, 33, 100, 12]]);
  const result = detect(true);
  assert.equal(result.ignoredTextBoxes, 1);
  assert.equal(result.boxes.length, 1);
  assert.ok(result.boxes[0].y > .2);
});

test('complete bilingual rows and horizontal-edge text stay eligible', () => {
  const detect = map([[0, 10, 40, 12], [50, 36, 65, 12]]);
  assert.equal(detect(true).boxes.length, 2);
  assert.deepEqual(detect(true), detect(false));
});

test('empty maps and subthreshold edge noise do not count as filtered text', () => {
  assert.deepEqual(map([])(true), { boxes: [], ignoredTextBoxes: 0 });
  assert.deepEqual(map([[3, 0, 2, 1]])(true), { boxes: [], ignoredTextBoxes: 0 });
});

test('original pale strokes catch an interior fragment of a glyph clipped at either edge', () => {
  const width = 160, height = 64, probabilities = new Float32Array(width * height), pixels = new Uint8ClampedArray(width * height * 4);
  // The detector sees only detached interior pieces of the two cut letters.
  for (const [x, y] of [[15, 8], [90, 52]]) {
    for (let row = y; row < y + 4; row++) probabilities.fill(.9, row * width + x, row * width + x + 12);
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const light = (x >= 15 && x < 27 && y < 12) || (x >= 90 && x < 102 && y >= 52);
    pixels.fill(light ? 255 : 20, (y * width + x) * 4, (y * width + x) * 4 + 3); pixels[(y * width + x) * 4 + 3] = 255;
  }
  assert.equal(detectTextBoxes(probabilities, width, height, width, height, true).boxes.length, 2);
  assert.deepEqual(detectTextBoxes(probabilities, width, height, width, height, true, pixels), { boxes: [], ignoredTextBoxes: 2 });
});

test('bright background connections do not filter text in the middle of the crop', () => {
  const width = 160, height = 64, pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  const probabilities = new Float32Array(width * height);
  for (let y = 25; y < 40; y++) probabilities.fill(.9, y * width + 20, y * width + 100);
  const result = detectTextBoxes(probabilities, width, height, width, height, true, pixels);
  assert.equal(result.boxes.length, 1); assert.equal(result.ignoredTextBoxes, 0);
});
