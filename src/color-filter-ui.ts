import { ColorMaskReader, DEFAULT_COLOR_FILTER, parseColorFilter, type ColorFilterOptions } from './color-filter';
import type { Region } from './core';
import { PixelLoupe } from './pixel-loupe';

export function setupColorFilter(video: HTMLVideoElement, stage: HTMLElement, region: () => Region,
  waitForSeek: () => Promise<void>, stopCrop: () => void, toast: (text: string, error?: boolean) => void) {
  const element = document.getElementById('color-filter')!;
  element.innerHTML = `<summary>字幕颜色过滤 <span class="hint">可选</span></summary>
<div class="color-filter-body"><label class="check"><input id="color-filter-enabled" type="checkbox">跳过不含所选颜色的空帧</label>
<div class="color-filter-controls"><label>字幕颜色<input id="subtitle-color" type="color" value="#ffffff"></label><button id="pick-subtitle-color" class="secondary">从画面取色</button><button id="white-subtitle" class="quiet">白色字幕</button><label>颜色容差 <output id="color-tolerance-value">60</output><input id="color-tolerance" type="range" min="0" max="128" step="1" value="60"></label></div>
<div class="color-filter-options"><label class="check"><input id="color-outline" type="checkbox">只保留带深色描边的像素</label><button id="refresh-color-preview" class="quiet">刷新滤镜预览</button></div>
<canvas id="color-mask-preview" aria-label="字幕颜色过滤预览" hidden></canvas><p id="color-filter-status" class="hint" role="status">选择视频后，可预览字幕区域的颜色匹配效果。</p>
<p class="hint">预览中白色为保留像素。仅用于判断空帧，OCR 使用原画面。字色变化或淡入淡出可能漏字幕；边界精修不使用此过滤。换视频后需重新启用。</p></div>`;
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const enabled = $<HTMLInputElement>('color-filter-enabled'), color = $<HTMLInputElement>('subtitle-color');
  const tolerance = $<HTMLInputElement>('color-tolerance'), outline = $<HTMLInputElement>('color-outline');
  const status = $<HTMLParagraphElement>('color-filter-status'), preview = $<HTMLCanvasElement>('color-mask-preview');
  const pick = $<HTMLButtonElement>('pick-subtitle-color');
  const layer = document.createElement('div'); layer.className = 'color-picker-layer'; layer.hidden = true;
  layer.tabIndex = -1; layer.setAttribute('aria-label', '移动鼠标查看像素放大，点击取色；方向键微调，Enter 确认，Esc 取消'); stage.append(layer);
  const loupe = new PixelLoupe(video, stage);
  const reader = new ColorMaskReader();
  let locked = false, hasVideo = false, sequence = 0, pickSequence = 0;
  let initialPreview: ReturnType<typeof setTimeout> | undefined;
  const cancelInitialPreview = () => { clearTimeout(initialPreview); initialPreview = undefined; };
  const options = (): ColorFilterOptions => ({ color: color.value, tolerance: Number(tolerance.value), outline: outline.checked });
  const restore = () => {
    let saved = DEFAULT_COLOR_FILTER;
    try { saved = parseColorFilter(JSON.parse(localStorage.getItem('sub-extract-color-filter') || 'null')) || saved; } catch { /* Use white by default. */ }
    color.value = saved.color; tolerance.value = String(saved.tolerance); outline.checked = saved.outline;
    $('color-tolerance-value').textContent = tolerance.value;
  };
  restore();
  function stopPicking() { ++pickSequence; layer.hidden = true; loupe.hide(); pick.textContent = '从画面取色'; pick.classList.remove('selected'); }
  const currentPick = (ticket: number) => ticket === pickSequence && !locked && hasVideo && (element as HTMLDetailsElement).open;
  function playbackChanged() {
    ++sequence; cancelInitialPreview(); stopPicking(); preview.hidden = true;
    if (hasVideo) status.textContent = video.seeking ? '视频定位中，完成后更新滤镜预览。' : '暂停视频后更新滤镜预览。';
  }
  async function renderPreview() {
    const ticket = ++sequence;
    if (!hasVideo || locked || !layer.hidden || !(element as HTMLDetailsElement).open) return;
    try {
      await waitForSeek();
      if (ticket !== sequence || locked || !hasVideo || !layer.hidden) return;
      if (video.seeking || !video.paused) { preview.hidden = true; status.textContent = '暂停视频并等待定位完成后更新滤镜预览。'; return; }
      if (video.readyState < 2) { preview.hidden = true; status.textContent = '当前画面尚未就绪，请稍后刷新预览。'; return; }
      const result = reader.readVideo(video, region(), options());
      preview.width = result.width; preview.height = result.height;
      const context = preview.getContext('2d')!, image = context.createImageData(result.width, result.height);
      for (let i = 0; i < result.mask.length; i++) {
        image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = result.mask[i] ? 255 : 0;
        image.data[i * 4 + 3] = 255;
      }
      context.putImageData(image, 0, 0); preview.hidden = false;
      status.textContent = result.count ? `保留 ${result.count} 个匹配像素 · 这帧会正常送检或复用已确认的字幕。`
        : '没有匹配像素 · 经 OCR 确认空白后可跳过。若画面有字幕，请重新取色或增大容差。';
    } catch (error) { if (ticket === sequence) status.textContent = error instanceof Error ? error.message : String(error); }
  }
  function changed() {
    $('color-tolerance-value').textContent = tolerance.value;
    try { localStorage.setItem('sub-extract-color-filter', JSON.stringify(options())); } catch { /* Filtering works without storage. */ }
    void renderPreview();
  }
  color.oninput = changed; tolerance.oninput = changed; outline.onchange = changed; enabled.onchange = () => void renderPreview();
  $('white-subtitle').onclick = () => { color.value = '#ffffff'; changed(); };
  $('refresh-color-preview').onclick = () => void renderPreview();
  element.addEventListener('toggle', () => { if ((element as HTMLDetailsElement).open) void renderPreview(); else { ++sequence; cancelInitialPreview(); stopPicking(); } });
  video.addEventListener('seeking', playbackChanged);
  video.addEventListener('play', playbackChanged);
  video.addEventListener('loadeddata', () => {
    // HAVE_CURRENT_DATA can precede the first paint; an immediate Canvas read
    // may still be black. Retry once after presentation without retaining frames.
    cancelInitialPreview();
    const ticket = ++sequence; preview.hidden = true;
    if (hasVideo && !locked) status.textContent = '正在准备视频画面…';
    initialPreview = setTimeout(() => {
      initialPreview = undefined;
      if (ticket === sequence) void renderPreview();
    }, 300);
  });
  video.addEventListener('seeked', () => void renderPreview());
  video.addEventListener('pause', () => void renderPreview());
  pick.onclick = async () => {
    if (locked || !hasVideo) return;
    if (!layer.hidden) { stopPicking(); void renderPreview(); return; }
    video.pause(); stopCrop();
    const ticket = ++pickSequence;
    try {
      await waitForSeek(); if (!currentPick(ticket) || video.seeking || !video.paused) return;
      if (video.readyState < 2) throw new Error('请等待视频画面加载后取色。');
      layer.hidden = false; pick.textContent = '取消取色'; pick.classList.add('selected'); layer.focus({ preventScroll: true });
      const box = region(); loupe.show({ x: Math.floor((box.x + box.width / 2) * video.videoWidth), y: Math.floor((box.y + box.height / 2) * video.videoHeight) });
      status.textContent = '移动鼠标查看 8× 像素放大，中心框为取色像素。点击取色；方向键微调，Enter 确认，Esc 取消。';
    } catch (error) { if (currentPick(ticket)) toast(error instanceof Error ? error.message : String(error), true); }
  };
  async function selectPixel(point: { x: number; y: number }) {
    if (locked || !hasVideo || layer.hidden) return;
    const ticket = ++pickSequence;
    const x = Math.max(0, Math.min(video.videoWidth - 1, point.x)), y = Math.max(0, Math.min(video.videoHeight - 1, point.y));
    try {
      await waitForSeek();
      if (!currentPick(ticket) || layer.hidden || video.seeking || !video.paused) return;
      if (video.readyState < 2) throw new Error('请等待视频画面加载后取色。');
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true })!;
      context.drawImage(video, x, y, 1, 1, 0, 0, 1, 1);
      const pixel = context.getImageData(0, 0, 1, 1).data;
      color.value = '#' + [...pixel.slice(0, 3)].map(channel => channel.toString(16).padStart(2, '0')).join('');
      stopPicking(); changed();
    } catch (error) { if (currentPick(ticket)) { stopPicking(); toast(error instanceof Error ? error.message : String(error), true); } }
  }
  layer.onpointermove = event => { if (!layer.hidden && !locked && hasVideo && !video.seeking) loupe.show(loupe.fromClient(event.clientX, event.clientY)); };
  layer.onpointerleave = () => loupe.hide(false);
  layer.onpointerdown = event => { if (event.button === 0) { event.preventDefault(); return selectPixel(loupe.fromClient(event.clientX, event.clientY)); } };
  layer.onkeydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); stopPicking(); pick.focus(); void renderPreview(); return; }
    if (event.key === 'Enter' && loupe.point) { event.preventDefault(); void selectPixel(loupe.point); return; }
    const directions: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (directions[event.key] && loupe.point && !layer.hidden) {
      event.preventDefault(); const [dx, dy] = directions[event.key], step = event.shiftKey ? 10 : 1;
      loupe.show({ x: loupe.point.x + dx * step, y: loupe.point.y + dy * step });
    }
  };
  return {
    options: () => enabled.checked ? options() : undefined,
    stopPicking,
    preview: renderPreview,
    sourceChanged() {
      ++sequence; cancelInitialPreview(); hasVideo = false; enabled.checked = false; stopPicking(); preview.hidden = true;
      for (const id of ['color-filter-enabled', 'pick-subtitle-color', 'refresh-color-preview']) $<HTMLInputElement>(id).disabled = true;
      status.textContent = '在有字幕的画面取色，并检查滤镜是否保留完整笔画。';
    },
    refresh(isLocked: boolean, source: boolean) {
      const becameReady = !hasVideo && source;
      locked = isLocked; hasVideo = source;
      if (locked || !source) { ++sequence; cancelInitialPreview(); stopPicking(); }
      for (const input of element.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')) input.disabled = locked;
      for (const id of ['color-filter-enabled', 'pick-subtitle-color', 'refresh-color-preview']) $<HTMLInputElement>(id).disabled = locked || !source;
      if (becameReady) void renderPreview();
    },
  };
}
