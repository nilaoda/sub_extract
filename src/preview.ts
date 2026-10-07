import { clamp, type Cue } from './core';

/** Keep drawing and hit testing on the same axis, including imported projects. */
export function timelineDuration(projectDuration: number | undefined, videoDurationSeconds: number): number {
  if (projectDuration && Number.isFinite(projectDuration) && projectDuration > 0) return projectDuration;
  return Number.isFinite(videoDurationSeconds) && videoDurationSeconds > 0 ? videoDurationSeconds * 1000 : 1;
}

/** Preview a witnessed OCR frame rather than the estimated subtitle boundary. */
export function cuePreviewTarget(cue: Pick<Cue, 'start' | 'end' | 'sampleTime'>, frameDurationMs?: number): { timeMs: number; frameTimeMs?: number } {
  if (Number.isFinite(cue.sampleTime) && cue.sampleTime >= cue.start && cue.sampleTime < cue.end) {
    // Seek inside the witnessed frame, avoiding timestamp rounding at its edge.
    const inset = Number.isFinite(frameDurationMs) && frameDurationMs! > 0 ? frameDurationMs! / 2 : 1;
    return { timeMs: cue.sampleTime + Math.min(inset, (cue.end - cue.sampleTime) / 2), frameTimeMs: cue.sampleTime };
  }
  // Edited/imported boundaries can invalidate the original sample frame.
  return { timeMs: cue.start + (cue.end - cue.start) / 2 };
}

/** Match the painted rectangles, including the minimum width of short cues. */
export function timelineCueAt(cues: Cue[], timeMs: number, durationMs: number, canvasWidth: number): Cue | undefined {
  const minimumSpan = 2 / Math.max(1, canvasWidth) * durationMs;
  for (let i = cues.length - 1; i >= 0; i--) {
    const cue = cues[i];
    if (timeMs >= cue.start && timeMs < Math.max(cue.end, cue.start + minimumSpan)) return cue;
  }
}

/** Prefer compositor confirmation; some paused seeks do not submit another frame callback. */
export function seekPreview(video: HTMLVideoElement, timeMs: number, signal: AbortSignal, frameTimeMs?: number): Promise<void> {
  signal.throwIfAborted();
  if (!Number.isFinite(timeMs) || !Number.isFinite(video.duration)) return Promise.reject(new Error('视频尚未就绪。'));
  video.pause();
  const seconds = clamp(timeMs / 1000, 0, video.duration);
  if (!video.seeking && Math.abs(video.currentTime - seconds) < 0.000001) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let seekDone = false, frameDone = typeof video.requestVideoFrameCallback !== 'function', frameCallback: number | undefined;
    let decodedTimer: ReturnType<typeof setTimeout> | undefined;
    const atTarget = () => !video.seeking && Math.abs(video.currentTime - seconds) <= 0.001;
    const hasDecodedTarget = () => atTarget() && video.readyState >= 2; // HAVE_CURRENT_DATA
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(decodedTimer);
      if (frameCallback !== undefined) video.cancelVideoFrameCallback(frameCallback);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const complete = () => { if (seekDone && frameDone) { cleanup(); resolve(); } };
    const waitForDecodedTarget = () => {
      clearTimeout(decodedTimer);
      // Give a matching compositor callback priority. A completed seek with
      // current frame data is still valid when callbacks are coalesced, paused
      // or throttled in a background tab. currentTime assignment alone is not.
      decodedTimer = setTimeout(() => {
        if (hasDecodedTarget()) { cleanup(); resolve(); }
      }, 300);
    };
    const onSeeked = () => {
      if (!atTarget()) return;
      seekDone = true;
      if (!frameDone) waitForDecodedTarget();
      complete();
    };
    const onError = () => { cleanup(); reject(new Error('无法跳转到该视频位置。')); };
    const onAbort = () => { cleanup(); reject(signal.reason); };
    const timer = setTimeout(() => {
      cleanup();
      if (hasDecodedTarget()) resolve();
      else reject(new Error('视频跳转超时，请重试。'));
    }, 8000);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    const onFrame: VideoFrameRequestCallback = (_now, metadata) => {
      frameCallback = undefined;
      const matches = frameTimeMs === undefined
        ? metadata.mediaTime <= seconds + 0.002 && metadata.mediaTime >= seconds - 0.25
        : Math.abs(metadata.mediaTime * 1000 - frameTimeMs) < 2;
      if (matches && Math.abs(video.currentTime - seconds) <= 0.001) { frameDone = true; complete(); }
      else frameCallback = video.requestVideoFrameCallback(onFrame);
    };
    if (!frameDone) frameCallback = video.requestVideoFrameCallback(onFrame);
    // fastSeek may land on a nearby keyframe seconds away from the requested time.
    try { video.currentTime = seconds; waitForDecodedTarget(); } catch (error) { cleanup(); reject(error); }
  });
}
