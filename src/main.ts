import './style.css';
import { setupPwa } from './pwa';
import thirdPartyNotices from '../THIRD_PARTY_NOTICES.md?raw';
import projectLicense from '../LICENSE?raw';
import { DEFAULT_REGION, clamp, buildCues, formatTime, parseTime, exportSubtitles, validateCues, importProject, normalizeText, moveRegion, resizeRegion, resizeRegionFromCenter, cropPointerMode, type CropCorner, type Region, type Observation, type Project, type Cue } from './core';
import { seekPreview, timelineDuration, cuePreviewTarget, timelineCueAt } from './preview';
import { OcrEngine, type OcrResult, type OcrTextResult, type OcrWindowResult } from './ocr';
import { MODEL_NAME, MODEL_FILES, downloadModels, localModels, clearModelCache, hasCachedModels, type ModelData } from './models';
import { readMetadata, sampleVideo, sampleVideoWindows, cropFrame, type VideoMetadata, type SamplingTimings } from './video';
import { PerformanceTotals } from './performance';
import { OcrCropQueue, OCR_WINDOW_FRAMES } from './ocr-batch';

const icon = (path: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">${path}</svg>`;
const uploadIcon = icon('<path d="M12 16V4m-4 4 4-4 4 4M4 15v5h16v-5"/>');
const cropIcon = icon('<path d="M7 3v14h14M3 7h14v14"/>');
const playIcon = icon('<path d="m9 5 10 7-10 7V5Z"/>');
document.querySelector('#app')!.innerHTML = `
<header class="app-header"><a class="brand" href="#" aria-label="Sub Extract 首页"><span class="brand-symbol">${icon('<path d="M4 6h16v12H4zM7 10h10M7 14h6"/>')}</span>Sub Extract<span class="version">0.1</span></a><div class="header-tools"><span class="local-note"><span class="dot"></span>视频仅在本机处理</span><button id="install-app" class="quiet" hidden>安装应用</button><button id="help" class="quiet">使用说明</button></div></header>
<main class="workspace"><section class="editor"><div class="section-heading"><div><span class="eyebrow">SOURCE / 本地视频</span><h1>硬字幕提取</h1></div><label class="button secondary file-action">${uploadIcon}选择视频<input id="video-file" type="file" accept="video/mp4,video/quicktime,.mp4,.mov,.m4v"></label></div>
<div id="video-stage" class="video-stage"><video id="video" playsinline preload="metadata"></video><div id="video-empty" class="video-empty"><div class="empty-mark">${icon('<path d="M3 5h18v14H3zM9 9l5 3-5 3V9ZM7 5v14M17 5v14"/>')}</div><p>选择或拖入带有硬字幕的视频</p><span>MP4 / MOV · 推荐 H.264 编码</span><label class="button primary file-action">${uploadIcon}打开本地视频<input id="video-file-empty" type="file" accept="video/mp4,video/quicktime,.mp4,.mov,.m4v"></label></div><div id="crop-layer" class="crop-layer" aria-label="在视频中拖动框选字幕区域"><div class="center-guide center-guide-x" id="center-guide-x" hidden></div><div class="center-guide center-guide-y" id="center-guide-y" hidden></div><div id="crop-box" class="crop-box" tabindex="0" role="group" aria-label="字幕区域，拖动移动，角点缩放，方向键微调"><span>字幕区域</span><button class="crop-handle" data-corner="nw" aria-label="调整字幕区域左上角"></button><button class="crop-handle" data-corner="ne" aria-label="调整字幕区域右上角"></button><button class="crop-handle" data-corner="se" aria-label="调整字幕区域右下角"></button><button class="crop-handle" data-corner="sw" aria-label="调整字幕区域左下角"></button></div></div></div>
<div id="transport" class="transport" hidden><button id="play-pause" class="quiet" aria-label="播放视频">${playIcon}</button><input id="video-scrub" type="range" min="0" max="1" step="0.04" value="0" aria-label="视频播放位置"><span id="play-time" class="mono">00:00 / 00:00</span><button id="mute-video" class="quiet" aria-label="静音视频">静音</button></div>
<div class="video-caption"><span id="video-name">尚未选择视频</span><span id="video-info">—</span></div>
<div class="crop-toolbar"><button id="select-region" class="secondary">${cropIcon}框选字幕</button><button id="reset-region" class="quiet">底部区域</button><button id="full-region" class="quiet">整幅画面</button><span id="region-info" class="mono" title="拖动字幕框移动，拖动角点缩放，靠近画面中心自动吸附">—</span><button id="test-frame" class="quiet">识别当前帧</button></div>
<div id="frame-result" class="frame-result" hidden><span class="eyebrow">当前帧</span><span id="frame-text"></span><span id="frame-timing" class="mono"></span></div>
<div class="settings"><section class="model-section"><div class="settings-heading"><h2><span class="step">01</span>识别模型</h2><span id="backend-badge" class="badge">${navigator.gpu ? 'WebGPU 可用' : 'WASM 可用'}</span></div><div class="model-row"><div><strong>${MODEL_NAME}</strong><p>检测 + 识别 + 字典 · 约 15.6 MB</p></div><button id="load-online" class="secondary">下载并加载模型</button></div><div class="backend-row"><label>推理方式<select id="backend"><option value="auto">自动 · 优先 WebGPU</option><option value="webgpu">WebGPU</option><option value="wasm">WASM · CPU</option></select></label><button id="clear-cache" class="quiet">清除模型缓存</button></div><details id="local-models"><summary>使用本地模型文件</summary><p class="hint">兼容 PP-OCRv4：识别输入高度 48，配套 UTF-8 字符字典。</p><div class="local-files"><label>检测模型<input id="detector-file" type="file" accept=".onnx"></label><label>识别模型<input id="recognizer-file" type="file" accept=".onnx"></label><label>字符字典<input id="dictionary-file" type="file" accept=".txt"></label></div><div class="local-model-footer"><button id="load-local" class="secondary">加载所选文件</button><span class="hint">示例文件：${MODEL_FILES.map(m => `<a href="${m.url}" target="_blank" rel="noreferrer">${m.name}</a>`).join(' · ')}</span></div></details><p id="model-status" class="status-text" role="status">加载一次即可识别；在线模型会缓存在当前浏览器。</p></section>
<section class="scan-section"><div class="settings-heading"><h2><span class="step">02</span>识别范围</h2><button id="whole-video" class="quiet">整段视频</button></div><div class="scan-fields"><label>开始时间<input id="range-start" type="text" value="00:00:00.000" spellcheck="false" inputmode="decimal"></label><label>结束时间<input id="range-end" type="text" value="00:00:00.000" spellcheck="false" inputmode="decimal"></label><label>采样密度<select id="interval"><option value="500">2 帧 / 秒 · 快速</option><option value="250" selected>4 帧 / 秒 · 标准</option><option value="100">10 帧 / 秒 · 精细</option></select></label></div><div class="scan-options"><label class="check" title="WebGPU 将相同尺寸的裁图两张一组处理；关闭可对照单张速度。"><input id="batch-ocr" type="checkbox" checked>批量加速</label><label class="check"><input id="refine" type="checkbox" checked>精修变化边界</label><label class="confidence-control">最低识别置信度<input id="confidence" type="number" value="0.75" min="0.1" max="0.99" step="0.05"></label></div><p class="hint">精修在已发现的变化附近以 50 ms 采样；短于采样间隔的字幕仍可能漏检。</p></section></div>
<div class="run-bar"><div><p id="run-status" role="status">选择视频并加载模型后开始。</p><span id="run-detail" class="hint">建议先识别 30–60 秒，确认字幕区域和效果。</span></div><button id="cancel" class="secondary" hidden>停止</button><button id="extract" class="primary">${playIcon}开始提取</button></div><progress id="progress" value="0" max="1" aria-label="提取进度"></progress>
</section><aside class="timeline-panel"><div class="timeline-heading"><div><span class="eyebrow">TIMELINE / 字幕时间轴</span><h2><span id="cue-count">0</span> 条字幕</h2></div><label class="quiet file-action import-action">导入 JSON<input id="import-json" type="file" accept=".json"></label></div><div class="timeline-summary"><span id="review-count">0 条待复核</span><span id="timeline-duration" class="mono">00:00:00.000</span></div><canvas id="timeline" height="48" aria-label="字幕分布，点击跳转"></canvas><div class="list-tools"><input id="search" type="search" placeholder="搜索字幕…" aria-label="搜索字幕"><label class="check"><input id="review-only" type="checkbox">待复核</label></div><div id="cue-list" class="cue-list"><div class="timeline-empty"><span class="empty-number">Aa</span><p>识别后的字幕会显示在这里</p><span>点击时间跳转 · 编辑文本与起止时间</span></div></div><div class="timeline-footer"><div class="export-actions"><button data-export="srt" class="secondary">导出 SRT</button><button data-export="vtt" class="secondary">WebVTT</button><button data-export="json" class="secondary">JSON</button></div><div class="footer-actions"><button id="add-cue" class="quiet">＋ 添加字幕</button><button id="clear-cues" class="quiet">清空时间轴</button></div></div></aside></main>
<div id="toast" class="toast" role="alert" hidden></div>
<dialog id="help-dialog"><div class="dialog-heading"><h2>使用说明</h2><button id="close-help" class="quiet" aria-label="关闭">✕</button></div><ol><li>选择本地视频或将文件拖入视频区域，在预览中找到有字幕的画面。</li><li>点击「重新框选」选取横排字幕区域，容纳完整文字和少量边距。之后可直接拖动框移动、拖动角点缩放，接近画面中心自动吸附。按住 Ctrl 或 ⌘ 拖动可固定中心对称缩放，兼容系统键位交换。方向键微调，Shift 加速，Esc 取消拖动。</li><li>下载模型，或选择兼容的检测模型、识别模型、字典。可先「识别当前帧」检查效果。</li><li>输入处理起止时间，开始提取。停止后可保留已有结果。</li><li>检查待复核字幕，修正文本和时间，导出所需格式。</li></ol><p>JSON 保存视频信息、字幕区域、置信度和时间轴，可导入继续编辑。SRT / WebVTT 使用视频原始时间；字幕时间对应画面显示，而非语音起止。</p><p>在线模型需要访问 Hugging Face / GitHub。使用本地模型时，单 HTML 可离线运行。首版面向横排字幕，竖排、旋转文字和复杂花字需要复核。</p><details><summary>开源组件与许可</summary><pre id="third-party-notices"></pre></details></dialog>`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
$('third-party-notices').textContent = `Sub Extract\n===========\n\n${projectLicense}\n\n${thirdPartyNotices}`;
const video = $<HTMLVideoElement>('video');
const stage = $('video-stage');
const cueList = $('cue-list');
const profiling = new URLSearchParams(location.search).get('profile') === '1';
function readSavedRegion(): Region {
  try {
    const saved = JSON.parse(localStorage.getItem('sub-extract-region') || 'null') as Region | null;
    if (saved && [saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)
      && saved.x >= 0 && saved.x < 1 && saved.y >= 0 && saved.y < 1 && saved.width > 0 && saved.height > 0
      && saved.x + saved.width <= 1 + 1e-9 && saved.y + saved.height <= 1 + 1e-9) {
      return { x: saved.x, y: saved.y, width: Math.min(saved.width, 1 - saved.x), height: Math.min(saved.height, 1 - saved.y) };
    }
  } catch { /* Missing, invalid, or unavailable storage uses the default region. */ }
  return { ...DEFAULT_REGION };
}
function rememberRegion() {
  try { localStorage.setItem('sub-extract-region', JSON.stringify(region)); } catch { /* Region editing still works without storage. */ }
}
let source: File | undefined;
let sourceURL: string | undefined;
let region: Region = readSavedRegion();
let engine: OcrEngine | undefined;
let engineReady = false, engineBackend = '', engineModel = MODEL_NAME;
let modelMode: 'online' | 'local' | undefined, cachedModels = false;
let active: AbortController | undefined;
let busy: 'model' | 'scan' | 'frame' | undefined;
let project: Project | undefined;
let metadata: VideoMetadata | undefined;
let observations: Observation[] = [];
let cropMode = false, currentCueId = '', toastTimer = 0;
let previewSeek: AbortController | undefined;
let pendingSeek: Promise<void> = Promise.resolve();
function seekTo(timeMs: number, frameTimeMs?: number) {
  previewSeek?.abort();
  const controller = new AbortController(); previewSeek = controller;
  pendingSeek = seekPreview(video, timeMs, controller.signal, frameTimeMs).then(() => {
    if (!controller.signal.aborted) updatePlaybackPosition();
  });
  void pendingSeek.catch(error => { if (!controller.signal.aborted) toast(message(error), true); });
}
function seekCue(cue: Cue) {
  const meta = metadata;
  const sample = meta?.samples.find(sample => Math.abs(sample.cts / sample.timescale * 1000 + meta.offsetMs - cue.sampleTime) < 0.001);
  const duration = sample ? sample.duration / sample.timescale * 1000 : undefined;
  const target = cuePreviewTarget(cue, duration);
  seekTo(target.timeMs, target.frameTimeMs);
}

function toast(message: string, error = false) {
  const element = $('toast'); element.textContent = message; element.hidden = false; element.classList.toggle('error', error);
  clearTimeout(toastTimer); toastTimer = window.setTimeout(() => { element.hidden = true; }, error ? 9000 : 4000);
}
function disposeEngine() { engine?.dispose(); engine = undefined; }
function invalidateFailedEngine() {
  if (!engine?.isDisposed) return;
  engineReady = false; disposeEngine();
  $('model-status').textContent = '识别模型已停止，请重新加载模型。';
  $('backend-badge').textContent = '待加载';
}
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function refreshControls() {
  const locked = Boolean(busy);
  for (const id of ['load-online', 'load-local', 'backend', 'detector-file', 'recognizer-file', 'dictionary-file', 'video-file', 'video-file-empty', 'import-json', 'select-region', 'reset-region', 'full-region', 'range-start', 'range-end', 'interval', 'confidence', 'refine', 'batch-ocr', 'whole-video', 'clear-cache', 'clear-cues', 'add-cue']) ($<HTMLInputElement>(id)).disabled = locked;
  const onlineButton = $<HTMLButtonElement>('load-online');
  onlineButton.disabled = locked || (engineReady && modelMode === 'online');
  onlineButton.textContent = busy === 'model' && modelMode === 'online' ? '加载模型中…' : engineReady && modelMode === 'online' ? '模型已就绪' : engineReady && modelMode === 'local' ? '切换到预设模型' : cachedModels ? '加载缓存模型' : '下载并加载模型';
  $('load-local').textContent = busy === 'model' && modelMode === 'local' ? '加载模型中…' : engineReady && modelMode === 'local' ? '重新加载本地模型' : '加载所选文件';
  $<HTMLButtonElement>('extract').disabled = locked || !source || !engineReady;
  $<HTMLButtonElement>('test-frame').disabled = locked || !source || !engineReady;
  $('cancel').hidden = !locked; $('extract').hidden = locked;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-export]')) button.disabled = locked || !project?.cues.length;
  for (const input of cueList.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>('input, textarea, button')) input.disabled = locked;
  $('crop-layer').classList.toggle('selecting', cropMode && !locked);
  $('crop-box').classList.toggle('locked', locked); $('crop-box').tabIndex = locked || !source ? -1 : 0;
  $('crop-box').setAttribute('aria-disabled', String(locked));
  $('crop-box').title = locked ? '识别中，字幕区域已固定' : '拖动移动 · 角点缩放 · Ctrl / ⌘ 拖动对称缩放 · 靠近中心吸附 · 方向键微调（Shift 加速）';
  for (const handle of document.querySelectorAll<HTMLButtonElement>('.crop-handle')) handle.disabled = locked || !source;
}
function updateRegion() {
  const box = $('crop-box'); box.style.left = `${region.x * 100}%`; box.style.top = `${region.y * 100}%`; box.style.width = `${region.width * 100}%`; box.style.height = `${region.height * 100}%`;
  $('crop-layer').hidden = !source;
  $('select-region').innerHTML = cropIcon + (source ? '重新框选' : '框选字幕');
  $('region-info').textContent = source ? `${Math.round(region.width * video.videoWidth)} × ${Math.round(region.height * video.videoHeight)} px` : '—';
}
function setCropMode(value: boolean) { cropMode = value; $('select-region').classList.toggle('selected', value); refreshControls(); }

async function loadVideo(file: File) {
  if (busy) return;
  if (project?.cues.length && source && !confirm('更换视频将清空当前时间轴。请先导出 JSON 保存结果。继续更换？')) return;
  if (source) { project = undefined; observations = []; }
  previewSeek?.abort();
  pendingSeek = Promise.resolve();
  if (sourceURL) URL.revokeObjectURL(sourceURL);
  source = file; metadata = undefined; sourceURL = URL.createObjectURL(file); $('frame-result').hidden = true;
  video.src = sourceURL; $('video-empty').hidden = true; stage.classList.add('has-video');
  $('video-name').textContent = file.name; $('video-info').textContent = '读取视频…';
  $<HTMLInputElement>('range-start').value = formatTime(0);
  try {
    await new Promise<void>((resolve, reject) => {
      const loaded = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('浏览器无法播放该视频，请使用 H.264 MP4。')); };
      const cleanup = () => { video.removeEventListener('loadedmetadata', loaded); video.removeEventListener('error', failed); };
      video.addEventListener('loadedmetadata', loaded, { once: true }); video.addEventListener('error', failed, { once: true });
    });
    if (source !== file) return;
    stage.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
    $('transport').hidden = false; $<HTMLInputElement>('video-scrub').max = String(video.duration); updateTransport();
    $<HTMLInputElement>('range-end').value = formatTime(video.duration * 1000);
    $('video-info').textContent = `${video.videoWidth} × ${video.videoHeight} · ${formatTime(video.duration * 1000).split('.')[0]}`;
    if (project && Math.abs(project.source.duration - video.duration * 1000) > 1000) toast('导入项目与当前视频的时长不一致，请检查时间轴。', true);
    $('run-status').textContent = engineReady ? '已就绪，可以开始提取。' : '视频已载入，请加载识别模型。';
    updateRegion(); renderCues(); refreshControls();
  } catch (error) { if (source !== file) return; toast(message(error), true); source = undefined; $('video-empty').hidden = false; stage.classList.remove('has-video'); $('transport').hidden = true; refreshControls(); }
}
for (const id of ['video-file', 'video-file-empty']) $<HTMLInputElement>(id).addEventListener('change', e => { const file = (e.target as HTMLInputElement).files?.[0]; if (file) void loadVideo(file); });

const dropHint = document.createElement('div');
dropHint.className = 'video-drop-hint'; dropHint.hidden = true; dropHint.setAttribute('role', 'status');
stage.append(dropHint);
let fileDragDepth = 0;
const isFileDrag = (event: DragEvent) => event.dataTransfer?.types.includes('Files');
function clearFileDrag() { fileDragDepth = 0; stage.classList.remove('file-drag-over'); dropHint.hidden = true; }
function showFileDrag(event: DragEvent) {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
  stage.classList.add('file-drag-over'); dropHint.hidden = false;
  dropHint.textContent = busy ? '任务进行中，请结束后再拖入视频' : source ? '松开以更换视频' : '松开以打开视频';
}
stage.addEventListener('dragenter', event => { if (isFileDrag(event)) { fileDragDepth++; showFileDrag(event); } });
stage.addEventListener('dragover', event => { if (isFileDrag(event)) showFileDrag(event); });
stage.addEventListener('dragleave', () => { if (--fileDragDepth <= 0) clearFileDrag(); });
stage.addEventListener('drop', event => {
  if (!isFileDrag(event)) return;
  event.preventDefault(); clearFileDrag();
  if (busy) return toast('任务进行中，请结束后再拖入视频。');
  const files = event.dataTransfer?.files;
  if (!files?.length) return toast('请拖入一个本地视频文件。', true);
  if (files.length !== 1) return toast('请一次拖入一个视频文件。', true);
  const file = files[0];
  if (!/\.(mp4|mov|m4v)$/i.test(file.name)) return toast('请使用 MP4 / MOV / M4V 视频文件。', true);
  void loadVideo(file);
});
// Keep a dropped file from replacing this page with the browser's file viewer.
document.addEventListener('dragover', event => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  if (!stage.contains(event.target as Node) && event.dataTransfer) event.dataTransfer.dropEffect = 'none';
});
document.addEventListener('drop', event => { if (isFileDrag(event)) { event.preventDefault(); clearFileDrag(); } });
window.addEventListener('dragend', clearFileDrag);
window.addEventListener('blur', clearFileDrag);

$('select-region').onclick = () => { if (!source) return toast('请先选择视频。'); setCropMode(!cropMode); };
$('reset-region').onclick = () => { region = { ...DEFAULT_REGION }; rememberRegion(); updateRegion(); setCropMode(false); };
$('full-region').onclick = () => { region = { x: 0, y: 0, width: 1, height: 1 }; rememberRegion(); updateRegion(); setCropMode(false); };
interface CropDrag { x: number; y: number; old: Region; pointerId: number; mode: 'select' | 'move' | 'resize' | 'center'; corner?: CropCorner; axis?: 'x' | 'y' }
let drag: CropDrag | undefined, guideTimer = 0;
const point = (event: PointerEvent) => { const rect = stage.getBoundingClientRect(); return { x: clamp((event.clientX - rect.left) / rect.width, 0, 1), y: clamp((event.clientY - rect.top) / rect.height, 0, 1) }; };
function guides(x = false, y = false) {
  clearTimeout(guideTimer); $('center-guide-x').hidden = !x; $('center-guide-y').hidden = !y;
  $('crop-box').classList.toggle('snapped', x || y);
}
$('crop-layer').onpointerdown = event => {
  if (!source || busy) return;
  const target = event.target as HTMLElement, corner = target.closest<HTMLElement>('.crop-handle')?.dataset.corner as CropCorner | undefined;
  const mode = cropPointerMode(event, cropMode, corner); if (!mode) return;
  if (!cropMode && !target.closest('#crop-box')) return;
  event.preventDefault(); video.pause(); $('crop-box').focus({ preventScroll: true });
  const p = point(event); drag = { ...p, old: { ...region }, pointerId: event.pointerId, mode, corner };
  $('crop-box').classList.toggle('center-resizing', drag.mode === 'center');
  $('crop-layer').setPointerCapture(event.pointerId); $('crop-layer').classList.add('dragging'); guides();
};
$('crop-layer').onpointermove = event => {
  if (!drag) return;
  const p = point(event), dx = p.x - drag.x, dy = p.y - drag.y;
  if (drag.mode === 'select') region = { x: Math.min(drag.x, p.x), y: Math.min(drag.y, p.y), width: Math.abs(dx), height: Math.abs(dy) };
  else if (drag.mode === 'center') {
    const bounds = stage.getBoundingClientRect();
    if (!drag.corner && !drag.axis && Math.max(Math.abs(dx) * bounds.width, Math.abs(dy) * bounds.height) > 2) drag.axis = Math.abs(dx) * bounds.width >= Math.abs(dy) * bounds.height ? 'x' : 'y';
    const cx = drag.old.x + drag.old.width / 2, cy = drag.old.y + drag.old.height / 2;
    const west = drag.corner ? drag.corner.endsWith('w') : drag.x < cx;
    const north = drag.corner ? drag.corner.startsWith('n') : drag.y < cy;
    region = resizeRegionFromCenter(drag.old, drag.corner || drag.axis === 'x' ? dx * (west ? -1 : 1) : 0, drag.corner || drag.axis === 'y' ? dy * (north ? -1 : 1) : 0, 16 / video.videoWidth, 8 / video.videoHeight);
  }
  else if (drag.mode === 'resize') region = resizeRegion(drag.old, drag.corner!, dx, dy, 16 / video.videoWidth, 8 / video.videoHeight);
  else {
    const bounds = stage.getBoundingClientRect();
    const moved = moveRegion(drag.old, dx, dy, 8 / bounds.width, 8 / bounds.height);
    region = moved.region; guides(moved.snappedX, moved.snappedY);
  }
  updateRegion();
};
$('crop-layer').onpointerup = event => {
  if (!drag) return;
  if (region.width * video.videoWidth < 16 || region.height * video.videoHeight < 8) { region = drag.old; toast('选取的字幕区域太小，请重新框选。'); }
  drag = undefined; $('crop-layer').releasePointerCapture(event.pointerId); $('crop-layer').classList.remove('dragging');
  $('crop-box').classList.remove('center-resizing');
  rememberRegion();
  updateRegion(); setCropMode(false); guideTimer = window.setTimeout(() => guides(), 650); $('crop-box').focus({ preventScroll: true });
};
const cancelDrag = () => {
  const previous = drag;
  if (previous) region = previous.old;
  drag = undefined;
  if (previous && $('crop-layer').hasPointerCapture(previous.pointerId)) $('crop-layer').releasePointerCapture(previous.pointerId);
  $('crop-layer').classList.remove('dragging'); $('crop-box').classList.remove('center-resizing'); guides(); updateRegion();
};
$('crop-layer').oncontextmenu = event => { if (event.ctrlKey || event.metaKey || drag?.mode === 'center') event.preventDefault(); };
$('crop-layer').onpointercancel = cancelDrag;
$('crop-layer').onlostpointercapture = () => { if (drag) cancelDrag(); };
$('crop-box').onkeydown = event => {
  if (!source || busy || event.ctrlKey || event.metaKey) return;
  if (event.key === 'Escape') { cancelDrag(); setCropMode(false); return; }
  const direction: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (!direction[event.key]) return;
  event.preventDefault(); const [x, y] = direction[event.key], step = event.shiftKey ? 10 : 1;
  const dx = x * step / video.videoWidth, dy = y * step / video.videoHeight;
  const corner = (event.target as HTMLElement).dataset.corner as CropCorner | undefined;
  region = corner ? resizeRegion(region, corner, dx, dy, 16 / video.videoWidth, 8 / video.videoHeight) : moveRegion(region, dx, dy).region;
  if (!drag) rememberRegion();
  guides(); updateRegion();
};

async function loadModel(mode: 'online' | 'local') {
  busy = 'model'; modelMode = mode; active = new AbortController(); const signal = active.signal; engineReady = false;
  disposeEngine(); setCropMode(false); refreshControls();
  $('model-status').textContent = '准备模型…'; $('run-status').textContent = '正在加载识别模型…';
  try {
    const models: ModelData = mode === 'online' ? await downloadModels(signal, value => { $('model-status').textContent = value; }) : await localModels($<HTMLInputElement>('detector-file').files?.[0], $<HTMLInputElement>('recognizer-file').files?.[0], $<HTMLInputElement>('dictionary-file').files?.[0]);
    signal.throwIfAborted();
    const requested = $<HTMLSelectElement>('backend').value;
    const preferred = requested === 'auto' ? (navigator.gpu ? 'webgpu' : 'wasm') : requested;
    $('model-status').textContent = `初始化 ${preferred === 'webgpu' ? 'WebGPU' : 'WASM'} 模型…`;
    let fallback = '';
    const initialize = async (backend: string) => {
      engine = new OcrEngine(profiling);
      return engine.init({ detector: models.detector.slice(0), recognizer: models.recognizer.slice(0), dictionary: models.dictionary }, backend);
    };
    let result;
    try { result = await initialize(preferred); }
    catch (error) {
      if (signal.aborted || preferred !== 'webgpu' || requested !== 'auto') throw error;
      fallback = `WebGPU 未能加载，已回退 WASM。${message(error)}`;
      disposeEngine(); $('model-status').textContent = 'WebGPU 加载失败，尝试 WASM…'; result = await initialize('wasm');
    }
    signal.throwIfAborted(); engineReady = true; engineBackend = result.backend; engineModel = mode === 'online' ? MODEL_NAME : '本地 PP-OCRv4 兼容模型';
    $('backend-badge').textContent = result.backend === 'webgpu' ? 'WebGPU 已启用' : 'WASM · CPU';
    $('model-status').textContent = fallback || `模型已就绪 · ${result.dictionarySize - 1} 个字符类别${result.gpu ? ' · ' + result.gpu : ''}`;
    $('run-status').textContent = source ? '已就绪，可以开始提取。' : '模型已载入，请选择视频。';
    if (fallback) toast('WebGPU 加载失败，已启用 WASM；详情见模型状态。', true);
  } catch (error) {
    disposeEngine();
    $('model-status').textContent = signal.aborted ? '模型加载已取消。' : message(error);
    $('run-status').textContent = '模型尚未就绪。'; if (!signal.aborted) toast(message(error), true);
  } finally { cachedModels = await hasCachedModels(); busy = undefined; active = undefined; refreshControls(); }
}
$('load-online').onclick = () => void loadModel('online');
$('load-local').onclick = () => void loadModel('local');
$('clear-cache').onclick = async () => { try { await clearModelCache(); cachedModels = false; refreshControls(); if (!engineReady && !busy) $('model-status').textContent = '模型缓存已清除，请下载或选择本地模型。'; toast('在线模型缓存已清除。'); } catch { toast('当前浏览器无法访问模型缓存。', true); } };
$('backend').onchange = () => { try { localStorage.setItem('sub-extract-backend', $<HTMLSelectElement>('backend').value); } catch { /* Storage may be unavailable. */ } engineReady = false; disposeEngine(); $('model-status').textContent = '推理方式已更改，请重新加载模型。'; $('backend-badge').textContent = '待加载'; refreshControls(); };

function updateTransport() {
  $<HTMLInputElement>('video-scrub').value = String(video.currentTime);
  $('play-time').textContent = `${formatTime(video.currentTime * 1000)} / ${formatTime((video.duration || 0) * 1000)}`;
  $('play-pause').innerHTML = video.paused ? playIcon : icon('<path d="M8 5v14M16 5v14"/>');
  $('play-pause').setAttribute('aria-label', video.paused ? '播放视频' : '暂停视频');
}
$('play-pause').onclick = () => { if (video.paused) void video.play().catch(e => toast(message(e), true)); else video.pause(); };
video.onplay = () => { previewSeek?.abort(); pendingSeek = Promise.resolve(); updateTransport(); }; video.onpause = updateTransport;
$('video-scrub').oninput = e => { seekTo(Number((e.target as HTMLInputElement).value) * 1000); };
$('mute-video').onclick = () => { video.muted = !video.muted; $('mute-video').textContent = video.muted ? '取消静音' : '静音'; };

function minConfidence() { const value = Number($<HTMLInputElement>('confidence').value); if (!Number.isFinite(value) || value < 0.1 || value > 0.99) throw new Error('最低置信度应在 0.1–0.99 之间。'); return value; }
function observation(result: OcrTextResult, time: number): Observation {
  return { time, text: result.text, confidence: result.confidence, lines: result.lines.map(line => ({ ...line, box: { x: region.x + line.box.x * region.width, y: region.y + line.box.y * region.height, width: line.box.width * region.width, height: line.box.height * region.height } })) };
}
$('test-frame').onclick = async () => {
  if (!engineReady || !engine || !source) return;
  busy = 'frame'; video.pause(); refreshControls();
  try {
    await pendingSeek;
    const result = await engine.recognize(await cropFrame(video, region), minConfidence());
    $('frame-result').hidden = false; $('frame-text').textContent = result.text || '未检测到符合置信度的文字，尝试调整区域或降低阈值。';
    $('frame-timing').textContent = `${Math.round(result.elapsed)} ms${result.text ? ' · ' + (result.confidence * 100).toFixed(0) + '%' : ''}`;
  } catch (error) { if (engineReady) toast(message(error), true); invalidateFailedEngine(); }
  finally { busy = undefined; $('run-status').textContent = engineReady ? '已就绪，可以开始提取。' : '请重新加载模型。'; refreshControls(); }
};
$('batch-ocr').onchange = () => { try { localStorage.setItem('sub-extract-batch', String($<HTMLInputElement>('batch-ocr').checked)); } catch { /* Use current selection without storage. */ } };
$('whole-video').onclick = () => { $<HTMLInputElement>('range-start').value = formatTime(0); $<HTMLInputElement>('range-end').value = formatTime(video.duration * 1000 || 0); };

async function extract() {
  if (!source || !engineReady || !engine) return;
  const start = parseTime($<HTMLInputElement>('range-start').value), end = parseTime($<HTMLInputElement>('range-end').value), interval = Number($<HTMLSelectElement>('interval').value);
  if (start === null || end === null || start < 0 || end <= start || end > video.duration * 1000 + 1) return toast('请输入有效的起止时间，结束时间不能超过视频时长。', true);
  let confidence: number; try { confidence = minConfidence(); } catch (e) { return toast(message(e), true); }
  if (project?.cues.length && !confirm('重新提取将替换当前时间轴。请先导出 JSON 保存修改。继续？')) return;
  busy = 'scan'; active = new AbortController(); const signal = active.signal; video.pause(); setCropMode(false); observations = [];
  project = { schemaVersion: 1, timeUnit: 'ms', source: { name: source.name, duration: Math.round(video.duration * 1000), width: video.videoWidth, height: video.videoHeight }, extraction: { region: { ...region }, start, end, sampleInterval: interval, backend: engineBackend, model: engineModel, complete: false }, cues: [] };
  const started = performance.now(); let lastRender = 0, refineCount = 0, coarseCount = 0, coarseComplete = false;
  const batchEnabled = engineBackend === 'webgpu' && $<HTMLInputElement>('batch-ocr').checked;
  let batchFallback = false;
  const modeLabel = () => batchEnabled ? batchFallback ? '批量加速 · 部分模型使用单张' : '批量加速' : '单张处理';
  const metrics = profiling ? new PerformanceTotals() : undefined;
  const samplingTimings = (): SamplingTimings | undefined => metrics ? { submittedFrames: 0, decodedFrames: 0, selectedFrames: 0, readMs: 0, queueWaitMs: 0, consumerMs: 0, wallMs: 0 } : undefined;
  const recordSampling = (phase: string, values: SamplingTimings | undefined) => {
    if (!values || !metrics) return;
    for (const [key, value] of Object.entries(values)) {
      if (key.endsWith('Ms')) metrics.add(`${phase}.${key}`, value); else metrics.count(`${phase}.${key}`, value);
    }
  };
  const recordOcr = (result: OcrResult | OcrWindowResult, phase: string, roundTrip: number) => {
    if (!metrics) return;
    metrics.add(`${phase}.workerMs`, roundTrip);
    metrics.add(`${phase}.workerOverheadMs`, Math.max(0, roundTrip - result.elapsed));
    metrics.add(`${phase}.ocrMs`, result.elapsed);
    for (const [key, value] of Object.entries(result.timings || {})) {
      if (key.endsWith('Ms')) metrics.add(`${phase}.${key}`, value); else metrics.count(`${phase}.${key}`, value);
    }
    for (const [key, value] of Object.entries(result.counts || {})) metrics.count(`${phase}.${key}`, value);
  };
  const queueFor = (phase: 'coarse' | 'refine', accept: (result: OcrTextResult, time: number) => void) => {
    const queue = new OcrCropQueue<ImageBitmap>(batchEnabled ? OCR_WINDOW_FRAMES : 1, signal, async items => {
      const workerStarted = performance.now();
      try {
        if (batchEnabled) {
          const result = await engine!.recognizeWindow(items.map(item => item.bitmap), confidence);
          batchFallback ||= result.fallback;
          recordOcr(result, phase, performance.now() - workerStarted);
          result.values.forEach((value, i) => accept(value, items[i].time));
        } else {
          const result = await engine!.recognize(items[0].bitmap, confidence);
          recordOcr(result, phase, performance.now() - workerStarted);
          accept(result, items[0].time);
        }
      } finally { items.forEach(item => item.bitmap.close()); }
      // Keep a completed in-flight window even when Stop was pressed during OCR.
      signal.throwIfAborted();
    });
    return { queue, consume: async (frame: VideoFrame, time: number) => {
      signal.throwIfAborted();
      const cropStarted = metrics ? performance.now() : 0;
      const bitmap = await cropFrame(frame, region);
      if (metrics) metrics.add(`${phase}.cropMs`, performance.now() - cropStarted);
      await queue.add(bitmap, time);
    } };
  };
  const displayProgress = (time: number, phase: string, value: number) => {
    $<HTMLProgressElement>('progress').value = value;
    $('run-status').textContent = `${phase} · ${formatTime(time)}`;
    $('run-detail').textContent = `${coarseCount} 个采样帧${refineCount ? ' + ' + refineCount + ' 个边界帧' : ''} · 已用 ${((performance.now() - started) / 1000).toFixed(1)} 秒 · ${engineBackend.toUpperCase()} · ${modeLabel()}`;
  };
  renderCues(); refreshControls();
  $<HTMLProgressElement>('progress').value = 0;
  $('run-detail').textContent = `准备提取 · ${engineBackend.toUpperCase()} · ${modeLabel()}`;
  try {
    $('run-status').textContent = '读取视频索引…';
    const indexStarted = metrics ? performance.now() : 0;
    metadata ||= await readMetadata(source, signal);
    if (metrics) metrics.add('metadataMs', performance.now() - indexStarted);
    const coarseTimings = samplingTimings();
    const coarse = queueFor('coarse', (result, time) => {
      observations.push(observation(result, time)); coarseCount++;
      displayProgress(time, '识别字幕', ((time - start) / (end - start)) * ($<HTMLInputElement>('refine').checked ? 0.85 : 1));
      if (performance.now() - lastRender > 1000) {
        const renderStarted = metrics ? performance.now() : 0;
        project!.cues = buildCues(observations, start, Math.min(end, time + interval / 2), interval);
        renderCues(); lastRender = performance.now();
        if (metrics) metrics.add('renderMs', lastRender - renderStarted);
      }
    });
    try {
      await sampleVideo(source, metadata, { start, end, interval }, signal, coarse.consume, coarseTimings);
      await coarse.queue.flush(); coarseComplete = true;
    } finally { coarse.queue.dispose(); recordSampling('coarse', coarseTimings); }
    if ($<HTMLInputElement>('refine').checked) {
      const windows: { start: number; end: number }[] = [];
      for (let i = 1; i < observations.length; i++) if (normalizeText(observations[i - 1].text) !== normalizeText(observations[i].text)) {
        const window = { start: observations[i - 1].time, end: observations[i].time };
        const previous = windows.at(-1); if (previous && window.start <= previous.end) previous.end = window.end; else windows.push(window);
      }
      const existingTimes = new Set(observations.map(o => Math.round(o.time)));
      const refineTimings = samplingTimings();
      const refine = queueFor('refine', (result, time) => {
        observations.push(observation(result, time)); refineCount++;
        displayProgress(time, '精修字幕边界', 0.85 + 0.15 * clamp((time - start) / (end - start), 0, 1));
      });
      try {
        await sampleVideoWindows(source, metadata, windows.map(window => ({ start: window.start, end: window.end + 1, interval: 50 })), signal, async (frame, time) => {
          if (existingTimes.has(Math.round(time))) return;
          existingTimes.add(Math.round(time));
          await refine.consume(frame, time);
        }, refineTimings);
        await refine.queue.flush();
      } finally { refine.queue.dispose(); recordSampling('refine', refineTimings); }
      observations.sort((a, b) => a.time - b.time);
    }
    project.cues = buildCues(observations, start, end, interval); project.extraction.complete = true;
    $<HTMLProgressElement>('progress').value = 1;
    $('run-status').textContent = `提取完成 · ${project.cues.length} 条字幕`;
    $('run-detail').textContent = `${observations.length} 个采样帧 · 用时 ${((performance.now() - started) / 1000).toFixed(1)} 秒 · ${engineBackend.toUpperCase()} · ${modeLabel()}${project.cues.length ? ' · 请复核识别文本和时间。' : ' · 未识别到字幕，请调整区域或阈值。'}`;
  } catch (error) {
    invalidateFailedEngine();
    observations.sort((a, b) => a.time - b.time);
    const processedEnd = coarseComplete ? end : observations.length ? Math.min(end, observations.at(-1)!.time + interval / 2) : start;
    project.extraction.end = processedEnd; project.cues = buildCues(observations, start, processedEnd, interval);
    $('run-status').textContent = signal.aborted ? `已停止 · 保留 ${project.cues.length} 条字幕` : '提取失败，已保留已识别结果。';
    $('run-detail').textContent = signal.aborted ? '可复核并导出已有结果。重新开始会替换时间轴。' : message(error);
    if (!signal.aborted) toast(message(error), true);
  } finally {
    busy = undefined; active = undefined; renderCues(); refreshControls();
    if (metrics) {
      metrics.add('totalMs', performance.now() - started);
      const report = { backend: engineBackend, batchEnabled, batchFallback, complete: project.extraction.complete, ...metrics.snapshot(), notes: 'Sampling wall/consumer/queue times overlap. WebGPU Run measures dispatch; Output includes waiting for GPU completion and download. Profiling changes output scheduling. No pure GPU kernel or transfer duration is claimed.' };
      let element = document.getElementById('performance-report');
      if (!element) { element = document.createElement('script'); element.id = 'performance-report'; (element as HTMLScriptElement).type = 'application/json'; document.body.append(element); }
      element.textContent = JSON.stringify(report);
      console.info('Sub Extract performance', report);
    }
  }
}
$('extract').onclick = () => void extract();
$('cancel').onclick = () => {
  active?.abort();
  if (busy === 'model') engine?.dispose();
  if (busy === 'frame') { disposeEngine(); engineReady = false; $('model-status').textContent = '识别已停止，请重新加载模型。'; }
  $('run-status').textContent = '正在停止…';
};

function renderCues() {
  const cues = project?.cues || [], query = $<HTMLInputElement>('search').value.trim().toLowerCase(), onlyReview = $<HTMLInputElement>('review-only').checked;
  const visible = cues.filter(c => c.text.toLowerCase().includes(query) && (!onlyReview || c.needsReview));
  $('cue-count').textContent = String(cues.length); $('review-count').textContent = `${cues.filter(c => c.needsReview).length} 条待复核`;
  $('timeline-duration').textContent = formatTime(project?.source.duration || video.duration * 1000 || 0);
  cueList.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement('div'); empty.className = 'timeline-empty';
    empty.innerHTML = `<span class="empty-number">Aa</span><p>${cues.length ? '没有符合筛选的字幕' : '识别后的字幕会显示在这里'}</p><span>点击时间跳转 · 编辑文本与起止时间</span>`; cueList.append(empty);
  }
  const fragment = document.createDocumentFragment();
  for (const cue of visible) {
    const row = document.createElement('article'); row.className = 'cue'; row.dataset.id = cue.id; row.classList.toggle('active', cue.id === currentCueId);
    row.innerHTML = `<div class="cue-top"><button class="cue-seek mono" title="预览这条字幕，定位到识别到文字的画面"></button><span class="cue-confidence mono"></span><button class="delete-cue quiet" title="删除字幕" aria-label="删除字幕">×</button></div><textarea class="cue-text" rows="${Math.max(1, cue.text.split('\n').length)}" aria-label="字幕文本" spellcheck="false"></textarea><div class="cue-bottom"><input class="cue-start mono" aria-label="字幕开始时间" spellcheck="false"><span>→</span><input class="cue-end mono" aria-label="字幕结束时间" spellcheck="false"><label class="check"><input class="cue-review" type="checkbox">待复核</label></div>`;
    row.querySelector('.cue-seek')!.textContent = `${String(cues.indexOf(cue) + 1).padStart(3, '0')} / ${formatTime(cue.start)}`;
    row.querySelector('.cue-confidence')!.textContent = `${Math.round(cue.confidence * 100)}%`;
    (row.querySelector('.cue-text') as HTMLTextAreaElement).value = cue.text;
    (row.querySelector('.cue-start') as HTMLInputElement).value = formatTime(cue.start);
    (row.querySelector('.cue-end') as HTMLInputElement).value = formatTime(cue.end);
    (row.querySelector('.cue-review') as HTMLInputElement).checked = cue.needsReview;
    fragment.append(row);
  }
  cueList.append(fragment); drawTimeline(); refreshControls();
}
cueList.addEventListener('click', event => {
  if (busy) return; const target = event.target as HTMLElement, row = target.closest<HTMLElement>('.cue');
  const cue = project?.cues.find(c => c.id === row?.dataset.id); if (!cue) return;
  if (target.closest('.cue-seek')) { if (source) seekCue(cue); else toast('请选择项目对应的视频以预览。'); }
  if (target.closest('.delete-cue')) { project!.cues = project!.cues.filter(c => c !== cue); renderCues(); }
});
cueList.addEventListener('change', event => {
  if (busy) return; const input = event.target as HTMLInputElement, row = input.closest<HTMLElement>('.cue');
  const cue = project?.cues.find(c => c.id === row?.dataset.id); if (!cue) return;
  if (input.matches('.cue-text')) { cue.text = input.value; cue.lines = cue.text.split('\n'); }
  if (input.matches('.cue-start, .cue-end')) {
    const value = parseTime(input.value), isStart = input.matches('.cue-start');
    if (value === null || (isStart ? value >= cue.end : value <= cue.start) || value > project!.source.duration) { input.value = formatTime(isStart ? cue.start : cue.end); return toast('起止时间无效，且不能超过视频时长。', true); }
    cue[isStart ? 'start' : 'end'] = value; input.value = formatTime(value); drawTimeline();
  }
  if (input.matches('.cue-review')) { cue.needsReview = input.checked; $('review-count').textContent = `${project!.cues.filter(c => c.needsReview).length} 条待复核`; }
});
$('search').oninput = renderCues; $('review-only').onchange = renderCues;

function drawTimeline() {
  const element = $<HTMLCanvasElement>('timeline'), rect = element.getBoundingClientRect();
  element.width = Math.max(1, Math.round(rect.width * devicePixelRatio)); element.height = 48 * devicePixelRatio;
  const ctx = element.getContext('2d')!, width = element.width, height = element.height, duration = timelineDuration(project?.source.duration, video.duration);
  ctx.fillStyle = '#1c2325'; ctx.fillRect(0, height * 0.35, width, height * 0.3);
  for (const cue of project?.cues || []) { ctx.fillStyle = cue.needsReview ? '#658c78' : '#a4dfbd'; ctx.fillRect(cue.start / duration * width, height * 0.28, Math.max(2, (cue.end - cue.start) / duration * width), height * 0.44); }
  if (source) { ctx.fillStyle = '#f3f5f1'; ctx.fillRect(video.currentTime * 1000 / duration * width, height * 0.16, 2 * devicePixelRatio, height * 0.68); }
}
new ResizeObserver(drawTimeline).observe($('timeline'));
$('timeline').onclick = event => {
  if (!source) return;
  const element = $<HTMLCanvasElement>('timeline'), rect = element.getBoundingClientRect(), duration = timelineDuration(project?.source.duration, video.duration);
  const time = clamp((event.clientX - rect.left) / rect.width, 0, 1) * duration;
  const cue = timelineCueAt(project?.cues || [], time, duration, element.width);
  if (cue) seekCue(cue); else seekTo(time);
};
function updatePlaybackPosition() {
  updateTransport(); drawTimeline();
  const cue = project?.cues.find(c => video.currentTime * 1000 >= c.start && video.currentTime * 1000 < c.end);
  if (cue?.id === currentCueId) return; currentCueId = cue?.id || '';
  for (const row of cueList.querySelectorAll<HTMLElement>('.cue')) row.classList.toggle('active', row.dataset.id === currentCueId);
}
video.ontimeupdate = () => { if (!video.seeking) updatePlaybackPosition(); };

function download(name: string, contents: string, type: string) {
  const url = URL.createObjectURL(new Blob([contents], { type })), link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-export]')) button.onclick = () => {
  if (!project) return; const format = button.dataset.export as 'srt' | 'vtt' | 'json';
  try {
    const error = validateCues(project.cues); if (error) throw new Error(error);
    const contents = format === 'json' ? JSON.stringify(project, null, 2) : exportSubtitles(project.cues, format);
    download(project.source.name.replace(/\.[^.]+$/, '') + '.' + format, contents, format === 'json' ? 'application/json' : format === 'vtt' ? 'text/vtt' : 'text/plain;charset=utf-8');
    toast(`已导出 ${format.toUpperCase()} · ${project.cues.length} 条字幕`);
  } catch (error) { toast(message(error), true); }
};
$<HTMLInputElement>('import-json').onchange = async event => {
  const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return;
  try {
    if (file.size > 20_000_000) throw new Error('JSON 项目过大。');
    const imported = importProject(JSON.parse(await file.text()));
    if (project?.cues.length && !confirm('导入将替换当前时间轴。继续？')) return;
    project = imported; region = { ...imported.extraction.region }; rememberRegion(); updateRegion(); renderCues();
    if (source && Math.abs(imported.source.duration - video.duration * 1000) > 1000) toast('JSON 项目与当前视频的时长不一致，请确认选择的视频。', true);
    else if (source && source.name !== imported.source.name) toast('JSON 项目视频名与当前视频不同，请确认选择的视频。', true); else toast('已导入字幕时间轴。');
  } catch (error) { toast(message(error), true); }
  finally { (event.target as HTMLInputElement).value = ''; }
};
$('clear-cues').onclick = () => { if (project?.cues.length && confirm('清空全部字幕？请先导出 JSON 保存结果。')) { project.cues = []; observations = []; renderCues(); } };
$('add-cue').onclick = () => {
  if (!source && !project) return toast('请先选择视频或导入 JSON 项目。');
  if (!project) project = { schemaVersion: 1, timeUnit: 'ms', source: { name: source!.name, duration: Math.round(video.duration * 1000), width: video.videoWidth, height: video.videoHeight }, extraction: { region: { ...region }, start: 0, end: Math.round(video.duration * 1000), sampleInterval: 250, backend: engineBackend, model: engineModel, complete: false }, cues: [] };
  const start = Math.round(video.currentTime * 1000 || 0), end = Math.min(project.source.duration, start + 2000);
  if (end <= start) return toast('当前时间已经到视频末尾。');
  const cue: Cue = { id: crypto.randomUUID(), start, end, text: '新字幕', lines: ['新字幕'], confidence: 1, needsReview: true, sampleTime: start };
  project.cues.push(cue); project.cues.sort((a, b) => a.start - b.start); renderCues();
};
$('help').onclick = () => $<HTMLDialogElement>('help-dialog').showModal();
$('close-help').onclick = () => $<HTMLDialogElement>('help-dialog').close();
$('help-dialog').onclick = event => { if (event.target === $('help-dialog')) $<HTMLDialogElement>('help-dialog').close(); };
window.addEventListener('beforeunload', event => { if (busy || project?.cues.length) { event.preventDefault(); } });
try { const batch = localStorage.getItem('sub-extract-batch'); if (batch !== null) $<HTMLInputElement>('batch-ocr').checked = batch !== 'false'; } catch { /* Use batch acceleration by default. */ }
try { const preferred = localStorage.getItem('sub-extract-backend'); if (preferred && ['auto', 'webgpu', 'wasm'].includes(preferred)) $<HTMLSelectElement>('backend').value = preferred; } catch { /* Use the default backend. */ }
setupPwa(toast);
updateRegion(); refreshControls();
void hasCachedModels().then(cached => {
  cachedModels = cached; refreshControls();
  if (cached && !engineReady && !busy) void loadModel('online');
});
