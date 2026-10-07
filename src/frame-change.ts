import type { OcrTextResult } from './ocr';
import type { Region } from './core';

export interface FrameSignature { width: number; height: number; ink: Uint8Array; count: number }
export const FRAME_RECHECK_MS = 1500;

/** Keep outlined strokes at their original positions; an average image hash can
 * hide a one-character edit. Colours have separate classes to detect colour changes. */
export function subtitleSignature(pixels: Uint8ClampedArray, width: number, height: number): FrameSignature {
  const ink = new Uint8Array(width * height);
  let count = 0;
  for (let y = 3; y < height - 3; y++) for (let x = 3; x < width - 3; x++) {
    const i = (y * width + x) * 4, r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    const bright = Math.max(r, g, b);
    if (bright < 180) continue;
    let outlined = false;
    for (let radius = 1; radius <= 3 && !outlined; radius++) {
      for (const offset of [-radius * 4, radius * 4, -radius * width * 4, radius * width * 4]) {
        if (Math.max(pixels[i + offset], pixels[i + offset + 1], pixels[i + offset + 2]) < 110) { outlined = true; break; }
      }
    }
    if (!outlined) continue;
    ink[y * width + x] = bright - Math.min(r, g, b) < 70 ? 1 : r === bright ? 2 : g === bright ? 3 : 4;
    count++;
  }
  return { width, height, ink, count };
}

/** Ignore one-pixel rasterisation movement, but check local differences too:
 * the edited glyph must not disappear in the average of a long subtitle. */
export function sameSubtitlePixels(a: FrameSignature, b: FrameSignature, boxes?: Region[]): boolean {
  if (a.width !== b.width || a.height !== b.height || Math.min(a.count, b.count) < 64) return false;
  const { width, height } = a, columns = Math.ceil(width / 32);
  const regions = boxes?.map(box => {
    const h = box.height * height;
    return { left: Math.max(0, box.x * width - h * .5), right: Math.min(width, (box.x + box.width) * width + h * .5), top: Math.max(0, box.y * height - h * .1), bottom: Math.min(height, (box.y + box.height) * height + h * .1) };
  });
  const changed = new Uint16Array(columns * Math.ceil(height / 16));
  const outside = regions ? new Uint8Array(width * height) : undefined;
  let difference = 0, aCount = 0, bCount = 0;
  const supported = (value: number, other: Uint8Array, x: number, y: number) => {
    if (!value) return true;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < height && other[(y + dy) * width + x + dx] === value) return true;
    }
    return false;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, av = a.ink[i], bv = b.ink[i];
    if (!av && !bv) continue;
    const inside = !regions || regions.some(box => x >= box.left && x < box.right && y >= box.top && y < box.bottom);
    if (inside) { if (av) aCount++; if (bv) bCount++; }
    if (av === bv || (supported(av, b.ink, x, y) && supported(bv, a.ink, x, y))) continue;
    if (!inside) { outside![i] = 1; continue; }
    const tile = Math.floor(y / 16) * columns + Math.floor(x / 32);
    changed[tile]++; difference++;
  }
  if (Math.min(aCount, bCount) < 64 || Math.abs(aCount - bCount) > Math.max(aCount, bCount) * .08 || difference > Math.max(aCount, bCount) * .006 || changed.some(count => count > 2)) return false;
  if (!outside) return true;
  // Ignore isolated noise and thin moving borders outside the OCR boxes. A new
  // glyph/component outside them (including another subtitle row) invalidates reuse.
  const queue = new Int32Array(outside.length);
  for (let i = 0; i < outside.length; i++) {
    if (!outside[i]) continue;
    let head = 0, tail = 1, left = width, right = 0, top = height, bottom = 0;
    queue[0] = i; outside[i] = 0;
    while (head < tail) {
      const index = queue[head++], x = index % width, y = Math.floor(index / width);
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const next = ny * width + nx;
        if (outside[next]) { outside[next] = 0; queue[tail++] = next; }
      }
    }
    if (tail >= 12 && right - left >= 2 && bottom - top >= 1) return false;
  }
  return true;
}

function supportedResult(value: OcrTextResult, signature: FrameSignature): boolean {
  if (!value.text || value.confidence < 0.9 || !value.lines.length || signature.count < 64) return false;
  // The strokes must cover the detected text boxes, rather than just a bright
  // object elsewhere in the selected area. Weak/unsupported text always runs OCR.
  return value.lines.every(line => {
    if (line.confidence < 0.9) return false;
    const left = Math.max(0, Math.floor(line.box.x * signature.width));
    const right = Math.min(signature.width, Math.ceil((line.box.x + line.box.width) * signature.width));
    const top = Math.max(0, Math.floor(line.box.y * signature.height));
    const bottom = Math.min(signature.height, Math.ceil((line.box.y + line.box.height) * signature.height));
    let count = 0, columns = 0;
    for (let x = left; x < right; x++) {
      let column = 0;
      for (let y = top; y < bottom; y++) if (signature.ink[y * signature.width + x]) { count++; column++; }
      if (column) columns++;
    }
    return count >= Math.max(32, (right - left) * (bottom - top) * 0.015) && columns >= (right - left) * 0.25;
  });
}

interface Reference { signature: FrameSignature; since: number; lastTime: number; sourceTime: number; value: OcrTextResult; confirmed: number }
interface Group { signature: FrameSignature; since: number; indices: number[]; fresh: number[]; reference?: Reference; boxes?: Region[] }

/** A single bounded reference. Two real, agreeing OCR reads are needed before
 * reuse. Every frame keeps its time and the time of the actual OCR witness. */
export class FrameReuse {
  private reference?: Reference;
  private scope = '';
  reset(scope: string) { if (scope !== this.scope) { this.reference = undefined; this.scope = scope; } }
  async recognize(signatures: FrameSignature[], times: number[], infer: (indices: number[]) => Promise<OcrTextResult[]>) {
    if (times.length !== signatures.length || times.some(time => !Number.isFinite(time))) throw new Error('画面去重需要每张裁图的有效时间戳。');
    const values: OcrTextResult[] = new Array(times.length), sourceTimes = [...times], reused = times.map(() => false);
    const fill = async (indices: number[]) => {
      if (!indices.length) return;
      try {
        const results = await infer(indices);
        if (results.length !== indices.length) throw new Error('OCR 返回的帧数不匹配。');
        indices.forEach((index, i) => { values[index] = results[i]; });
      } catch (error) { this.reference = undefined; throw error; }
    };
    let guide = this.reference;
    if (!guide && times.length) {
      // Establish real text geometry before comparing the remaining window.
      const first = times.length > 1 ? [0, 1] : [0]; await fill(first);
      const index = first.at(-1)!;
      if (supportedResult(values[index], signatures[index])) guide = { signature: signatures[index], since: times[index], lastTime: times[index], sourceTime: times[index], value: values[index], confirmed: 1 };
    }
    const groups: Group[] = [];
    for (let index = 0; index < signatures.length; index++) {
      const signature = signatures[index], time = times[index];
      let group = groups.at(-1);
      if (!group || time - group.since > FRAME_RECHECK_MS || (index && time <= times[index - 1]) || !sameSubtitlePixels(group.signature, signature, group.boxes)) {
        const previous = index === 0 ? this.reference : undefined;
        const reference = previous && time > previous.lastTime && time - previous.since <= FRAME_RECHECK_MS && sameSubtitlePixels(previous.signature, signature, previous.value.lines.map(line => line.box)) ? previous : undefined;
        group = { signature: reference?.signature || signature, since: reference?.since ?? time, indices: [], fresh: [], reference, boxes: guide?.value.lines.map(line => line.box) };
        groups.push(group);
      }
      group.indices.push(index);
      if ((group.reference?.confirmed || 0) + group.fresh.length < 2) group.fresh.push(index);
    }
    await fill(groups.flatMap(group => group.fresh).filter(index => !values[index]));
    const retry: number[] = [];
    for (const group of groups) {
      const candidates = [
        ...(group.reference ? [{ value: group.reference.value, time: group.reference.sourceTime, confirmed: group.reference.confirmed }] : []),
        ...group.fresh.map(index => ({ value: values[index], time: times[index], confirmed: 1 })),
      ];
      const trusted = candidates.reduce((sum, item) => sum + item.confirmed, 0) >= 2
        && candidates.every(item => item.value.text === candidates[0].value.text && supportedResult(item.value, group.signature));
      if (trusted) {
        const best = candidates.reduce((best, item) => item.value.confidence > best.value.confidence ? item : best);
        for (const index of group.indices) if (!values[index]) { values[index] = best.value; sourceTimes[index] = best.time; reused[index] = true; }
        group.reference = { signature: group.signature, since: group.since, lastTime: times[group.indices.at(-1)!], sourceTime: best.time, value: best.value, confirmed: 2 };
      } else {
        retry.push(...group.indices.filter(index => !values[index])); group.reference = undefined;
      }
    }
    await fill(retry);
    const last = groups.at(-1), index = times.length - 1;
    this.reference = last?.reference || (index >= 0 && supportedResult(values[index], signatures[index])
      ? { signature: signatures[index], since: times[index], lastTime: times[index], sourceTime: times[index], value: values[index], confirmed: 1 } : undefined);
    return { values, sourceTimes, reused, reusedFrames: reused.filter(Boolean).length };
  }
}

/** Separate canvas: no interference with the OCR model's preprocessing canvas. */
export class FrameSignatureReader {
  private canvas = new OffscreenCanvas(1, 1);
  private context = this.canvas.getContext('2d', { willReadFrequently: true })!;
  read(bitmap: ImageBitmap) {
    const scale = Math.min(1, 1024 / bitmap.width, 256 / bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
    this.canvas.width = width; this.canvas.height = height;
    this.context.drawImage(bitmap, 0, 0, width, height);
    return subtitleSignature(this.context.getImageData(0, 0, width, height).data, width, height);
  }
}
