import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sample = resolve(process.env.TEST_VIDEO || '.local-test/sample-603-645.mp4');
const models = resolve(process.env.TEST_MODELS || '.local-test/models');
const output = resolve('.local-test'); await mkdir(output, { recursive: true });
const url = process.env.TEST_URL || pathToFileURL(resolve('dist/sub-extract.html')).href;
const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADED !== '1' });
const context = await browser.newContext({ offline: !process.env.TEST_URL, viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
const pageErrors = [], networkRequests = [];
page.on('pageerror', e => pageErrors.push(e.message));
page.on('request', request => { if (/^https?:/.test(request.url())) networkRequests.push(request.url()); });
page.on('dialog', dialog => dialog.accept());
const report = { url, video: sample, checks: [] };
async function ready(selector, timeout = 120000) { await page.waitForFunction(id => document.querySelector(id)?.disabled === false, selector, { timeout }); }
async function download(format, filename) {
  const downloaded = page.waitForEvent('download'); await page.locator(`[data-export="${format}"]`).click();
  await (await downloaded).saveAs(resolve(output, filename));
  return readFile(resolve(output, filename), 'utf8');
}
try {
  await page.goto(url, { waitUntil: 'load' });
  assert(await page.locator('#extract').isDisabled());
  await page.locator('#video-file').setInputFiles(sample);
  await page.waitForFunction(() => document.querySelector('video')?.duration > 1);
  report.duration = await page.locator('video').evaluate(v => v.duration);
  await page.locator('#backend').selectOption(process.env.TEST_BACKEND || 'webgpu');
  await page.locator('#local-models').evaluate(el => { el.open = true; });
  await page.locator('#detector-file').setInputFiles(resolve(models, 'det.onnx'));
  await page.locator('#recognizer-file').setInputFiles(resolve(models, 'rec.onnx'));
  await page.locator('#dictionary-file').setInputFiles(resolve(models, 'dict.txt'));
  await page.locator('#load-local').click(); await ready('#load-local');
  report.model = await page.locator('#model-status').textContent();
  assert(await page.locator('#test-frame').isEnabled(), report.model);
  report.backend = await page.locator('#backend-badge').textContent();
  await page.locator('video').evaluate(async v => { v.currentTime = 3; await new Promise(r => v.addEventListener('seeked', r, { once: true })); });
  await page.locator('#test-frame').click(); await ready('#test-frame');
  report.frame = await page.locator('#frame-text').textContent(); assert.match(report.frame, /律令直解/);
  report.checks.push('offline file:// + local models + real OCR');

  const start = Date.now();
  await page.locator('#extract').click();
  await page.waitForFunction(() => !document.querySelector('#cancel').hidden, null, { timeout: 10000 });
  assert.equal(await page.locator('#crop-box').getAttribute('aria-disabled'), 'true');
  assert(await page.locator('.crop-handle').first().isDisabled());
  let previous = '';
  const progress = setInterval(async () => { try { const text = await page.locator('#run-status').textContent(); if (text !== previous) { console.log(text); previous = text; } } catch {} }, 5000);
  try { await ready('#extract', 300000); } finally { clearInterval(progress); }
  report.scanMs = Date.now() - start;
  report.status = await page.locator('#run-status').textContent(); report.detail = await page.locator('#run-detail').textContent();
  assert.match(report.status, /提取完成/);
  const json = await download('json', 'extracted.json'), project = JSON.parse(json);
  assert(project.extraction.complete); assert(project.cues.length >= 10);
  assert(project.cues.some(c => c.text.includes('律令直解')));
  assert(project.cues.every(c => c.start >= 0 && c.end > c.start && c.end <= project.source.duration));
  report.cueCount = project.cues.length; report.cues = project.cues.map(c => ({ start: c.start, end: c.end, text: c.text, confidence: c.confidence, needsReview: c.needsReview }));
  const srt = await download('srt', 'extracted.srt'), vtt = await download('vtt', 'extracted.vtt');
  assert.match(srt, /\d\d:\d\d:\d\d,\d{3} --> /); assert(vtt.startsWith('WEBVTT\n\n'));
  assert.equal((srt.match(/ --> /g) || []).length, project.cues.length); assert.equal((vtt.match(/ --> /g) || []).length, project.cues.length);
  report.checks.push('full clip decoding + refinement + SRT / VTT / JSON exports');

  // Text is user data and must stay literal, even when it looks like HTML.
  const first = page.locator('.cue-text').first(); await first.fill('<img src=x onerror=alert(1)> 测试\n第二行'); await first.blur();
  const edited = JSON.parse(await download('json', 'edited.json'));
  assert(edited.cues[0].text.startsWith('<img')); assert.equal(await page.locator('.cue img').count(), 0);
  await page.locator('#import-json').setInputFiles(resolve(output, 'extracted.json'));
  await page.waitForFunction(text => document.querySelector('.cue-text')?.value === text, project.cues[0].text);
  assert.equal(await page.locator('.cue-text').first().inputValue(), project.cues[0].text);
  report.checks.push('edit and JSON roundtrip; literal text rendering');

  // Check crop selection against the actual scaled preview, then restore the preset.
  await page.locator('#select-region').click(); const bounds = await page.locator('#video-stage').boundingBox();
  await page.mouse.move(bounds.x + bounds.width * 0.2, bounds.y + bounds.height * 0.8); await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.8, bounds.y + bounds.height * 0.95, { steps: 4 }); await page.mouse.up();
  assert.match(await page.locator('#region-info').textContent(), /768 × 108/); await page.locator('#reset-region').click();
  report.checks.push('region selection');
  const getRegion = () => page.locator('#crop-box').evaluate(el => ({ x: parseFloat(el.style.left) / 100, y: parseFloat(el.style.top) / 100, width: parseFloat(el.style.width) / 100, height: parseFloat(el.style.height) / 100 }));
  const dragRegion = async (dx, dy, check) => {
    const box = await page.locator('#crop-box').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 5 });
    if (check) await check(); await page.mouse.up();
  };
  await dragRegion(-60, -40); let moved = await getRegion();
  assert(moved.x < 0.1 && moved.y < 0.82); assert(Math.abs(moved.width - 0.8) < 1e-8);
  await dragRegion((0.5 - moved.x - moved.width / 2) * bounds.width + 4, 0, async () => assert(await page.locator('#center-guide-x').isVisible()));
  moved = await getRegion(); assert(Math.abs(moved.x - 0.1) < 1e-8);
  await dragRegion(0, (0.5 - moved.y - moved.height / 2) * bounds.height + 4, async () => assert(await page.locator('#center-guide-y').isVisible()));
  moved = await getRegion(); assert(Math.abs(moved.y - 0.425) < 1e-8);
  await page.screenshot({ path: resolve(output, 'crop-snap.png') });
  const corner = await page.locator('.crop-handle[data-corner=se]').boundingBox();
  await page.mouse.move(corner.x + 2, corner.y + 2); await page.mouse.down();
  await page.mouse.move(corner.x + 2 - 50, corner.y + 2 - 25, { steps: 4 }); await page.mouse.up();
  const resized = await getRegion(); assert(resized.width < moved.width && resized.height < moved.height); assert.equal(resized.x, moved.x); assert.equal(resized.y, moved.y);
  await page.locator('#crop-box').focus(); await page.keyboard.press('ArrowRight');
  // CSSOM serializes percentages to six significant digits.
  const nudged = await getRegion(); assert(Math.abs(nudged.x - resized.x - 1 / 1280) < 1e-6);
  await dragRegion(-bounds.width, -bounds.height);
  const bounded = await getRegion(); assert.equal(bounded.x, 0); assert.equal(bounded.y, 0); assert.equal(bounded.width, nudged.width); assert.equal(bounded.height, nudged.height);
  const box = await page.locator('#crop-box').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 20);
  await page.keyboard.press('Escape'); await page.mouse.up(); assert.deepEqual(await getRegion(), bounded);
  await page.locator('#reset-region').click();
  report.checks.push('persistent crop dragging, horizontal/vertical center snapping, corner resizing, keyboard movement, bounds, Escape restore, processing lock');
  await page.locator('#play-pause').click(); await page.waitForFunction(() => !document.querySelector('video').paused);
  await page.locator('#play-pause').click(); await page.waitForFunction(() => document.querySelector('video').paused);
  report.checks.push('video playback controls');

  await page.locator('#toast').evaluate(el => { el.hidden = true; }); await page.evaluate(() => scrollTo(0, 0)); await page.locator('#local-models').evaluate(el => { el.open = false; });
  await page.screenshot({ path: resolve(output, 'desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: resolve(output, 'mobile.png'), fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile horizontal overflow');
  report.checks.push('desktop and mobile layout'); await page.setViewportSize({ width: 1440, height: 1000 });

  await page.locator('#extract').click();
  await page.waitForFunction(() => Number(document.querySelector('#cue-count').textContent) > 0, null, { timeout: 30000 });
  await page.locator('#cancel').click(); await ready('#extract');
  assert.match(await page.locator('#run-status').textContent(), /已停止/);
  const partial = JSON.parse(await download('json', 'partial.json')); assert(!partial.extraction.complete); assert(partial.cues.length > 0);
  report.checks.push('cancel preserves partial results');
  assert.deepEqual(pageErrors, []); if (!process.env.TEST_URL) assert.deepEqual(networkRequests, []);
  report.checks.push('no page errors; no network requests in standalone offline mode');
  await writeFile(resolve(output, 'browser-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, cues: undefined }, null, 2));
} finally { await browser.close(); }
