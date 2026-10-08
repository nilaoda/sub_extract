import test from 'node:test';
import assert from 'node:assert/strict';
import { ColorEmptyGate, colorMask, DEFAULT_COLOR_FILTER, parseColorFilter } from './color-filter';

test('colour matching includes tolerance boundaries and retains a single weak pixel', () => {
  const pixels = new Uint8ClampedArray([195, 255, 195, 255, 194, 255, 255, 255, 255, 255, 255, 0]);
  const result = colorMask(pixels, 3, 1, DEFAULT_COLOR_FILTER);
  assert.deepEqual([...result.mask], [1, 0, 0]); assert.equal(result.count, 1);
  assert.equal(colorMask(new Uint8ClampedArray([32, 64, 128, 255]), 1, 1, { color: '#204080', tolerance: 0, outline: false }).count, 1);
});

test('outline filter removes a uniform background and never wraps across rows', () => {
  const pixels = new Uint8ClampedArray(5 * 2 * 4).fill(255);
  pixels.set([0, 0, 0, 255], 5 * 4);
  const result = colorMask(pixels, 5, 2, { ...DEFAULT_COLOR_FILTER, outline: true });
  assert.equal(result.mask[0], 1); assert.equal(result.mask[4], 0); assert.equal(result.mask[5], 0);
  assert.equal(colorMask(new Uint8ClampedArray(5 * 2 * 4).fill(255), 5, 2, { ...DEFAULT_COLOR_FILTER, outline: true }).count, 0);
});

test('skip requires a real blank confirmation and expires after one second', () => {
  const gate = new ColorEmptyGate();
  assert.equal(gate.canSkip(0, 250), false);
  gate.observe(0, 250, '');
  assert.equal(gate.canSkip(0, 250), false);
  assert.equal(gate.canSkip(0, 500), true);
  assert.equal(gate.canSkip(1, 500), false);
  assert.equal(gate.canSkip(0, 1250), false);
  gate.observe(0, 1250, '');
  assert.equal(gate.canSkip(0, 1500), true);
  gate.observe(1, 1500, '好');
  assert.equal(gate.canSkip(0, 1750), false);
});

test('a subtitle without matching pixels permanently disables this scan gate', () => {
  const gate = new ColorEmptyGate();
  gate.observe(0, 0, '好'); assert.equal(gate.disabled, true);
  gate.observe(0, 250, ''); assert.equal(gate.canSkip(0, 500), false);
  assert.equal(new ColorEmptyGate().disabled, false);
});

test('saved settings validate colour, integer tolerance and outline mode', () => {
  assert.deepEqual(parseColorFilter({ color: '#AaBBcc', tolerance: 128, outline: true }), { color: '#aabbcc', tolerance: 128, outline: true });
  for (const value of [null, {}, { ...DEFAULT_COLOR_FILTER, color: '#fff' }, { ...DEFAULT_COLOR_FILTER, tolerance: -1 }, { ...DEFAULT_COLOR_FILTER, tolerance: 129 }, { ...DEFAULT_COLOR_FILTER, tolerance: 0.5 }, { ...DEFAULT_COLOR_FILTER, outline: 'true' }]) assert.equal(parseColorFilter(value), undefined);
});
