import { createFile, DataStream, Endianness, type MP4BoxBuffer, type Movie, type Sample, type Track } from 'mp4box';
import type { Region } from './core';

export interface VideoMetadata { track: Track; samples: Sample[]; offsetMs: number; config: VideoDecoderConfig }

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
  return { track, samples, offsetMs, config };
}

/** Bounded streaming: metadata only + one 2 MiB compressed block + a short decoder/frame queue. */
export async function sampleVideo(
  file: File, metadata: VideoMetadata, range: { start: number; end: number; interval: number }, signal: AbortSignal,
  onFrame: (frame: VideoFrame, time: number) => Promise<void>,
) {
  const { samples, offsetMs, config } = metadata;
  const frameQueue: { frame: VideoFrame; time: number }[] = [];
  let nextTime = range.start, error: Error | undefined, done = false;
  let startIndex = 0;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].cts / samples[i].timescale * 1000 + offsetMs > range.start) continue;
    if (samples[i].is_sync) startIndex = i;
  }
  let wake: (() => void) | undefined;
  const notify = () => { wake?.(); wake = undefined; };
  const decoder = new VideoDecoder({
    output(frame) {
      const time = frame.timestamp / 1000;
      if (time + 0.01 >= nextTime && time < range.end) {
        nextTime = range.start + (Math.floor((time - range.start) / range.interval) + 1) * range.interval;
        frameQueue.push({ frame, time });
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
          try { await onFrame(item.frame, item.time); } finally { item.frame.close(); }
        } else if (!done) await new Promise<void>(resolve => { wake = resolve; });
      }
    } catch (e) { consumerError = e; notify(); }
  })();
  let block = new ArrayBuffer(0), blockStart = -1;
  try {
    for (let i = startIndex; i < samples.length; i++) {
      signal.throwIfAborted(); if (error) throw error; if (consumerError) throw consumerError;
      const sample = samples[i];
      if (sample.dts / sample.timescale * 1000 + offsetMs > range.end + 1000) break;
      // Yield while the decoder or OCR consumer is busy; never retain an entire decoded clip.
      while (decoder.decodeQueueSize > 6 || frameQueue.length > 2) {
        signal.throwIfAborted(); if (error) throw error; if (consumerError) throw consumerError;
        await new Promise(resolve => setTimeout(resolve, 4));
      }
      if (sample.offset < blockStart || sample.offset + sample.size > blockStart + block.byteLength) {
        blockStart = sample.offset; block = await file.slice(blockStart, blockStart + Math.max(2 * 1024 * 1024, sample.size)).arrayBuffer();
      }
      const data = new Uint8Array(block, sample.offset - blockStart, sample.size);
      decoder.decode(new EncodedVideoChunk({ type: sample.is_sync ? 'key' : 'delta', timestamp: Math.round(sample.cts / sample.timescale * 1e6 + offsetMs * 1000), duration: Math.round(sample.duration / sample.timescale * 1e6), data }));
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
  }
}

export async function cropFrame(source: VideoFrame | HTMLVideoElement, region: Region): Promise<ImageBitmap> {
  const width = source instanceof HTMLVideoElement ? source.videoWidth : source.displayWidth;
  const height = source instanceof HTMLVideoElement ? source.videoHeight : source.displayHeight;
  const x = Math.round(region.x * width), y = Math.round(region.y * height);
  return createImageBitmap(source, x, y, Math.max(1, Math.min(width - x, Math.round(region.width * width))), Math.max(1, Math.min(height - y, Math.round(region.height * height))));
}
