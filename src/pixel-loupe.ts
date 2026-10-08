/** Read only a small neighbourhood of the paused video, with no interpolation. */
export class PixelLoupe {
  private element = document.createElement('div');
  private canvas = document.createElement('canvas');
  private pixels = document.createElement('canvas');
  private label = document.createElement('span');
  private chip = document.createElement('i');
  private positionLabel = document.createElement('small');
  private target = document.createElement('span');
  private frame?: number;
  point?: { x: number; y: number };
  constructor(private video: HTMLVideoElement, private stage: HTMLElement) {
    this.element.className = 'pixel-loupe'; this.element.hidden = true;
    this.element.setAttribute('aria-hidden', 'true');
    this.canvas.width = this.canvas.height = 136;
    this.pixels.width = this.pixels.height = 17;
    const caption = document.createElement('div'); caption.className = 'pixel-loupe-color';
    caption.append(this.chip, this.label);
    this.element.append(this.canvas, caption, this.positionLabel); document.body.append(this.element);
    this.target.className = 'pixel-loupe-target'; this.target.hidden = true;
    this.target.setAttribute('aria-hidden', 'true'); stage.append(this.target);
  }
  fromClient(clientX: number, clientY: number) {
    const rect = this.stage.getBoundingClientRect();
    return { x: Math.floor((clientX - rect.left) / rect.width * this.video.videoWidth), y: Math.floor((clientY - rect.top) / rect.height * this.video.videoHeight) };
  }
  show(point: { x: number; y: number }) {
    this.point = { x: Math.max(0, Math.min(this.video.videoWidth - 1, point.x)), y: Math.max(0, Math.min(this.video.videoHeight - 1, point.y)) };
    if (this.frame === undefined) this.frame = requestAnimationFrame(() => { this.frame = undefined; this.draw(); });
  }
  hide(clearPoint = true) {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined; if (clearPoint) this.point = undefined;
    this.element.hidden = this.target.hidden = true;
  }
  private draw() {
    const p = this.point, video = this.video;
    if (!p || video.seeking || !video.paused || video.readyState < 2) { this.element.hidden = this.target.hidden = true; return; }
    try {
      const raw = this.pixels.getContext('2d', { willReadFrequently: true })!;
      raw.clearRect(0, 0, 17, 17);
      const left = Math.max(0, p.x - 8), top = Math.max(0, p.y - 8);
      const width = Math.min(video.videoWidth, p.x + 9) - left, height = Math.min(video.videoHeight, p.y + 9) - top;
      raw.drawImage(video, left, top, width, height, left - p.x + 8, top - p.y + 8, width, height);
      const pixel = raw.getImageData(8, 8, 1, 1).data;
      const hex = '#' + [...pixel.slice(0, 3)].map(channel => channel.toString(16).padStart(2, '0')).join('');
      const context = this.canvas.getContext('2d')!;
      context.imageSmoothingEnabled = false; context.clearRect(0, 0, 136, 136);
      context.drawImage(this.pixels, 0, 0, 136, 136);
      context.lineWidth = 1; context.strokeStyle = '#000'; context.strokeRect(62.5, 62.5, 11, 11);
      context.strokeStyle = '#fff'; context.strokeRect(63.5, 63.5, 9, 9);
      this.chip.style.backgroundColor = hex; this.label.textContent = hex.toUpperCase();
      this.positionLabel.textContent = `8× · RGB ${pixel[0]}, ${pixel[1]}, ${pixel[2]}`;
      this.element.hidden = false;
      this.target.hidden = false; this.target.style.left = `${(p.x + .5) / video.videoWidth * 100}%`;
      this.target.style.top = `${(p.y + .5) / video.videoHeight * 100}%`;
      const bounds = this.stage.getBoundingClientRect(), size = this.element.getBoundingClientRect();
      const x = bounds.left + (p.x + .5) / video.videoWidth * bounds.width;
      const y = bounds.top + (p.y + .5) / video.videoHeight * bounds.height;
      const leftPosition = x + size.width + 20 <= innerWidth ? x + 20 : x - size.width - 20;
      const topPosition = y - size.height - 20 >= 8 ? y - size.height - 20 : y + 20;
      this.element.style.left = `${Math.max(8, Math.min(innerWidth - size.width - 8, leftPosition))}px`;
      this.element.style.top = `${Math.max(8, Math.min(innerHeight - size.height - 8, topPosition))}px`;
    } catch { this.element.hidden = this.target.hidden = true; }
  }
}
