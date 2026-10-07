import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeReorderMargin, sampleVideo, sampleVideoWindows, type VideoMetadata } from './video';

test('negative composition offsets keep B frames beyond the requested decode end', () => {
  const samples = [
    { dts: 0, cts: 0, timescale: 1000 },
    { dts: 40, cts: 120, timescale: 1000 },
    { dts: 80, cts: 40, timescale: 1000 },
    { dts: 120, cts: 80, timescale: 1000 },
  ];
  const margin = decodeReorderMargin(samples)!;
  assert.equal(margin, 40);
  const end = 90;
  assert(samples[3].dts > end && samples[3].cts < end, 'Stopping at DTS=end would drop a wanted B frame');
  assert(samples.filter(sample => sample.cts < end).every(sample => sample.dts <= end + margin));
});
test('decode margin uses milliseconds, supports shifted timelines, and avoids unnecessary positive-offset padding', () => {
  const samples = [{ dts: 0, cts: 2048, timescale: 12800 }, { dts: 1024, cts: 0, timescale: 12800 }];
  assert.equal(decodeReorderMargin(samples), 80);
  const offsetMs = -160, end = -100;
  assert(samples.filter(s => s.cts / s.timescale * 1000 + offsetMs < end)
    .every(s => s.dts / s.timescale * 1000 + offsetMs <= end + decodeReorderMargin(samples)!));
  assert.equal(decodeReorderMargin([{ dts: 0, cts: 80, timescale: 1000 }, { dts: 40, cts: 120, timescale: 1000 }]), 0);
});
test('unordered or invalid decode indices retain the existing conservative fallback', () => {
  assert.equal(decodeReorderMargin([{ dts: 80, cts: 80, timescale: 1000 }, { dts: 40, cts: 40, timescale: 1000 }]), undefined);
  assert.equal(decodeReorderMargin([{ dts: 0, cts: 0, timescale: 0 }]), undefined);
  assert.equal(decodeReorderMargin([{ dts: 0, cts: NaN, timescale: 1000 }]), undefined);
});

test('shared GOP decoding preserves independent sampling origins and gaps, and releases frames on stop or failure', async () => {
  const originals = ['VideoDecoder', 'EncodedVideoChunk'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const frames: { closed: boolean }[] = [];
  let decoders = 0, closedDecoders = 0;
  class Decoder {
    state = 'configured'; decodeQueueSize = 0;
    private timestamps: number[] = [];
    constructor(private callbacks: VideoDecoderInit) { decoders++; }
    configure() {}
    decode(chunk: EncodedVideoChunk) { this.timestamps.push(chunk.timestamp); }
    async flush() {
      for (const timestamp of this.timestamps) {
        const frame = { timestamp, closed: false, close() { assert.equal(this.closed, false); this.closed = true; } };
        frames.push(frame); this.callbacks.output(frame as unknown as VideoFrame);
      }
    }
    close() { this.state = 'closed'; closedDecoders++; }
  }
  Object.defineProperty(globalThis, 'VideoDecoder', { configurable: true, value: Decoder });
  Object.defineProperty(globalThis, 'EncodedVideoChunk', { configurable: true, value: class { timestamp: number; constructor(init: EncodedVideoChunkInit) { this.timestamp = init.timestamp; } } });
  try {
    const metadata = {
      samples: Array.from({ length: 20 }, (_, i) => ({ dts: i * 40, cts: i * 40, timescale: 1000, is_sync: i % 10 === 0, offset: i, size: 1, duration: 40 })),
      offsetMs: 0, config: {}, decodeMarginMs: 0,
    } as unknown as VideoMetadata;
    const file = new File([new Uint8Array(20)], 'fixture.mp4');
    const ranges = [{ start: 13, end: 174, interval: 50 }, { start: 217, end: 378, interval: 50 }, { start: 417, end: 618, interval: 50 }];
    const signal = new AbortController().signal, independent: number[] = [], shared: number[] = [];
    for (const range of ranges) await sampleVideo(file, metadata, range, signal, async (_, time) => { independent.push(time); });
    const before = decoders;
    await sampleVideoWindows(file, metadata, ranges, signal, async (_, time) => { shared.push(time); });
    assert.deepEqual(shared, [40, 80, 120, 240, 280, 320, 440, 480, 520, 600]);
    assert.deepEqual(shared, independent);
    assert.equal(decoders - before, 2, 'Only windows with the same preceding keyframe share a decoder');
    const aborter = new AbortController(); let seen = 0;
    await assert.rejects(sampleVideoWindows(file, metadata, ranges, aborter.signal, async () => { seen++; aborter.abort(); }), { name: 'AbortError' });
    assert.equal(seen, 1);
    const failure = new Error('consumer failed');
    await assert.rejects(sampleVideoWindows(file, metadata, ranges, signal, async () => { throw failure; }), error => error === failure);
    await sampleVideoWindows(file, metadata, [], signal, async () => { assert.fail('Empty windows cannot select a frame'); });
    await assert.rejects(sampleVideoWindows(file, metadata, [ranges[1], ranges[0]], signal, async () => {}), /有序且不重叠/);
    assert.equal(closedDecoders, decoders);
    assert(frames.every(frame => frame.closed), 'Discarded, consumed and queued frames all close');
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
