import test from 'node:test';
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { BatchJobError, BatchRunner, batchRange, copySettings, droppedSources, naturalOrder, sourceKey, type BatchItem, type BatchSettings } from './batch';
import { availableName, exportStem, BatchDirectoryWriter, subtitleZip, type OutputDirectory } from './batch-export';
import { DEFAULT_REGION, type Project } from './core';
const settings: BatchSettings = { region: { ...DEFAULT_REGION }, interval: 250, confidence: .75, batch: true, deduplicate: true, refine: true, ignoreClippedText: false, startOffset: 0, endTrim: 0 };
const file = (name: string, contents = 'video') => new File([contents], name, { lastModified: 42 }) as unknown as globalThis.File;
const item = (name: string): BatchItem => ({ file: file(name), path: name, id: name, key: name, status: 'waiting', progress: 0, detail: '', selected: true, outputNames: new Map() });
const project = (complete = true): Project => ({ schemaVersion: 1, timeUnit: 'ms', source: { name: 'episode.mp4', duration: 1000, width: 100, height: 100 }, extraction: { start: 0, end: 1000, sampleInterval: 250, region: DEFAULT_REGION, backend: 'wasm', model: 'test', complete }, cues: [{ id: '1', start: 0, end: 500, text: '测试', lines: ['测试'], confidence: .96, needsReview: false, sampleTime: 0 }] });

test('natural ordering, small sampled fingerprints, and independent settings', async () => {
  assert.deepEqual(['第10集.mp4', '第2集.mp4', '第1集.mp4'].sort(naturalOrder.compare), ['第1集.mp4', '第2集.mp4', '第10集.mp4']);
  assert.equal(await sourceKey(file('1.mp4')), await sourceKey(file('1.mp4')));
  assert.notEqual(await sourceKey(file('1.mp4', 'abcde')), await sourceKey(file('1.mp4', 'vwxyz')));
  const copy = copySettings(settings); copy.region.y = 0; assert.notEqual(copy.region.y, settings.region.y);
  assert.deepEqual(batchRange(1000, { startOffset: 100, endTrim: 200 }), { start: 100, end: 800 });
  for (const [startOffset, endTrim] of [[800, 200], [-1, 0], [0, NaN]]) assert.throws(() => batchRange(1000, { startOffset, endTrim }));
});
test('mixed folder drops drain all reader batches and preserve relative paths', async () => {
  const video = (name: string) => ({ name, isFile: true, isDirectory: false, file: (resolve: (file: globalThis.File) => void) => resolve(file(name)) });
  const batches = [[video('2.mp4'), video('notes.txt')], [video('10.mov')], []];
  const directory = { name: 'Season', isDirectory: true, isFile: false, createReader: () => ({ readEntries: (resolve: (entries: unknown[]) => void) => resolve(batches.shift() || []) }) };
  const data = { items: [...[directory, video('1.m4v')].map(entry => ({ kind: 'file', webkitGetAsEntry: () => entry })), { kind: 'file', webkitGetAsEntry: () => null, getAsFile: () => file('3.mp4') }], files: [] } as unknown as DataTransfer;
  const result = await droppedSources(data);
  assert.equal(result.errors, 0); assert.deepEqual(result.sources.map(s => s.path), ['Season/2.mp4', 'Season/10.mov', '1.m4v', '3.mp4']);
  assert.equal((await droppedSources({ items: [], files: [file('single.mp4')] } as unknown as DataTransfer)).sources[0].path, 'single.mp4');
});
test('episodes execute serially, failures continue, save failures retain successful results', async () => {
  const runner = new BatchRunner(), queue = [item('1'), item('2'), item('3')], order: string[] = []; let active = 0;
  queue[1].settings = { ...settings, confidence: .8 };
  await runner.run(queue, settings, async (entry, config) => {
    assert.equal(active++, 0); order.push(entry.id); await Promise.resolve(); active--;
    if (entry.id === '2') { assert.equal(config.confidence, .8); throw new Error('bad video'); }
    return project();
  }, async entry => { if (entry.id === '1') throw new Error('disk full'); }, () => {});
  assert.deepEqual(order, ['1', '2', '3']); assert.deepEqual(queue.map(i => i.status), ['completed', 'failed', 'completed']);
  assert.equal(queue[0].outputError, 'disk full'); assert(queue[0].result); assert.equal(runner.running, false);
});
test('pause finishes current episode; stopping keeps partial results and waiting episodes', async () => {
  const runner = new BatchRunner(), queue = [item('1'), item('2')];
  await runner.run(queue, settings, async () => { runner.pause(); return project(); }, async () => {}, () => {});
  assert.deepEqual(queue.map(i => i.status), ['completed', 'waiting']);
  await runner.run(queue, settings, async (_entry, _config, signal) => { runner.stop(); assert(signal.aborted); throw new BatchJobError('stopped', project(false)); }, async () => {}, () => {});
  assert.equal(queue[1].status, 'partial'); assert.equal(queue[1].result?.cues.length, 1);
  queue[1].status = 'waiting'; await runner.run(queue, settings, async () => project(), async () => {}, () => {});
  assert.equal(queue[1].status, 'completed');
});
test('directory exports reserve case-insensitive names and overwrite only their own saved files', async () => {
  const names = new Set(['EP.srt']); // availableName expects normalized names.
  assert.equal(availableName('ep', 'srt', new Set([...names].map(n => n.toLowerCase()))), 'ep (2).srt');
  const written = new Map<string, string>();
  const directory: OutputDirectory = { name: 'subtitles', async *values() { yield { name: 'ep.srt' }; }, async getFileHandle(name) { return { async createWritable() { return { async write(text) { written.set(name, text); }, async close() {}, async abort() {} }; } }; } };
  const writer = new BatchDirectoryWriter(directory); await writer.prepare();
  const first = item('ep.mp4'), second = item('ep.mov'); first.result = project(); second.result = project(false);
  await writer.save(first, ['srt']); await writer.save(first, ['srt']); await writer.save(second, ['srt']);
  assert.deepEqual([...written.keys()], ['ep (2).srt', 'ep (未完成).srt']); assert.match(written.get('ep (2).srt')!, /测试/);
});
test('ZIP preserves UTF-8 subtitles, CRC, and central directory offsets', async () => {
  const bytes = new Uint8Array(await subtitleZip([{ name: '第1集.srt', text: '123456789' }, { name: 'empty.vtt', text: '' }]).arrayBuffer());
  const view = new DataView(bytes.buffer); assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint16(6, true), 0x800); assert.equal(view.getUint32(14, true), 0xcbf43926);
  const nameSize = view.getUint16(26, true); assert.equal(new TextDecoder().decode(bytes.slice(30, 30 + nameSize)), '第1集.srt');
  const end = bytes.length - 22; assert.equal(view.getUint32(end, true), 0x06054b50); assert.equal(view.getUint16(end + 10, true), 2);
  const central = view.getUint32(end + 16, true); assert.equal(view.getUint32(central, true), 0x02014b50); assert.equal(view.getUint32(central + 42, true), 0);
});

test('long Unicode filenames leave room for partial and collision suffixes', () => {
  const stem = exportStem('中文😀'.repeat(80) + '.mp4');
  assert(new TextEncoder().encode(stem).length <= 180);
  assert(!stem.includes('\ufffd'));
  const name = availableName(stem + ' (未完成)', 'json', new Set([(stem + ' (未完成).json').toLowerCase()]));
  assert(new TextEncoder().encode(name).length < 255);
  assert.equal(exportStem('Title. .mp4'), 'Title');
  assert.equal(exportStem('....mp4'), 'episode');
});
