import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Regression fixture: original interview, using its absolute video timestamps.
if (!process.argv[2]) throw new Error('用法：npm run test:interview -- /path/to/interview-fixture.mp4');
const video = resolve(process.argv[2]);
const models = resolve(process.env.TEST_MODELS || '.local-test/models');
const output = resolve('.local-test');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADED !== '1' });
const context = await browser.newContext({ offline: true, acceptDownloads: true });
const page = await context.newPage();
const errors = [], requests = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
async function ready(selector) {
  await page.waitForFunction(id => document.querySelector(id)?.disabled === false, selector, { timeout: 120000 });
}
async function download(format) {
  const pending = page.waitForEvent('download');
  await page.locator(`[data-export="${format}"]`).click();
  const path = resolve(output, `interview-window.${format}`);
  await (await pending).saveAs(path);
  return path;
}
try {
  await page.goto(pathToFileURL(resolve('dist/sub-extract.html')).href);
  await page.locator('#video-file').setInputFiles(video);
  await page.waitForFunction(() => document.querySelector('video')?.duration > 1);
  await page.locator('#backend').selectOption('webgpu');
  await page.locator('#local-models').evaluate(element => { element.open = true; });
  await page.locator('#detector-file').setInputFiles(resolve(models, 'det.onnx'));
  await page.locator('#recognizer-file').setInputFiles(resolve(models, 'rec.onnx'));
  await page.locator('#dictionary-file').setInputFiles(resolve(models, 'dict.txt'));
  await page.locator('#load-local').click();
  await ready('#load-local');
  assert(await page.locator('#extract').isEnabled(), await page.locator('#model-status').textContent());
  await page.locator('#range-start').fill('00:01:58.000');
  await page.locator('#range-end').fill('00:02:06.000');
  const start = Date.now();
  await page.locator('#extract').click();
  await ready('#extract');
  const scanMs = Date.now() - start;
  const data = JSON.parse(await readFile(await download('json'), 'utf8'));
  assert(data.extraction.complete, await page.locator('#run-status').textContent());
  assert(data.cues.every(cue => cue.start >= 118000 && cue.end > cue.start && cue.end <= 126000));
  const phrase = data.cues.filter(cue => cue.text.includes('他不是'));
  assert.equal(phrase.length, 1, 'Transient missing characters must not split the subtitle');
  assert.equal(phrase[0].text, '他不是一个');
  assert(Math.abs(phrase[0].start - 121788) < 100, 'Start boundary must stay near the actual subtitle change');
  assert(Math.abs(phrase[0].end - 122789) < 100, 'End boundary must stay near the actual subtitle change');
  assert(data.cues.some(cue => cue.text === '一定是那种万人迷的男主'));
  await download('srt');
  await download('vtt');
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  const report = { video, range: [118000, 126000], scanMs, cues: data.cues.map(({ start, end, text, needsReview }) => ({ start, end, text, needsReview })) };
  await writeFile(resolve(output, 'interview-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
