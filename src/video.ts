import { createFile, DataStream, Endianness, type MP4BoxBuffer, type Movie, type Sample, type Track } from 'mp4box';
import type { Region } from './core';

export interface VideoMetadata { track: Track; samples: Sample[]; offsetMs: number; config: VideoDecoderConfig; decodeMarginMs?: number }
export interface SamplingTimings { submittedFrames: number; decodedFrames: number; selectedFrames: number; readMs: number; queueWaitMs: number; consumerMs: number; wallMs: number }
export interface SamplingRange { start: number; end: number; interval: number }

function startSample(metadata: VideoMetadata, timeMs: number) {
  let index = 0;
  for (let i = 0; i < metadata.samples.length; i++) {
    const sample = metadata.samples[i];
    if (sample.is_sync && sample.cts / sample.timescale * 1000 + metadata.offsetMs <= timeMs) index = i;
  }
  return index;
}

/** Presentation order may differ from decode order, especially with B frames. */
export function decodeReorderMargin(samples: readonly Pick<Sample, 'dts' | 'cts' | 'timescale'>[]): number | undefined {
  let margin = 0, previousDts = -Infinity;
  for (const sample of samples) {
    const dts = sample.dts / sample.timescale * 1000, cts = sample.cts / sample.timescale * 1000;
    if (!Number.isFinite(dts) || !Number.isFinite(cts) || dts < previousDts) return;
    previousDts = dts; margin = Math.max(margin, dts - cts);
  }
  return margin;
}

export async function readMetadata(file: File, signal: AbortSignal): Promise<VideoMetadata> {
  const mp4 = createFile(false);
  let info: Movie | undefined, failure: Error | undefined, position = 0;
  mp4.onReady = value => { info = value; };
  mp4.onError = (_module, message) => { failure = new Error(`MP4 解析失败：${message}`); };
  // Respect MP4Box's requested offset: a moov at the end must not make us read the whole mdat.
  while (!info && position < file.size) {
    signal.throwIfAborted();
    const bytes = await file.slice(position, position + 1024 * 1024).arrayBuffer() as MP4BoxBuffer;
    bytes.fileStart = position;
    const next = mp4.appendBuffer(bytes);
    if (failure) throw failure;
    position = next > position ? next : position + bytes.byteLength;
  }
  const movie = info as Movie | undefined;
  if (!movie) throw new Error('没有找到 MP4 视频信息。首版支持 MP4 / MOV 容器，TS / MKV 请先转换为 MP4。');
  if (movie.isFragmented) throw new Error('首版暂不支持分片 MP4，请先转为普通 MP4。');
  const track = movie.videoTracks[0];
  if (!track?.video) throw new Error('文件没有可读取的视频轨道。');
  if (track.matrix && (track.matrix[1] !== 0 || track.matrix[3] !== 0 || track.matrix[0] < 0 || track.matrix[4] < 0)) throw new Error('首版暂不处理容器旋转信息，请先将视频旋转固化为普通横排画面。');
  const samples = mp4.getTrackSamplesInfo(track.id);
  if (!samples.length) throw new Error('视频轨道没有帧。');
  // Once DTS is beyond end + max(DTS - CTS), no later sample can have a
  // presentation timestamp in the range. Keep the old margin for invalid indices.
  const decodeMarginMs = decodeReorderMargin(samples);
  const entry = samples[0].description as any;
  const configBox = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
  let description: ArrayBuffer | undefined;
  if (configBox) {
    const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
    configBox.write(stream); description = stream.buffer.slice(8);
  }
  let offsetMs = 0, emptyDuration = 0, mediaEdits = 0;
  for (const edit of track.edits || []) {
    if (edit.media_rate_integer !== 1 || edit.media_rate_fraction !== 0) throw new Error('暂不支持变速 edit list。请先转换为普通 MP4。');
    if (edit.media_time === -1) emptyDuration += edit.segment_duration / movie.timescale * 1000;
    else { mediaEdits++; offsetMs = emptyDuration - edit.media_time / track.timescale * 1000; }
  }
  if (mediaEdits > 1) throw new Error('暂不支持多段 edit list。请先转换为普通 MP4。');
  const config: VideoDecoderConfig = { codec: track.codec, codedWidth: track.video.width, codedHeight: track.video.height, description, hardwareAcceleration: 'prefer-hardware' };
  if (typeof VideoDecoder === 'undefined') throw new Error('浏览器不支持 WebCodecs，请使用新版桌面 Chrome / Edge。');
  if (!(await VideoDecoder.isConfigSupported(config)).supported) throw new Error(`浏览器无法解码 ${track.codec}。请转换为 H.264 MP4 后重试。`);
  return { track, samples, offsetMs, config, decodeMarginMs };
}

/** Bounded streaming: metadata only + one 2 MiB compressed block + a short decoder/frame queue. */
export async function sampleVideo(
  file: File, metadata: VideoMetadata, range: SamplingRange, signal: AbortSignal,
  onFrame: (frame: VideoFrame, time: number) => Promise<void>,
  timings?: SamplingTimings,
) {
  return sampleVideoBatch(file, metadata, [range], signal, onFrame, timings);
}

/** Share decoding for ordered, disjoint windows that start in the same GOP.
 * Each window retains its own sampling origin; gaps do not invoke OCR. */
export async function sampleVideoWindows(
  file: File, metadata: VideoMetadata, ranges: readonly SamplingRange[], signal: AbortSignal,
  onFrame: (frame: VideoFrame, time: number) => Promise<void>, timings?: SamplingTimings,
) {
  const groups: { start: number; ranges: SamplingRange[] }[] = [];
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    if (range.end <= range.start || range.interval <= 0 || (i && range.start < ranges[i - 1].end)) throw new Error('字幕精修区间必须有序且不重叠。');
    const start = startSample(metadata, range.start), previous = groups.at(-1);
    if (previous?.start === start) previous.ranges.push(range); else groups.push({ start, ranges: [range] });
  }
  for (const group of groups) {
    signal.throwIfAborted();
    const batch = timings ? { submittedFrames: 0, decodedFrames: 0, selectedFrames: 0, readMs: 0, queueWaitMs: 0, consumerMs: 0, wallMs: 0 } : undefined;
    try { await sampleVideoBatch(file, metadata, group.ranges, signal, onFrame, batch, group.start); }
    finally { if (timings && batch) for (const key of Object.keys(batch) as (keyof SamplingTimings)[]) timings[key] += batch[key]; }
  }
}

async function sampleVideoBatch(
  file: File, metadata: VideoMetadata, ranges: readonly SamplingRange[], signal: AbortSignal,
  onFrame: (frame: VideoFrame, time: number) => Promise<void>, timings?: SamplingTimings, startIndex = startSample(metadata, ranges[0].start),
) {
  const started = timings ? performance.now() : 0;
  const { samples, offsetMs, config } = metadata;
  const decodeEnd = ranges.at(-1)!.end + (metadata.decodeMarginMs ?? 1000) + 0.01;
  const frameQueue: { frame: VideoFrame; time: number }[] = [];
  let rangeIndex = 0, nextTime = ranges[0].start, error: Error | undefined, done = false;
  let wake: (() => void) | undefined;
  const notify = () => { wake?.(); wake = undefined; };
  const decoder = new VideoDecoder({
    output(frame) {
      if (timings) timings.decodedFrames++;
      const time = frame.timestamp / 1000;
      while (rangeIndex + 1 < ranges.length && time >= ranges[rangeIndex].end) { rangeIndex++; nextTime = ranges[rangeIndex].start; }
      const range = ranges[rangeIndex];
      if (time + 0.01 >= nextTime && time < range.end) {
        nextTime = range.start + (Math.floor((time - range.start) / range.interval) + 1) * range.interval;
        frameQueue.push({ frame, time });
        if (timings) timings.selectedFrames++;
      } else frame.close();
      notify();
    },
    error(e) { error = new Error(`视频解码失败：${e.message}`); notify(); },
  });
  decoder.configure(config);
  let consumerError: unknown;
  const abort = () => notify(); signal.addEventListener('abort', abort);
  const consumer = (async () => {
    try {
      while (!done || frameQueue.length) {
        signal.throwIfAborted();
        if (error) throw error;
        const item = frameQueue.shift();
        if (item) {
          const consumeStarted = timings ? performance.now() : 0;
          try { await onFrame(item.frame, item.time); } finally { if (timings) timings.consumerMs += performance.now() - consumeStarted; item.frame.close(); }
        } else if (!done) await new Promise<void>(resolve => { wake = resolve; });
      }
    } catch (e) { consumerError = e; notify(); }
  })();
  let block = new ArrayBuffer(0), blockStart = -1;
  try {
    for (let i = startIndex; i < samples.length; i++) {
      signal.throwIfAborted(); if (error) throw error; if (consumerError) throw consumerError;
      const sample = samples[i];
      if (sample.dts / sample.timescale * 1000 + offsetMs > decodeEnd) break;
      // Yield while the decoder or OCR consumer is busy; never retain an entire decoded clip.
      while (decoder.decodeQueueSize > 6 || frameQueue.length > 2) {
        signal.throwIfAborted(); if (error) throw error; if (consumerError) throw consumerError;
        const waitStarted = timings ? performance.now() : 0;
        await new Promise(resolve => setTimeout(resolve, 4));
        if (timings) timings.queueWaitMs += performance.now() - waitStarted;
      }
      if (sample.offset < blockStart || sample.offset + sample.size > blockStart + block.byteLength) {
        const readStarted = timings ? performance.now() : 0;
        blockStart = sample.offset; block = await file.slice(blockStart, blockStart + Math.max(2 * 1024 * 1024, sample.size)).arrayBuffer();
        if (timings) timings.readMs += performance.now() - readStarted;
      }
      const data = new Uint8Array(block, sample.offset - blockStart, sample.size);
      decoder.decode(new EncodedVideoChunk({ type: sample.is_sync ? 'key' : 'delta', timestamp: Math.round(sample.cts / sample.timescale * 1e6 + offsetMs * 1000), duration: Math.round(sample.duration / sample.timescale * 1e6), data }));
      if (timings) timings.submittedFrames++;
    }
    await decoder.flush();
    done = true; notify(); await consumer;
    if (consumerError) throw consumerError; if (error) throw error;
  } finally {
    done = true; notify();
    if (decoder.state !== 'closed') decoder.close();
    await consumer;
    for (const item of frameQueue) item.frame.close();
    signal.removeEventListener('abort', abort);
    if (timings) timings.wallMs = performance.now() - started;
  }
}

export async function cropFrame(source: VideoFrame | HTMLVideoElement, region: Region): Promise<ImageBitmap> {
  const width = source instanceof HTMLVideoElement ? source.videoWidth : source.displayWidth;
  const height = source instanceof HTMLVideoElement ? source.videoHeight : source.displayHeight;
  const x = Math.round(region.x * width), y = Math.round(region.y * height);
  return createImageBitmap(source, x, y, Math.max(1, Math.min(width - x, Math.round(region.width * width))), Math.max(1, Math.min(height - y, Math.round(region.height * height))));
}
