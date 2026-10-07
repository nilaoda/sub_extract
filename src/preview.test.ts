import test from 'node:test';
import assert from 'node:assert/strict';
import { seekPreview, timelineDuration, cuePreviewTarget, timelineCueAt } from './preview';
import { exportSubtitles, type Cue } from './core';

class Preview extends EventTarget {
  duration = 60.16;
  currentTime = 0;
  seeking = false;
  paused = false;
  pause() { this.paused = true; }
  get element() { return this as unknown as HTMLVideoElement; }
}

test('subtitle seek pauses playback and waits for decoded seek completion at millisecond precision', async () => {
  const video = new Preview();
  let complete = false;
  const seek = seekPreview(video.element, 44700, new AbortController().signal).then(() => { complete = true; });
  await Promise.resolve();
  assert(video.paused); assert.equal(video.currentTime, 44.7); assert.equal(complete, false);
  video.dispatchEvent(new Event('seeked')); await seek; assert(complete);
});

test('a newer seek cancels the previous wait; end positions clamp to the loaded video', async () => {
  const video = new Preview(), controller = new AbortController();
  const first = seekPreview(video.element, 30000, controller.signal);
  const cancelled = assert.rejects(first, { name: 'AbortError' });
  controller.abort();
  const second = seekPreview(video.element, 90000, new AbortController().signal);
  assert.equal(video.currentTime, video.duration);
  video.dispatchEvent(new Event('seeked')); await second; await cancelled;
  await seekPreview(video.element, video.duration * 1000, new AbortController().signal);
});

test('timeline clicks use the same project duration as drawn subtitles when the video differs', () => {
  const duration = timelineDuration(65000, 60.16), cueStart = 44700;
  const fraction = cueStart / duration;
  assert(Math.abs(fraction * duration - cueStart) < 1e-8);
  assert.equal(timelineDuration(undefined, 60.16), 60160);
  assert.equal(timelineDuration(undefined, NaN), 1);
});

test('the 13.340 subtitle boundary previews the witnessed 13.360 frame while exports retain 13.340', () => {
  const cue: Cue = { id: '7', start: 13340, end: 14420, sampleTime: 13360, text: '一点都不管用', lines: ['一点都不管用'], confidence: 1, needsReview: false };
  assert.deepEqual(cuePreviewTarget(cue, 40), { timeMs: 13380, frameTimeMs: 13360 });
  assert.deepEqual(cuePreviewTarget(cue), { timeMs: 13361, frameTimeMs: 13360 });
  assert.match(exportSubtitles([cue], 'srt'), /00:00:13,340 --> 00:00:14,420/);
  assert.match(exportSubtitles([cue], 'vtt'), /00:00:13.340 --> 00:00:14.420/);
  assert.deepEqual(cuePreviewTarget({ ...cue, sampleTime: 13200 }), { timeMs: 13880 });
  assert.deepEqual(cuePreviewTarget({ ...cue, sampleTime: cue.end }), { timeMs: 13880 });
  assert.deepEqual(cuePreviewTarget({ ...cue, start: 13359, end: 13362 }, 40), { timeMs: 13361, frameTimeMs: 13360 });
  const short = { ...cue, start: 13140, end: 13340, sampleTime: 13200 };
  assert.equal(timelineCueAt([short, cue], 13340, 60480, 960), cue);
  assert.equal(timelineCueAt([short, cue], 14000, 60480, 960), cue);
  assert.equal(timelineCueAt([short, cue], 15000, 60480, 960), undefined);
  const brief = { ...cue, start: 1000, end: 1001, sampleTime: 1000 };
  assert.equal(timelineCueAt([brief], 1100, 60000, 400), brief, 'The minimum two-pixel rectangle remains clickable');
});

class FramePreview extends Preview {
  callbacks = new Map<number, VideoFrameRequestCallback>();
  id = 0;
  requestVideoFrameCallback(callback: VideoFrameRequestCallback) { this.callbacks.set(++this.id, callback); return this.id; }
  cancelVideoFrameCallback(id: number) { this.callbacks.delete(id); }
  present(time: number) {
    const callbacks = [...this.callbacks.values()]; this.callbacks.clear();
    for (const callback of callbacks) callback(0, { mediaTime: time } as VideoFrameCallbackMetadata);
  }
}

test('seeked alone cannot finish subtitle preview; an old displayed frame is ignored', async () => {
  const video = new FramePreview(); let complete = false;
  const seek = seekPreview(video.element, 13380, new AbortController().signal, 13360).then(() => { complete = true; });
  video.dispatchEvent(new Event('seeked')); await Promise.resolve(); assert(!complete);
  video.present(13.32); await Promise.resolve(); assert(!complete, 'The previous 走 frame must not complete the new subtitle preview');
  video.present(13.36); await seek; assert(complete); assert.equal(video.callbacks.size, 0);
});

test('frame arrival before seeked still waits; cancelled seeks release frame callbacks', async () => {
  const video = new FramePreview(); let complete = false;
  const seek = seekPreview(video.element, 13380, new AbortController().signal, 13360).then(() => { complete = true; });
  video.present(13.36); await Promise.resolve(); assert(!complete);
  video.dispatchEvent(new Event('seeked')); await seek;
  const controller = new AbortController();
  const cancelled = seekPreview(video.element, 20000, controller.signal, 20000);
  const rejection = assert.rejects(cancelled, { name: 'AbortError' });
  controller.abort(); await rejection; assert.equal(video.callbacks.size, 0);
});

test('raw-time seeking also accepts frame submission before seeked, while ignoring distant old frames', async () => {
  const video = new FramePreview(); let complete = false;
  const seek = seekPreview(video.element, 13340, new AbortController().signal).then(() => { complete = true; });
  video.seeking = true;
  video.present(0); assert.equal(video.callbacks.size, 1);
  video.present(13.32); await Promise.resolve(); assert(!complete);
  video.seeking = false; video.dispatchEvent(new Event('seeked')); await seek; assert(complete);
});
