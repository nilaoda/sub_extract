import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CompatibleBatchRunner, groupOcrJobs, OcrCropQueue, OCR_WINDOW_BYTES } from './ocr-batch';

test('batch by identical dimensions, retaining identity and an odd tail', () => {
  const jobs = [320, 640, 320, 320, 640].map((width, index) => ({ width, height: 48, index }));
  const batches = groupOcrJobs(jobs);
  assert.deepEqual(batches.map(batch => batch.map(job => job.index)), [[0, 2], [3], [1, 4]]);
  assert.ok(batches.every(batch => batch.length <= 2 && batch.every(job => job.width === batch[0].width)));
});

test('disabled batching never submits pairs', async () => {
  const calls: number[][] = [];
  const runner = new CompatibleBatchRunner(false);
  assert.deepEqual(await runner.run([4, 2], async jobs => { calls.push([...jobs]); return jobs.map(n => n * 2); }), [8, 4]);
  assert.deepEqual(calls, [[4], [2]]);
});

test('dynamic model incompatibility retries singles and disables further pairs', async () => {
  const calls: number[][] = [];
  const runner = new CompatibleBatchRunner(true);
  const infer = async (jobs: readonly number[]) => { calls.push([...jobs]); if (jobs.length > 1) throw Error('batch unsupported'); return jobs.map(n => n * 2); };
  assert.deepEqual(await runner.run([4, 2], infer), [8, 4]);
  assert.deepEqual(await runner.run([1, 3], infer), [2, 6]);
  assert.deepEqual(calls, [[4, 2], [4], [2], [1], [3]]);
  assert.equal(runner.fallback, true);
});

test('a genuine inference failure is propagated instead of claiming successful fallback', async () => {
  const runner = new CompatibleBatchRunner(true);
  await assert.rejects(runner.run([1, 2], async () => { throw Error('device lost'); }), /device lost/);
  assert.equal(runner.fallback, false);
});

function crop(width = 20, height = 10) { return { width, height, closed: 0, close() { this.closed++; } }; }
test('crop queue flushes full and tail windows preserving timestamp association', async () => {
  const batches: number[][] = [];
  const queue = new OcrCropQueue(2, new AbortController().signal, async items => { batches.push(items.map(item => item.time)); items.forEach(item => item.bitmap.close()); });
  const crops = [crop(), crop(), crop()];
  for (let i = 0; i < crops.length; i++) await queue.add(crops[i], [103, 267, 349][i]);
  await queue.flush(); queue.dispose();
  assert.deepEqual(batches, [[103, 267], [349]]);
  assert.ok(crops.every(bitmap => bitmap.closed === 1));
});

test('cancel releases buffered crops without submitting a partial window', async () => {
  const controller = new AbortController(); let submitted = 0;
  const queue = new OcrCropQueue(8, controller.signal, async () => { submitted++; });
  const bitmap = crop(); await queue.add(bitmap, 100); controller.abort();
  await assert.rejects(queue.flush(), { name: 'AbortError' });
  queue.dispose(); assert.equal(bitmap.closed, 1); assert.equal(submitted, 0);
  const next = crop(); await assert.rejects(queue.add(next, 200), { name: 'AbortError' }); assert.equal(next.closed, 1);
});

test('queue bounds crop bytes independently of its frame count', async () => {
  const batches: number[][] = [];
  const queue = new OcrCropQueue(8, new AbortController().signal, async items => { batches.push(items.map(item => item.time)); items.forEach(item => item.bitmap.close()); });
  const width = OCR_WINDOW_BYTES / 4 / 2 + 1;
  await queue.add(crop(width, 1), 1); await queue.add(crop(width, 1), 2); await queue.flush();
  assert.deepEqual(batches, [[1], [2]]);
});

test('a crop exceeding the byte budget is processed alone immediately', async () => {
  const batches: number[][] = [];
  const queue = new OcrCropQueue(8, new AbortController().signal, async items => { batches.push(items.map(item => item.time)); items.forEach(item => item.bitmap.close()); });
  const large = crop(OCR_WINDOW_BYTES / 4 + 1, 1), small = crop();
  await queue.add(small, 1); await queue.add(large, 2);
  assert.deepEqual(batches, [[1], [2]]);
  assert.equal(large.closed, 1); queue.dispose();
});

test('failed flush leaves no stale pending crops and releases the incoming crop', async () => {
  const first = crop(OCR_WINDOW_BYTES / 8 + 1, 1), second = crop(first.width, 1);
  const queue = new OcrCropQueue(8, new AbortController().signal, async items => { items.forEach(item => item.bitmap.close()); throw Error('inference failed'); });
  await queue.add(first, 1);
  await assert.rejects(queue.add(second, 2), /inference failed/);
  queue.dispose(); assert.equal(first.closed, 1); assert.equal(second.closed, 1);
});
