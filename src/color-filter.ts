import type { Region } from './core';
export interface ColorFilterOptions { color: string; tolerance: number; outline: boolean }
export const DEFAULT_COLOR_FILTER: ColorFilterOptions = { color: '#ffffff', tolerance: 60, outline: false };

export function parseColorFilter(value: unknown): ColorFilterOptions | undefined {
  const option = value as Partial<ColorFilterOptions> | null;
  if (!option || typeof option.color !== 'string' || !/^#[\da-f]{6}$/i.test(option.color)
    || !Number.isInteger(option.tolerance) || option.tolerance! < 0 || option.tolerance! > 128 || typeof option.outline !== 'boolean') return;
  return { color: option.color.toLowerCase(), tolerance: option.tolerance!, outline: option.outline };
}

/** The same mask drives the user's preview and the actual empty-frame gate. */
export function colorMask(pixels: Uint8ClampedArray, width: number, height: number, options: ColorFilterOptions) {
  const red = Number.parseInt(options.color.slice(1, 3), 16), green = Number.parseInt(options.color.slice(3, 5), 16), blue = Number.parseInt(options.color.slice(5, 7), 16);
  const tolerance = options.tolerance;
  const mask = new Uint8Array(width * height);
  const dark = Math.min(110, Math.max(red, green, blue) * .55);
  const isDark = (index: number) => pixels[index + 3] !== 0 && Math.max(pixels[index], pixels[index + 1], pixels[index + 2]) < dark;
  let count = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x, i = index * 4;
    if (pixels[i + 3] === 0 || Math.abs(red - pixels[i]) > tolerance || Math.abs(green - pixels[i + 1]) > tolerance || Math.abs(blue - pixels[i + 2]) > tolerance) continue;
    if (options.outline) {
      let outlined = false;
      for (let radius = 1; radius <= 3 && !outlined; radius++) {
        outlined = (x >= radius && isDark(i - radius * 4)) || (x + radius < width && isDark(i + radius * 4))
          || (y >= radius && isDark(i - radius * width * 4)) || (y + radius < height && isDark(i + radius * width * 4));
      }
      if (!outlined) continue;
    }
    mask[index] = 1; count++;
  }
  return { mask, count, width, height };
}

export class ColorMaskReader {
  private canvas = new OffscreenCanvas(1, 1);
  private context = this.canvas.getContext('2d', { willReadFrequently: true })!;
  read(bitmap: ImageBitmap, options: ColorFilterOptions) {
    return this.readCrop(bitmap, 0, 0, bitmap.width, bitmap.height, options);
  }
  readVideo(video: HTMLVideoElement, region: Region, options: ColorFilterOptions) {
    const x = Math.round(region.x * video.videoWidth), y = Math.round(region.y * video.videoHeight);
    return this.readCrop(video, x, y, Math.max(1, Math.min(video.videoWidth - x, Math.round(region.width * video.videoWidth))),
      Math.max(1, Math.min(video.videoHeight - y, Math.round(region.height * video.videoHeight))), options);
  }
  private readCrop(source: CanvasImageSource, x: number, y: number, sourceWidth: number, sourceHeight: number, options: ColorFilterOptions) {
    const scale = Math.min(1, 1024 / sourceWidth, 256 / sourceHeight);
    const width = Math.max(1, Math.round(sourceWidth * scale)), height = Math.max(1, Math.round(sourceHeight * scale));
    this.canvas.width = width; this.canvas.height = height;
    this.context.drawImage(source, x, y, sourceWidth, sourceHeight, 0, 0, width, height);
    return colorMask(this.context.getImageData(0, 0, width, height).data, width, height, options);
  }
}

/** Verify an empty result before skipping; even one matching pixel stays uncertain.
 * A real text result with no colour evidence disables the gate for this scan. */
export class ColorEmptyGate {
  private confirmed = false;
  private lastProbe = -Infinity;
  disabled = false;
  canSkip(matches: number, time: number) {
    return !this.disabled && matches === 0 && this.confirmed && time > this.lastProbe && time - this.lastProbe < 1000;
  }
  observe(matches: number, time: number, text: string) {
    if (matches !== 0) { this.confirmed = false; return; }
    this.lastProbe = time;
    this.confirmed = !text;
    if (text) this.disabled = true;
  }
}
